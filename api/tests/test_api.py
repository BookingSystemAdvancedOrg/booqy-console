import json
import os
import re

import pytest

from conftest import NEW_TENANT, call


def T(tid, suffix=""):
    return f"/platform/tenants/{tid}{suffix}"


def test_requires_operator_group(aws):
    assert call("GET /platform/tenants", groups=None)[0] == 403
    assert call("GET /platform/tenants", groups="[owner_user]")[0] == 403
    assert call("GET /platform/tenants", groups="[platform_admin owner_user]")[0] == 200


def test_unknown_route(aws):
    assert call("GET /platform/nope")[0] == 404


def test_plans(aws):
    status, body = call("GET /platform/plans")
    assert status == 200
    assert {p["planId"]: p["maxLocations"] for p in body["plans"]} == {"starter": 1, "growth": 3}


def test_create_tenant_writes_everything_and_starts_onboarding(aws, tenant):
    assert re.fullmatch(r"[0-9a-z]{26}", tenant)
    status, body = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})
    assert status == 200
    t = body["tenant"]
    assert t["status"] == "provisioning" and t["slug"] == "pizzeria-roma"
    assert t["ownerEmail"] == "owner@roma.se"                      # normalised
    assert t["entitlements"]["maxLocations"] == 1 and t["locationCount"] == 1
    assert t["address"]["country"] == "SE"
    assert "PK" not in t and "GSI1PK" not in t
    assert len(body["locations"]) == 1 and body["locations"][0]["tenantId"] == tenant
    assert body["audit"][0]["action"] == "tenant_created"
    assert body["onboarding"]["status"] in ("RUNNING", "SUCCEEDED")

    slug_row = aws["ddb"].get_item(TableName="dev-tenant", Key={"PK": {"S": "SLUG#pizzeria-roma"}, "SK": {"S": "TENANT"}})
    assert slug_row["Item"]["tenantId"]["S"] == tenant
    ex = aws["sfn"].list_executions(stateMachineArn=os.environ["ONBOARDING_STATE_MACHINE_ARN"])["executions"]
    assert [e["name"] for e in ex] == [f"onboard-{tenant}-1"]
    inp = json.loads(aws["sfn"].describe_execution(executionArn=ex[0]["executionArn"])["input"])
    assert inp == {"tenantId": tenant, "slug": "pizzeria-roma", "name": "Pizzeria Roma",
                   "ownerEmail": "owner@roma.se", "ownerName": "Maria Rossi"}


def test_duplicate_slug(aws, tenant):
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "locations": []})
    assert status == 409 and body["error"] == "slug_taken"


@pytest.mark.parametrize("patch,field", [
    ({"slug": "app"}, "slug"), ({"slug": "-bad"}, "slug"), ({"ownerEmail": "nope"}, "ownerEmail"),
    ({"orgNumber": "12"}, "orgNumber"), ({"senderName": "Way too long name"}, "senderName"),
    ({"address": {"street": "x", "postalCode": "abc", "city": "y"}}, "address.postalCode"),
    ({"locations": [{"name": "Only name"}]}, "locations.0.address"),
])
def test_create_validation(aws, patch, field):
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, **patch})
    assert status == 400 and field in body["fields"], body


def test_create_more_locations_than_plan(aws):
    locs = NEW_TENANT["locations"] * 2
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "locations": locs})
    assert status == 400 and "locations" in body["fields"]


def test_unknown_plan(aws):
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "planId": "gold"})
    assert status == 400 and body["fields"] == {"planId": "Unknown plan"}


def test_list_tenants(aws, tenant):
    status, body = call("GET /platform/tenants")
    assert status == 200 and body["tenants"][0]["tenantId"] == tenant
    assert body["tenants"][0]["maxLocations"] == 1
    assert call("GET /platform/tenants", query={"status": "active"})[1]["tenants"] == []


def test_update_tenant(aws, tenant):
    status, body = call("PATCH /platform/tenants/{tenantId}", {"tenantId": tenant},
                        {"name": "Roma", "contactPhone": "+46 70 111 22 33", "senderName": None})
    assert status == 200, body
    assert body["tenant"]["name"] == "Roma" and "senderName" not in body["tenant"]
    assert call("PATCH /platform/tenants/{tenantId}", {"tenantId": tenant}, {"slug": "x"})[0] == 400
    assert call("PATCH /platform/tenants/{tenantId}", {"tenantId": "nope"}, {"name": "x"})[0] == 404


