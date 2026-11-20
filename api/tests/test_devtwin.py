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
PROD_ID = "t-prod-roma"


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
        self.uploads = 0
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
            if method == "DELETE":
                self.items = [i for i in self.items if i["menuItemId"] != path.rsplit("/", 1)[1]]
                return 204, None
            if method == "PUT" and "/items/" in path:
                item = next(i for i in self.items if i["menuItemId"] == path.rsplit("/", 1)[1])
                item.update(body)
                return 200, item
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
            if method == "DELETE":
                self.elements = [e for e in self.elements if e["elementId"] != path.rsplit("/", 1)[1]]
                return 204, None
            if body["type"] != "floor":
                assert body["floorId"] in {e["elementId"] for e in self.elements if e["type"] == "floor"}
            assert not str(body.get("wallId", "")).startswith("p-"), "a prod id reached the twin"
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
        if fn == "pre-signed-url":
            assert c["query"]["contentType"] == "image/jpeg" and int(c["query"]["size"]) > 0
            self.uploads += 1
            return 200, {"uploadUrl": f"https://upload.example/{self.uploads}", "imageKey":
                         f"menu-images/{self.tenant}/locations/x/menu/{self.uploads}.jpg",
                         "requiredHeaders": {"Content-Type": "image/jpeg"}}
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
    monkeypatch.setenv("DEV_TWIN_OWNER_EMAIL", "aws+{slug}@ithjalparna.se")
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
                           UpdateExpression="SET #s = :a, entitlements.features = :f, siteKind = :k, twinOf = :t",
                           ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":a": {"S": "active"}, ":f": features, ":k": {"S": "prod-link"},
                                                      ":t": {"M": {"env": {"S": "prod"}, "tenantId": {"S": PROD_ID}}}})
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
    assert profile["ownerEmail"] == "aws+pizzeria-roma@ithjalparna.se"
    for personal in ("legalName", "orgNumber", "contactEmail", "address"):
        assert personal not in profile
    users = call("GET /platform/tenants/{tenantId}/users", {"tenantId": tenant})[1]["users"]
    assert {u["email"] for u in users} >= {"aws+pizzeria-roma@ithjalparna.se", "aws+pizzeria-roma-personal@ithjalparna.se"}
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
    assert len([u for u in users if u["email"].startswith("aws+")]) == 2


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
    assert _profile(out["tenantId"])["ownerEmail"] == "aws+anar-test@ithjalparna.se"


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
    # special-day hours may not run past midnight (create-location refuses them)
    assert all(i["opensAt"] < i["closesAt"] for d in days for i in d.get("intervals", []))


# ------------------------------------------------- twins versus test customers
def _set(aws, tenant, **fields):
    from app.core import to_ddb_value
    names = {f"#k{i}": k for i, k in enumerate(fields)}
    values = {f":v{i}": to_ddb_value(v) for i, v in enumerate(fields.values())}
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(fields))),
                           ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def _unset(aws, tenant, *fields):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="REMOVE " + ", ".join(fields))


def _mirror(slug="pizzeria-roma", prod_id=PROD_ID):
    from app.handler import handler
    return handler({"siteTask": {"action": "mirror", "slug": slug, "name": "Pizzeria Roma", "planId": "growth",
                                 "prodTenantId": prod_id}}, Ctx())


def test_a_dev_test_customer_is_never_merged_into_a_twin(twin, tenant, aws):
    _set(aws, tenant, siteKind="test")
    _unset(aws, tenant, "twinOf")
    out = _mirror()
    assert out["error"] == "slug_used_by_test_customer"
    assert out["message"] == ("A dev test customer already uses the slug pizzeria-roma. Rename or delete it in "
                              "Booqy Console Dev, then create the twin.")
    profile = _profile(tenant)
    assert profile["siteKind"] == "test" and "twinOf" not in profile and profile["twinClash"]["prodTenantId"] == PROD_ID
    assert twin.self_invokes == []
    # and it gets no twin logic from the console either
    status, body = call("POST /platform/tenants/{tenantId}/dev-twin", {"tenantId": tenant})
    assert status == 409 and body["error"] == "not_a_twin"


def test_a_dev_customer_that_is_not_a_twin_is_left_alone(twin, tenant, aws):
    _unset(aws, tenant, "siteKind", "twinOf")
    out = _mirror()
    assert out["error"] == "slug_used_by_dev_customer" and "not a twin" in out["message"]
    assert "twinOf" not in _profile(tenant)
    assert devtwin.twin_task({"twinTask": {"tenantId": tenant}}, Ctx()) == {"status": "not_a_twin"}


def test_another_prod_customers_twin_is_never_taken_over(twin, tenant):
    out = _mirror(prod_id="t-prod-other")
    assert out["error"] == "slug_used_by_other_twin"
    assert _profile(tenant)["twinOf"]["tenantId"] == PROD_ID


def test_the_same_prod_customer_adopts_its_twin_and_marks_it(twin, tenant, aws):
    _unset(aws, tenant, "twinOf")
    out = _mirror()
    assert out == {"tenantId": tenant, "status": "adopted"}
    profile = _profile(tenant)
    assert profile["twinOf"]["env"] == "prod" and profile["twinOf"]["tenantId"] == PROD_ID
    assert "twinClash" not in profile


