"""Website tab of a customer: the restaurant's own site repo site-<slug>.

Every call goes to the site-repo function (it holds the GitHub App key; this
function never sees it). The repo itself is created by onboarding; Retry
runs that step again.

    GET  /platform/tenants/{tenantId}/site            repo, status, last dev/prod deploy, booqy.json values
    POST /platform/tenants/{tenantId}/site/retry      set the site up again (async; poll GET)
    POST /platform/tenants/{tenantId}/site/invite     {username}: write access to this repo only
    POST /platform/tenants/{tenantId}/site/redeploy   deploy this environment's branch again
    POST /platform/tenants/{tenantId}/site/archive    {confirmSlug}: this environment's role and
                                                      variables go; the repo is archived, never deleted
    POST /platform/tenants/{tenantId}/site/mount      {environment: prod | dev}: put the restaurant's
                                                      verified own domain on that environment's site (prod only)

Where each environment's site answers (GET's "hosting"): always on its slug
address, <slug>.booqy.se / <slug>.dev.booqy.se (the shared multi-tenant
distribution, made by onboarding), so a site never needs an own domain to
go live. Once the restaurant's own domain is verified in prod (Domains tab),
Mount puts it on the site through the normal domain-attach workflow of that
environment: prod www.<domain> (the Domains tab usually did this already),
dev dev.<domain>. A hostname can live on only one CloudFront distribution in
the world, hence dev.<domain> in dev: when Booqy runs the domain's DNS, Mount
writes its CNAME; otherwise the restaurant adds it. The slug address keeps
working. With per_tenant_sites off in an environment, every hostname there
serves the shared customer-front-end build instead of the repo's site.

A repo is born in the PROD console. Prod's site-repo reaches dev only
through the dev account's booqy-sites-prod-link role, which may invoke this
function with {"siteTask": {...}} and nothing else (site_task below, dev
only): create or adopt the restaurant's empty dev tenant by slug (its own
onboarding then sets up the dev side of the repo), or archive that side.
"""

import json
import re
from types import SimpleNamespace

from . import domains
from . import validation as v
from .core import ApiError, client, env, from_ddb, log, query_all, tenant_table, write_audit
from .tenants import create_tenant, get_plan, get_profile

_SLUG = re.compile(r"[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])")
_MIRROR_FIELDS = ("name", "slug", "ownerEmail", "ownerName", "legalName", "orgNumber", "contactEmail",
                  "contactPhone", "address")
_OPTIONAL_MIRROR_FIELDS = ("legalName", "orgNumber", "contactEmail", "contactPhone", "address")
LINK_ACTOR = "prod-site-repo"


def _enabled() -> bool:
    return env("SITE_REPOS_ENABLED", "false") == "true"


def _invoke(payload: dict, *, wait: bool = True) -> dict:
    response = client("lambda").invoke(
        FunctionName=env("SITE_REPO_FUNCTION_ARN"), InvocationType="RequestResponse" if wait else "Event",
        Payload=json.dumps(payload).encode("utf-8"))
    if not wait:
        return {}
    body = json.loads(response["Payload"].read() or b"{}")
    if response.get("FunctionError"):
        message = str(body.get("errorMessage") or "The site repo function failed")[:500]
        log.info(json.dumps({"siteRepoError": message, "action": payload.get("action")}))
        if message == "not a GitHub username":
            raise ApiError(400, "validation_failed", "Not a GitHub username", fields={"username": "Not a GitHub username"})
        raise ApiError(502, "site_repo_failed", message)
    return body


def _require(tenant_id: str) -> dict:
    profile = get_profile(tenant_id)
    if not _enabled():
        raise ApiError(409, "site_repos_off", "Site repos are not switched on in this environment yet")
    return profile


