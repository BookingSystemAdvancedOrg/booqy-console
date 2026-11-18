"""Dev twins (devtwin.py, docs/DEV-TWINS.md): the seed sets up every Kom
igång step through the admin's own functions (faked here as they answer a
console call; their rules are tested in the application repo), only adds
what is missing, and never runs in prod."""

import io
import json
from datetime import date
from decimal import Decimal

import pytest

from app import core, devtwin
from conftest import call

PREFIX = "arn:aws:lambda:eu-north-1:1:function:dev-"
SELF = "arn:aws:lambda:eu-north-1:1:function:dev-platform-tenants:live"


class Ctx:
    aws_request_id = "req-1"
    invoked_function_arn = SELF

    @staticmethod
    def get_remaining_time_in_millis():
        return 280_000


class FakeAdmin:
    """The admin's functions behind console_invoke, with just enough state."""

    def __init__(self, aws, tenant):
        self.aws, self.tenant = aws, tenant
        self.calls, self.self_invokes = [], []
        self.location = {}
        self.categories = {"categories": [{"categoryId": "starters", "name": "Förrätter"},
                                          {"categoryId": "mains", "name": "Varmrätter"}], "version": 0}
        self.items, self.elements, self.versions = [], [], []
        self.dpa = {"currentVersion": "2026-10", "upToDate": False}
        self.google = {}
        self.phone_config = {"version": 0}
        self.phone_loc = {"version": 0, "enabled": False, "mode": "after_hours", "agentHours": {}}

    def answer(self, fn, c):
        method, path, route, body = c["method"], c["path"], c.get("route"), c.get("body") or {}
        writes = method != "GET"
        if writes:
            self.calls.append((fn, method, path))
        if fn == "tenant-account":
            if method == "GET":
                return 200, {"dpa": self.dpa, "staffAccess": {"areas": [], "defaults": [], "users": {}, "version": 1}}
            assert body == {"version": "2026-10"}
            self.dpa = {**self.dpa, "upToDate": True}
            return 200, {}
        if fn == "create-location":
            assert route == "/locations/{locationId}"
            self.location.update(body)
            self._store_location(path.split("/")[2], body)
            return 200, {"locationId": path.split("/")[2], **self.location}
        if fn == "get-menu":
            return 200, (self.categories if path.endswith("/categories") else {"items": self.items})
        if fn == "manage-menu":
            if path.endswith("/categories"):
                assert body["version"] == self.categories["version"]
                cats = [{"categoryId": c.get("categoryId") or f"c{i}", "name": c["name"]}
                        for i, c in enumerate(body["categories"])]
                self.categories = {"categories": cats, "version": body["version"] + 1}
                return 200, self.categories
            assert body["category"] in {c["categoryId"] for c in self.categories["categories"]}
            self.items.append({"menuItemId": f"m{len(self.items)}", **body})
            return 201, self.items[-1]
        if fn == "list-layout-version":
            return 200, {"items": self.versions}
        if fn == "manage-layout-element":
            if method == "GET":
                return 200, {"items": self.elements}
            if body["type"] != "floor":
                assert body["floorId"] == self.elements[0]["elementId"]
            self.elements.append({"elementId": f"e{len(self.elements)}", **body})
            return 201, self.elements[-1]
        if fn == "publish-layout":
            self.versions.append({"version": len(self.versions) + 1, "isCurrent": False})
            return 201, self.versions[-1]
        if fn == "activate-layout-version":
            assert route.endswith("/{versionId}/activate")
            self.versions[-1]["isCurrent"] = True
            return 200, {}
        if fn == "google-business":
            if method == "PUT":
                assert body == {"skipped": True}
                self.google = {"skipped": True}
            return 200, self.google
        if fn == "phone-agent":
            if path == "/tenant/phone-agent":
                return 200, {"config": self.phone_config}
            if path == "/tenant/phone-agent/config":
                self.phone_config = {**body, "version": body["version"] + 1}
                return 200, self.phone_config
            if path.endswith("/setup"):
                assert body["version"] == self.phone_loc["version"]
                self.phone_loc = {**self.phone_loc, "setup": {"forwardedAt": "x", "testedAt": "x"},
                                  "version": body["version"] + 1}
                return 200, self.phone_loc
            if method == "PUT":
                self.phone_loc = {**self.phone_loc, **body, "number": "+46100000001", "version": body["version"] + 1}
            return 200, self.phone_loc
        if fn == "manage-user":
            sub = "staff-1"
            item = {"PK": f"USER#{sub}", "SK": "PROFILE", "cognitoSub": sub, "tenantId": self.tenant, "role": "staff",
                    "locationId": body["locationId"], "name": body["name"], "email": body["email"], "status": "active"}
            self.aws["ddb"].put_item(TableName="dev-user", Item={k: {"S": v} for k, v in item.items()})
            return 201, item
        raise AssertionError(f"unexpected {fn} {method} {path}")

    def _store_location(self, location_id, fields):
        """As create-location: the location row gets the fields."""
        key = {"PK": {"S": f"TENANT#{self.tenant}"}, "SK": {"S": f"LOCATION#{location_id}"}}
        item = core.from_ddb(self.aws["ddb"].get_item(TableName="dev-location", Key=key)["Item"])
        item.update(json.loads(json.dumps(fields), parse_float=Decimal))
        self.aws["ddb"].put_item(TableName="dev-location", Item=core.to_ddb(item))

    def invoke(self, **kwargs):
        name = kwargs["FunctionName"]
        payload = json.loads(kwargs["Payload"])
        if "twinTask" in payload:
            assert name == SELF and kwargs["InvocationType"] == "Event"
            self.self_invokes.append(payload["twinTask"])
            return {"StatusCode": 202, "Payload": io.BytesIO(b"")}
        c = payload["booqyConsole"]
        assert c["tenantId"] == self.tenant and c["operator"] in ("dev-twin", "op-1")   # op-1: the Users tab
        fn = name.removeprefix(PREFIX).removesuffix(":live") if name.startswith(PREFIX) else (
            "manage-user" if "manage-user" in name else "tenant-account")
        status, body = self.answer(fn, c)
        out = {"statusCode": status, "body": json.dumps(body) if body is not None else ""}
        return {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(out).encode())}