def test_anars_manual_dev_tenant_is_its_twin(twin, tenant, aws):
    assert devtwin.is_twin({"slug": "anar"}) and not devtwin.is_twin({"slug": "anar", "siteKind": "test"})
    assert devtwin.clash({"slug": "anar"}, "t-prod-anar") is None
    assert devtwin.clash({"slug": "roma"}, "t-prod-roma")[0] == "slug_used_by_dev_customer"


def test_prod_offboarding_only_flags_the_twin(twin, tenant, monkeypatch):
    from app import site
    archived = []
    monkeypatch.setattr(site, "invoke", lambda payload, **_: archived.append(payload) or {"status": "archived"})
    from app.handler import handler
    out = handler({"siteTask": {"action": "archive", "slug": "pizzeria-roma"}}, Ctx())
    assert out["status"] == "archived"
    profile = _profile(tenant)
    assert profile["status"] == "active" and profile["twinProdOffboardedAt"]   # flagged, not offboarded


def test_a_new_dev_test_customer_may_not_take_a_prod_slug(aws, monkeypatch):
    from conftest import NEW_TENANT
    monkeypatch.setenv("DEV_TWIN_PROD_API_URL", "https://prod.example")
    asked = []
    monkeypatch.setattr(devtwin, "prod_public", lambda path, **_: asked.append(path) or (
        {"tenant": {"slug": "pizzeria-roma", "tenantId": PROD_ID}} if "pizzeria-roma" in path else None))
    status, body = call("POST /platform/tenants", body=NEW_TENANT)
    assert status == 400 and "A prod customer uses this slug" in body["fields"]["slug"]
    assert asked == ["/site-config?host=pizzeria-roma.booqy.se"]
    status, _ = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "pizzeria-dev"})
    assert status == 202


# ------------------------------------------------- public content from prod
PROD_LOC = "p-loc-1"
PROD_SITE = {"tenant": {"tenantId": PROD_ID, "slug": "pizzeria-roma", "name": "Pizzeria Roma"},
             "locations": [{"locationId": PROD_LOC, "name": "Roma Södermalm", "address": "Götgatan 10, Stockholm",
                            "timezone": "Europe/Stockholm", "phoneNumber": "+46812345678", "email": "info@roma.se",
                            "businessHours": {**devtwin.HOURS, "monday": []}, "bookingDurationHours": 2.5,
                            "gracePeriodMinutes": 15, "maxPartySizeOnline": 10,
                            "specialDays": [{"date": "2026-12-24", "kind": "closed", "note": "Julafton"}],
                            "guarantee": {"enabled": True, "minPartySize": 8, "noShowFeePerPerson": 300,
                                          "lateCancelFeePerPerson": 0, "cancelCutoffHours": 48},
                            "ordering": {"enabled": False, "pickup": True, "prepMinutes": 25, "lastOrderMinutes": 10}}]}
PROD_MENU = {"categories": [{"categoryId": "pc1", "name": "Pizza"}, {"categoryId": "pc2", "name": "Drycker"}],
             "items": [
                 {"menuItemId": "pm1", "name": "Margherita", "description": "Tomat, mozzarella, basilika.", "price": 129,
                  "category": "pc1", "imageKey": "menu-images/t-prod-roma/locations/p-loc-1/menu/a.jpg",
                  "alcohol": False, "allergens": ["gluten", "milk"], "options": []},
                 {"menuItemId": "pm2", "name": "Äppelmust", "description": "Från Skåne.", "price": 49,
                  "category": "pc2", "imageKey": None, "alcohol": False, "allergens": [], "options": []}]}
PROD_LAYOUT = {"floors": [{"floorId": "p-floor", "name": "Matsal", "level": 0}], "elements": [
    {"elementId": "p-wall", "type": "wall", "floorId": "p-floor", "x": 0, "y": 0, "z": -5, "width": 12, "height": 1.8,
     "depth": 0.2, "rotationY": 0},
    {"elementId": "p-door", "type": "door", "kind": "entrance", "floorId": "p-floor", "wallId": "p-wall", "x": 2,
     "y": 0, "z": -5, "width": 1.6, "height": 2, "depth": 0.28, "rotationY": 0},
    {"elementId": "p-t1", "type": "table", "floorId": "p-floor", "label": "1", "seats": 4, "shape": "rect",
     "zone": "Mitten", "x": 1, "y": 0, "z": 1, "width": 1.4, "height": 0.75, "depth": 1, "rotationY": 0}]}


