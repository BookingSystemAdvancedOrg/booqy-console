"""Tenants (customers): create / read / update, plan changes, lifecycle.

Provisioning itself (Cognito owner, Stripe connected account, subdomain,
offboarding) is done by the Step Functions workflows in the infrastructure
repo - this module only writes the rows and starts them."""

import json

from botocore.exceptions import ClientError

from . import validation as v
from .core import (ApiError, audit_put, cancellation_codes, client, env, from_ddb, location_table,
                   new_id, not_found, now_iso, query_all, tenant_table, to_ddb, to_ddb_value,
                   user_table, write_audit)

ACTIVE_LIKE = ("provisioning", "provisioning_failed", "active", "suspended")
EDITABLE = ("name", "legalName", "orgNumber", "vatNumber", "contactEmail", "contactPhone",
            "billingEmail", "senderName", "replyToEmail", "address", "branding", "notes")
HIDDEN = ("PK", "SK", "GSI1PK", "GSI1SK")


def tkey(tenant_id: str) -> dict:
    return {"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}}


def get_profile(tenant_id: str, *, required: bool = True) -> dict | None:
    item = from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), Key=tkey(tenant_id), ConsistentRead=True).get("Item"))
    if item is None and required:
        raise not_found("No such tenant")
    return item


def public(profile: dict) -> dict:
    return {k: val for k, val in profile.items() if k not in HIDDEN}


def get_plan(plan_id: str) -> dict | None:
    return from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), Key={"PK": {"S": f"PLAN#{plan_id}"}, "SK": {"S": "PLAN"}}).get("Item"))


def _profile_fields(f: v.Fields) -> dict:
    out = {
        "legalName": f.text("legalName", max_len=150),
        "orgNumber": f.text("orgNumber", max_len=11, pattern=v.ORG_NUMBER_RE, msg="Format NNNNNN-NNNN"),
        "vatNumber": f.text("vatNumber", max_len=14, pattern=v.VAT_RE, msg="Format SE + 12 digits"),
        "contactEmail": f.email("contactEmail"),
        "contactPhone": f.phone("contactPhone"),
        "billingEmail": f.email("billingEmail"),
        "senderName": f.text("senderName", max_len=11, pattern=v.SENDER_RE,
                             msg="Max 11 characters, letters, digits and spaces (SMS sender)"),
        "replyToEmail": f.email("replyToEmail"),
        "address": v.address(f),
        "notes": f.text("notes", max_len=2000),
    }
    if "branding" in f.data:
        if not isinstance(f.data["branding"], dict):
            f.fail("branding", "Must be an object")
        else:
            out["branding"] = f.data["branding"]
    return out


# ---------------------------------------------------------------------- plans
def list_plans(req) -> tuple[int, dict]:
    plans = query_all(TableName=tenant_table(), IndexName="GSI1",
                      KeyConditionExpression="GSI1PK = :p", ExpressionAttributeValues={":p": {"S": "PLAN"}})
    return 200, {"plans": [
        {"planId": p["planId"], "name": p.get("name", p["planId"]),
         "maxLocations": p.get("maxLocations", 1), "features": p.get("features", {})}
        for p in plans]}


def _entitlements(plan: dict, overrides: dict | None) -> dict:
    ent = {"maxLocations": int(plan.get("maxLocations", 1)), "features": dict(plan.get("features") or {})}
    if overrides:
        if overrides.get("maxLocations") is not None:
            ent["maxLocations"] = int(overrides["maxLocations"])
        for k, val in (overrides.get("features") or {}).items():
            ent["features"][k] = bool(val)
    return ent


def _overrides(f: v.Fields) -> dict | None:
    raw = f.data.get("overrides")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        f.fail("overrides", "Must be an object")
        return None
    sub = v.Fields(raw)
    out = {"maxLocations": sub.integer("maxLocations", minimum=1, maximum=100)}
    feats = raw.get("features")
    if feats is not None:
        if not isinstance(feats, dict) or not all(isinstance(x, bool) for x in feats.values()):
            sub.fail("features", "Map of feature -> true/false")
        else:
            out["features"] = feats
    for k, msg in sub.errors.items():
        f.fail(f"overrides.{k}", msg)
    return {k: val for k, val in out.items() if val is not None}


