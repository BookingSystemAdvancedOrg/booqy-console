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
        self.dishes, self.packages, self.tiers = [], [], []
        self.gift = {"enabled": False, "amountsSek": [250, 500, 1000], "customMinSek": 100, "customMaxSek": 5000,
                     "validityMonths": 24, "version": 0}
        self.wait = {"enabled": False, "holdMinutes": 10, "maxWaiting": 30, "publicJoin": False, "version": 0}
        self.events = {}

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
            key = {"PK": {"S": f"TENANT#{self.tenant}"}, "SK": {"S": f"LOCATION#{path.split('/')[2]}"}}
            row = core.from_ddb(self.aws["ddb"].get_item(TableName="dev-location", Key=key).get("Item") or {})
            if not row or not devtwin.resolves(self.tenant, row):     # as tenant.for_jwt: guests' lookup
                return 404, {"error": "location not found"}
            if not (body.get("timezone") or row.get("timezone")):      # create-location validates the whole row
                return 400, {"error": "timezone is required"}
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
        if fn == "catering-settings":
            return self._catering(method, path, route, body)
        if fn == "catering-discount-tiers":
            assert route == "/locations/{locationId}/catering/discount-tiers"
            if method == "GET":
                return 200, {"tiers": self.tiers}
            assert set(body) <= {"name", "fromPortions", "toPortions", "discountPercent", "active"}
            assert len(body["name"]) <= 40 and 0 <= body["discountPercent"] <= 50
            self.tiers.append({"tierId": f"t{len(self.tiers)}", **body})
            return 201, self.tiers[-1]
        if fn == "gift-cards":
            assert path == "/tenant/gift-cards/settings" and route is None
            if method == "PUT":
                assert set(body) == {"enabled", "amountsSek", "customMinSek", "customMaxSek", "validityMonths",
                                     "version"} and body["version"] == self.gift["version"]
                assert all(100 <= a <= 5000 for a in body["amountsSek"]) and 12 <= body["validityMonths"] <= 60
                self.gift = {**body, "version": body["version"] + 1}
            return 200, self.gift
        if fn == "waitlist":
            if method == "GET":
                assert route == "/locations/{locationId}/waitlist" and c["query"]["date"]
                return 200, {"settings": self.wait, "entries": [], "suggestions": []}
            assert route == "/locations/{locationId}/waitlist/settings" and body["version"] == self.wait["version"]
            assert set(body) == {"enabled", "publicJoin", "holdMinutes", "maxWaiting", "version"}
            self.wait = {**body, "version": body["version"] + 1}
            self._store_location(path.split("/")[2], {"waitlist": {"publicJoin": body["enabled"] and body["publicJoin"]}})
            return 200, self.wait
        if fn == "events-tickets":
            return self._events(method, path, route, body)
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

    def _catering(self, method, path, route, body):
        menu = "/locations/{locationId}/catering/menu"
        if route == "/locations/{locationId}/catering/settings":
            assert method == "PUT" and "originFound" not in body
            if body.get("notifyPhone"):
                assert devtwin.fiction_phone(body["notifyPhone"])
            key = {"PK": {"S": f"TENANT#{self.tenant}"}, "SK": {"S": f"LOCATION#{path.split('/')[2]}"}}
            row = core.from_ddb(self.aws["ddb"].get_item(TableName="dev-location", Key=key)["Item"])
            settings = {**devtwin._plain(row.get("cateringSettings") or {}), **body}
            if settings.get("enabled"):
                assert settings["pickup"] or settings["delivery"]
                if "deliveryBands" in settings:
                    assert settings["deliveryBands"][-1]["upToKm"] == settings["maxDeliveryKm"]
            self.catering = settings
            self._store_location(path.split("/")[2], {"cateringSettings": settings})
            return 200, {**settings, "originFound": True}
        kind = "dishes" if "/dishes" in route else "packages"
        rows = self.dishes if kind == "dishes" else self.packages
        if method == "GET":
            assert route == f"{menu}/{kind}"
            return 200, {kind: rows}
        if kind == "packages":
            assert set(body["dishIds"]) <= {d["dishId"] for d in self.dishes} and body["dishIds"]
            assert set(body) <= {"name", "description", "pricePerGuest", "dishIds", "minGuests", "active", "sort"}
        else:
            assert set(body) <= {"name", "description", "pricePerPortion", "allergens", "dietary", "active", "sort",
                                 "sourceMenuItemId", "version"}
            assert set(body.get("allergens") or []) <= set(devtwin.CATERING_ALLERGENS)
            assert 0 < body["pricePerPortion"] <= 10000
        if method == "PUT":
            assert route == f"{menu}/dishes/{{dishId}}"
            dish = next(d for d in self.dishes if d["dishId"] == path.rsplit("/", 1)[1])
            assert body["version"] == dish["version"]
            dish.update({**body, "version": body["version"] + 1})
            return 200, dish
        assert method == "POST" and route == f"{menu}/{kind}"
        rows.append({("dishId" if kind == "dishes" else "packageId"): f"{kind[0]}{len(rows)}", **body, "version": 1})
        return 201, rows[-1]

    def _events(self, method, path, route, body):
        base = "/locations/{locationId}/events"
        if route == base and method == "GET":
            return 200, {"events": [{k: e[k] for k in ("eventId", "title", "status", "nextOccurrence")}
                                    for e in self.events.values()]}
        if route == base:
            assert set(body) <= {"eventId", "title", "description", "occurrences", "ticketTypes", "settings"}
            assert len(body["eventId"]) <= 40 and body["eventId"].isidentifier()
            from datetime import datetime, timezone
            occ = body["occurrences"][0]
            start, end = datetime.fromisoformat(occ["startAt"]), datetime.fromisoformat(occ["endAt"])
            assert start.tzinfo and start > datetime.now(timezone.utc) and start < end
            assert len(body["ticketTypes"]) == 2 and all(t["vatRate"] in (25, 12, 6) for t in body["ticketTypes"])
            self.events[body["eventId"]] = {"eventId": body["eventId"], "title": body["title"], "status": "draft",
                                            "version": 1, "nextOccurrence": occ["startAt"]}
            return 201, self.events[body["eventId"]]
        event = self.events[path.split("/")[4]]
        if route == base + "/{eventId}":
            return 200, event
        assert route == base + "/{eventId}/publish" and body == {"version": event["version"]}
        event.update(status="published", version=event["version"] + 1)
        return 200, event

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
    monkeypatch.setattr(devtwin, "FEATURES_SETTLE_SECONDS", 0)
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
    # owner: a team login, never the restaurant's; its own details replaced with fake ones
    profile = _profile(tenant)
    assert profile["ownerEmail"] == "aws+pizzeria-roma@ithjalparna.se"
    assert profile["legalName"] == "Pizzeria Roma Test AB" and profile["orgNumber"] == devtwin.LEGAL_ORG_NUMBER
    assert profile["contactEmail"] == "aws+pizzeria-roma@ithjalparna.se" and profile["address"] == devtwin.LEGAL_ADDRESS
    assert profile["contactPhone"] == devtwin.PHONE and "Roma Restaurang AB" not in json.dumps(profile)
    # every guest-facing feature on, whatever the plan (starter here)
    features = profile["entitlements"]["features"]
    assert all(features[k] for k in devtwin.TWIN_FEATURES)
    assert profile["entitlements"]["limits"]["phoneAgentMinutesPerMonth"] == 100
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
    # fake contact data on the location (the restaurant's own phone and address replaced)
    assert loc["phoneNumber"] == devtwin.PHONE and loc["address"] == devtwin.ADDRESS
    assert loc["email"] == "aws+pizzeria-roma@ithjalparna.se"
    # catering: settings with test terms, dishes from the menu with allergens, a package, a tier
    assert twin.catering["enabled"] and twin.catering["terms"] == devtwin.CATERING_TERMS
    assert twin.catering["notifyPhone"] == devtwin.PHONE and twin.catering["allowSimpleAcceptance"]
    names = {d["name"] for d in twin.dishes}
    assert names == {"Toast Skagen", "Burrata", "Pannbiff med lök", "Grillad lax", "Svamprisotto", "Kladdkaka",
                     "Crème brûlée"}
    assert next(d for d in twin.dishes if d["name"] == "Toast Skagen")["allergens"] == [
        "gluten", "crustaceans", "eggs", "fish", "milk"]
    assert all(d["sourceMenuItemId"] for d in twin.dishes)
    assert len(twin.packages) == 1 and len(twin.packages[0]["dishIds"]) == 3 and len(twin.tiers) == 1
    # gift cards, waitlist with public join, one published test evening
    assert twin.gift["enabled"] and twin.gift["amountsSek"] == [250, 500, 1000]
    assert twin.wait["enabled"] and twin.wait["publicJoin"]
    assert [(e["title"], e["status"]) for e in twin.events.values()] == [("Testkväll", "published")]
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


