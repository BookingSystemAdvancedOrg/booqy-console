"""Tenants (customers): create / read / update, plan changes, lifecycle.

Provisioning itself (Cognito owner, Stripe connected account, subdomain,
offboarding) is done by the Step Functions workflows in the infrastructure
repo - this module only writes the rows and starts them."""

import json
from datetime import date, timedelta

from botocore.exceptions import ClientError

from . import validation as v
from .core import not_while, status_words
from .contracts import FEATURE_KEYS, LIMITS
from .core import (ApiError, audit_put, cancellation_codes, client, env, from_ddb, location_table,
                   new_id, not_found, now_iso, query_all, tenant_table, to_ddb, to_ddb_value,
                   user_table, write_audit)

ACTIVE_LIKE = ("provisioning", "provisioning_failed", "active", "suspended")
EDITABLE = ("name", "legalName", "orgNumber", "vatNumber", "contactEmail", "contactPhone",
            "billingEmail", "senderName", "replyToEmail", "address", "branding", "notes")
# The owner is invited by onboarding, so these change only while setup has
# failed (a wrong or taken address); afterwards the Users tab manages people.
OWNER_EDITABLE = ("ownerName", "ownerEmail", "ownerPhone")
HIDDEN = ("PK", "SK", "GSI1PK", "GSI1SK")


def tkey(tenant_id: str) -> dict:
    return {"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}}


def get_profile(tenant_id: str, *, required: bool = True) -> dict | None:
    item = from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), Key=tkey(tenant_id), ConsistentRead=True).get("Item"))
    if item is None and required:
        raise not_found("We can't find this customer. Reload the page.")
    return item


def public(profile: dict) -> dict:
    return {k: val for k, val in profile.items() if k not in HIDDEN}


def owner_email_problem(email: str | None, tenant_id: str | None = None) -> str | None:
    """Every owner sign-in belongs to exactly one customer (custom:tenant_id).
    Caught here, the form can point at the field instead of onboarding
    failing later at InviteOwner."""
    if not email:
        return None
    idp = client("cognito-idp")
    try:
        user = idp.admin_get_user(UserPoolId=env("TENANT_USER_POOL_ID"), Username=email)
    except idp.exceptions.UserNotFoundException:
        return None
    owner = next((a["Value"] for a in user.get("UserAttributes", []) if a["Name"] == "custom:tenant_id"), "")
    if not owner or owner == tenant_id:
        return None
    other = (get_profile(owner, required=False) or {}).get("name") or owner
    local, _, domain = email.partition("@")
    return f"Already used to sign in to {other}. Use another email, e.g. {local}+{domain.split('.')[0]}2@{domain}."


# Free: no monthly charge, Growth's features and limits. Not a row in the
# catalog (no Stripe product, nothing to keep in step): derived from
# PLAN#growth on every read, so it always follows Growth. A limited free
# period ends on billing.freeUntil (the last free day) and the daily task
# (billing.free_step) moves the customer to billing.freeThenPlanId.
FREE_PLAN_ID = "free"
FREE_BASE_PLAN_ID = "growth"
FREE_MONTHS = 3
FREE_NOTICE_DAYS = 14          # the owner is told this many days before the first paid day


def _plan_row(plan_id: str) -> dict | None:
    return from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), Key={"PK": {"S": f"PLAN#{plan_id}"}, "SK": {"S": "PLAN"}}).get("Item"))


def free_plan(base: dict | None) -> dict | None:
    if not base:
        return None
    return {**base, "planId": FREE_PLAN_ID, "name": "Free", "priceSek": 0, "free": True,
            "stripePriceId": None, "stripeProductId": None, "GSI1SK": FREE_PLAN_ID}


def get_plan(plan_id: str) -> dict | None:
    if plan_id == FREE_PLAN_ID:
        return free_plan(_plan_row(FREE_BASE_PLAN_ID))
    return _plan_row(plan_id)


def add_months(day: date, months: int) -> date:
    month = day.month - 1 + months
    year = day.year + month // 12
    month = month % 12 + 1
    last = (date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)).day
    return day.replace(year=year, month=month, day=min(day.day, last))


def default_free_until(today: date | None = None) -> date:
    """The default last free day: three months from today (Stockholm), the
    day before the same date three months on (from 14 Nov: 13 Feb, the
    first paid day 14 Feb)."""
    from .website import stockholm_today          # website imports nothing from here
    return add_months(today or stockholm_today(), FREE_MONTHS) - timedelta(days=1)


def _stockholm_today() -> date:
    """Today in Stockholm: the day a free period counts from (freeSince), like its end."""
    from .website import stockholm_today          # website imports nothing from here
    return stockholm_today()


FREE_PRESETS = {"until_changed": None, "3m": 3, "6m": 6}


def free_until_for(preset: str, start: date) -> date | None:
    """The last free day of a preset: none for until_changed, else the day
    before the same date 3 or 6 calendar months on (from 14 Nov 2026, 3m
    ends 13 Feb 2027; from 31 Aug, 6m ends 27 Feb as 28 Feb is the first paid day)."""
    months = FREE_PRESETS[preset]
    return None if months is None else add_months(start, months) - timedelta(days=1)


