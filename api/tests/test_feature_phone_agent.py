"""Run 0 addendum, phone agent (L): the console side of CONTRACTS.md 2, 9.3 and
OWNERSHIP.md 6.4. The feature module has no routes yet; the four forward ops,
the `phoneAgent` key and the `phoneAgentMinutesPerMonth` limit work through
the generic Run 0 code."""

import pytest

from conftest import call
from test_feature_scaffold import FakeLambda, _audit, _ever, _plan

LIMIT = "phoneAgentMinutesPerMonth"


def test_module_is_merged_with_no_routes():
    from app import handler
    from app.features import MODULES, phone_agent
    assert phone_agent in MODULES and phone_agent.ROUTES == {}
    assert not [r for r in handler.ROUTES if "phone-agent" in r]  # nothing reachable before the feature run


def test_contract_has_key_limit_and_ops():
    from app.contracts import CONSOLE_FORWARD_OPS, FEATURE_KEYS, FEATURE_LABELS_EN, LIMITS
    assert "phoneAgent" in FEATURE_KEYS and FEATURE_LABELS_EN["phoneAgent"] == "Phone agent"
    assert LIMITS[LIMIT] == {"feature": "phoneAgent", "min": 0, "max": 100000, "default": 0}
    ops = {k: v for k, v in CONSOLE_FORWARD_OPS.items() if v["target"] == "phone-agent"}
    assert sorted(ops) == ["phone-agent.settings.get", "phone-agent.settings.put",
                           "phone-agent.tenant.get", "phone-agent.tenant.pause"]


def test_existing_tenant_is_unchanged(aws, tenant):
    ent = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["tenant"]["entitlements"]
    assert "phoneAgent" not in ent["features"] and LIMIT not in ent.get("limits", {})
    ent = _plan(tenant, {"planId": "starter"})[1]["tenant"]["entitlements"]
    assert "phoneAgent" not in ent["features"] and LIMIT not in ent["limits"]
    assert "phoneAgent" not in _ever(tenant)


@pytest.mark.parametrize("value", [-1, 100001, 1.5, True, "300"])
def test_minutes_limit_bounds(aws, tenant, value):
    status, body = _plan(tenant, {"planId": "starter", "overrides": {"limits": {LIMIT: value}}})
    assert status == 400 and f"overrides.limits.{LIMIT}" in body["fields"]


@pytest.mark.parametrize("value", [0, 300, 100000])
def test_minutes_limit_override_and_feature_on(aws, tenant, value):
    status, body = _plan(tenant, {"planId": "starter",
                                  "overrides": {"features": {"phoneAgent": True}, "limits": {LIMIT: value}}})
    assert status == 200, body
    ent = body["tenant"]["entitlements"]
    assert ent["features"]["phoneAgent"] is True and ent["limits"] == {LIMIT: value}
    assert "phoneAgent" in _ever(tenant)


def test_plan_minutes_copied(aws, tenant):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": "PLAN#starter"}, "SK": {"S": "PLAN"}},
                           UpdateExpression="SET limits = :l",
                           ExpressionAttributeValues={":l": {"M": {LIMIT: {"N": "300"}}}})
    plans = {p["planId"]: p for p in call("GET /platform/plans")[1]["plans"]}
    assert plans["starter"]["limits"] == {LIMIT: 300}
    assert _plan(tenant, {"planId": "starter"})[1]["tenant"]["entitlements"]["limits"] == {LIMIT: 300}


@pytest.fixture
def fwd(aws, monkeypatch):
    from app import core, handler
    from app.features import _forward
    fake = FakeLambda()
    core._clients["lambda"] = fake
    routes = {  # the operator routes L15-L18 (CONTRACTS.md 6.L), as the feature run will add them
        "GET /platform/tenants/{tenantId}/phone-agent": _forward.forward("phone-agent", "phone-agent.tenant.get"),
        "PUT /platform/tenants/{tenantId}/phone-agent": _forward.forward("phone-agent", "phone-agent.tenant.pause"),
        "GET /platform/phone-agent/settings": _forward.forward("phone-agent", "phone-agent.settings.get"),
        "PUT /platform/phone-agent/settings": _forward.forward("phone-agent", "phone-agent.settings.put"),
    }
    monkeypatch.setattr(handler, "ROUTES", {**handler.ROUTES, **routes})
    return fake


def test_forward_ops_invoke_phone_agent_and_audit_writes(fwd, aws, tenant):
    p = {"tenantId": tenant}
    before = _audit(aws, tenant)
    fwd.answer = {"ok": True, "status": 200, "body": {"paused": False, "locations": [], "usage": []}}
    assert call("GET /platform/tenants/{tenantId}/phone-agent", p)[0] == 200
    name, payload = fwd.calls[0]
    assert name == "dev-phone-agent:live" and payload["op"] == "phone-agent.tenant.get" and payload["tenantId"] == tenant
    assert _audit(aws, tenant) == before  # reads are not audited

    fwd.answer = {"ok": True, "status": 200, "body": {"paused": True}}
    assert call("PUT /platform/tenants/{tenantId}/phone-agent", p, {"paused": True}) == (200, {"paused": True})
    assert fwd.calls[-1][1]["op"] == "phone-agent.tenant.pause" and fwd.calls[-1][1]["body"] == {"paused": True}
    fwd.answer = {"ok": True, "status": 200, "body": {"paused": False}}
    call("PUT /platform/tenants/{tenantId}/phone-agent", p, {"paused": False})
    assert sorted(a for a in _audit(aws, tenant) if a.startswith("phone_agent")) == ["phone_agent_paused",
                                                                                     "phone_agent_resumed"]

    fwd.answer = {"ok": True, "status": 200, "body": {"killSwitch": False, "maxMinutesCap": 1000}}
    assert call("GET /platform/phone-agent/settings")[0] == 200
    assert fwd.calls[-1][1]["op"] == "phone-agent.settings.get" and fwd.calls[-1][1]["tenantId"] is None
    assert _audit(aws, "PLATFORM") == []
    fwd.answer = {"ok": True, "status": 200, "body": {"killSwitch": True, "maxMinutesCap": 1000}}
    assert call("PUT /platform/phone-agent/settings", body={"killSwitch": True, "maxMinutesCap": 1000})[0] == 200
    assert _audit(aws, "PLATFORM") == ["phone_agent_settings_changed"]


def test_forward_errors_and_undeployed_feature(fwd, aws, tenant):
    fwd.answer = {"ok": False, "status": 400, "code": "invalid_cap", "field": "maxMinutesCap"}
    status, body = call("PUT /platform/phone-agent/settings", body={"maxMinutesCap": -1})
    assert status == 400 and body["fields"] == {"maxMinutesCap": "invalid_cap"}
    assert _audit(aws, "PLATFORM") == []  # refused writes are not audited
    fwd.raise_code = "ResourceNotFoundException"  # Run 0: no phone-agent Lambda is deployed
    assert call("GET /platform/tenants/{tenantId}/phone-agent", {"tenantId": tenant})[0] == 404


def test_forward_refuses_another_features_op():
    from app.features import _forward
    with pytest.raises(ValueError):
        _forward.forward("meta-ads", "phone-agent.tenant.get")