# ------------------------------------------- guest features and fake data (2026-11-24)
def test_fiction_phone_range():
    assert devtwin.fiction_phone("+46701740605") and devtwin.fiction_phone("070-174 06 99")
    assert devtwin.fiction_phone("0046 8 465 004 00") and devtwin.fiction_phone("+46313900650")
    assert not devtwin.fiction_phone("+46701740604") and not devtwin.fiction_phone("+46812345678")
    assert not devtwin.fiction_phone("+46 8 123 45") and not devtwin.fiction_phone(None)


def test_every_guest_feature_stays_on_through_a_plan_change(twin, tenant):
    _seed(tenant)
    status, body = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "starter"})
    assert status == 200, body
    ent = _profile(tenant)["entitlements"]
    assert all(ent["features"][k] for k in devtwin.TWIN_FEATURES) and ent["limits"]["phoneAgentMinutesPerMonth"] == 100


def test_a_dev_test_customer_keeps_its_plan(twin, tenant, aws):
    _set(aws, tenant, siteKind="test")
    _unset(aws, tenant, "twinOf")
    status, _ = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "starter"})
    assert status == 200
    assert not _profile(tenant)["entitlements"]["features"].get("giftCards")


def test_a_new_twin_has_every_guest_feature_from_the_mirror(twin):
    out = _mirror(slug="roma-ny")
    assert out["status"] == "created"
    features = _profile(out["tenantId"])["entitlements"]["features"]
    assert all(features[k] for k in devtwin.TWIN_FEATURES)