# -------------------------------------------------------------------- tenants
def list_tenants(req) -> tuple[int, dict]:
    items = query_all(TableName=tenant_table(), IndexName="GSI1",
                      KeyConditionExpression="GSI1PK = :t", ExpressionAttributeValues={":t": {"S": "TENANT"}})
    status = (req.query.get("status") or "").strip()
    rows = []
    for t in items:
        if status and t.get("status") != status:
            continue
        stripe = t.get("stripe") or {}
        rows.append({
            "tenantId": t["tenantId"], "name": t.get("name"), "slug": t.get("slug"),
            "status": t.get("status"), "planId": t.get("planId"),
            "locationCount": t.get("locationCount", 0),
            "maxLocations": (t.get("entitlements") or {}).get("maxLocations"),
            "chargesEnabled": bool(stripe.get("chargesEnabled")),
            "primaryDomain": t.get("primaryDomain"), "ownerEmail": t.get("ownerEmail"),
            "createdAt": t.get("createdAt"),
        })
    rows.sort(key=lambda r: (r["name"] or "").lower())
    return 200, {"tenants": rows}


def create_tenant(req) -> tuple[int, dict]:
    f = v.Fields(req.body)
    name = f.text("name", required=True, max_len=100)
    slug = v.slug(f)
    owner_email = f.email("ownerEmail", required=True)
    owner_name = f.text("ownerName", required=True, max_len=100)
    owner_phone = f.phone("ownerPhone")
    plan_id = f.text("planId", required=True, max_len=40)
    fields = _profile_fields(f)
    overrides = _overrides(f)
    raw_locations = req.body.get("locations") or []
    if not isinstance(raw_locations, list):
        f.fail("locations", "Must be a list")
        raw_locations = []
    f.done()

    plan = get_plan(plan_id)
    if plan is None:
        raise ApiError(400, "validation_failed", "Unknown plan", fields={"planId": "Unknown plan"})
    entitlements = _entitlements(plan, overrides)

    locations = [v.location_fields(loc if isinstance(loc, dict) else {}, partial=False, prefix=f"locations.{i}.")
                 for i, loc in enumerate(raw_locations)]
    if len(locations) > entitlements["maxLocations"]:
        raise ApiError(400, "validation_failed", "More locations than the plan allows",
                       fields={"locations": f"The plan allows {entitlements['maxLocations']}"})

    tenant_id, now = new_id(), now_iso()
    profile = {
        "PK": f"TENANT#{tenant_id}", "SK": "PROFILE", "GSI1PK": "TENANT", "GSI1SK": slug,
        "tenantId": tenant_id, "name": name, "slug": slug, "status": "provisioning",
        "planId": plan_id, "entitlements": entitlements, "locationCount": len(locations),
        "ownerEmail": owner_email, "ownerName": owner_name, "ownerPhone": owner_phone,
        "onboardingRuns": 1,
        "createdAt": now, "createdBy": req.actor, "updatedAt": now, "updatedBy": req.actor,
        **{k: val for k, val in fields.items() if val is not None},
    }
    items = [
        {"Put": {"TableName": tenant_table(), "ConditionExpression": "attribute_not_exists(PK)",
                 "Item": to_ddb({"PK": f"SLUG#{slug}", "SK": "TENANT", "tenantId": tenant_id})}},
        {"Put": {"TableName": tenant_table(), "ConditionExpression": "attribute_not_exists(PK)",
                 "Item": to_ddb(profile)}},
    ]
    for loc in locations:
        location_id = new_id()
        items.append({"Put": {"TableName": location_table(), "ConditionExpression": "attribute_not_exists(PK)",
                              "Item": to_ddb({"PK": f"TENANT#{tenant_id}", "SK": f"LOCATION#{location_id}",
                                              "tenantId": tenant_id, "locationId": location_id,
                                              "createdAt": now, "createdBy": req.actor,
                                              **v.app_location_fields(loc), **loc})}})
    items.append(audit_put(tenant_id, "tenant_created", req.actor,
                           {"planId": plan_id, "ownerEmail": owner_email, "locations": len(locations)}))
    try:
        client("dynamodb").transact_write_items(TransactItems=items)
    except ClientError as e:
        if e.response["Error"]["Code"] == "TransactionCanceledException" and \
                cancellation_codes(e)[0] == "ConditionalCheckFailed":
            raise ApiError(409, "slug_taken", "That slug is already used by another customer",
                           fields={"slug": "Already taken"}) from e
        raise

    status = _start_onboarding(tenant_id, profile, run=1)
    return 202, {"tenantId": tenant_id, "status": status}


