"""platform-tenants Lambda: the single entry point for every /platform/* route
of the operator console (sbs-admin).

API Gateway has already verified the caller: an access token from the
OPERATOR user pool, issued to the sbs-admin app client. This handler is the
authorization check (cognito:groups must contain platform_admin), records
who did what (audit rows) and dispatches on routeKey."""

import json
from dataclasses import dataclass, field

from . import domains, locations, operators, outbox, stripe_connect, tenants, terminal, users
from .core import ApiError, error_body, log, parse_body, respond

ROUTES = {
    "GET /platform/plans": tenants.list_plans,
    "GET /platform/tenants": tenants.list_tenants,
    "POST /platform/tenants": tenants.create_tenant,
    "GET /platform/tenants/{tenantId}": tenants.get_tenant,
    "PATCH /platform/tenants/{tenantId}": tenants.update_tenant,
    "PUT /platform/tenants/{tenantId}/plan": tenants.set_plan,
    "POST /platform/tenants/{tenantId}/suspend": tenants.suspend,
    "POST /platform/tenants/{tenantId}/resume": tenants.resume,
    "POST /platform/tenants/{tenantId}/offboard": tenants.offboard,
    "POST /platform/tenants/{tenantId}/onboarding/retry": tenants.retry_onboarding,
    "GET /platform/tenants/{tenantId}/users": users.list_users,
    "POST /platform/tenants/{tenantId}/owners": users.invite_owner,
    "GET /platform/tenants/{tenantId}/locations": locations.list_locations,
    "POST /platform/tenants/{tenantId}/locations": locations.create_location,
    "PATCH /platform/tenants/{tenantId}/locations/{locationId}": locations.update_location,
    "DELETE /platform/tenants/{tenantId}/locations/{locationId}": locations.delete_location,
    "POST /platform/tenants/{tenantId}/domains": domains.add_domain,
    "DELETE /platform/tenants/{tenantId}/domains/{domain}": domains.remove_domain,
    "POST /platform/tenants/{tenantId}/stripe/account-link": stripe_connect.account_link,
    "POST /platform/tenants/{tenantId}/stripe/sync": stripe_connect.sync_account,
    "GET /platform/tenants/{tenantId}/locations/{locationId}/terminal": terminal.get_terminal,
    "POST /platform/tenants/{tenantId}/locations/{locationId}/terminal": terminal.enable_terminal,
    "PATCH /platform/tenants/{tenantId}/locations/{locationId}/terminal": terminal.update_terminal,
    "POST /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers": terminal.register_reader,
    "DELETE /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers/{readerId}": terminal.remove_reader,
    "GET /platform/operators": operators.list_operators,
    "POST /platform/operators": operators.create_operator,
    "PATCH /platform/operators/{username}": operators.update_operator,
    "DELETE /platform/operators/{username}": operators.delete_operator,
    "POST /platform/operators/{username}/resend-invite": operators.resend_invite,
    "GET /platform/outbox": outbox.list_messages,
    "GET /platform/outbox/{messageId}": outbox.get_message,
}

OPERATOR_GROUP = "platform_admin"


@dataclass
class Request:
    path: dict
    query: dict
    body: dict
    actor: str
    claims: dict = field(default_factory=dict)


def _groups(claims: dict) -> set[str]:
    # HTTP API JWT authorizers pass list claims as a string like "[a b]".
    raw = claims.get("cognito:groups") or ""
    if isinstance(raw, list):
        return set(raw)
    return {g.strip(" ,\"'") for g in raw.strip("[]").replace(",", " ").split() if g.strip(" ,\"'")}


def handler(event, context):
    route = event.get("routeKey", "")
    request_id = getattr(context, "aws_request_id", "-")
    fn = ROUTES.get(route)
    if fn is None:
        return respond(404, {"error": "not_found", "message": f"No route {route}"})
    claims = (((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt") or {}).get("claims") or {}
    if OPERATOR_GROUP not in _groups(claims):
        return respond(403, {"error": "forbidden", "message": "Platform operators only"})
    actor = claims.get("username") or claims.get("sub") or "unknown"
    try:
        req = Request(path=event.get("pathParameters") or {}, query=event.get("queryStringParameters") or {},
                      body=parse_body(event), actor=actor, claims=claims)
        status, body = fn(req)
        log.info(json.dumps({"route": route, "status": status, "actor": actor,
                             "tenantId": req.path.get("tenantId"), "requestId": request_id}))
        return respond(status, body)
    except ApiError as e:
        log.info(json.dumps({"route": route, "status": e.status, "error": e.code, "actor": actor,
                             "requestId": request_id}))
        return respond(e.status, error_body(e))
    except Exception:  # noqa: BLE001 - last line of defence, details only in the logs
        log.exception("unhandled error on %s (request %s)", route, request_id)
        return respond(500, {"error": "internal_error", "message": "Something went wrong", "requestId": request_id})