def free_input(f: v.Fields, plan_id: str | None, field: str = "free", current_until: str | None = None,
               start: date | None = None, current_preset: str | None = None) -> dict | None:
    """The `free` object next to planId "free". Either a preset,
    {preset: "until_changed" | "3m" | "6m", thenPlanId}, the end computed
    here from `start` (the free period's first day, Stockholm; today when
    left out) and thenPlanId required for 3m/6m; or, for older callers,
    {until: yyyy-mm-dd | null (no end date), thenPlanId (default starter)}.
    Left out: three months, then Starter. A new last free day is at least
    14 days ahead, so the owner can be told 14 days before the first paid
    day (`current_until`, the one already set, may stay, and so does the
    saved end of an unchanged preset, `current_preset`)."""
    if plan_id != FREE_PLAN_ID:
        return None
    from .website import stockholm_today
    today = stockholm_today()
    raw = f.data.get(field)
    if raw is None:
        return {"until": default_free_until(today).isoformat(), "thenPlanId": "starter"}
    if not isinstance(raw, dict):
        f.fail(field, "Pick how long Free lasts.")
        return None
    out = {"until": None, "thenPlanId": "starter"}
    preset = raw.get("preset")
    if preset is not None:
        if not isinstance(preset, str) or preset not in FREE_PRESETS:
            f.fail(f"{field}.preset", "Pick Free until changed, 3 months or 6 months.")
            return None
        out["preset"] = preset
        if preset == current_preset and current_until is not None:
            out["until"] = current_until          # unchanged: the saved end stays
        else:
            day = free_until_for(preset, start or today)
            if day is not None and day < today + timedelta(days=FREE_NOTICE_DAYS) and day.isoformat() != current_until:
                f.fail(f"{field}.preset", f"Less than {FREE_NOTICE_DAYS} days of that period are left. "
                                          "Pick a longer one, or Free until changed.")
            out["until"] = day.isoformat() if day else None
        if preset != "until_changed" and not raw.get("thenPlanId"):
            f.fail(f"{field}.thenPlanId", "Pick the plan that starts after Free.")
            return out
    else:
        until = raw.get("until")
        if until is not None:
            try:
                day = date.fromisoformat(str(until)[:10]) if isinstance(until, str) else None
            except ValueError:
                day = None
            if day is None:
                f.fail(f"{field}.until", "Write a date like 2027-03-01, or leave it empty.")
            elif day < today + timedelta(days=FREE_NOTICE_DAYS) and day.isoformat() != current_until:
                f.fail(f"{field}.until", f"Pick a date at least {FREE_NOTICE_DAYS} days ahead. The owner is told "
                                         f"{FREE_NOTICE_DAYS} days before the first paid day.")
            elif day > today + timedelta(days=3 * 366):
                f.fail(f"{field}.until", "Pick a date at most three years ahead.")
            else:
                out["until"] = day.isoformat()
    then = raw.get("thenPlanId") or "starter"
    if not isinstance(then, str) or then == FREE_PLAN_ID or _plan_row(then) is None:
        f.fail(f"{field}.thenPlanId", "Pick Starter or Growth.")
    else:
        out["thenPlanId"] = then
    return out


def free_price_problem(free: dict | None, price_sek: int | None) -> str | None:
    """A timed preset (3m, 6m) needs the monthly price after Free, above 0."""
    if free and free.get("preset") in ("3m", "6m") and not price_sek:
        return "Write the monthly price after Free, e.g. 499."
    return None


def _profile_fields(f: v.Fields) -> dict:
    org = v.org_number(f)
    out = {
        "legalName": f.text("legalName", max_len=150),
        "orgNumber": org,
        "vatNumber": v.vat_number(f, org),
        "contactEmail": f.email("contactEmail"),
        "contactPhone": f.phone("contactPhone"),
        "billingEmail": f.email("billingEmail"),
        "senderName": f.text("senderName", max_len=11, pattern=v.SENDER_RE,
                             msg="Use at most 11 letters, digits or spaces, e.g. PizzaRoma."),
        "replyToEmail": f.email("replyToEmail"),
        "address": v.address(f),
        "notes": f.text("notes", max_len=2000),
    }
    if "branding" in f.data:
        if not isinstance(f.data["branding"], dict):
            f.fail("branding", "Booqy couldn't read the branding. Reload the page and try again.")
        else:
            out["branding"] = f.data["branding"]
    return out


# ---------------------------------------------------------------------- plans
def list_plans(req) -> tuple[int, dict]:
    plans = [p for p in query_all(TableName=tenant_table(), IndexName="GSI1",
                                  KeyConditionExpression="GSI1PK = :p", ExpressionAttributeValues={":p": {"S": "PLAN"}})
             if p.get("planId") != FREE_PLAN_ID]
    plans.sort(key=lambda p: (p.get("priceSek") is None, p.get("priceSek") or 0, p["planId"]))
    free = free_plan(next((p for p in plans if p["planId"] == FREE_BASE_PLAN_ID), None))
    return 200, {"plans": [
        {"planId": p["planId"], "name": p.get("name", p["planId"]),
         "maxLocations": p.get("maxLocations", 1), "features": _known_features(p.get("features")),
         "limits": _known_limits(p.get("limits")), "priceSek": p.get("priceSek"), "free": bool(p.get("free"))}
        for p in plans + ([free] if free else [])],
        "freeDefaultUntil": default_free_until().isoformat()}


# Limits of removed features: an older console tab may still send them; they
# are dropped instead of refused (the site builder, removed 2026-11-17).
RETIRED_LIMITS = frozenset({"siteBuilderAiEditsPerMonth"})


def _known_features(features) -> dict:
    """Only the contract's feature keys: a retired feature on a stored plan
    (e.g. siteBuilder) is neither shown nor copied to a tenant."""
    return {k: on for k, on in (features or {}).items() if k in FEATURE_KEYS}