@pytest.fixture
def twin(aws, tenant, monkeypatch):
    monkeypatch.setenv("DEV_TWIN_FUNCTION_PREFIX", PREFIX)
    monkeypatch.setenv("DEV_TWIN_OWNER_EMAIL", "dev+{slug}@booqy.se")
    monkeypatch.setenv("DEV_TWIN_STRIPE_ACCOUNT_ID", "acct_test_shared")
    monkeypatch.setenv("MANAGE_USER_FUNCTION_ARN", "arn:aws:lambda:eu-north-1:1:function:dev-manage-user:live")
    monkeypatch.setenv("TENANT_ACCOUNT_FUNCTION_ARN", f"{PREFIX}tenant-account:live")
    fake = FakeAdmin(aws, tenant)
    core._clients["lambda"] = fake
    from app import stripe_connect
    stripe_calls = []
    monkeypatch.setattr(stripe_connect, "_api_key", lambda: "rk_test_x")

    def stripe(method, path, params=None, **_):
        stripe_calls.append(path)
        return {"id": "acct_test_shared", "charges_enabled": True, "payouts_enabled": True, "details_submitted": True}
    monkeypatch.setattr(stripe_connect, "stripe_request", stripe)
    fake.stripe_calls = stripe_calls
    features = {"M": {"reservations": {"BOOL": True}, "ordering": {"BOOL": True}, "googleBusiness": {"BOOL": True},
                      "phoneAgent": {"BOOL": True}}}
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :a, entitlements.features = :f",
                           ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":a": {"S": "active"}, ":f": features})
    return fake


def _profile(tenant):
    return call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["tenant"]


def _seed(tenant):
    return devtwin.twin_task({"twinTask": {"tenantId": tenant, "requestedBy": "op-1"}}, Ctx())


def test_seed_sets_up_every_kom_igang_step(twin, tenant, aws):
    assert _seed(tenant) == {"status": "ready", "failed": []}
    state = _profile(tenant)["devTwin"]
    assert state["status"] == "ready" and set(state["steps"]) == set(devtwin.STEPS)
    assert all(step["ok"] for step in state["steps"].values()), state["steps"]
    # owner: a team login, never the restaurant's; its own details removed
    profile = _profile(tenant)
    assert profile["ownerEmail"] == "dev+pizzeria-roma@booqy.se"
    for personal in ("legalName", "orgNumber", "contactEmail", "address"):
        assert personal not in profile
    users = call("GET /platform/tenants/{tenantId}/users", {"tenantId": tenant})[1]["users"]
    assert {u["email"] for u in users} >= {"dev+pizzeria-roma@booqy.se", "dev+pizzeria-roma-personal@booqy.se"}
    # stripe: the shared test-mode account, ready
    assert profile["stripe"]["accountId"] == "acct_test_shared" and profile["stripe"]["chargesEnabled"] is True
    # location details, menu, layout, printer, DPA, Google, phone
    loc = twin.location
    assert loc["businessHours"] == devtwin.HOURS and loc["guarantee"]["enabled"] and loc["ordering"]["enabled"]
    assert [d["kind"] for d in loc["specialDays"]] == ["closed", "hours", "no_online"] or loc["specialDays"]
    names = [c["name"] for c in twin.categories["categories"]]
    assert names[0] == "Dagens lunch" and set(devtwin.CATEGORIES) <= set(names)
    assert len(twin.items) == len(devtwin.DISHES)
    assert [i["alcohol"] for i in twin.items if i["name"] == "Husets röda, glas"] == [True]
    assert sum(e["type"] == "table" for e in twin.elements) == 8 and twin.versions[-1]["isCurrent"]
    assert twin.dpa["upToDate"] and twin.google == {"skipped": True}
    assert twin.phone_config["agentName"] == "Sara" and twin.phone_loc["enabled"] and twin.phone_loc["number"]
    assert twin.phone_loc["setup"]["testedAt"]
    printers = call("GET /platform/tenants/{tenantId}/printers", {"tenantId": tenant})[1]
    assert json.dumps(printers).count('"protocol": "sim"') == 1