def get_site(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    get_profile(tenant_id)
    if not _enabled():
        return 200, {"enabled": False}
    return 200, {"enabled": True, **_invoke({"action": "status", "tenantId": tenant_id}),
                 "hosting": hosting(tenant_id, get_profile(tenant_id))}


def retry(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    profile = _require(tenant_id)
    if profile.get("status") not in ("active", "suspended"):
        raise ApiError(409, "invalid_status", f"Not possible while the customer is {profile.get('status')}",
                       currentStatus=profile.get("status"))
    _invoke({"action": "provision", "tenantId": tenant_id}, wait=False)
    write_audit(tenant_id, "site_setup_rerun", req.actor)
    return 202, {"status": "creating"}


def invite(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    _require(tenant_id)
    username = req.body.get("username")
    if not isinstance(username, str) or not username.strip():
        raise ApiError(400, "validation_failed", "Enter a GitHub username", fields={"username": "Required"})
    result = _invoke({"action": "invite", "tenantId": tenant_id, "username": username.strip()})
    write_audit(tenant_id, "site_access_granted", req.actor, {"username": result.get("username")})
    return 200, result


def redeploy(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    _require(tenant_id)
    result = _invoke({"action": "redeploy", "tenantId": tenant_id})
    write_audit(tenant_id, "site_redeployed", req.actor, {"branch": result.get("branch")})
    return 202, result


def archive(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    profile = _require(tenant_id)
    if req.body.get("confirmSlug") != profile.get("slug"):
        raise ApiError(400, "validation_failed", "Type the customer's slug to confirm",
                       fields={"confirmSlug": "Does not match"})
    result = _invoke({"action": "archive", "tenantId": tenant_id})
    write_audit(tenant_id, "site_archived", req.actor, {"repoArchived": result.get("repoArchived")})
    return 200, result


# ------------------------------------------------------------------- hosting
_LIVE, _RETRYABLE = "active", ("failed", "validation_timeout")


def _rows(tenant_id: str, prefix: str) -> list[dict]:
    return query_all(TableName=tenant_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :s)",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":s": {"S": prefix}})


def _own_domain(tenant_id: str, profile: dict) -> tuple[str | None, str | None, dict | None]:
    """(host in this environment, the dev host, the zone when Booqy runs its
    DNS). Booqy's zones put the site on www.<domain>; a bare CNAME is the
    host the operator added (the primary one first)."""
    zone = next((z for z in _rows(tenant_id, "ZONE#") if z.get("status") in ("attaching", "live")), None)
    custom = [r["domain"] for r in _rows(tenant_id, "DOMAIN#")
              if r.get("kind") == "custom" and r.get("status") != "removing"]
    if zone:
        return f"www.{zone['domain']}", f"dev.{zone['domain']}", zone
    if not custom:
        return None, None, None
    host = profile.get("primaryDomain") if profile.get("primaryDomain") in custom else \
        next((h for h in custom if h.startswith("www.")), custom[0])
    return host, f"dev.{host.removeprefix('www.')}", None


def _entry(tenant_id: str, host: str | None) -> dict:
    """One environment's row, from this environment's own tables."""
    slug_row = next((r for r in _rows(tenant_id, "DOMAIN#") if r.get("kind") == "platform"), None)
    row = from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), ConsistentRead=True,
        Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"DOMAIN#{host}"}}).get("Item")) if host else None
    status = (row or {}).get("status")
    state = ("slug_only" if not host else "not_mounted" if not row else "live" if status == _LIVE
             else "failed" if status in _RETRYABLE else "attaching")
    return {"slugUrl": f"https://{slug_row['domain']}" if slug_row else None, "host": host, "state": state,
            "status": status, "lastError": (row or {}).get("lastError"),
            "cnameTarget": env("TENANT_DOMAIN_CNAME_TARGET", "")}


def hosting(tenant_id: str, profile: dict) -> dict:
    """Both environments in prod (dev's row through site-repo and the dev
    link), this one only in dev."""
    here = env("ENVIRONMENT")
    host, dev_host, zone = _own_domain(tenant_id, profile)
    if here != "prod":
        return {here: _entry(tenant_id, host)}
    prod = _entry(tenant_id, host)
    prod["canMount"] = prod["state"] in ("not_mounted", "failed")
    prod["dnsByBooqy"] = bool(zone)
    try:
        dev = _invoke({"action": "devDomain", "op": "status", "tenantId": tenant_id,
                       **({"host": dev_host} if prod["state"] == "live" else {})})
    except ApiError as e:
        dev = {"state": "unknown", "lastError": e.message}
    dev["dnsByBooqy"] = bool(zone)
    dev["canMount"] = prod["state"] == "live" and dev.get("state") in ("not_mounted", "failed")
    if prod["state"] != "live":
        dev["waitsFor"] = host           # dev.<domain> only after the own domain is live in prod
    return {"prod": prod, "dev": dev}


def mount(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    profile = _require(tenant_id)
    target = req.body.get("environment")
    if env("ENVIRONMENT") != "prod":
        raise ApiError(409, "managed_from_prod", "Domains are mounted from the production console")
    if target not in ("prod", "dev"):
        raise ApiError(400, "validation_failed", "environment must be prod or dev",
                       fields={"environment": "prod or dev"})
    host, dev_host, zone = _own_domain(tenant_id, profile)
    if not host:
        raise ApiError(409, "no_own_domain", "Add the restaurant's own domain on the Domains tab first")
    if target == "prod":
        domains.start_attach(tenant_id, host, req.actor)
    else:
        if _entry(tenant_id, host)["state"] != "live":
            raise ApiError(409, "own_domain_not_live", f"{host} is not live in production yet")
        dev = _invoke({"action": "devDomain", "op": "mount", "tenantId": tenant_id, "host": dev_host})
        if zone and dev.get("cnameTarget"):
            # Booqy runs this domain's DNS: the restaurant has nothing to add.
            client("route53").change_resource_record_sets(HostedZoneId=zone["hostedZoneId"], ChangeBatch={
                "Comment": "Restaurant dev site (Booqy)", "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
                    "Name": dev_host, "Type": "CNAME", "TTL": 300, "ResourceRecords": [{"Value": dev["cnameTarget"]}]}}]})
    write_audit(tenant_id, "site_domain_mounted", req.actor,
                {"environment": target, "domain": host if target == "prod" else dev_host})
    return 202, {"hosting": hosting(tenant_id, get_profile(tenant_id))}


