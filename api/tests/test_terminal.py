import pytest

from conftest import call

LOC = {"line1": "Götgatan 10", "postalCode": "118 46", "city": "Stockholm"}


@pytest.fixture
def stripe(monkeypatch):
    """Fake Stripe: records calls, keeps readers per terminal location."""
    from app import stripe_connect, terminal
    state = {"calls": [], "charges_enabled": True, "readers": {}, "n": 0}

    def fake(method, path, params=None, *, account=None, idempotency_key=None):
        state["calls"].append((method, path, params, account))
        if path.startswith("/accounts/"):
            return {"id": path.split("/")[-1], "charges_enabled": state["charges_enabled"]}
        if method == "POST" and path == "/terminal/locations":
            return {"id": "tml_123", "display_name": params["display_name"]}
        if method == "POST" and path.startswith("/terminal/locations/"):
            return {"id": path.split("/")[-1]}
        if method == "GET" and path == "/terminal/readers":
            return {"data": state["readers"].get(params["location"], [])}
        if method == "POST" and path == "/terminal/readers":
            if params["registration_code"] == "bad":
                from app.core import ApiError
                raise ApiError(502, "stripe_error", "Stripe: invalid registration code", stripeStatus=400)
            state["n"] += 1
            r = {"id": f"tmr_{state['n']}", "label": params["label"], "device_type": "simulated_wisepos_e",
                 "status": "online", "location": params["location"]}
            state["readers"].setdefault(params["location"], []).append(r)
            return r
        if method == "DELETE" and path.startswith("/terminal/readers/"):
            rid = path.split("/")[-1]
            for lst in state["readers"].values():
                lst[:] = [r for r in lst if r["id"] != rid]
            return {"id": rid, "deleted": True}
        if method == "DELETE" and path.startswith("/terminal/locations/"):
            return {"id": path.split("/")[-1], "deleted": True}
        raise AssertionError(f"unexpected Stripe call {method} {path}")

    monkeypatch.setattr(stripe_connect, "stripe_request", fake)
    monkeypatch.setattr(terminal, "stripe_request", fake)
    return state


def _ready(aws, tenant, terminal_feature=True, account="acct_123456"):
    aws["ddb"].update_item(
        TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
        UpdateExpression="SET stripe = :s, entitlements.features.terminal = :t, #st = :a",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":s": {"M": {"accountId": {"S": account}}}, ":t": {"BOOL": terminal_feature},
                                   ":a": {"S": "active"}})


def _loc(tenant):
    return call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["locations"][0]["locationId"]


def P(tenant, loc, **extra):
    return {"tenantId": tenant, "locationId": loc, **extra}


def test_enable_register_list_remove(aws, tenant, stripe):
    _ready(aws, tenant)
    loc = _loc(tenant)
    status, body = call("GET /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc))
    assert status == 200 and body["enabled"] is False and body["inPlan"] is True

    status, body = call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc), body=LOC)
    assert status == 201, body
    assert body["terminal"]["locationId"] == "tml_123" and body["terminal"]["accountId"] == "acct_123456"
    create = next(c for c in stripe["calls"] if c[1] == "/terminal/locations")
    assert create[3] == "acct_123456"                                   # created ON the restaurant's account
    assert create[2]["address[country]"] == "SE" and create[2]["address[postal_code]"] == "118 46"

    # can't enable twice
    assert call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc),
                body=LOC)[1]["error"] == "already_enabled"

    status, body = call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers", P(tenant, loc),
                        body={"registrationCode": "simulated-wpe", "label": "Counter 1"})
    assert status == 201 and body["reader"]["label"] == "Counter 1"
    rid = body["reader"]["id"]

    status, body = call("GET /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc))
    assert body["enabled"] and [r["id"] for r in body["readers"]] == [rid]

    assert call("DELETE /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers/{readerId}",
                P(tenant, loc, readerId="tmr_other"))[0] == 404              # not this location's reader
    assert call("DELETE /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers/{readerId}",
                P(tenant, loc, readerId=rid))[0] == 200
    assert call("GET /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc))[1]["readers"] == []


def test_location_stripe_override_is_used(aws, tenant, stripe):
    _ready(aws, tenant)
    loc = _loc(tenant)
    assert call("PATCH /platform/tenants/{tenantId}/locations/{locationId}", P(tenant, loc),
                body={"stripeAccountId": "acct_SEPARATE1"})[0] == 200
    assert call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc), body=LOC)[0] == 201
    create = next(c for c in stripe["calls"] if c[1] == "/terminal/locations")
    assert create[3] == "acct_SEPARATE1"


def test_guards(aws, tenant, stripe):
    loc = _loc(tenant)
    # no Stripe account yet
    assert call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc),
                body=LOC)[1]["error"] == "no_stripe_account"
    # not in plan
    _ready(aws, tenant, terminal_feature=False)
    status, body = call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc), body=LOC)
    assert status == 403 and body["error"] == "feature_not_in_plan"
    # Stripe onboarding not finished
    _ready(aws, tenant)
    stripe["charges_enabled"] = False
    assert call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc),
                body=LOC)[1]["error"] == "payments_not_ready"
    # bad address
    stripe["charges_enabled"] = True
    status, body = call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc),
                        body={"line1": "x", "postalCode": "12", "city": "y"})
    assert status == 400 and "postalCode" in body["fields"]
    # readers need an enabled terminal location
    assert call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers", P(tenant, loc),
                body={"registrationCode": "simulated-wpe", "label": "A"})[1]["error"] == "not_enabled"
    # unknown location
    assert call("GET /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, "nope"))[0] == 404


def test_bad_registration_code_is_a_field_error(aws, tenant, stripe):
    _ready(aws, tenant)
    loc = _loc(tenant)
    call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc), body=LOC)
    status, body = call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers", P(tenant, loc),
                        body={"registrationCode": "bad", "label": "A"})
    assert status == 400 and "registrationCode" in body["fields"]


def test_update_address(aws, tenant, stripe):
    _ready(aws, tenant)
    loc = _loc(tenant)
    call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc), body=LOC)
    status, body = call("PATCH /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc),
                        body={"line1": "Hornsgatan 98", "postalCode": "118 21"})
    assert status == 200 and body["terminal"]["address"]["line1"] == "Hornsgatan 98"
    assert body["terminal"]["address"]["city"] == "Stockholm"


def test_deleting_location_removes_readers_in_stripe(aws, tenant, stripe):
    _ready(aws, tenant)
    loc = _loc(tenant)
    call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal", P(tenant, loc), body=LOC)
    call("POST /platform/tenants/{tenantId}/locations/{locationId}/terminal/readers", P(tenant, loc),
         body={"registrationCode": "simulated-wpe", "label": "A"})
    assert call("DELETE /platform/tenants/{tenantId}/locations/{locationId}", P(tenant, loc))[0] == 200
    deletes = [c[1] for c in stripe["calls"] if c[0] == "DELETE"]
    assert "/terminal/readers/tmr_1" in deletes and "/terminal/locations/tml_123" in deletes