def _known_limits(limits) -> dict:
    """Only the contract's limits (a retired limit on a stored plan is dropped)."""
    return {k: val for k, val in (limits or {}).items() if k in LIMITS}


def _entitlements(plan: dict, overrides: dict | None) -> dict:
    ent = {"maxLocations": int(plan.get("maxLocations", 1)), "features": _known_features(plan.get("features"))}
    if overrides:
        if overrides.get("maxLocations") is not None:
            ent["maxLocations"] = int(overrides["maxLocations"])
        for k, val in (overrides.get("features") or {}).items():
            ent["features"][k] = bool(val)
    ent["limits"] = {k: int(val) for k, val in _known_limits(plan.get("limits")).items()}
    for k, val in ((overrides or {}).get("limits") or {}).items():
        ent["limits"][k] = int(val)
    return ent


def _turned_on(ent: dict) -> set[str]:
    """Feature keys on in these entitlements: stamped into featuresEver, which only grows (CONTRACTS.md 9.2)."""
    return {k for k, on in (ent.get("features") or {}).items() if on}


def _overrides(f: v.Fields) -> dict | None:
    raw = f.data.get("overrides")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        f.fail("overrides", "Booqy couldn't read the changes. Reload the page and try again.")
        return None
    sub = v.Fields(raw)
    out = {"maxLocations": sub.integer("maxLocations", minimum=1, maximum=100)}
    feats = raw.get("features")
    if feats is not None:
        if not isinstance(feats, dict) or not all(isinstance(x, bool) for x in feats.values()):
            sub.fail("features", "Turn each feature on or off.")
        else:
            # Keys no longer in the contract (a retired feature, e.g. "terminal", still on
            # stored entitlements and sent back) are dropped, not rejected.
            out["features"] = {k: on for k, on in feats.items() if k in FEATURE_KEYS}
    lims = raw.get("limits")
    if lims is not None:
        if not isinstance(lims, dict):
            sub.fail("limits", "Write each limit as a whole number, e.g. 3.")
        else:
            lims = {k: val for k, val in lims.items() if k not in RETIRED_LIMITS}
            ls = v.Fields(lims)
            for k in lims:
                if k not in LIMITS:
                    ls.fail(k, "Booqy doesn't know this limit. Reload the page.")
                else:
                    ls.integer(k, minimum=LIMITS[k]["min"], maximum=LIMITS[k]["max"])
            for k, msg in ls.errors.items():
                sub.fail(f"limits.{k}", msg)
            if not ls.errors:
                out["limits"] = {k: int(val) for k, val in lims.items()}
    for k, msg in sub.errors.items():
        f.fail(f"overrides.{k}", msg)
    return {k: val for k, val in out.items() if val is not None}


def price_field(f: v.Fields, field: str = "priceSek") -> int | None:
    """A monthly price in whole SEK excluding VAT, or None for the plan's."""
    return f.integer(field, minimum=0, maximum=1_000_000)


def _billing_input(f: v.Fields) -> dict:
    """The optional `billing` object of the create form: terms (try-out or
    subscription), the customer's own price, whether invoicing starts now."""
    raw = f.data.get("billing")
    if raw is None:
        return {"terms": "subscription", "startInvoicing": False}
    if not isinstance(raw, dict):
        f.fail("billing", "Booqy couldn't read the billing details. Reload the page and try again.")
        return {"terms": "subscription", "startInvoicing": False}
    sub = v.Fields(raw)
    terms = sub.text("terms", max_len=20) or "subscription"
    if terms not in ("trial", "subscription"):
        sub.fail("terms", "Pick trial or subscription.")
    out = {"terms": terms, "priceSek": price_field(sub), "startInvoicing": sub.boolean("startInvoicing") or False,
           "collectionMethod": sub.text("collectionMethod", max_len=30), "startDate": _start_date_input(sub),
           "collectionPreference": sub.text("collectionPreference", max_len=20)}
    if out["collectionMethod"] not in (None, "send_invoice", "charge_automatically"):
        sub.fail("collectionMethod", "Pick emailed invoice or card.")
    if out["collectionPreference"] not in (None, "card", "invoice"):
        sub.fail("collectionPreference", "Pick card or invoice.")
    for k, msg in sub.errors.items():
        f.fail(f"billing.{k}", msg)
    return out


def _start_date_input(f: v.Fields) -> str | None:
    """billing.startDate: yyyy-mm-dd, at most a year ahead (the Billing tab's
    rule, billing._start_day), checked before anything is written."""
    from .billing import _start_day                  # billing imports this module
    day = _start_day(f)
    return day.isoformat() if day else None


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
            "legalName": t.get("legalName"), "orgNumber": t.get("orgNumber"),
            "status": t.get("status"), "planId": t.get("planId"),
            "locationCount": t.get("locationCount", 0),
            "maxLocations": (t.get("entitlements") or {}).get("maxLocations"),
            "chargesEnabled": bool(stripe.get("chargesEnabled")),
            "primaryDomain": t.get("primaryDomain"), "ownerEmail": t.get("ownerEmail"),
            "createdAt": t.get("createdAt"),
            # Dev: "twin" (a prod customer's dev twin) or "test" (a dev test customer)
            **({"devKind": _dev_kind(t)} if env("ENVIRONMENT") != "prod" and _dev_kind(t) else {}),
            "freeUntil": (t.get("billing") or {}).get("freeUntil") if t.get("planId") == FREE_PLAN_ID
            and isinstance(t.get("billing"), dict) else None,
        })
    rows.sort(key=lambda r: (r["name"] or "").lower())
    return 200, {"tenants": rows}


