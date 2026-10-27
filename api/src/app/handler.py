"""platform-tenants Lambda: the single entry point for every /platform/* route
of the operator console (Booqy Console).

API Gateway has already verified the caller: an access token from the
OPERATOR user pool, issued to the Booqy Console app client. This handler is the
authorization check (cognito:groups must contain platform_admin), records
who did what (audit rows) and dispatches on routeKey."""

import json
from dataclasses import dataclass, field

from . import (billing, domains, finance, locations, mail, operators, outbox, site, stripe_connect, tenants,
               terminal, users, website, zones)
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
    "POST /platform/tenants/{tenantId}/purge": tenants.purge_now,
    "POST /platform/tenants/{tenantId}/onboarding/retry": tenants.retry_onboarding,
    # Website tab: the restaurant's own site repo (site-repo function)
    "GET /platform/tenants/{tenantId}/site": site.get_site,
    "POST /platform/tenants/{tenantId}/site/retry": site.retry,
    "POST /platform/tenants/{tenantId}/site/invite": site.invite,
    "POST /platform/tenants/{tenantId}/site/redeploy": site.redeploy,
    "POST /platform/tenants/{tenantId}/site/archive": site.archive,
    "GET /platform/tenants/{tenantId}/users": users.list_users,
    "POST /platform/tenants/{tenantId}/owners": users.invite_owner,
    "GET /platform/tenants/{tenantId}/locations": locations.list_locations,
    "POST /platform/tenants/{tenantId}/locations": locations.create_location,
    "PATCH /platform/tenants/{tenantId}/locations/{locationId}": locations.update_location,
    "DELETE /platform/tenants/{tenantId}/locations/{locationId}": locations.delete_location,
    "POST /platform/tenants/{tenantId}/domains": domains.add_domain,
    "DELETE /platform/tenants/{tenantId}/domains/{domain}": domains.remove_domain,
    "GET /platform/domains/search": zones.search,
    "GET /platform/domains/dns-scan": zones.dns_scan,
    "POST /platform/tenants/{tenantId}/domains/documents": zones.document_upload,
    "POST /platform/tenants/{tenantId}/domains/registrations": zones.register,
    "POST /platform/tenants/{tenantId}/domains/connections": zones.connect,
    "GET /platform/tenants/{tenantId}/zones/{domain}/document": zones.document_download,
    "GET /platform/tenants/{tenantId}/zones/{domain}/transfer": zones.transfer_check,
    "POST /platform/tenants/{tenantId}/zones/{domain}/transfer": zones.transfer,
    "POST /platform/tenants/{tenantId}/stripe/account-link": stripe_connect.account_link,
    "POST /platform/tenants/{tenantId}/stripe/sync": stripe_connect.sync_account,
    "GET /platform/tenants/{tenantId}/locations/{locationId}/terminal": terminal.get_terminal,
    "POST /platform/tenants/{tenantId}/locations/{locationId}/terminal": terminal.enable_terminal,
    "PATCH /platform/tenants/{tenantId}/locations/{locationId}/terminal": terminal.update_terminal,
    "POST /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers": terminal.register_reader,
    "DELETE /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers/{readerId}": terminal.remove_reader,
    "GET /platform/terminal/readers": terminal.list_all_readers,
    "GET /platform/operators": operators.list_operators,
    "POST /platform/operators": operators.create_operator,
    "PATCH /platform/operators/{username}": operators.update_operator,
    "DELETE /platform/operators/{username}": operators.delete_operator,
    "POST /platform/operators/{username}/resend-invite": operators.resend_invite,
    "GET /platform/outbox": outbox.list_messages,
    "GET /platform/outbox/{messageId}": outbox.get_message,
    # News to the restaurant owners (Mail page): brand template, preview, send
    "GET /platform/mail/template": mail.get_template,
    "PUT /platform/mail/template": mail.put_template,
    "POST /platform/mail/preview": mail.preview,
    "GET /platform/mail/recipients": mail.list_recipients,
    "GET /platform/mail/newsletters": mail.list_newsletters,
    "POST /platform/mail/newsletters": mail.send,
    "GET /platform/mail/newsletters/{newsletterId}": mail.get_newsletter,
    # Finance: subscriptions (Stripe Billing) and the Finance page
    "GET /platform/finance/overview": finance.overview,
    "GET /platform/finance/tenants/{tenantId}": finance.tenant_detail,
    "POST /platform/finance/rebuild": finance.rebuild,
    "POST /platform/finance/stripe-sync": finance.stripe_sync,
    "GET /platform/tenants/{tenantId}/billing": billing.get_billing,
    "POST /platform/tenants/{tenantId}/billing/subscription": billing.start_subscription,
    "PATCH /platform/tenants/{tenantId}/billing/subscription": billing.update_subscription,
    "POST /platform/tenants/{tenantId}/billing/card-link": billing.card_link,
    "POST /platform/tenants/{tenantId}/billing/invoices/{invoiceId}/remind": billing.remind_invoice,
    "POST /platform/tenants/{tenantId}/billing/invoice": billing.invoice_now,
    "GET /platform/finance/invoices": finance.invoices,
    "POST /platform/finance/invoicing": billing.invoicing,
    # Website page: booqy.se's cookieless statistics
    "GET /platform/website": website.overview,
}

OPERATOR_GROUP = "platform_admin"


@dataclass
class Request:
    path: dict
    query: dict
    body: dict
    actor: str
    claims: dict = field(default_factory=dict)
    # The alias this invocation came through - what a send hands its work to.
    function_arn: str | None = None


def _groups(claims: dict) -> set[str]:
    # HTTP API JWT authorizers pass list claims as a string like "[a b]".
    raw = claims.get("cognito:groups") or ""
    if isinstance(raw, list):
        return set(raw)
    return {g.strip(" ,\"'") for g in raw.strip("[]").replace(",", " ").split() if g.strip(" ,\"'")}


def handler(event, context):
    # The domain-provision workflow invokes the function directly (no
    # routeKey, no JWT). API Gateway events always carry a routeKey, and only
    # API Gateway and that workflow's role may invoke this function.
    if "workflowTask" in event and "routeKey" not in event:
        result = zones.workflow_task(event)
        log.info(json.dumps({"workflowTask": event.get("workflowTask"), "domain": event.get("domain"),
                             "tenantId": event.get("tenantId"), "result": result.get("status")}))
        return result
    # A newsletter send the function handed to itself (mail.send); only this
    # function's own role may invoke it.
    if "mailTask" in event and "routeKey" not in event:
        result = mail.mail_task(event, context)
        log.info(json.dumps({"mailTask": event.get("mailTask"), "newsletterId": event.get("newsletterId"),
                             "result": result.get("status")}))
        return result
    # The daily dunning schedule ({"financeTask": "dunning"}) and the monthly
    # invoicing on the 25th ({"financeTask": "invoice"}), both EventBridge
    # Scheduler; only the scheduler role may invoke the function this way.
    if "financeTask" in event and "routeKey" not in event:
        result = billing.finance_task(event, context)
        log.info(json.dumps({"financeTask": event.get("financeTask"), "result": result.get("status")}))
        return result
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
                      body=parse_body(event), actor=actor, claims=claims,
                      function_arn=getattr(context, "invoked_function_arn", None))
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