def test_a_legacy_twins_real_contact_data_is_replaced(twin, tenant, aws, monkeypatch):
    monkeypatch.setenv("DEV_TWIN_PROD_API_URL", "https://prod.example")
    monkeypatch.setattr(devtwin, "prod_public", lambda path, **_: {
        "tenant": {"slug": "pizzeria-roma", "tenantId": PROD_ID},
        "locations": [{"phoneNumber": "+46701740640"}], "legal": {"contactPhone": None}})
    location_id = call("GET /platform/tenants/{tenantId}/locations", {"tenantId": tenant})[1]["locations"][0]["locationId"]
    twin._store_location(location_id, {"address": "Storgatan 5, 582 22 Linköping", "phoneNumber": "+46701740640",
                                       "email": "anna.privat@example.se",
                                       "cateringSettings": {"enabled": True, "pickup": True, "delivery": False,
                                                            "minGuests": 20, "notifyPhone": "+46731234567",
                                                            "notifyEmail": "anna.privat@example.se", "terms": ""}})
    twin.dishes.append({"dishId": "own", "name": "Grillad lax", "description": "", "pricePerPortion": 189,
                        "allergens": [], "dietary": [], "active": True, "sort": 0, "version": 3})
    assert _seed(tenant)["status"] == "ready"
    loc = twin.location
    # prod's own number is never the twin's, even inside the fiction range
    assert loc["phoneNumber"] == devtwin.PHONE and loc["address"] == devtwin.ADDRESS
    assert loc["email"] == "aws+pizzeria-roma@ithjalparna.se"
    # hand-made catering kept; only the real contacts and the missing terms replaced
    assert twin.catering["minGuests"] == 20 and twin.catering["delivery"] is False
    assert twin.catering["notifyPhone"] == devtwin.PHONE and twin.catering["terms"] == devtwin.CATERING_TERMS
    assert twin.catering["notifyEmail"] == "aws+pizzeria-roma@ithjalparna.se"
    own = next(d for d in twin.dishes if d["dishId"] == "own")
    assert own["allergens"] == ["fish", "milk"] and own["pricePerPortion"] == 189 and own["version"] == 4
    assert len([d for d in twin.dishes if d["name"] == "Grillad lax"]) == 1