def test_location_crud_and_plan_limit(aws, tenant):
    p = {"tenantId": tenant}
    loc = {"name": "Roma Kungsholmen", "address": "Fleminggatan 5, Stockholm"}
    status, body = call("POST /platform/tenants/{tenantId}/locations", p, loc)
    assert status == 409 and body["error"] == "plan_limit_reached" and body["maxLocations"] == 1

    # Customer upgrades: override to 2 locations on the starter plan
    status, body = call("PUT /platform/tenants/{tenantId}/plan", p, {"planId": "starter", "overrides": {"maxLocations": 2}})
    assert status == 200 and body["tenant"]["entitlements"]["maxLocations"] == 2
    status, body = call("POST /platform/tenants/{tenantId}/locations", p, loc)
    assert status == 201, body
    new_id = body["location"]["locationId"]
    assert call("GET /platform/tenants/{tenantId}", p)[1]["tenant"]["locationCount"] == 2

    status, body = call("PATCH /platform/tenants/{tenantId}/locations/{locationId}",
                        {**p, "locationId": new_id}, {"phone": "+46 8 555 00", "stripeAccountId": "acct_1AbCdEf"})
    assert status == 200 and body["location"]["phone"] == "+46 8 555 00"
    status, body = call("PATCH /platform/tenants/{tenantId}/locations/{locationId}",
                        {**p, "locationId": new_id}, {"stripeAccountId": ""})
    assert status == 200 and "stripeAccountId" not in body["location"]
    assert call("PATCH /platform/tenants/{tenantId}/locations/{locationId}",
                {**p, "locationId": new_id}, {"name": ""})[0] == 400

    assert call("DELETE /platform/tenants/{tenantId}/locations/{locationId}", {**p, "locationId": new_id})[0] == 200
    assert call("DELETE /platform/tenants/{tenantId}/locations/{locationId}", {**p, "locationId": new_id})[0] == 404
    assert call("GET /platform/tenants/{tenantId}", p)[1]["tenant"]["locationCount"] == 1
    assert len(call("GET /platform/tenants/{tenantId}/locations", p)[1]["locations"]) == 1


def test_location_of_other_tenant_is_not_reachable(aws, tenant):
    _, other = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "other-place"})
    other_loc = call("GET /platform/tenants/{tenantId}/locations", {"tenantId": other["tenantId"]})[1]["locations"][0]
    path = {"tenantId": tenant, "locationId": other_loc["locationId"]}
    assert call("PATCH /platform/tenants/{tenantId}/locations/{locationId}", path, {"name": "x"})[0] == 404
    assert call("DELETE /platform/tenants/{tenantId}/locations/{locationId}", path)[0] == 404


def test_plan_below_location_count_needs_force(aws, tenant):
    p = {"tenantId": tenant}
    call("PUT /platform/tenants/{tenantId}/plan", p, {"planId": "growth"})
    call("POST /platform/tenants/{tenantId}/locations", p, {"name": "B", "address": "B-gatan 1"})
    status, body = call("PUT /platform/tenants/{tenantId}/plan", p, {"planId": "starter"})
    assert status == 409 and body["error"] == "below_location_count"
    assert call("PUT /platform/tenants/{tenantId}/plan", p, {"planId": "starter", "force": True})[0] == 200


def _activate(aws, tenant):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :a", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":a": {"S": "active"}})