@pytest.fixture
def prod(twin, monkeypatch):
    from app import devtwin_content
    monkeypatch.setenv("DEV_TWIN_PROD_API_URL", "https://prod.example")
    monkeypatch.setenv("DEV_TWIN_PROD_IMAGE_URL", "https://images.prod.example")
    answers = {"/site-config?host=pizzeria-roma.booqy.se": PROD_SITE, f"/locations/{PROD_LOC}/menu": PROD_MENU,
               f"/locations/{PROD_LOC}/layout/active": PROD_LAYOUT}
    reads, transfers = [], []
    fake = lambda path, **_: reads.append(path) or json.loads(json.dumps(answers.get(path)))   # noqa: E731
    monkeypatch.setattr(devtwin, "prod_public", fake)
    monkeypatch.setattr(devtwin_content, "prod_public", fake)

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.close()

    def urlopen(request, timeout=None):
        transfers.append((request.get_method(), request.full_url))
        return Resp(b"\xff\xd8jpeg-bytes")
    monkeypatch.setattr(devtwin_content.urllib.request, "urlopen", urlopen)
    return {"answers": answers, "reads": reads, "transfers": transfers}


def _copy(tenant):
    return devtwin.twin_task({"twinTask": {"tenantId": tenant, "requestedBy": "op-1", "mode": "content"}}, Ctx())


def test_public_content_follows_prod_and_secrets_never_cross(twin, prod, tenant):
    _seed(tenant)                      # the fake twin first
    assert _copy(tenant) == {"status": "ready", "failed": []}
    loc = twin.location
    src = PROD_SITE["locations"][0]
    assert loc["businessHours"]["monday"] == [] and loc["bookingDurationHours"] == 2.5
    assert loc.get("gracePeriodHours", 0.25) == 0.25 and loc["maxPartySizeOnline"] == 10   # 15 min, already set
    assert loc["specialDays"] == src["specialDays"] and loc["guarantee"]["noShowFeePerPerson"] == 300
    assert loc.get("address", src["address"]) == src["address"]
    # never the restaurant's phone or email
    assert loc.get("phoneNumber") != src["phoneNumber"] and loc.get("email") != src["email"]
    assert src["phoneNumber"] not in json.dumps(twin.location) and src["email"] not in json.dumps(twin.location)
    # the menu mirrors prod's: its dishes in its categories, the seed's gone
    assert sorted(i["name"] for i in twin.items) == ["Margherita", "Äppelmust"]
    cats = {c["categoryId"]: c["name"] for c in twin.categories["categories"]}
    assert [c["name"] for c in twin.categories["categories"]] == ["Pizza", "Drycker"]
    marg = next(i for i in twin.items if i["name"] == "Margherita")
    assert cats[marg["category"]] == "Pizza" and marg["price"] == 129 and marg["allergens"] == ["gluten", "milk"]
    # the photo went prod CDN -> twin's own upload URL; the twin's key, never prod's
    assert marg["imageKey"].startswith(f"menu-images/{tenant}/")
    assert prod["transfers"] == [("GET", "https://images.prod.example/menu-images/t-prod-roma/locations/p-loc-1/menu/a.jpg"),
                                 ("PUT", "https://upload.example/1")]
    # prod's layout, with the twin's own ids, published and active
    assert sorted(e["type"] for e in twin.elements) == ["door", "floor", "table", "wall"]
    door = next(e for e in twin.elements if e["type"] == "door")
    assert door["wallId"] == next(e for e in twin.elements if e["type"] == "wall")["elementId"]
    assert twin.versions[-1]["isCurrent"]
    # only public reads of prod
    assert all(not r.startswith(("/tenant", "/platform")) for r in prod["reads"])


def test_copying_again_changes_nothing_until_prod_changes(twin, prod, tenant):
    _seed(tenant)
    _copy(tenant)
    writes, uploads, versions = len(twin.calls), twin.uploads, len(twin.versions)
    assert _copy(tenant)["status"] == "ready"
    assert twin.calls[writes:] == [] and twin.uploads == uploads and len(twin.versions) == versions
    prod["answers"][f"/locations/{PROD_LOC}/menu"]["items"][1]["price"] = 55
    _copy(tenant)
    assert [c for c in twin.calls[writes:] if c[0] == "manage-menu"] and twin.uploads == uploads
    assert next(i for i in twin.items if i["name"] == "Äppelmust")["price"] == 55


def test_nothing_is_copied_from_another_prod_customer(twin, prod, tenant):
    prod["answers"]["/site-config?host=pizzeria-roma.booqy.se"] = {
        **PROD_SITE, "tenant": {**PROD_SITE["tenant"], "tenantId": "t-prod-someone-else"}}
    out = _copy(tenant)
    assert out == {"status": "partial", "failed": ["source"]}
    assert twin.calls == []


def test_setup_completed_in_prod_queues_the_copy(twin, prod, tenant):
    from app.handler import handler
    out = handler({"siteTask": {"action": "content", "slug": "pizzeria-roma", "prodTenantId": PROD_ID}}, Ctx())
    assert out == {"tenantId": tenant, "status": "content_queued"}
    assert twin.self_invokes == [{"tenantId": tenant, "requestedBy": "prod-site-repo", "mode": "content"}]
    assert _profile(tenant)["devTwinContent"]["status"] == "queued"


def test_copy_button_in_the_dev_console(twin, prod, tenant):
    status, body = call("POST /platform/tenants/{tenantId}/dev-twin/content", {"tenantId": tenant})
    assert status == 202 and body["devTwinContent"]["status"] == "queued"