def test_prods_public_address_stays_after_a_content_copy(twin, tenant, aws):
    location_id = call("GET /platform/tenants/{tenantId}/locations", {"tenantId": tenant})[1]["locations"][0]["locationId"]
    twin._store_location(location_id, {"address": "Götgatan 10, Stockholm", "phoneNumber": devtwin.PHONE,
                                       "email": "aws+pizzeria-roma@ithjalparna.se"})
    _set(aws, tenant, devTwinContent={"status": "ready", "steps": {"location": {"ok": True}}})
    _seed(tenant)
    assert "address" not in twin.location or twin.location["address"] == "Götgatan 10, Stockholm"


def test_a_past_test_evening_gets_a_new_one_and_an_upcoming_one_is_kept(twin, tenant):
    twin.events["testkvall20250101"] = {"eventId": "testkvall20250101", "title": "Testkväll", "status": "published",
                                        "version": 2, "nextOccurrence": None}
    _seed(tenant)
    assert len(twin.events) == 2 and all(e["status"] == "published" for e in twin.events.values())
    writes = len(twin.calls)
    _seed(tenant)
    assert [c for c in twin.calls[writes:] if c[0] == "events-tickets"] == []


def test_a_draft_test_evening_is_published(twin, tenant):
    twin.events["testkvall20991231"] = {"eventId": "testkvall20991231", "title": "Testkväll", "status": "draft",
                                        "version": 1, "nextOccurrence": "2099-12-31T18:00:00Z"}
    _seed(tenant)
    assert list(twin.events) == ["testkvall20991231"] and twin.events["testkvall20991231"]["status"] == "published"


def test_refresh_all_dev_twins_queues_every_active_twin(twin, tenant, aws):
    other = _mirror(slug="roma-ny")["tenantId"]
    _set(aws, other, status="active", devTwin={"status": "ready", "steps": {}})
    twin.self_invokes.clear()
    status, body = _refresh_all(tenant)
    assert status == 202 and body == {"queued": ["pizzeria-roma", "roma-ny"], "skipped": []}
    assert sorted(t["tenantId"] for t in twin.self_invokes) == sorted([tenant, other])
    assert _profile(other)["devTwin"]["status"] == "queued"
    # a second press while they run starts nothing new
    status, body = _refresh_all(tenant)
    assert body["queued"] == [] and {s["reason"] for s in body["skipped"]} == {"Already running"}
    assert len(twin.self_invokes) == 2


def _refresh_all(tenant):
    from app.handler import handler
    resp = handler({"routeKey": "POST /platform/tenants/{tenantId}/dev-twin", "pathParameters": {"tenantId": tenant},
                    "body": json.dumps({"all": True}), "requestContext": {"authorizer": {"jwt": {"claims": {
                        "username": "op-1", "cognito:groups": "[platform_admin]"}}}}}, Ctx())
    return resp["statusCode"], json.loads(resp["body"])


def test_refresh_all_leaves_test_customers_alone_and_never_runs_in_prod(twin, tenant, aws, monkeypatch):
    _set(aws, tenant, siteKind="test")
    _unset(aws, tenant, "twinOf")
    status, body = call("POST /platform/tenants/{tenantId}/dev-twin", {"tenantId": tenant}, body={"all": True})
    assert status == 202 and body == {"queued": [], "skipped": []} and twin.self_invokes == []
    monkeypatch.setenv("ENVIRONMENT", "prod")
    assert call("POST /platform/tenants/{tenantId}/dev-twin", {"tenantId": tenant}, body={"all": True})[0] == 404