def test_a_second_run_adds_nothing(twin, tenant):
    _seed(tenant)
    writes = len(twin.calls)
    stripe = len(twin.stripe_calls)
    assert _seed(tenant)["status"] == "ready"
    assert twin.calls[writes:] == [] and len(twin.stripe_calls) == stripe
    assert len(twin.items) == len(devtwin.DISHES) and len(twin.versions) == 1
    users = call("GET /platform/tenants/{tenantId}/users", {"tenantId": tenant})[1]["users"]
    assert len([u for u in users if u["email"].startswith("dev+")]) == 2


def test_refresh_only_fills_what_is_missing(twin, tenant):
    twin.items.append({"menuItemId": "own", "name": "Toast Skagen", "category": "starters", "price": 199})
    own_hours = {"monday": [{"opensAt": "10:00", "closesAt": "12:00"}]}
    location_id = call("GET /platform/tenants/{tenantId}/locations", {"tenantId": tenant})[1]["locations"][0]["locationId"]
    twin._store_location(location_id, {"businessHours": own_hours})
    _seed(tenant)
    assert "businessHours" not in twin.location
    assert len([i for i in twin.items if i["name"] == "Toast Skagen"]) == 1


def test_a_failing_step_is_reported_and_the_rest_still_runs(twin, tenant):
    original = twin.answer

    def broken(fn, c):
        if fn == "publish-layout":
            return 409, {"code": "invalid_layout"}
        return original(fn, c)
    twin.answer = broken
    out = _seed(tenant)
    assert out == {"status": "partial", "failed": ["layout"]}
    state = _profile(tenant)["devTwin"]
    assert "invalid_layout" in state["steps"]["layout"]["note"] and state["steps"]["phone"]["ok"]


def test_console_button_queues_the_seed_through_the_live_alias(twin, tenant):
    from app.handler import handler
    event = {"routeKey": "POST /platform/tenants/{tenantId}/dev-twin", "pathParameters": {"tenantId": tenant},
             "body": None, "requestContext": {"authorizer": {"jwt": {"claims": {
                 "username": "op-1", "cognito:groups": "[platform_admin]"}}}}}
    resp = handler(event, Ctx())
    assert resp["statusCode"] == 202 and json.loads(resp["body"])["devTwin"]["status"] == "queued"
    assert twin.self_invokes == [{"tenantId": tenant, "requestedBy": "op-1", "run": 1}]
    # the async invoke runs the seed
    handler({"twinTask": twin.self_invokes[0]}, Ctx())
    assert _profile(tenant)["devTwin"]["status"] == "ready"


def test_never_in_prod(twin, tenant, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "prod")
    assert call("POST /platform/tenants/{tenantId}/dev-twin", {"tenantId": tenant})[0] == 404
    assert devtwin.twin_task({"twinTask": {"tenantId": tenant}}, Ctx()) == {"status": "off"}
    assert twin.calls == [] and twin.self_invokes == []


def test_prod_link_mirror_starts_the_seed(twin, aws):
    from app.handler import handler
    out = handler({"siteTask": {"action": "mirror", "name": "Anar", "slug": "anar-test", "planId": "growth",
                                "ownerEmail": "someone@restaurant.se"}}, Ctx())
    assert out["status"] == "created"
    assert twin.self_invokes == [{"tenantId": out["tenantId"], "requestedBy": "prod-site-repo", "run": 1}]
    assert _profile(out["tenantId"])["ownerEmail"] == "dev+anar-test@booqy.se"


def test_waits_for_onboarding_then_hands_itself_the_rest(twin, tenant, aws, monkeypatch):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :p", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":p": {"S": "provisioning"}})
    monkeypatch.setattr(devtwin, "ACTIVE_WAIT_SECONDS", 0)
    assert _seed(tenant) == {"status": "waiting"}
    assert twin.self_invokes == [{"tenantId": tenant, "requestedBy": "op-1", "run": 2}] and twin.calls == []


def test_special_days_are_ahead():
    days = devtwin.special_days(date(2026, 12, 28))
    assert [d["date"] for d in days] == ["2026-12-31", "2027-01-11", "2027-12-24"]
    assert all(len(d["note"]) <= 80 for d in days)