def _site_kind(actor: str) -> dict:
    """Dev with test sites on (owner 2026-11-15): a customer created in this
    console is a test customer (repo in BooqyCustomersDev, hosts on
    test.booqy.se / test-dev.booqy.se); one prod creates through the link is
    the dev side of a real customer. Prod never sets it."""
    if env("ENVIRONMENT") == "prod":
        return {}
    if actor == "prod-site-repo":
        return {"siteKind": "prod-link"}
    return {"siteKind": "test"} if env("TEST_SITES_ENABLED", "false") == "true" else {}


def _dev_kind(t: dict) -> str | None:
    from .devtwin import is_twin
    if t.get("siteKind") == "test":
        return "test"
    return "twin" if is_twin(t) else None


def create_tenant(req) -> tuple[int, dict]:
    f = v.Fields(req.body)
    name = f.text("name", required=True, max_len=100)
    slug = v.slug(f)
    if slug and req.actor != "prod-site-repo":
        # Dev: a slug a prod customer uses is its twin's; a dev test customer
        # may not take it (BooqyCustomers/site-template docs/DATA-RULES.md).
        from .devtwin import prod_slug_taken
        if prod_slug_taken(slug):
            f.fail("slug", "A prod customer uses this slug. Pick another one, so its dev twin can't clash.")
    owner_email = f.email("ownerEmail", required=True)
    owner_name = f.text("ownerName", required=True, max_len=100)
    owner_phone = f.phone("ownerPhone")
    plan_id = f.text("planId", required=True, max_len=40)
    fields = _profile_fields(f)
    overrides = _overrides(f)
    billing_input = _billing_input(f)
    free_start = _start_day(billing_input)
    free = free_input(f, plan_id, start=free_start)
    price_problem = free_price_problem(free, billing_input.get("priceSek"))
    if price_problem:
        f.fail("billing.priceSek", price_problem)
    raw_locations = req.body.get("locations") or []
    if not isinstance(raw_locations, list):
        f.fail("locations", "Booqy couldn't read the locations. Reload the page and try again.")
        raw_locations = []

    # Every problem in one response - the form shows them all at once instead
    # of one round trip per mistake.
    locations = []
    for i, loc in enumerate(raw_locations):
        try:
            locations.append(v.location_fields(loc if isinstance(loc, dict) else {}, partial=False,
                                               prefix=f"locations.{i}."))
        except ApiError as e:
            for k, msg in e.extra.get("fields", {}).items():
                f.fail(k, msg)
    taken = owner_email_problem(owner_email)
    if taken:
        f.fail("ownerEmail", taken)
    plan = get_plan(plan_id) if plan_id else None
    if plan_id and plan is None:
        f.fail("planId", "Unknown plan. Pick one of the listed plans.")
    entitlements = _entitlements(plan, overrides) if plan else None
    if entitlements and _turned_on(entitlements):
        entitlements["featuresEver"] = _turned_on(entitlements)   # a DynamoDB string set
    if entitlements and len(raw_locations) > entitlements["maxLocations"]:
        f.fail("locations", f"The plan allows {entitlements['maxLocations']} locations. Remove a location "
                            "or raise Locations allowed.")
    f.done()

    tenant_id, now = new_id(), now_iso()
    # A purged customer's slug is free again: its claim moves to the new one
    # (only while it still points at that purged customer).
    previous = _slug_owner(slug)
    if previous and (get_profile(previous, required=False) or {}).get("status") != "purged":
        previous = None
    slug_claim = {"ConditionExpression": "tenantId = :old", "ExpressionAttributeValues": {":old": {"S": previous}}} \
        if previous else {"ConditionExpression": "attribute_not_exists(PK)"}
    billing = {"terms": billing_input["terms"]}
    # On Free an own price is the price after it (compared with the next plan's).
    price_plan = (get_plan(free.get("thenPlanId") or "starter") or {}) if free is not None else plan
    if free is not None:
        billing.update({k: val for k, val in free_fields(free, (free_start or _stockholm_today()).isoformat(), overrides).items()
                        if val is not None})
    if billing_input.get("priceSek") is not None and price_plan and billing_input["priceSek"] != price_plan.get("priceSek"):
        billing["priceSek"] = billing_input["priceSek"]
    profile = {
        "PK": f"TENANT#{tenant_id}", "SK": "PROFILE", "GSI1PK": "TENANT", "GSI1SK": slug,
        "tenantId": tenant_id, "name": name, "slug": slug, "status": "provisioning",
        "planId": plan_id, "entitlements": entitlements, "locationCount": len(locations),
        "ownerEmail": owner_email, "ownerName": owner_name, "ownerPhone": owner_phone,
        "onboardingRuns": 1, "billing": billing,
        **_site_kind(req.actor),
        # New restaurants go live only after the owner accepts the DPA in
        # admin (application shared/dpa.py); older tenants never get this.
        "dpaRequired": True,
        "createdAt": now, "createdBy": req.actor, "updatedAt": now, "updatedBy": req.actor,
        **{k: val for k, val in fields.items() if val is not None},
    }
    items = [
        {"Put": {"TableName": tenant_table(), **slug_claim,
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
                           {"planId": plan_id, "ownerEmail": owner_email, "locations": len(locations),
                            **({"free": free} if free else {}),
                            **({"slugFromPurgedTenant": previous} if previous else {})}))
    try:
        client("dynamodb").transact_write_items(TransactItems=items)
    except ClientError as e:
        if e.response["Error"]["Code"] == "TransactionCanceledException" and \
                cancellation_codes(e)[0] == "ConditionalCheckFailed":
            raise ApiError(409, "slug_taken", "Another customer already uses this slug. Pick another.",
                           fields={"slug": "Already used. Pick another, e.g. with the area: roma-sodermalm."}) from e
        raise

    status = _start_onboarding(tenant_id, profile, run=1)
    out = {"tenantId": tenant_id, "status": status}
    if billing_input.get("startInvoicing"):
        # Invoicing starts right away (the restaurant's first invoice runs
        # from startDate when given). A Stripe hiccup is reported and the
        # Billing tab can start it later; the customer is created either way.
        from .billing import start_for                 # billing imports this module
        try:
            out["billing"] = start_for(tenant_id, get_profile(tenant_id), actor=req.actor,
                                       method=billing_input.get("collectionMethod"),
                                       preference=billing_input.get("collectionPreference"),
                                       start_day=billing_input.get("startDate"), price_sek=billing_input.get("priceSek"),
                                       terms=billing_input["terms"])
        except ApiError as e:
            write_audit(tenant_id, "subscription_start_failed", req.actor, {"error": e.message})
            out["billingError"] = e.message
    return 202, out


def _slug_owner(slug: str | None) -> str | None:
    item = client("dynamodb").get_item(TableName=tenant_table(), ConsistentRead=True,
                                       Key={"PK": {"S": f"SLUG#{slug}"}, "SK": {"S": "TENANT"}}).get("Item") if slug else None
    return item["tenantId"]["S"] if item else None


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
    from .zones import list_zones          # zones imports this module
    return 200, {
        "tenant": public(profile),
        "domains": [{**{k: val for k, val in d.items() if k not in HIDDEN}, "primary": d.get("domain") == primary}
                    for d in domains],
        "zones": list_zones(tenant_id),
        "locations": [{k: val for k, val in loc.items() if k not in HIDDEN} for loc in locations],
        "userCount": users,
        "onboarding": onboarding,
        "audit": [{k: a.get(k) for k in ("action", "by", "at", "details")} for a in audit],
    }


def update_tenant(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    unknown = sorted(set(req.body) - set(EDITABLE) - set(OWNER_EDITABLE))
    if unknown:
        raise ApiError(400, "validation_failed", "Some of this can't be changed here. Reload the page and try again.",
                       fields={k: "Can't be changed here." for k in unknown})
    owner_keys = [k for k in OWNER_EDITABLE if k in req.body]
    if owner_keys:
        status = (get_profile(tenant_id) or {}).get("status")
        if status != "provisioning_failed":
            raise ApiError(409, "validation_failed", "The owner is already invited. Change the owner on the Users tab.",
                           fields={k: "Change it on the Users tab." for k in owner_keys})
    f = v.Fields(req.body)
    fields = _profile_fields(f)
    if "name" in req.body:
        fields["name"] = f.text("name", required=True, max_len=100)
    if "ownerName" in req.body:
        fields["ownerName"] = f.text("ownerName", required=True, max_len=100)
    if "ownerEmail" in req.body:
        fields["ownerEmail"] = f.email("ownerEmail", required=True)
        taken = owner_email_problem(fields["ownerEmail"], tenant_id)
        if taken:
            f.fail("ownerEmail", taken)
    if "ownerPhone" in req.body:
        fields["ownerPhone"] = f.phone("ownerPhone")
    f.done()
    sets, removes, names, values = [], [], {}, {}
    for i, key in enumerate(k for k in EDITABLE + OWNER_EDITABLE if k in req.body):
        names[f"#f{i}"] = key
        if fields.get(key) is None:
            removes.append(f"#f{i}")              # cleared in the form
        else:
            sets.append(f"#f{i} = :v{i}")
            values[f":v{i}"] = to_ddb_value(fields[key])
    if not sets and not removes:
        raise ApiError(400, "validation_failed", "Nothing was changed. Change a field, then save.")
    sets += ["updatedAt = :now", "updatedBy = :by"]
    values.update({":now": {"S": now_iso()}, ":by": {"S": req.actor}})
    expr = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
    try:
        out = client("dynamodb").update_item(
            TableName=tenant_table(), Key=tkey(tenant_id), UpdateExpression=expr,
            ConditionExpression="attribute_exists(PK)", ExpressionAttributeNames=names,
            ExpressionAttributeValues=values, ReturnValues="ALL_NEW")
    except client("dynamodb").exceptions.ConditionalCheckFailedException as e:
        raise not_found("We can't find this customer. Reload the page.") from e
    write_audit(tenant_id, "profile_updated", req.actor, {"fields": sorted(names.values())})
    return 200, {"tenant": public(from_ddb(out["Attributes"]))}


def _day(text) -> date | None:
    try:
        return date.fromisoformat(str(text)[:10]) if text else None
    except ValueError:
        return None


def _start_day(billing_input: dict) -> date | None:
    """The agreement's first day when given (create form), else None = today."""
    return _day(billing_input.get("startDate")) if billing_input.get("startInvoicing") else None


def free_fields(free: dict | None, since: str | None = None, overrides: dict | None = None) -> dict:
    """PROFILE.billing fields of a free period (None values = REMOVE).
    freeLocationsChosen: the operator set the number of locations on Free
    (kept after it, billing._kept_locations), so a number equal to the Free
    plan's own still counts as chosen."""
    if free is None:
        return {"freeUntil": None, "freeThenPlanId": None, "freeSince": None, "freeNoticeFor": None, "freePreset": None,
                "freeLocationsChosen": None}
    return {"freeUntil": free.get("until"), "freeThenPlanId": free.get("thenPlanId") or "starter", "freeSince": since,
            "freePreset": free.get("preset"),
            "freeLocationsChosen": (overrides or {}).get("maxLocations") is not None}


def set_plan(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    f = v.Fields(req.body)
    plan_id = f.text("planId", required=True, max_len=40)
    overrides = _overrides(f)
    force = f.boolean("force") or False
    price_sek = price_field(f)
    profile = get_profile(tenant_id)
    old = (profile.get("billing") or {}) if profile.get("planId") == FREE_PLAN_ID else {}
    since = _day(old.get("freeSince"))
    free = free_input(f, plan_id, current_until=old.get("freeUntil"), start=since,
                      current_preset=old.get("freePreset"))
    price_problem = free_price_problem(free, price_sek)
    if price_problem:
        f.fail("priceSek", price_problem)
    f.done()
    plan = get_plan(plan_id)
    if plan is None:
        raise ApiError(400, "validation_failed", "Unknown plan. Pick one of the listed plans.",
                       fields={"planId": "Unknown plan. Pick one of the listed plans."})
    tenant, subscription = apply_plan(tenant_id, profile, plan, req.actor, overrides=overrides, force=force,
                                      price_sek=price_sek, free=free)
    return 200, {"tenant": tenant, "subscription": subscription}


def apply_plan(tenant_id: str, profile: dict, plan: dict, actor: str, *, overrides: dict | None = None,
               force: bool = False, price_sek: int | None = None, free: dict | None = None,
               expect_free_until: str | None = None, price_from: date | None = None,
               agreement_pending: str | None = None) -> tuple[dict, dict | None]:
    """Sets the plan, its entitlements (plus overrides) and the customer's
    own price; Free also sets its period (`free`), any other plan ends one.
    On Free the own price is the price after it: `price_sek` sets it (the
    next plan's price = none), left out it stays as it is.
    `expect_free_until`: only while the customer is still on that free
    period (the daily switch, so a re-run never switches twice).
    `agreement_pending`: the day an agreement should start from, kept
    until one runs (billing.freeSwitchAgreementPending)."""
    plan_id = plan["planId"]
    is_free = plan_id == FREE_PLAN_ID
    ent = _entitlements(plan, overrides)
    old_billing = profile.get("billing") if isinstance(profile.get("billing"), dict) else {}
    keep_price = is_free and price_sek is None
    price_plan = (get_plan((free or {}).get("thenPlanId") or "starter") or {}) if is_free else plan
    custom_price = price_sek if price_sek is not None and price_sek != price_plan.get("priceSek") else None
    count = int(profile.get("locationCount", 0))
    if ent["maxLocations"] < count and not force:
        raise ApiError(409, "below_location_count",
                       f"The customer has {count} locations, but the new limit is {ent['maxLocations']}. "
                       "Confirm to apply anyway: the locations keep working, but no new ones can be added.",
                       locationCount=count)
    ensure_billing_map(tenant_id)
    values = {":p": {"S": plan_id}, ":n": {"S": now_iso()}, ":b": {"S": actor}}
    names: dict = {}
    ever = _turned_on(ent)
    if isinstance(profile.get("entitlements"), dict):
        # Field by field, so featuresEver is only ever added to (ADD is a set union, safe against concurrent writes).
        values.update({":m": to_ddb_value(ent["maxLocations"]), ":f": to_ddb_value(ent["features"]),
                       ":l": to_ddb_value(ent["limits"])})
        expression = ("SET planId = :p, entitlements.maxLocations = :m, entitlements.features = :f, "
                      "entitlements.limits = :l, updatedAt = :n, updatedBy = :b")
        if ever:
            values[":ever"] = to_ddb_value(ever)
            expression_add = " ADD entitlements.featuresEver :ever"
        else:
            expression_add = ""
    else:
        values[":e"] = to_ddb_value({**ent, **({"featuresEver": ever} if ever else {})})
        expression, expression_add = "SET planId = :p, entitlements = :e, updatedAt = :n, updatedBy = :b", ""
    removes = []
    if custom_price is not None:
        values[":price"] = {"N": str(custom_price)}
        expression += ", billing.priceSek = :price"
    elif not keep_price:
        removes.append("billing.priceSek")
    if agreement_pending:
        values[":pending"] = {"S": agreement_pending}
        expression += ", billing.freeSwitchAgreementPending = :pending"
    was_free = profile.get("planId") == FREE_PLAN_ID
    since = old_billing.get("freeSince") if was_free and old_billing.get("freeSince") else _stockholm_today().isoformat()
    fields = free_fields(free if is_free else None, since, overrides)
    if is_free and old_billing.get("freeNoticeFor") and old_billing.get("freeNoticeFor") != free.get("until"):
        fields["freeNoticeFor"] = None          # a new end date gets its own notice
    for i, (key, val) in enumerate(fields.items()):
        names[f"#fr{i}"] = key
        if val is None:
            removes.append(f"billing.#fr{i}")
        else:
            values[f":fr{i}"] = to_ddb_value(val)
            expression += f", billing.#fr{i} = :fr{i}"
    if removes:
        expression += " REMOVE " + ", ".join(removes)
    expression += expression_add
    condition = "attribute_exists(PK)"
    if expect_free_until:
        condition += " AND planId = :free AND billing.freeUntil = :until"
        values.update({":free": {"S": FREE_PLAN_ID}, ":until": {"S": expect_free_until}})
    out = client("dynamodb").update_item(
        TableName=tenant_table(), Key=tkey(tenant_id), UpdateExpression=expression, ConditionExpression=condition,
        ExpressionAttributeValues=values, ReturnValues="ALL_NEW", **({"ExpressionAttributeNames": names} if names else {}))
    write_audit(tenant_id, "plan_changed", actor, {
        "from": {"planId": profile.get("planId"), "entitlements": profile.get("entitlements"),
                 "priceSek": old_billing.get("priceSek"),
                 **({"freeUntil": old_billing.get("freeUntil")} if was_free else {})},
        "to": {"planId": plan_id, "entitlements": ent,
               "priceSek": old_billing.get("priceSek") if keep_price else custom_price, **({"free": free} if is_free else {})}})
    from .billing import after_plan_change          # billing imports this module
    from .website import stockholm_today
    subscription = after_plan_change(tenant_id, from_ddb(out["Attributes"]), plan, actor,
                                     exact=is_free or was_free, on=price_from or stockholm_today(), before=profile)
    tenant = public(from_ddb(out["Attributes"])) if subscription is None else public(get_profile(tenant_id))
    return tenant, subscription


def ensure_billing_map(tenant_id: str) -> None:
    """PROFILE.billing exists (empty map) so nested fields can be set."""
    client("dynamodb").update_item(
        TableName=tenant_table(), Key=tkey(tenant_id),
        UpdateExpression="SET billing = if_not_exists(billing, :empty)",
        ConditionExpression="attribute_exists(PK)", ExpressionAttributeValues={":empty": {"M": {}}})


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
        raise ApiError(409, "invalid_status", not_while(current),
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


def suspend_tenant(tenant_id: str, actor: str, reason: str | None) -> dict:
    """Block every user of the tenant. Allowed again on a suspended tenant, so
    a run that failed for some users can simply be repeated. Also what the
    dunning task does to a customer whose subscription is long past due."""
    get_profile(tenant_id)
    _set_status(tenant_id, "suspended", ("active", "suspended"), actor)
    # Profile status is left alone on purpose: resume re-enables only users
    # whose profile says active, so people an owner disabled stay disabled.
    n, failed = _cognito_each(tenant_users(tenant_id), "admin_disable_user", "admin_user_global_sign_out")
    write_audit(tenant_id, "suspended", actor, {"usersDisabled": n, "failed": failed, "reason": reason})
    return {"status": "suspended", "usersDisabled": n, "failed": failed}


def resume_tenant(tenant_id: str, actor: str) -> dict:
    get_profile(tenant_id)
    _set_status(tenant_id, "active", ("suspended", "active"), actor)
    users = [u for u in tenant_users(tenant_id) if u.get("status", "active") == "active"]
    n, failed = _cognito_each(users, "admin_enable_user")
    write_audit(tenant_id, "resumed", actor, {"usersEnabled": n, "failed": failed})
    return {"status": "active", "usersEnabled": n, "failed": failed}


def suspend(req) -> tuple[int, dict]:
    return 200, suspend_tenant(req.path["tenantId"], req.actor, _reason(req))


def resume(req) -> tuple[int, dict]:
    return 200, resume_tenant(req.path["tenantId"], req.actor)


def purge_now(req) -> tuple[int, dict]:
    """'Delete customer' on an offboarded tenant (e.g. the customer asked for
    erasure, or won't come back): moves purgeAt to now, so Restore is no
    longer possible, and deletes the website repo right away (site-repo
    "delete"; a refusal is logged and the purge tries again). The
    tenant-purge Lambda (nightly in production) deletes the data on its
    next run."""
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    if req.body.get("confirmSlug") != profile.get("slug"):
        raise ApiError(400, "validation_failed", "Type the customer's slug to confirm, e.g. pizzeria-roma.",
                       fields={"confirmSlug": "This doesn't match the slug. Type it exactly."})
    now = now_iso()
    try:
        client("dynamodb").update_item(
            TableName=tenant_table(), Key=tkey(tenant_id),
            UpdateExpression="SET purgeAt = :n, updatedAt = :n, updatedBy = :b",
            ConditionExpression="#s = :off",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":n": {"S": now}, ":b": {"S": req.actor}, ":off": {"S": "offboarded"}})
    except client("dynamodb").exceptions.ConditionalCheckFailedException as e:
        current = (get_profile(tenant_id) or {}).get("status")
        raise ApiError(409, "invalid_status", f"Only an offboarded customer's data can be deleted. This customer is {status_words(current)}.",
                       currentStatus=current) from e
    write_audit(tenant_id, "purge_requested", req.actor, {"previousPurgeAt": profile.get("purgeAt")})
    out = {"status": "offboarded", "purgeAt": now}
    from . import site                              # site imports this module
    if site.enabled():
        try:
            repo = site.invoke({"action": "delete", "tenantId": tenant_id})
            write_audit(tenant_id, "site_repo_deleted" if repo.get("repoDeleted") else "site_repo_not_deleted",
                        req.actor, {k: repo[k] for k in ("repo", "status", "reason") if repo.get(k)})
            out["repo"] = repo
        except ApiError as e:
            write_audit(tenant_id, "site_repo_delete_failed", req.actor, {"error": e.message})
            out["repoError"] = e.message
    return 202, out


def restore(req) -> tuple[int, dict]:
    return 202, restore_tenant(req.path["tenantId"], req.actor)


def restore_tenant(tenant_id: str, actor: str) -> dict:
    """Undo an offboarding while its data still exists (before purgeAt and
    before Delete customer): active again, users enabled again (those whose
    profile says active), and onboarding re-run, which gives back the
    <slug> subdomain and sets the website repo up again (unarchived, deploy
    role and variables; prod also restores dev's side). Own domains are
    re-added by hand on the Domains tab; billing is restarted on the Billing
    tab."""
    profile = get_profile(tenant_id)
    now = now_iso()
    try:
        client("dynamodb").update_item(
            TableName=tenant_table(), Key=tkey(tenant_id),
            UpdateExpression="SET #s = :active, restoredAt = :n, restoredBy = :b, updatedAt = :n, updatedBy = :b, "
                             "restoreCount = if_not_exists(restoreCount, :zero) + :one REMOVE purgeAt, offboardedAt",
            ConditionExpression="#s = :off AND attribute_not_exists(purgeStartedAt) AND "
                                "(attribute_not_exists(purgeAt) OR purgeAt > :n)",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":active": {"S": "active"}, ":off": {"S": "offboarded"}, ":n": {"S": now},
                                       ":b": {"S": actor}, ":zero": {"N": "0"}, ":one": {"N": "1"}})
    except client("dynamodb").exceptions.ConditionalCheckFailedException as e:
        current = get_profile(tenant_id) or {}
        status = current.get("status")
        why = (f"Only an offboarded customer can be restored. This customer is {status_words(status)}."
               if status != "offboarded" else "Too late: the customer's data is already being deleted.")
        raise ApiError(409, "not_restorable", why, currentStatus=status) from e
    users = [u for u in tenant_users(tenant_id) if u.get("status", "active") == "active"]
    n, failed = _cognito_each(users, "admin_enable_user")
    out = {"status": "active", "usersEnabled": n, "failed": failed}
    run = int(profile.get("onboardingRuns", 1)) + 1
    try:
        _start_onboarding(tenant_id, {**profile, "status": "active"}, run)
    except ApiError as e:
        out["onboardingError"] = e.message           # Retry setup on the page starts it again
    write_audit(tenant_id, "restored", actor, {"usersEnabled": n, "failed": failed, "onboardingRun": run,
                                               "purgeAtWas": profile.get("purgeAt"),
                                               **({"onboardingError": out["onboardingError"]}
                                                  if "onboardingError" in out else {})})
    return out


def offboard(req) -> tuple[int, dict]:
    """'Delete customer': disable users, detach domains, mark offboarded with
    purgeAt = now + the retention days. The data itself is deleted by the
    tenant-purge Lambda once purgeAt has passed (purge_now moves it).

    The status flips to offboarding first (conditional), and the execution
    name is fixed per tenant - a double click or two operators can't start
    two runs, and a request that failed after the flip can be repeated."""
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    if req.body.get("confirmSlug") != profile.get("slug"):
        raise ApiError(400, "validation_failed", "Type the customer's slug to confirm, e.g. pizzeria-roma.",
                       fields={"confirmSlug": "This doesn't match the slug. Type it exactly."})
    if profile.get("status") == "provisioning":
        raise ApiError(409, "invalid_status", "Setup is still running. Wait until it finishes, then try again.",
                       currentStatus="provisioning")
    return 202, offboard_tenant(tenant_id, profile, req.actor)


def offboard_tenant(tenant_id: str, profile: dict, actor: str, reason: str | None = None) -> dict:
    """Offboarding proper: used by the route above and by the daily billing
    task when a cancelled subscription has ended."""
    _set_status(tenant_id, "offboarding", ("active", "suspended", "provisioning_failed", "offboarding"), actor)
    # A running subscription ends now with a final prorated invoice; a Stripe
    # failure is reported and does not stop the offboarding (the Billing tab
    # keeps its Cancel button until the webhook or a retry says canceled).
    from .billing import cancel_for_offboarding       # billing imports this module
    subscription = cancel_for_offboarding(tenant_id, profile, actor)
    # Own domains: the 301s, dev.<domain> and the primary domain go first
    # (the workflow detaches the hosts); a registered domain stays theirs.
    from .own_domains import release_for_offboarding   # own_domains imports this module
    domain_notes = release_for_offboarding(tenant_id, actor)
    sfn = client("stepfunctions")
    restores = int(profile.get("restoreCount", 0))     # one execution name per offboarding
    try:
        sfn.start_execution(
            stateMachineArn=env("OFFBOARDING_STATE_MACHINE_ARN"),
            name=f"offboard-{tenant_id}" + (f"-{restores + 1}" if restores else ""),
            input=json.dumps({"tenantId": tenant_id, "requestedBy": actor}))
    except sfn.exceptions.ExecutionAlreadyExists:
        pass                                    # already running / ran - nothing to do
    details = {k: val for k, val in (("reason", reason), ("domains", domain_notes[:5] or None)) if val}
    write_audit(tenant_id, "offboarding_started", actor, details or None)
    return {"status": "offboarding", "subscription": subscription}


def retry_onboarding(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    status = profile.get("status")
    if status == "provisioning_failed":
        _set_status(tenant_id, "provisioning", ("provisioning_failed",), req.actor)
        profile["status"] = "provisioning"
    elif status != "active":
        raise ApiError(409, "invalid_status", not_while(status), currentStatus=status)
    run = int(profile.get("onboardingRuns", 1)) + 1
    result = _start_onboarding(tenant_id, profile, run)
    write_audit(tenant_id, "onboarding_rerun", req.actor, {"run": run})
    return 202, {"status": result}