def test_twin_features_are_never_set_in_prod(twin, tenant, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "prod")
    assert not devtwin.applies_to(_profile(tenant))
    status, _ = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "starter"})
    assert status == 200
    assert not _profile(tenant)["entitlements"]["features"].get("giftCards")


def test_the_waitlist_is_switched_on_even_when_its_queue_view_fails(twin, tenant):
    original = twin.answer

    def no_queue(fn, c):
        if fn == "waitlist" and c["method"] == "GET":
            return 503, {"error": "service_unavailable"}
        return original(fn, c)
    twin.answer = no_queue
    assert _seed(tenant)["status"] == "ready"
    assert twin.wait["enabled"] and twin.wait["publicJoin"] and twin.wait["maxWaiting"] == 50


def test_the_test_evening_skips_christmas_and_new_year(twin, tenant, monkeypatch):
    monkeypatch.setattr(devtwin, "_today", lambda tz: date(2026, 11, 24))
    _seed(tenant)
    assert list(twin.events) == ["testkvall20261226"]


# ------------------------------------------------ review fixes (2026-11-24)
def _location_id(tenant):
    return call("GET /platform/tenants/{tenantId}/locations", {"tenantId": tenant})[1]["locations"][0]["locationId"]


def _lkey(tenant, location_id):
    return {"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": f"LOCATION#{location_id}"}}


def _max_locations(aws, tenant, n):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET entitlements.maxLocations = :n",
                           ExpressionAttributeValues={":n": {"N": str(n)}})


def test_a_location_without_tenant_id_is_made_reachable_for_guests(twin, tenant, aws):
    location_id = _location_id(tenant)
    aws["ddb"].update_item(TableName="dev-location", Key=_lkey(tenant, location_id), UpdateExpression="REMOVE tenantId")
    assert _seed(tenant)["status"] == "ready"
    row = core.from_ddb(aws["ddb"].get_item(TableName="dev-location", Key=_lkey(tenant, location_id))["Item"])
    assert row["tenantId"] == tenant and row["locationId"] == location_id
    assert "tenantId set on location" in _profile(tenant)["devTwin"]["steps"]["location"]["note"]
    assert len(call("GET /platform/tenants/{tenantId}/locations", {"tenantId": tenant})[1]["locations"]) == 1
    assert devtwin.resolves(tenant, row)


def test_a_location_id_another_customer_also_holds_gets_a_fresh_location(twin, tenant, aws):
    location_id = _location_id(tenant)
    aws["ddb"].put_item(TableName="dev-location", Item={
        "PK": {"S": "TENANT#t-other"}, "SK": {"S": f"LOCATION#{location_id}"}, "tenantId": {"S": "t-other"},
        "locationId": {"S": location_id}})
    out = _seed(tenant)        # the plan allows one location: the step says why
    assert out["failed"][0] == "location"
    assert f"Guests can't reach location {location_id}" in _profile(tenant)["devTwin"]["steps"]["location"]["note"]
    _max_locations(aws, tenant, 2)
    assert _seed(tenant)["status"] == "ready"
    rows = call("GET /platform/tenants/{tenantId}/locations", {"tenantId": tenant})[1]["locations"]
    fresh = next(r for r in rows if r["locationId"] != location_id)
    # the seed worked on the fresh one (its hours, guarantee, menu calls)
    assert fresh["businessHours"] == devtwin.HOURS and fresh["guarantee"]["enabled"]
    assert all(f"/locations/{location_id}" not in c[2] for c in twin.calls)
    assert fresh["address"] == devtwin.ADDRESS and devtwin.resolves(tenant, core.from_ddb(aws["ddb"].get_item(
        TableName="dev-location", Key=_lkey(tenant, fresh["locationId"]))["Item"]))
    # the old row guests can't reach (create-location answers 404 for it) still gets fake contact data,
    # through the console's own location edit
    old = core.from_ddb(aws["ddb"].get_item(TableName="dev-location", Key=_lkey(tenant, location_id))["Item"])
    assert old["phoneNumber"] == devtwin.PHONE and old["email"] == "aws+pizzeria-roma@ithjalparna.se"
    assert old["address"] == devtwin.ADDRESS and _profile(tenant)["devTwin"]["steps"]["details"]["ok"]


