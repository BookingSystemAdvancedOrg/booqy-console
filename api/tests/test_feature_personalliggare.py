"""Personalliggare (feature H): the console forwards H9 to the personalliggare
Lambda's platform hook (CONTRACTS.md 9.3) and audits every export."""

import pytest

from conftest import call
from test_feature_scaffold import FakeLambda, _audit

ROUTE = "GET /platform/tenants/{tenantId}/personalliggare/export"
QUERY = {"locationId": "loc-1", "from": "2026-11-01", "to": "2026-11-05"}


@pytest.fixture
def ledger(aws):
    from app import core
    fake = FakeLambda()
    core._clients["lambda"] = fake
    return fake


def test_module_routes_are_the_one_operator_route():
    from app import handler
    from app.features import personalliggare
    assert sorted(personalliggare.ROUTES) == [ROUTE]
    assert all(handler.ROUTES[k] is v for k, v in personalliggare.ROUTES.items())


def test_export_is_forwarded_with_the_query_and_audited(ledger, aws, tenant):
    ledger.answer = {"ok": True, "status": 200, "body": {"chainOk": True, "filename": "x.csv", "format": "csv",
                                                          "content": "seq,kind\r\n", "count": 0}}
    before = _audit(aws, tenant)
    status, body = call(ROUTE, {"tenantId": tenant}, query=QUERY)
    assert status == 200 and body["chainOk"] is True and body["content"].startswith("seq,kind")
    name, payload = ledger.calls[0]
    assert name == "dev-personalliggare:live" and payload["op"] == "personalliggare.export"
    assert payload["tenantId"] == tenant and payload["query"] == QUERY
    assert _audit(aws, tenant) == before + ["staff_ledger_exported"]
    call(ROUTE, {"tenantId": tenant}, query=QUERY)
    assert _audit(aws, tenant).count("staff_ledger_exported") == 2  # one row per call


def test_errors_are_passed_on_and_not_audited(ledger, aws, tenant):
    before = _audit(aws, tenant)
    ledger.answer = {"ok": False, "status": 400, "code": "invalid_range", "field": "from"}
    status, body = call(ROUTE, {"tenantId": tenant}, query={**QUERY, "to": "2026-01-01"})
    assert status == 400 and body["error"] == "invalid_range"
    ledger.answer = {"ok": False, "status": 404, "code": "not_found"}
    assert call(ROUTE, {"tenantId": "nope"}, query=QUERY)[0] == 404
    ledger.raise_code = "ResourceNotFoundException"
    assert call(ROUTE, {"tenantId": tenant}, query=QUERY)[0] == 404
    assert _audit(aws, tenant) == before


def test_only_platform_admins(ledger, tenant):
    assert call(ROUTE, {"tenantId": tenant}, query=QUERY, groups="[owner_user]")[0] in (401, 403)
    assert ledger.calls == []
