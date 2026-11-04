"""Google Business Profile (feature D): the console forwards D11 to the
google-business Lambda's platform hook (CONTRACTS.md 9.3); reads are not audited."""

import pytest

from conftest import call
from test_feature_scaffold import FakeLambda, _audit


@pytest.fixture
def gbp(aws):
    from app import core
    fake = FakeLambda()
    core._clients["lambda"] = fake
    return fake


def test_module_routes_are_the_one_operator_route():
    from app import handler
    from app.features import google_business
    assert sorted(google_business.ROUTES) == ["GET /platform/tenants/{tenantId}/google-business"]
    assert all(handler.ROUTES[k] is v for k, v in google_business.ROUTES.items())


def test_tenant_get_is_forwarded_and_not_audited(gbp, aws, tenant):
    gbp.answer = {"ok": True, "status": 200, "body": {"status": "connected", "links": [
        {"locationId": "loc-1", "title": "Bistro", "syncStatus": "ok", "lastSyncAt": "2026-11-04T13:05:00.000Z"}]}}
    before = _audit(aws, tenant)
    status, body = call("GET /platform/tenants/{tenantId}/google-business", {"tenantId": tenant})
    assert status == 200 and body["status"] == "connected" and body["links"][0]["locationId"] == "loc-1"
    name, payload = gbp.calls[0]
    assert name == "dev-google-business:live" and payload["op"] == "google-business.tenant.get"
    assert payload["tenantId"] == tenant and _audit(aws, tenant) == before


def test_unknown_tenant_and_undeployed_feature(gbp, tenant):
    gbp.answer = {"ok": False, "status": 404, "code": "not_found"}
    assert call("GET /platform/tenants/{tenantId}/google-business", {"tenantId": "nope"})[0] == 404
    gbp.raise_code = "ResourceNotFoundException"
    assert call("GET /platform/tenants/{tenantId}/google-business", {"tenantId": tenant})[0] == 404
