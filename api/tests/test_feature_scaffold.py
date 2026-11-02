"""Run 0 scaffolding: feature keys and limits on plans and overrides,
feature route merge and the platform-hook forward (CONTRACTS.md 2, 9.3)."""

import io
import json
import types

import pytest
from botocore.exceptions import ClientError

from conftest import call


def _plan(p, body):
    return call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": p}, body)


def test_unknown_feature_key_is_refused(aws, tenant):
    status, body = _plan(tenant, {"planId": "starter", "overrides": {"features": {"nope": True}}})
    assert status == 400 and "overrides.features" in body["fields"]
    status, body = _plan(tenant, {"planId": "starter", "overrides": {"features": {"metaAds": True}}})
    assert status == 200 and body["tenant"]["entitlements"]["features"]["metaAds"] is True


@pytest.mark.parametrize("value", [-1, 1001, 2.5, True, "3"])
def test_limit_bounds(aws, tenant, value):
    status, body = _plan(tenant, {"planId": "starter", "overrides": {"limits": {"siteBuilderAiEditsPerMonth": value}}})
    assert status == 400 and "overrides.limits.siteBuilderAiEditsPerMonth" in body["fields"]


def test_unknown_limit_and_bad_shape(aws, tenant):
    assert "overrides.limits.other" in _plan(tenant, {"planId": "starter", "overrides": {"limits": {"other": 1}}})[1]["fields"]
    assert "overrides.limits" in _plan(tenant, {"planId": "starter", "overrides": {"limits": [1]}})[1]["fields"]


def test_plan_limits_copied_and_overridden(aws, tenant):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": "PLAN#starter"}, "SK": {"S": "PLAN"}},
                           UpdateExpression="SET limits = :l",
                           ExpressionAttributeValues={":l": {"M": {"siteBuilderAiEditsPerMonth": {"N": "10"}}}})
    plans = {p["planId"]: p for p in call("GET /platform/plans")[1]["plans"]}
    assert plans["starter"]["limits"] == {"siteBuilderAiEditsPerMonth": 10} and plans["growth"]["limits"] == {}
    assert _plan(tenant, {"planId": "starter"})[1]["tenant"]["entitlements"]["limits"] == {"siteBuilderAiEditsPerMonth": 10}
    body = _plan(tenant, {"planId": "starter", "overrides": {"limits": {"siteBuilderAiEditsPerMonth": 1000}}})[1]
    assert body["tenant"]["entitlements"]["limits"] == {"siteBuilderAiEditsPerMonth": 1000}
    body = _plan(tenant, {"planId": "growth", "overrides": {"limits": {"siteBuilderAiEditsPerMonth": 0}}})[1]
    assert body["tenant"]["entitlements"]["limits"] == {"siteBuilderAiEditsPerMonth": 0}


def test_feature_routes_merge_and_refuse_duplicates():
    from app import handler
    ok = types.SimpleNamespace(__name__="f", ROUTES={"GET /platform/x": len})
    assert handler.merge_routes({"GET /a": abs}, [ok]) == {"GET /a": abs, "GET /platform/x": len}
    dup = types.SimpleNamespace(__name__="f", ROUTES={"GET /platform/plans": len})
    with pytest.raises(RuntimeError, match="duplicate route GET /platform/plans"):
        handler.merge_routes(handler.ROUTES, [dup])


class FakeLambda:
    def __init__(self, answer=None, error=None, raise_code=None):
        self.answer, self.error, self.raise_code, self.calls = answer, error, raise_code, []

    def invoke(self, FunctionName, InvocationType, Payload):
        self.calls.append((FunctionName, json.loads(Payload)))
        if self.raise_code:
            raise ClientError({"Error": {"Code": self.raise_code}}, "Invoke")
        out = {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(self.answer).encode())}
        if self.error:
            out["FunctionError"] = "Unhandled"
        return out


@pytest.fixture
def fwd(aws, monkeypatch):
    from app import core, handler
    from app.features import _forward
    fake = FakeLambda()
    core._clients["lambda"] = fake
    routes = {
        "PUT /platform/tenants/{tenantId}/meta-ads": _forward.forward("meta-ads", "meta-ads.tenant.pause"),
        "GET /platform/tenants/{tenantId}/meta-ads": _forward.forward("meta-ads", "meta-ads.tenant.get"),
        "PUT /platform/meta-ads/settings": _forward.forward("meta-ads", "meta-ads.settings.put"),
    }
    monkeypatch.setattr(handler, "ROUTES", {**handler.ROUTES, **routes})
    return fake


def _audit(aws, tenant_id):
    items = aws["ddb"].query(TableName="dev-tenant", KeyConditionExpression="PK = :p AND begins_with(SK, :a)",
                             ExpressionAttributeValues={":p": {"S": f"TENANT#{tenant_id}"}, ":a": {"S": "AUDIT#"}})["Items"]
    return [i["action"]["S"] for i in items]


