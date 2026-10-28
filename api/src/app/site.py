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

A repo is born in the PROD console. Prod's site-repo reaches dev only
through the dev account's booqy-sites-prod-link role, which may invoke this
function with {"siteTask": {...}} and nothing else (site_task below, dev
only): create or adopt the restaurant's empty dev tenant by slug (its own
onboarding then sets up the dev side of the repo), or archive that side.
"""

import json
import re
from types import SimpleNamespace

from .core import ApiError, client, env, log, query_all, tenant_table, write_audit
from .tenants import create_tenant, get_plan, get_profile

_SLUG = re.compile(r"[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])")
_MIRROR_FIELDS = ("name", "slug", "ownerEmail", "ownerName", "legalName", "orgNumber", "contactEmail",
                  "contactPhone", "address")
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
    return 200, {"enabled": True, **_invoke({"action": "status", "tenantId": tenant_id})}


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
        _, out = create_tenant(SimpleNamespace(body=body, actor=LINK_ACTOR))
        return {"tenantId": out["tenantId"], "status": "created"}
    except ApiError as e:
        return {"error": e.code, "message": str(e)}