def _domain_task(tenant_id: str | None, task: dict) -> dict:
    """Dev side of the prod Website tab's dev row: status, or mount (dev's
    own domain-attach for dev.<domain>)."""
    if not tenant_id:
        return {"error": "not_found", "message": f"No dev customer {task.get('slug')} yet"}
    host = task.get("host")
    if host is not None:
        host = v.hostname(host)
        domains.check_custom_host(host)
    if task.get("op") == "mount":
        if not host:
            return {"error": "validation_failed", "message": "host missing"}
        domains.start_attach(tenant_id, host, LINK_ACTOR)
    elif task.get("op") != "status":
        return {"error": "validation_failed", "message": "unknown domain op"}
    return _entry(tenant_id, host)


def _tenant_by_slug(slug: str) -> str | None:
    item = client("dynamodb").get_item(TableName=tenant_table(), Key={"PK": {"S": f"SLUG#{slug}"}, "SK": {"S": "TENANT"}},
                                       ConsistentRead=True).get("Item")
    return item["tenantId"]["S"] if item else None


def _dev_plan(plan_id: str | None) -> str:
    if plan_id and get_plan(plan_id):
        return plan_id
    plans = query_all(TableName=tenant_table(), IndexName="GSI1", KeyConditionExpression="GSI1PK = :p",
                      ExpressionAttributeValues={":p": {"S": "PLAN"}})
    if not plans:
        raise ApiError(409, "no_plans", "No plans in dev")
    return sorted(p["planId"] for p in plans)[-1]


def site_task(event: dict) -> dict:
    """Prod -> dev (the booqy-sites-prod-link role). Never in prod."""
    if env("ENVIRONMENT") == "prod":
        return {"error": "refused", "message": "Site tasks only run in dev"}
    task = event.get("siteTask") if isinstance(event.get("siteTask"), dict) else {}
    slug = task.get("slug")
    if not isinstance(slug, str) or not _SLUG.fullmatch(slug):
        return {"error": "validation_failed", "message": "slug missing or invalid"}
    tenant_id = _tenant_by_slug(slug)
    try:
        if task.get("action") == "archive":
            if not tenant_id:
                return {"status": "none"}
            return {"tenantId": tenant_id, **_invoke({"action": "archive", "tenantId": tenant_id})}
        if task.get("action") == "domain":
            return _domain_task(tenant_id, task)
        if task.get("action") != "mirror":
            return {"error": "validation_failed", "message": "unknown site task"}
        if tenant_id:
            # The same restaurant already has a dev tenant: keep its test data,
            # set up the dev side of the repo now (provision is idempotent).
            status = get_profile(tenant_id).get("status")
            if status in ("offboarding", "offboarded", "purged"):
                return {"error": "invalid_status", "message": f"The dev customer {slug} is {status}"}
            if status in ("active", "suspended"):
                _invoke({"action": "provision", "tenantId": tenant_id}, wait=False)
            write_audit(tenant_id, "site_linked_from_prod", LINK_ACTOR, {"prodTenantId": task.get("prodTenantId")})
            return {"tenantId": tenant_id, "status": "adopted"}
        body = {k: task[k] for k in _MIRROR_FIELDS if task.get(k) not in (None, "")}
        body["planId"] = _dev_plan(task.get("planId"))
        return _create_mirror(body, slug)
    except ApiError as e:
        fields = e.extra.get("fields") or {}
        detail = "; ".join(f"{k}: {msg}" for k, msg in fields.items())
        return {"error": e.code, "message": f"{e} ({detail})" if detail else str(e)}


def _create_mirror(body: dict, slug: str) -> dict:
    """create_tenant, once more if it refuses a field: the owner's address
    usually already signs in to another dev customer (one login, one
    tenant), so the dev invitation goes to <local>+<slug>@<domain>, the same
    mailbox with most providers; an optional field dev refuses is left out
    (no data is needed in dev). A missing domain is never the problem here."""
    try:
        _, out = create_tenant(SimpleNamespace(body=body, actor=LINK_ACTOR))
    except ApiError as e:
        fields = {k.split(".")[0] for k in (e.extra.get("fields") or {})}
        if e.code != "validation_failed" or not fields or fields - {"ownerEmail", *_OPTIONAL_MIRROR_FIELDS}:
            raise
        body = {k: val for k, val in body.items() if k not in fields - {"ownerEmail"}}
        if "ownerEmail" in fields:
            local, _, domain = body["ownerEmail"].partition("@")
            body["ownerEmail"] = f"{local.split('+')[0]}+{slug}@{domain}"
        _, out = create_tenant(SimpleNamespace(body=body, actor=LINK_ACTOR))
        log.info(json.dumps({"siteTask": "mirror", "slug": slug, "adjusted": sorted(fields)}))
    return {"tenantId": out["tenantId"], "status": "created"}