def test_a_legacy_location_without_a_timezone_gets_one(twin, tenant, aws):
    location_id = _location_id(tenant)
    aws["ddb"].update_item(TableName="dev-location", Key=_lkey(tenant, location_id), UpdateExpression="REMOVE #tz",
                           ExpressionAttributeNames={"#tz": "timezone"})
    assert _seed(tenant)["status"] == "ready"
    row = core.from_ddb(aws["ddb"].get_item(TableName="dev-location", Key=_lkey(tenant, location_id))["Item"])
    assert row["timezone"] == devtwin.TIMEZONE


def test_guest_steps_wait_once_for_the_functions_tenant_cache(twin, tenant, monkeypatch):
    import time
    slept = []
    monkeypatch.setattr(devtwin, "FEATURES_SETTLE_SECONDS", 61)
    monkeypatch.setattr(time, "sleep", slept.append)
    assert _seed(tenant)["status"] == "ready"
    assert len(slept) == 1 and 0 < slept[0] <= 61       # features went on this run: one wait, then every guest step
    slept.clear()
    assert _seed(tenant)["status"] == "ready" and slept == []    # nothing turned on: no wait


def test_a_failing_catering_settings_call_never_blocks_the_location_details(twin, tenant):
    from botocore.exceptions import ClientError
    location_id = _location_id(tenant)
    twin._store_location(location_id, {"phoneNumber": "+46812345678", "email": "anna.privat@example.se",
                                       "cateringSettings": {"enabled": True, "pickup": True,
                                                            "notifyPhone": "+46731234567"}})
    original = twin.invoke

    def denied(**kwargs):
        if "catering-settings" in kwargs["FunctionName"]:
            raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "not allowed"}}, "Invoke")
        return original(**kwargs)
    twin.invoke = denied
    assert _seed(tenant) == {"status": "partial", "failed": ["catering"]}
    assert twin.location["phoneNumber"] == devtwin.PHONE and twin.location["email"] == "aws+pizzeria-roma@ithjalparna.se"
    assert twin.location["guarantee"]["enabled"] and twin.location["ordering"]["enabled"]


def test_catering_switched_off_goes_back_on_with_the_developers_settings(twin, tenant):
    own = {"enabled": False, "pickup": False, "delivery": True, "minGuests": 30, "minPortions": 20,
           "deliveryBands": [{"upToKm": 5, "price": 100}], "maxDeliveryKm": 5, "terms": "Egna testvillkor",
           "leadTimeRules": [{"fromGuests": 30, "toGuests": None, "days": 3}], "deliveryArea": "",
           "notifyEmail": "aws+pizzeria-roma@ithjalparna.se", "notifyPhone": "+46701740650"}
    twin._store_location(_location_id(tenant), {"cateringSettings": own})
    assert _seed(tenant)["status"] == "ready"
    c = twin.catering
    assert c["enabled"] is True and c["pickup"] is False and c["delivery"] is True
    assert c["minGuests"] == 30 and c["minPortions"] == 20 and c["terms"] == "Egna testvillkor"
    assert c["deliveryBands"] == [{"upToKm": 5, "price": 100}] and c["maxDeliveryKm"] == 5
    assert c["leadTimeRules"] == own["leadTimeRules"] and c["notifyPhone"] == "+46701740650"
    assert c["deliveryArea"] == devtwin.CATERING["deliveryArea"]      # empty: the seed's


def test_catering_off_with_neither_pickup_nor_delivery_gets_pickup(twin, tenant):
    twin._store_location(_location_id(tenant), {"cateringSettings": {"enabled": False, "pickup": False,
                                                                     "delivery": False}})
    assert _seed(tenant)["status"] == "ready"
    assert twin.catering["enabled"] and twin.catering["pickup"] is True and twin.catering["delivery"] is False