def test_owners_suspend_resume(aws, tenant):
    p = {"tenantId": tenant}
    status, body = call("POST /platform/tenants/{tenantId}/owners", p, {"email": "Partner@roma.se", "name": "Luca"})
    assert status == 201, body
    sub = body["user"]["cognitoSub"]
    user = aws["idp"].admin_get_user(UserPoolId=aws["pool"], Username=sub)
    attrs = {a["Name"]: a["Value"] for a in user["UserAttributes"]}
    assert attrs["custom:tenant_id"] == tenant and attrs["email"] == "partner@roma.se"
    groups = aws["idp"].admin_list_groups_for_user(UserPoolId=aws["pool"], Username=sub)["Groups"]
    assert [g["GroupName"] for g in groups] == ["owner_user"]
    assert call("POST /platform/tenants/{tenantId}/owners", p, {"email": "partner@roma.se", "name": "L"})[1]["error"] == "user_exists"

    # a second user that an owner disabled earlier
    _, b2 = call("POST /platform/tenants/{tenantId}/owners", p, {"email": "old@roma.se", "name": "Old"})
    aws["ddb"].update_item(TableName="dev-user", Key={"PK": {"S": f"USER#{b2['user']['cognitoSub']}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :d", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":d": {"S": "disabled"}})

    assert call("POST /platform/tenants/{tenantId}/suspend", p)[1]["error"] == "invalid_status"   # still provisioning
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/suspend", p, {"reason": "unpaid"})
    assert status == 200 and body["usersDisabled"] == 2
    assert aws["idp"].admin_get_user(UserPoolId=aws["pool"], Username=sub)["Enabled"] is False
    status, body = call("POST /platform/tenants/{tenantId}/resume", p)
    assert status == 200 and body["usersEnabled"] == 1
    assert aws["idp"].admin_get_user(UserPoolId=aws["pool"], Username=sub)["Enabled"] is True
    assert aws["idp"].admin_get_user(UserPoolId=aws["pool"], Username=b2["user"]["cognitoSub"])["Enabled"] is False
    users = call("GET /platform/tenants/{tenantId}/users", p)[1]["users"]
    assert {u["email"] for u in users} == {"partner@roma.se", "old@roma.se"}


def test_offboard(aws, tenant):
    p = {"tenantId": tenant}
    assert call("POST /platform/tenants/{tenantId}/offboard", p, {"confirmSlug": "wrong"})[0] == 400
    # not while setup is still running
    assert call("POST /platform/tenants/{tenantId}/offboard", p, {"confirmSlug": "pizzeria-roma"})[0] == 409
    _activate(aws, tenant)
    assert call("POST /platform/tenants/{tenantId}/offboard", p, {"confirmSlug": "pizzeria-roma"})[0] == 202
    assert call("GET /platform/tenants/{tenantId}", p)[1]["tenant"]["status"] == "offboarding"
    # double click: same single execution
    assert call("POST /platform/tenants/{tenantId}/offboard", p, {"confirmSlug": "pizzeria-roma"})[0] == 202
    ex = aws["sfn"].list_executions(stateMachineArn=os.environ["OFFBOARDING_STATE_MACHINE_ARN"])["executions"]
    assert [e["name"] for e in ex] == [f"offboard-{tenant}"]
    # locations of an offboarding tenant are frozen
    loc = call("GET /platform/tenants/{tenantId}/locations", p)[1]["locations"][0]["locationId"]
    assert call("PATCH /platform/tenants/{tenantId}/locations/{locationId}", {**p, "locationId": loc}, {"name": "x"})[0] == 409


def test_invite_while_suspended_is_disabled(aws, tenant):
    p = {"tenantId": tenant}
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/suspend", p, {"reason": "unpaid"})
    _, body = call("POST /platform/tenants/{tenantId}/owners", p, {"email": "new@roma.se", "name": "New"})
    sub = body["user"]["cognitoSub"]
    assert aws["idp"].admin_get_user(UserPoolId=aws["pool"], Username=sub)["Enabled"] is False
    # suspend can be repeated (repairs a partial run); resume enables the new owner
    assert call("POST /platform/tenants/{tenantId}/suspend", p)[0] == 200
    assert call("POST /platform/tenants/{tenantId}/resume", p)[0] == 200
    assert aws["idp"].admin_get_user(UserPoolId=aws["pool"], Username=sub)["Enabled"] is True


def test_delete_location_when_count_is_missing(aws, tenant):
    p = {"tenantId": tenant}
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="REMOVE locationCount")
    loc = call("GET /platform/tenants/{tenantId}/locations", p)[1]["locations"][0]["locationId"]
    assert call("DELETE /platform/tenants/{tenantId}/locations/{locationId}", {**p, "locationId": loc})[0] == 200


def test_retry_onboarding(aws, tenant):
    p = {"tenantId": tenant}
    assert call("POST /platform/tenants/{tenantId}/onboarding/retry", p)[1]["error"] == "invalid_status"
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/onboarding/retry", p)
    assert status == 202 and body["status"] == "active"
    names = [e["name"] for e in aws["sfn"].list_executions(stateMachineArn=os.environ["ONBOARDING_STATE_MACHINE_ARN"])["executions"]]
    assert sorted(names) == [f"onboard-{tenant}-1", f"onboard-{tenant}-2"]


def test_domains(aws, tenant):
    p = {"tenantId": tenant}
    assert call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "www.roma.se"})[1]["error"] == "platform_domain_not_configured"
    os.environ.update({"PLATFORM_DOMAIN": "bokning.example.se", "TENANT_DOMAIN_CNAME_TARGET": "x.cloudfront.net"})
    assert call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "https://www.roma.se"})[0] == 400
    assert call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "a.bokning.example.se"})[0] == 400
    status, body = call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "WWW.Roma.se", "makePrimary": True})
    assert status == 202 and body["dns"][0] == {"type": "CNAME", "name": "www.roma.se", "value": "x.cloudfront.net"}
    # double submit: already added (row is pending_dns)
    assert call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "www.roma.se"})[1]["error"] == "domain_exists"
    # after a timeout it can be added again (resumes)
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "DOMAIN#www.roma.se"}},
                           UpdateExpression="SET #s = :t", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":t": {"S": "validation_timeout"}})
    assert call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "www.roma.se"})[0] == 202
    # another tenant can't take it
    _, other = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "other-place", "locations": []})
    assert call("POST /platform/tenants/{tenantId}/domains", {"tenantId": other["tenantId"]},
                {"domain": "www.roma.se"})[1]["error"] == "domain_in_use"

    # claimed by another tenant
    aws["ddb"].put_item(TableName="dev-tenant", Item={"PK": {"S": "DOMAIN#www.taken.se"}, "SK": {"S": "TENANT"},
                                                      "tenantId": {"S": "someone-else"}})
    assert call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "www.taken.se"})[1]["error"] == "domain_in_use"
    assert call("DELETE /platform/tenants/{tenantId}/domains/{domain}", {**p, "domain": "www.none.se"})[0] == 404