def _start_onboarding(tenant_id: str, profile: dict, run: int) -> str:
    """Starts the onboarding workflow. A failure to even start it marks the
    tenant provisioning_failed so Retry works the same as a failed run."""
    try:
        arn = client("stepfunctions").start_execution(
            stateMachineArn=env("ONBOARDING_STATE_MACHINE_ARN"),
            name=f"onboard-{tenant_id}-{run}",
            input=json.dumps({"tenantId": tenant_id, "slug": profile["slug"], "name": profile["name"],
                              "ownerEmail": profile["ownerEmail"], "ownerName": profile["ownerName"]}),
        )["executionArn"]
    except ClientError as e:
        if profile.get("status") != "provisioning":
            # Re-run on an active tenant: nothing to roll back, just report it.
            raise ApiError(502, "workflow_start_failed", f"Could not start onboarding: {e}") from e
        client("dynamodb").update_item(
            TableName=tenant_table(), Key=tkey(tenant_id),
            UpdateExpression="SET #s = :f, lastError = :e, updatedAt = :n",
            ConditionExpression="#s = :p",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":f": {"S": "provisioning_failed"}, ":p": {"S": "provisioning"},
                                       ":e": {"S": f"Could not start onboarding: {e}"[:1000]},
                                       ":n": {"S": now_iso()}})
        return "provisioning_failed"
    client("dynamodb").update_item(
        TableName=tenant_table(), Key=tkey(tenant_id),
        UpdateExpression="SET onboardingExecutionArn = :a, onboardingRuns = :r",
        ExpressionAttributeValues={":a": {"S": arn}, ":r": {"N": str(run)}})
    return profile.get("status", "provisioning")


def get_tenant(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    ddb = client("dynamodb")
    domains = query_all(TableName=tenant_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :d)",
                        ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":d": {"S": "DOMAIN#"}})
    audit = [from_ddb(i) for i in ddb.query(
        TableName=tenant_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :a)",
        ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":a": {"S": "AUDIT#"}},
        ScanIndexForward=False, Limit=25).get("Items", [])]
    locations = query_all(TableName=location_table(), KeyConditionExpression="PK = :pk",
                          ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}})
    users = ddb.query(TableName=user_table(), IndexName=env("USER_TENANT_INDEX_NAME"),
                      KeyConditionExpression="tenantId = :t", Select="COUNT",
                      ExpressionAttributeValues={":t": {"S": tenant_id}}).get("Count", 0)
    onboarding = None
    if profile.get("onboardingExecutionArn"):
        try:
            ex = client("stepfunctions").describe_execution(executionArn=profile["onboardingExecutionArn"])
            onboarding = {"status": ex["status"], "startDate": ex["startDate"].isoformat(),
                          "stopDate": ex["stopDate"].isoformat() if ex.get("stopDate") else None}
        except ClientError:
            onboarding = None
    primary = profile.get("primaryDomain")
    return 200, {
        "tenant": public(profile),
        "domains": [{**{k: val for k, val in d.items() if k not in HIDDEN}, "primary": d.get("domain") == primary}
                    for d in domains],
        "locations": [{k: val for k, val in loc.items() if k not in HIDDEN} for loc in locations],
        "userCount": users,
        "onboarding": onboarding,
        "audit": [{k: a.get(k) for k in ("action", "by", "at", "details")} for a in audit],
    }