def test_a_developers_draft_called_testkvall_is_never_published(twin, tenant):
    twin.events["jazz1"] = {"eventId": "jazz1", "title": "Testkväll med jazz", "status": "draft", "version": 1,
                            "nextOccurrence": "2099-12-31T18:00:00Z"}
    _seed(tenant)
    assert twin.events["jazz1"]["status"] == "draft"
    seeds = [e for e in twin.events.values() if devtwin.SEED_EVENT_ID.fullmatch(e["eventId"])]
    assert len(seeds) == 1 and seeds[0]["status"] == "published"


def test_a_cancelled_seed_evening_on_the_same_day_gets_the_next_day(twin, tenant, monkeypatch):
    monkeypatch.setattr(devtwin, "_today", lambda tz: date(2026, 11, 24))
    twin.events["testkvall20261226"] = {"eventId": "testkvall20261226", "title": "Testkväll", "status": "cancelled",
                                        "version": 2, "nextOccurrence": "2026-12-26T18:00:00Z"}
    _seed(tenant)
    assert twin.events["testkvall20261227"]["status"] == "published"
    assert twin.events["testkvall20261226"]["status"] == "cancelled"


def test_a_developers_fake_seller_details_stay_and_real_contacts_go(twin, tenant, aws):
    _seed(tenant)
    own = {"legalName": "Provbolaget Test AB", "vatNumber": f"SE{devtwin.LEGAL_ORG_NUMBER.replace('-', '')}01",
           "address": {"street": "Provgatan 2", "postalCode": "582 22", "city": "Linköping", "country": "SE"},
           "contactEmail": "anna@ithjalparna.se", "replyToEmail": "svar@restaurang.se",
           "billingEmail": "aws+faktura@ithjalparna.se", "contactPhone": "+46701740650"}
    _set(aws, tenant, **own)
    _seed(tenant)
    p = _profile(tenant)
    assert p["legalName"] == own["legalName"] and p["address"] == own["address"] and p["vatNumber"] == own["vatNumber"]
    assert p["contactPhone"] == "+46701740650" and p["billingEmail"] == "aws+faktura@ithjalparna.se"
    # a person's mailbox at the team domain is not a team address
    assert p["contactEmail"] == "aws+pizzeria-roma@ithjalparna.se" and p["replyToEmail"] == p["contactEmail"]
    # the restaurant's org. number (an older mirror) takes all its seller details with it
    _set(aws, tenant, orgNumber="556677-8899")
    _seed(tenant)
    p = _profile(tenant)
    assert p["orgNumber"] == devtwin.LEGAL_ORG_NUMBER and p["legalName"] == "Pizzeria Roma Test AB"
    assert p["address"] == devtwin.LEGAL_ADDRESS


def test_the_test_org_number_is_valid_and_in_no_issued_group():
    from app.validation import luhn_ok
    digits = devtwin.LEGAL_ORG_NUMBER.replace("-", "")
    assert luhn_ok(digits) and digits[0] == "4" and int(digits[2]) >= 2


def test_team_addresses(twin):
    slug = "pizzeria-roma"
    assert devtwin.team_email("aws+pizzeria-roma@ithjalparna.se", slug)
    assert devtwin.team_email("AWS+annat@ithjalparna.se", slug) and devtwin.team_email("aws@ithjalparna.se", slug)
    assert not devtwin.team_email("anna@ithjalparna.se", slug) and not devtwin.team_email("aws+@ithjalparna.se", slug)
    assert not devtwin.team_email("aws+x@example.se", slug) and not devtwin.team_email(None, slug)


def test_every_location_of_the_twin_gets_fake_contact_data(twin, tenant, aws):
    _max_locations(aws, tenant, 2)
    aws["ddb"].put_item(TableName="dev-location", Item=core.to_ddb({
        "PK": f"TENANT#{tenant}", "SK": "LOCATION#loc-2", "tenantId": tenant, "locationId": "loc-2",
        "createdAt": "2999-01-01T00:00:00.000Z", "name": "Roma Vasastan", "address": "Odengatan 3, Stockholm",
        "timezone": "Europe/Stockholm", "phoneNumber": "+46812345679", "email": "vasa@roma.se"}))
    assert _seed(tenant)["status"] == "ready"
    second = core.from_ddb(aws["ddb"].get_item(TableName="dev-location", Key=_lkey(tenant, "loc-2"))["Item"])
    assert second["phoneNumber"] == devtwin.PHONE and second["email"] == "aws+pizzeria-roma@ithjalparna.se"
    assert second["address"] == devtwin.ADDRESS and second["name"] == "Roma Vasastan" and "businessHours" not in second


