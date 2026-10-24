"""GET /platform/terminal/readers: every card reader across customers with
its tenant and location."""
import pytest

from conftest import NEW_TENANT, call


def _enable(aws, tenant, account, terminal_location):
    aws["ddb"].update_item(
        TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
        UpdateExpression="SET stripe = :s", ExpressionAttributeValues={":s": {"M": {"accountId": {"S": account}}}})
    loc = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["locations"][0]["locationId"]
    aws["ddb"].update_item(
        TableName="dev-location", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": f"LOCATION#{loc}"}},
        UpdateExpression="SET terminal = :t",
        ExpressionAttributeValues={":t": {"M": {"accountId": {"S": account}, "locationId": {"S": terminal_location}}}})
    return loc


@pytest.fixture
def two_customers(aws, tenant):
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "name": "Annan Krog", "slug": "annan-krog",
                                                        "ownerEmail": "owner2@example.se"})
    assert status == 202, body
    other = body["tenantId"]
    return {"a": (tenant, _enable(aws, tenant, "acct_a", "tml_a")),
            "b": (other, _enable(aws, other, "acct_b", "tml_b"))}


@pytest.fixture
def stripe(monkeypatch):
    from app import terminal
    readers = {
        "acct_a": [{"id": "tmr_1", "label": "Kassan", "location": "tml_a", "status": "online", "device_type": "stripe_s700",
                    "serial_number": "S700-1"},
                   {"id": "tmr_old", "label": "Gammal", "location": "tml_gone", "status": "offline",
                    "device_type": "bbpos_wisepos_e"}],
        "acct_b": [{"id": "tmr_2", "label": "Baren", "location": "tml_b", "status": "offline", "device_type": "stripe_s710"}],
    }
    state = {"calls": [], "fail": set()}

    def fake(method, path, params=None, *, account=None, idempotency_key=None):
        state["calls"].append((method, path, dict(params or {}), account))
        assert (method, path) == ("GET", "/terminal/readers") and "location" not in params
        if account in state["fail"]:
            from app.core import ApiError
            raise ApiError(502, "stripe_error", "Stripe: boom")
        return {"data": readers.get(account, []), "has_more": False}

    monkeypatch.setattr(terminal, "stripe_request", fake)
    return state


def test_lists_every_reader_with_its_customer_and_location(two_customers, stripe):
    status, body = call("GET /platform/terminal/readers")
    assert status == 200, body
    (tenant_a, loc_a), (tenant_b, loc_b) = two_customers["a"], two_customers["b"]
    by_id = {r["id"]: r for r in body["readers"]}
    assert by_id["tmr_1"]["tenantId"] == tenant_a and by_id["tmr_1"]["locationId"] == loc_a
    assert by_id["tmr_1"]["accountId"] == "acct_a" and by_id["tmr_1"]["serial_number"] == "S700-1"
    assert by_id["tmr_2"]["tenantId"] == tenant_b and by_id["tmr_2"]["locationId"] == loc_b
    # On the restaurant's account but at a Terminal Location no Booqy location has.
    assert by_id["tmr_old"]["tenantId"] == tenant_a and by_id["tmr_old"]["locationId"] is None
    assert {(e["tenantId"], e["readerCount"]) for e in body["locations"]} == {(tenant_a, 1), (tenant_b, 1)}
    # One call per restaurant account, each with its own Stripe-Account.
    assert sorted(c[3] for c in stripe["calls"]) == ["acct_a", "acct_b"]
    assert body["errors"] == []


def test_one_failing_account_does_not_hide_the_others(two_customers, stripe):
    stripe["fail"].add("acct_b")
    status, body = call("GET /platform/terminal/readers")
    assert status == 200
    assert {r["id"] for r in body["readers"]} == {"tmr_1", "tmr_old"}
    assert [(e["accountId"], e["tenantId"]) for e in body["errors"]] == [("acct_b", two_customers["b"][0])]


def test_no_terminals_anywhere(aws, tenant, stripe):
    assert call("GET /platform/terminal/readers")[1] == {"readers": [], "locations": [], "errors": []}
    assert stripe["calls"] == []


def test_operators_only(two_customers, stripe):
    assert call("GET /platform/terminal/readers", groups="[staff_user]")[0] == 403