def test_forward_invokes_feature_and_audits_writes(fwd, aws, tenant):
    fwd.answer = {"ok": True, "status": 200, "body": {"paused": True}}
    status, body = call("PUT /platform/tenants/{tenantId}/meta-ads", {"tenantId": tenant}, {"paused": True})
    assert (status, body) == (200, {"paused": True})
    name, payload = fwd.calls[0]
    assert name == "dev-meta-ads:live"
    assert payload == {"hook": "platform", "hookVersion": 1, "tenantId": tenant, "op": "meta-ads.tenant.pause",
                       "body": {"paused": True}, "query": {}, "operator": {"sub": None, "email": None}}
    fwd.answer = {"ok": True, "status": 200, "body": {"paused": False}}
    call("PUT /platform/tenants/{tenantId}/meta-ads", {"tenantId": tenant}, {"paused": False})
    assert {"meta_ads_paused", "meta_ads_resumed"} <= set(_audit(aws, tenant))

    before = _audit(aws, tenant)
    fwd.answer = {"ok": True, "status": 200, "body": {"status": "connected"}}
    assert call("GET /platform/tenants/{tenantId}/meta-ads", {"tenantId": tenant})[0] == 200
    assert _audit(aws, tenant) == before  # reads are not audited

    fwd.answer = {"ok": True, "status": 200, "body": {"killSwitch": True}}
    assert call("PUT /platform/meta-ads/settings", body={"killSwitch": True, "maxMonthlyCapSek": 500})[0] == 200
    assert _audit(aws, "PLATFORM") == ["meta_ads_settings_changed"]


def test_forward_maps_errors(fwd, aws, tenant, monkeypatch):
    p = {"tenantId": tenant}
    fwd.answer = {"ok": False, "status": 404, "code": "not_found"}
    assert call("GET /platform/tenants/{tenantId}/meta-ads", p)[0] == 404
    fwd.answer = {"ok": False, "status": 400, "code": "invalid_cap", "field": "maxMonthlyCapSek"}
    status, body = call("PUT /platform/meta-ads/settings", body={"maxMonthlyCapSek": -1})
    assert status == 400 and body["error"] == "invalid_cap" and body["fields"] == {"maxMonthlyCapSek": "invalid_cap"}
    assert _audit(aws, "PLATFORM") == []  # refused writes are not audited
    fwd.answer, fwd.error = {"errorMessage": "boom"}, True
    assert call("GET /platform/tenants/{tenantId}/meta-ads", p)[0] == 503
    fwd.error, fwd.raise_code = False, "ResourceNotFoundException"
    assert call("GET /platform/tenants/{tenantId}/meta-ads", p)[0] == 404
    monkeypatch.setenv("ENVIRONMENT", "prod")
    fwd.raise_code, fwd.answer = None, {"ok": True, "status": 200, "body": {}}
    call("GET /platform/tenants/{tenantId}/meta-ads", p)
    assert fwd.calls[-1][0] == "meta-ads:live"


def test_forward_refuses_wrong_target():
    from app.features import _forward
    with pytest.raises(ValueError):
        _forward.forward("site-builder", "meta-ads.tenant.get")


def _ever(tenant_id):
    return call("GET /platform/tenants/{tenantId}", {"tenantId": tenant_id})[1]["tenant"]["entitlements"].get("featuresEver", [])


def test_features_ever_only_grows(aws, tenant):
    assert sorted(_ever(tenant)) == ["ordering", "reservations"]          # stamped at create from the plan
    body = _plan(tenant, {"planId": "starter", "overrides": {"features": {"giftCards": True}}})[1]
    assert sorted(body["tenant"]["entitlements"]["featuresEver"]) == ["giftCards", "ordering", "reservations"]
    _plan(tenant, {"planId": "starter", "overrides": {"features": {"giftCards": False}}})
    assert "giftCards" in _ever(tenant)                                       # turning off keeps it
    _plan(tenant, {"planId": "growth"})
    assert sorted(_ever(tenant)) == ["catering", "giftCards", "ordering", "reservations"]  # plan change keeps earlier keys
    _plan(tenant, {"planId": "starter", "overrides": {"features": {"reservations": False, "ordering": False}}})
    assert sorted(_ever(tenant)) == ["catering", "giftCards", "ordering", "reservations"]  # nothing on: unchanged


def test_create_with_overrides_stamps_them(aws):
    from conftest import NEW_TENANT
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "ever-place",
                                                        "overrides": {"features": {"waitlist": True, "ordering": False}}})
    assert status == 202, body
    assert sorted(_ever(body["tenantId"])) == ["reservations", "waitlist"]


def test_plan_change_on_a_row_without_entitlements(aws, tenant):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="REMOVE entitlements")
    _plan(tenant, {"planId": "starter", "overrides": {"features": {"metaAds": True}}})
    assert sorted(_ever(tenant)) == ["metaAds", "ordering", "reservations"]
