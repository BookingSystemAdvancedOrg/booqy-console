"""Meta ads (feature A): the console forwards A14-A17 to the meta-ads
Lambda's platform hook and audits the writes (CONTRACTS.md 9.3)."""

import pytest

from conftest import call
from test_feature_scaffold import FakeLambda, _audit


@pytest.fixture
def meta(aws):
    from app import core
    fake = FakeLambda()
    core._clients["lambda"] = fake
    return fake


def test_module_routes_are_the_four_operator_routes():
    from app import handler
    from app.features import meta_ads
    assert sorted(meta_ads.ROUTES) == ["GET /platform/meta-ads/settings", "GET /platform/tenants/{tenantId}/meta-ads",
                                       "PUT /platform/meta-ads/settings", "PUT /platform/tenants/{tenantId}/meta-ads"]
    assert all(handler.ROUTES[k] is v for k, v in meta_ads.ROUTES.items())


def test_settings_get_and_put_are_forwarded_and_put_is_audited_once_per_write(meta, aws):
    meta.answer = {"ok": True, "status": 200, "body": {"killSwitch": False, "maxMonthlyCapSek": 20000}}
    assert call("GET /platform/meta-ads/settings") == (200, {"killSwitch": False, "maxMonthlyCapSek": 20000})
    name, payload = meta.calls[0]
    assert name == "dev-meta-ads:live" and payload["op"] == "meta-ads.settings.get" and payload["tenantId"] is None
    meta.answer = {"ok": True, "status": 200, "body": {"killSwitch": True, "maxMonthlyCapSek": 5000}}
    status, body = call("PUT /platform/meta-ads/settings", body={"killSwitch": True, "maxMonthlyCapSek": 5000})
    assert status == 200 and body["killSwitch"] is True
    assert meta.calls[-1][1]["body"] == {"killSwitch": True, "maxMonthlyCapSek": 5000}
    assert _audit(aws, "PLATFORM") == ["meta_ads_settings_changed"]


def test_feature_refusal_is_passed_through_with_its_field(meta):
    meta.answer = {"ok": False, "status": 400, "code": "invalid_cap", "field": "maxMonthlyCapSek"}
    status, body = call("PUT /platform/meta-ads/settings", body={"killSwitch": False, "maxMonthlyCapSek": 1})
    assert status == 400 and body["error"] == "invalid_cap" and body["fields"] == {"maxMonthlyCapSek": "invalid_cap"}


def test_tenant_pause_and_get(meta, aws, tenant):
    meta.answer = {"ok": True, "status": 200, "body": {"paused": True}}
    assert call("PUT /platform/tenants/{tenantId}/meta-ads", {"tenantId": tenant}, {"paused": True}) == (
        200, {"paused": True})
    assert meta.calls[-1][1]["tenantId"] == tenant and "meta_ads_paused" in _audit(aws, tenant)
    meta.answer = {"ok": True, "status": 200, "body": {"status": "connected", "paused": True, "spendThisMonthSek": 120}}
    before = _audit(aws, tenant)
    status, body = call("GET /platform/tenants/{tenantId}/meta-ads", {"tenantId": tenant})
    assert status == 200 and body["status"] == "connected" and _audit(aws, tenant) == before


def test_unknown_tenant_and_undeployed_feature(meta, tenant):
    meta.answer = {"ok": False, "status": 404, "code": "not_found"}
    assert call("GET /platform/tenants/{tenantId}/meta-ads", {"tenantId": "nope"})[0] == 404
    meta.raise_code = "ResourceNotFoundException"
    assert call("GET /platform/meta-ads/settings")[0] == 404