def test_two_quick_presses_start_one_seed(twin, tenant):
    assert devtwin.kick(tenant, "op-1", SELF) is not None
    assert devtwin.kick(tenant, "op-2", SELF) is None
    assert len(twin.self_invokes) == 1 and _profile(tenant)["devTwin"]["requestedBy"] == "op-1"


def test_a_seed_the_timeout_killed_can_be_started_again(twin, tenant, aws):
    _set(aws, tenant, devTwin={"status": "running", "startedAt": "2026-01-01T00:00:00.000Z", "steps": {}})
    status, body = call("POST /platform/tenants/{tenantId}/dev-twin", {"tenantId": tenant})
    assert status == 202 and body["devTwin"]["status"] == "queued" and _profile(tenant)["devTwin"]["status"] == "queued"
    _set(aws, tenant, devTwin={"status": "running", "startedAt": "2026-01-01T00:00:00.000Z", "steps": {}})
    assert _refresh_all(tenant)[1]["queued"] == ["pizzeria-roma"] and len(twin.self_invokes) == 1
    # a fresh run is left alone
    _set(aws, tenant, devTwin={"status": "running", "startedAt": core.now_iso(), "steps": {}})
    status, body = call("POST /platform/tenants/{tenantId}/dev-twin", {"tenantId": tenant})
    assert body["devTwin"]["status"] == "running" and _refresh_all(tenant)[1]["queued"] == []


def test_refresh_all_caps_and_skips(twin, tenant, aws, monkeypatch):
    onboarding = _mirror(slug="roma-ny")["tenantId"]
    _set(aws, onboarding, status="provisioning", devTwin={"status": "ready", "steps": {}})
    paused = _mirror(slug="roma-paus")["tenantId"]
    _set(aws, paused, status="suspended", devTwin={"status": "ready", "steps": {}})
    twin.self_invokes.clear()
    monkeypatch.setattr(devtwin, "REFRESH_ALL_MAX", 1)
    status, body = _refresh_all(tenant)
    assert status == 202 and body["queued"] == ["pizzeria-roma"]
    assert {s["slug"]: s["reason"] for s in body["skipped"]} == {
        "roma-ny": "Too many at once. Refresh all again when these are done.", "roma-paus": "Customer is suspended"}
    monkeypatch.setattr(devtwin, "REFRESH_ALL_MAX", 50)
    _set(aws, tenant, devTwin={"status": "ready", "steps": {}})
    assert _refresh_all(tenant)[1]["queued"] == ["pizzeria-roma", "roma-ny"]     # onboarding: the seed waits


@pytest.mark.parametrize("environment", ["prod", None, "Dev"])
def test_anars_real_tenant_in_prod_keeps_its_plan(twin, tenant, aws, monkeypatch, environment):
    _unset(aws, tenant, "siteKind", "twinOf")
    _set(aws, tenant, slug="anar")
    monkeypatch.setenv("DEV_TWIN_FUNCTION_PREFIX", "")
    if environment is None:
        monkeypatch.delenv("ENVIRONMENT")
    else:
        monkeypatch.setenv("ENVIRONMENT", environment)
    profile = _profile(tenant)
    assert devtwin.is_twin(profile) and not devtwin.applies_to(profile)
    monkeypatch.setenv("DEV_TWIN_FUNCTION_PREFIX", PREFIX)       # even a stray prefix: only ENVIRONMENT dev
    assert not devtwin.applies_to(profile) and not devtwin.enabled()
    if environment == "prod":
        status, _ = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "starter"})
        assert status == 200
        features = _profile(tenant)["entitlements"]["features"]
        assert not features.get("giftCards") and not features.get("phoneAgent")