def test_stripe_link_and_sync(aws, tenant, monkeypatch):
    from app import stripe_connect
    p = {"tenantId": tenant}
    assert call("POST /platform/tenants/{tenantId}/stripe/account-link", p)[1]["error"] == "no_stripe_account"
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET stripe = :s",
                           ExpressionAttributeValues={":s": {"M": {"accountId": {"S": "acct_123456"}}}})
    seen = []

    def fake(method, path, params=None):
        seen.append((method, path, params))
        if path == "/v2/core/account_links":
            return {"url": "https://connect.stripe.com/setup/x", "expires_at": "2026-10-09T10:00:00.000Z"}
        return {"charges_enabled": True, "payouts_enabled": False, "details_submitted": True,
                "requirements": {"currently_due": ["external_account"]}}

    monkeypatch.setattr(stripe_connect, "stripe_request", fake)
    status, body = call("POST /platform/tenants/{tenantId}/stripe/account-link", p)
    assert status == 200 and body["url"].startswith("https://connect.stripe.com")
    onboarding = seen[0][2]["use_case"]["account_onboarding"]
    assert seen[0][2]["account"] == "acct_123456" and onboarding["configurations"] == ["merchant"]
    assert onboarding["return_url"] == f"https://ops.example.se/tenants/{tenant}?stripe=return"
    status, body = call("POST /platform/tenants/{tenantId}/stripe/sync", p)
    assert status == 200 and body["stripe"]["chargesEnabled"] is True
    t = call("GET /platform/tenants/{tenantId}", p)[1]["tenant"]
    assert t["stripe"]["requirementsDue"] == ["external_account"]


def test_stripe_request_encodes_v1_and_v2(monkeypatch):
    """v1 paths go form-encoded to /v1, /v2/ paths go as JSON - Stripe
    rejects new connected accounts on v1, so account links use v2."""
    import io
    import json as _json

    from app import stripe_connect
    monkeypatch.setattr(stripe_connect, "_api_key", lambda: "sk_test_x")
    sent = []

    def fake_urlopen(req, timeout):
        sent.append(req)
        return io.BytesIO(b'{"id": "x"}')

    monkeypatch.setattr(stripe_connect.urllib.request, "urlopen", fake_urlopen)
    stripe_connect.stripe_request("POST", "/terminal/locations", {"display_name": "A+B"}, account="acct_1")
    stripe_connect.stripe_request("POST", "/v2/core/account_links", {"use_case": {"type": "account_onboarding"}})
    v1, v2 = sent
    assert v1.full_url == "https://api.stripe.com/v1/terminal/locations"
    assert v1.data == b"display_name=A%2BB" and v1.headers["Stripe-account"] == "acct_1"
    assert v2.full_url == "https://api.stripe.com/v2/core/account_links"
    assert v2.headers["Content-type"] == "application/json"
    assert _json.loads(v2.data) == {"use_case": {"type": "account_onboarding"}}


def test_locations_meet_the_admin_app_contract(aws, tenant):
    """The application backend refuses location rows without timezone,
    opening hours, booking duration and grace period - every location the
    operator creates has them (closed until the owner sets hours), and the
    phone is also stored in E.164 as phoneNumber."""
    from app import validation as v
    p = {"tenantId": tenant}
    (loc,) = call("GET /platform/tenants/{tenantId}/locations", p)[1]["locations"]
    assert loc["timezone"] == "Europe/Stockholm"
    assert loc["businessHours"] == {d: [] for d in v.WEEKDAYS}
    assert loc["bookingDurationHours"] == 2 and loc["gracePeriodHours"] == 0
    assert loc["phoneNumber"] == "+46812345"

    status, body = call("PATCH /platform/tenants/{tenantId}/locations/{locationId}",
                        {**p, "locationId": loc["locationId"]}, {"phone": "070-123 45 67"})
    assert status == 200 and body["location"]["phoneNumber"] == "+46701234567"
    status, body = call("PATCH /platform/tenants/{tenantId}/locations/{locationId}",
                        {**p, "locationId": loc["locationId"]}, {"phone": ""})
    assert status == 200 and "phoneNumber" not in body["location"]


def test_e164():
    from app.validation import e164
    assert e164("+46 8 123 45") == "+46812345"
    assert e164("0046701234567") == "+46701234567"
    assert e164("070-123 45 67") == "+46701234567"
    assert e164("12") is None and e164(None) is None