def update_tenant(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    unknown = sorted(set(req.body) - set(EDITABLE))
    if unknown:
        raise ApiError(400, "validation_failed", "These fields can't be changed here",
                       fields={k: "Not editable" for k in unknown})
    f = v.Fields(req.body)
    fields = _profile_fields(f)
    if "name" in req.body:
        fields["name"] = f.text("name", required=True, max_len=100)
    f.done()
    sets, removes, names, values = [], [], {}, {}
    for i, key in enumerate(k for k in EDITABLE if k in req.body):
        names[f"#f{i}"] = key
        if fields.get(key) is None:
            removes.append(f"#f{i}")              # cleared in the form
        else:
            sets.append(f"#f{i} = :v{i}")
            values[f":v{i}"] = to_ddb_value(fields[key])
    if not sets and not removes:
        raise ApiError(400, "validation_failed", "Nothing to update")
    sets += ["updatedAt = :now", "updatedBy = :by"]
    values.update({":now": {"S": now_iso()}, ":by": {"S": req.actor}})
    expr = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
    try:
        out = client("dynamodb").update_item(
            TableName=tenant_table(), Key=tkey(tenant_id), UpdateExpression=expr,
            ConditionExpression="attribute_exists(PK)", ExpressionAttributeNames=names,
            ExpressionAttributeValues=values, ReturnValues="ALL_NEW")
    except client("dynamodb").exceptions.ConditionalCheckFailedException as e:
        raise not_found("No such tenant") from e
    write_audit(tenant_id, "profile_updated", req.actor, {"fields": sorted(names.values())})
    return 200, {"tenant": public(from_ddb(out["Attributes"]))}


def set_plan(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    f = v.Fields(req.body)
    plan_id = f.text("planId", required=True, max_len=40)
    overrides = _overrides(f)
    force = f.boolean("force") or False
    f.done()
    profile = get_profile(tenant_id)
    plan = get_plan(plan_id)
    if plan is None:
        raise ApiError(400, "validation_failed", "Unknown plan", fields={"planId": "Unknown plan"})
    ent = _entitlements(plan, overrides)
    count = int(profile.get("locationCount", 0))
    if ent["maxLocations"] < count and not force:
        raise ApiError(409, "below_location_count",
                       f"The tenant already has {count} locations; the new limit is {ent['maxLocations']}. "
                       "Send force=true to apply anyway (existing locations keep working, no new ones).",
                       locationCount=count)
    out = client("dynamodb").update_item(
        TableName=tenant_table(), Key=tkey(tenant_id),
        UpdateExpression="SET planId = :p, entitlements = :e, updatedAt = :n, updatedBy = :b",
        ConditionExpression="attribute_exists(PK)",
        ExpressionAttributeValues={":p": {"S": plan_id}, ":e": to_ddb_value(ent),
                                   ":n": {"S": now_iso()}, ":b": {"S": req.actor}},
        ReturnValues="ALL_NEW")
    write_audit(tenant_id, "plan_changed", req.actor, {
        "from": {"planId": profile.get("planId"), "entitlements": profile.get("entitlements")},
        "to": {"planId": plan_id, "entitlements": ent}})
    return 200, {"tenant": public(from_ddb(out["Attributes"]))}


# ------------------------------------------------------------------ lifecycle
def _set_status(tenant_id: str, to: str, allowed_from: tuple[str, ...], actor: str) -> None:
    values = {":to": {"S": to}, ":n": {"S": now_iso()}, ":b": {"S": actor}}
    placeholders = []
    for i, s in enumerate(allowed_from):
        values[f":f{i}"] = {"S": s}
        placeholders.append(f":f{i}")
    try:
        client("dynamodb").update_item(
            TableName=tenant_table(), Key=tkey(tenant_id),
            UpdateExpression="SET #s = :to, updatedAt = :n, updatedBy = :b",
            ConditionExpression=f"#s IN ({', '.join(placeholders)})",
            ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues=values)
    except client("dynamodb").exceptions.ConditionalCheckFailedException as e:
        current = (get_profile(tenant_id) or {}).get("status")
        raise ApiError(409, "invalid_status", f"Not possible while the tenant is {current}",
                       currentStatus=current) from e


def tenant_users(tenant_id: str) -> list[dict]:
    return query_all(TableName=user_table(), IndexName=env("USER_TENANT_INDEX_NAME"),
                     KeyConditionExpression="tenantId = :t", ExpressionAttributeValues={":t": {"S": tenant_id}})


def _cognito_each(users: list[dict], *calls: str) -> tuple[int, list[str]]:
    """Runs the calls per user. Never aborts halfway: failures are collected
    and reported, and every caller can simply be run again (idempotent)."""
    idp, pool, done, failed = client("cognito-idp"), env("TENANT_USER_POOL_ID"), 0, []
    for u in users:
        username = u.get("cognitoSub") or u.get("email")
        if not username:
            continue
        try:
            for call in calls:
                getattr(idp, call)(UserPoolId=pool, Username=username)
            done += 1
        except idp.exceptions.UserNotFoundException:
            continue
        except ClientError as e:
            failed.append(f"{u.get('email') or username}: {e.response['Error']['Code']}")
    return done, failed


def _reason(req) -> str | None:
    f = v.Fields(req.body)
    reason = f.text("reason", max_len=500)
    f.done()
    return reason


def suspend(req) -> tuple[int, dict]:
    """Block every user of the tenant. Allowed again on a suspended tenant, so
    a run that failed for some users can simply be repeated."""
    tenant_id = req.path["tenantId"]
    reason = _reason(req)
    get_profile(tenant_id)
    _set_status(tenant_id, "suspended", ("active", "suspended"), req.actor)
    # Profile status is left alone on purpose: resume re-enables only users
    # whose profile says active, so people an owner disabled stay disabled.
    n, failed = _cognito_each(tenant_users(tenant_id), "admin_disable_user", "admin_user_global_sign_out")
    write_audit(tenant_id, "suspended", req.actor, {"usersDisabled": n, "failed": failed, "reason": reason})
    return 200, {"status": "suspended", "usersDisabled": n, "failed": failed}


def resume(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    get_profile(tenant_id)
    _set_status(tenant_id, "active", ("suspended", "active"), req.actor)
    users = [u for u in tenant_users(tenant_id) if u.get("status", "active") == "active"]
    n, failed = _cognito_each(users, "admin_enable_user")
    write_audit(tenant_id, "resumed", req.actor, {"usersEnabled": n, "failed": failed})
    return 200, {"status": "active", "usersEnabled": n, "failed": failed}


def offboard(req) -> tuple[int, dict]:
    """'Delete customer': disable users, detach domains, mark offboarded. Data
    is kept (exports, 7-year bookkeeping retention); purging is a separate,
    manual decision.

    The status flips to offboarding first (conditional), and the execution
    name is fixed per tenant - a double click or two operators can't start
    two runs, and a request that failed after the flip can be repeated."""
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    if req.body.get("confirmSlug") != profile.get("slug"):
        raise ApiError(400, "validation_failed", "Type the customer's slug to confirm",
                       fields={"confirmSlug": "Does not match"})
    if profile.get("status") == "provisioning":
        raise ApiError(409, "invalid_status", "Wait until setup has finished (or failed)",
                       currentStatus="provisioning")
    _set_status(tenant_id, "offboarding", ("active", "suspended", "provisioning_failed", "offboarding"), req.actor)
    sfn = client("stepfunctions")
    try:
        sfn.start_execution(
            stateMachineArn=env("OFFBOARDING_STATE_MACHINE_ARN"), name=f"offboard-{tenant_id}",
            input=json.dumps({"tenantId": tenant_id, "requestedBy": req.actor}))
    except sfn.exceptions.ExecutionAlreadyExists:
        pass                                    # already running / ran - nothing to do
    write_audit(tenant_id, "offboarding_started", req.actor)
    return 202, {"status": "offboarding"}


def retry_onboarding(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    status = profile.get("status")
    if status == "provisioning_failed":
        _set_status(tenant_id, "provisioning", ("provisioning_failed",), req.actor)
        profile["status"] = "provisioning"
    elif status != "active":
        raise ApiError(409, "invalid_status", f"Not possible while the tenant is {status}", currentStatus=status)
    run = int(profile.get("onboardingRuns", 1)) + 1
    result = _start_onboarding(tenant_id, profile, run)
    write_audit(tenant_id, "onboarding_rerun", req.actor, {"run": run})
    return 202, {"status": result}
