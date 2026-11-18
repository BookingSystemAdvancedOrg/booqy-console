"""Audit finding 14: prod's site link role (booqy-sites-prod-link) invokes dev
platform-tenants without the live qualifier and is meant for site tasks only.
Every real entry point (API Gateway, the schedules, the domain-provision
workflow, the newsletter hand-over) goes through the live alias, so an
unqualified (or $LATEST) invoke may only carry a site task."""

import json
from types import SimpleNamespace

import pytest

from app import handler as h

FN = "arn:aws:lambda:eu-north-1:123456789012:function:dev-platform-tenants"
LIVE = SimpleNamespace(invoked_function_arn=FN + ":live", aws_request_id="r-live")
VERSION = SimpleNamespace(invoked_function_arn=FN + ":42", aws_request_id="r-v42")
UNQUALIFIED = SimpleNamespace(invoked_function_arn=FN, aws_request_id="r-unq")
LATEST = SimpleNamespace(invoked_function_arn=FN + ":$LATEST", aws_request_id="r-latest")

ROUTE = "GET /platform/tenants"
API_EVENT = {
    "routeKey": ROUTE,
    "requestContext": {"authorizer": {"jwt": {"claims": {"username": "op", "cognito:groups": "[platform_admin]"}}}},
}


@pytest.fixture
def spies(monkeypatch):
    calls = []
    monkeypatch.setitem(h.ROUTES, ROUTE, lambda req: calls.append(("route", req.actor)) or (200, {"ok": True}))
    monkeypatch.setattr(h.site, "site_task", lambda event, function_arn=None: calls.append(("site", event)) or {"status": "done"})
    monkeypatch.setattr(h.billing, "finance_task", lambda event, ctx: calls.append(("finance", event)) or {"status": "done"})
    monkeypatch.setattr(h.own_domains, "workflow_task", lambda event: calls.append(("workflow", event)) or {"status": "done"})
    monkeypatch.setattr(h.mail, "mail_task", lambda event, ctx: calls.append(("mail", event)) or {"status": "sent"})
    monkeypatch.setattr(h.own_domains, "health_task", lambda event: calls.append(("domain", event)) or {"status": "done"})
    return calls


def test_a_qualified_api_call_behaves_as_today(spies):
    for ctx in (LIVE, VERSION):
        out = h.handler(API_EVENT, ctx)
        assert out["statusCode"] == 200 and json.loads(out["body"]) == {"ok": True}
    assert spies == [("route", "op"), ("route", "op")]


def test_qualified_tasks_behave_as_today(spies):
    assert h.handler({"financeTask": "invoice"}, LIVE) == {"status": "done"}
    assert h.handler({"workflowTask": "mark", "domain": "x.se"}, LIVE) == {"status": "done"}
    assert h.handler({"siteTask": {"action": "status", "slug": "roma"}}, LIVE) == {"status": "done"}
    assert h.handler({"mailTask": "send", "newsletterId": "n1"}, LIVE) == {"status": "sent"}
    assert h.handler({"domainTask": "health"}, LIVE) == {"status": "done"}
    assert [c[0] for c in spies] == ["finance", "workflow", "site", "mail", "domain"]


def test_an_unqualified_site_task_runs(spies):
    task = {"siteTask": {"action": "status", "slug": "roma"}}
    assert h.handler(task, UNQUALIFIED) == {"status": "done"}
    assert h.handler(task, LATEST) == {"status": "done"}
    assert spies == [("site", task), ("site", task)]


def test_an_unqualified_api_event_with_operator_claims_is_refused(spies):
    for ctx in (UNQUALIFIED, LATEST):
        assert h.handler(API_EVENT, ctx) == {"error": "forbidden", "message": "Site tasks only"}
    assert spies == []


@pytest.mark.parametrize("event", [
    {"financeTask": "invoice"},
    {"financeTask": "migrate_to_advance", "dryRun": False},
    {"workflowTask": "mark", "domain": "x.se"},
    {"mailTask": "send", "newsletterId": "n1"},
    {"domainTask": "health"},
    {"twinTask": {"tenantId": "t1"}},   # the dev twin seed runs only through the live alias
    {"siteTask": {"action": "status", "slug": "roma"}, "financeTask": "invoice"},
    {"siteTask": {"action": "status", "slug": "roma"}, "routeKey": ROUTE},
    {},
])
def test_unqualified_non_site_tasks_are_refused(spies, event):
    assert h.handler(event, UNQUALIFIED) == {"error": "forbidden", "message": "Site tasks only"}
    assert spies == []


def test_a_local_call_without_a_context_is_not_guarded(spies):
    # Tests and local runs call handler(event, None); only a real Lambda
    # context carries invoked_function_arn.
    assert h.handler({"financeTask": "invoice"}, None) == {"status": "done"}
