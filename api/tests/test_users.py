"""The Users tab: every sign-in account of a customer, owners and staff.
manage-user and tenant-account are faked here (their own rules are tested in
the application repo); this checks what the console adds: routing, the last
owner guard, the contact owner, system accounts, errors and the audit."""

import io
import json

import pytest

from app import core
from conftest import call

U = "/platform/tenants/{tenantId}/users/{userId}"
LOC = "loc-1"


class FakeFunctions:
    """manage-user and tenant-account answering console calls (as API Gateway responses)."""

    def __init__(self, aws, tenant):
        self.aws, self.tenant, self.calls, self.n = aws, tenant, [], 0
        self.access = {"areas": ["statistik", "bokningar", "personal"], "defaults": ["bokningar"], "users": {}, "version": 3}
        self.fail = None

    def _row(self, sub):
        return self.aws["ddb"].get_item(TableName="dev-user", Key={"PK": {"S": f"USER#{sub}"}, "SK": {"S": "PROFILE"}}).get("Item")

    def _set(self, sub, **fields):
        names = {f"#k{i}": k for i, k in enumerate(fields)}
        values = {f":v{i}": {"S": val} for i, val in enumerate(fields.values())}
        self.aws["ddb"].update_item(TableName="dev-user", Key={"PK": {"S": f"USER#{sub}"}, "SK": {"S": "PROFILE"}},
                                    UpdateExpression="SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(fields))),
                                    ExpressionAttributeNames=names, ExpressionAttributeValues=values)

    def answer(self, fn, c):
        if self.fail:
            return self.fail
        method, path, body = c["method"], c["path"], c.get("body") or {}
        if fn == "tenant-account":
            if method == "GET":
                return 200, {"staffAccess": self.access}
            self.access = {**self.access, "users": {**self.access["users"], **body["staffAccess"]["users"]},
                           "version": self.access["version"] + 1}
            return 200, {}
        parts = path.strip("/").split("/")
        if parts == ["users", "invite"]:
            self.n += 1
            sub = f"staff-{self.n}"
            item = {"PK": f"USER#{sub}", "SK": "PROFILE", "cognitoSub": sub, "tenantId": self.tenant, "role": "staff",
                    "locationId": body["locationId"], "name": body["name"], "email": body["email"],
                    "phone": body["phone"], "status": "active", "createdAt": "2026-11-18T10:00:00Z"}
            self.aws["ddb"].put_item(TableName="dev-user", Item={k: {"S": val} for k, val in item.items()})
            return 201, item
        sub = parts[1]
        if not self._row(sub):
            return 404, {"error": "user not found"}
        if method == "DELETE":
            self.aws["ddb"].delete_item(TableName="dev-user", Key={"PK": {"S": f"USER#{sub}"}, "SK": {"S": "PROFILE"}})
            return 204, None
        if len(parts) == 3 and parts[2] == "group":
            self._set(sub, role="owner_user" if body["group"] == "owner_user" else "staff", locationId=body["locationId"])
        elif len(parts) == 3:
            self._set(sub, status="disabled" if parts[2] == "deactivate" else "active")
        else:
            self._set(sub, **body)
        return 200, {}

    def invoke(self, **kwargs):
        fn = "tenant-account" if "tenant-account" in kwargs["FunctionName"] else "manage-user"
        c = json.loads(kwargs["Payload"])["booqyConsole"]
        assert c["tenantId"] == self.tenant and c["operator"] == "op-1"
        self.calls.append((fn, c["method"], c["path"], c.get("body")))
        status, body = self.answer(fn, c)
        out = {"statusCode": status, "body": json.dumps(body) if body is not None else ""}
        return {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(out).encode())}


@pytest.fixture
def fns(aws, tenant, monkeypatch):
    monkeypatch.setenv("MANAGE_USER_FUNCTION_ARN", "arn:aws:lambda:eu-north-1:1:function:dev-manage-user:live")
    monkeypatch.setenv("TENANT_ACCOUNT_FUNCTION_ARN", "arn:aws:lambda:eu-north-1:1:function:dev-tenant-account:live")
    fake = FakeFunctions(aws, tenant)
    core._clients["lambda"] = fake
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :a", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":a": {"S": "active"}})
    return fake


def _owner(tenant, email, name):
    status, body = call("POST /platform/tenants/{tenantId}/users", {"tenantId": tenant},
                        {"role": "owner_user", "email": email, "name": name})
    assert status == 201, body
    return body["user"]["cognitoSub"]


def _staff(tenant, **extra):
    status, body = call("POST /platform/tenants/{tenantId}/users", {"tenantId": tenant},
                        {"role": "staff_user", "email": "kim@roma.se", "name": "Kim", "phone": "070-123 45 67",
                         "locationId": LOC, **extra})
    assert status == 201, body
    return body["user"]["cognitoSub"]


def _audit(tenant):
    return call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["audit"]


def _users(tenant):
    return call("GET /platform/tenants/{tenantId}/users", {"tenantId": tenant})[1]


def test_invite_staff_through_manage_user_with_permissions(fns, tenant):
    sub = _staff(tenant, access={"add": ["personal"], "remove": [], "version": 3})
    assert ("manage-user", "POST", "/users/invite",
            {"name": "Kim", "email": "kim@roma.se", "phone": "+46701234567", "group": "staff_user", "locationId": LOC}) in fns.calls
    assert fns.access["users"][sub] == {"add": ["personal"], "remove": []}
    listed = _users(tenant)
    row = next(u for u in listed["users"] if u["cognitoSub"] == sub)
    assert row["role"] == "staff_user" and row["phone"] == "+46701234567"
    assert listed["access"]["version"] == 4
    assert _audit(tenant)[0]["action"] == "user_invited"


def test_edit_staff_name_location_and_permissions(fns, tenant):
    sub = _staff(tenant)
    p = {"tenantId": tenant, "userId": sub}
    status, body = call(f"PATCH {U}", p, {"name": "Kim Berg", "locationId": "loc-2",
                                          "access": {"add": [], "remove": ["bokningar"], "version": 3}})
    assert status == 200, body
    assert ("manage-user", "PUT", f"/users/{sub}", {"name": "Kim Berg", "locationId": "loc-2"}) in fns.calls
    assert fns.access["users"][sub] == {"add": [], "remove": ["bokningar"]}
    entry = _audit(tenant)[0]
    assert entry["action"] == "user_updated" and entry["details"]["fields"] == ["locationId", "name", "access"]
    assert call(f"PATCH {U}", p, {"name": "Kim Berg"})[0] == 400          # nothing changed


def test_promote_staff_to_owner_and_back_keeps_one_owner(fns, tenant):
    sub = _staff(tenant)
    p = {"tenantId": tenant, "userId": sub}
    assert call(f"PATCH {U}", p, {"role": "owner_user"})[0] == 200
    assert ("manage-user", "PUT", f"/users/{sub}/group", {"group": "owner_user", "locationId": ""}) in fns.calls
    # the only active owner can't become staff
    status, body = call(f"PATCH {U}", p, {"role": "staff_user", "locationId": LOC})
    assert status == 409 and body["error"] == "last_owner"
    _owner(tenant, "anna@roma.se", "Anna")
    assert call(f"PATCH {U}", p, {"role": "staff_user", "locationId": LOC})[0] == 200
    assert _audit(tenant)[0]["details"]["roleTo"] == "staff_user"


def test_disable_enable_and_the_last_owner(fns, tenant):
    owner = _owner(tenant, "anna@roma.se", "Anna")
    staff = _staff(tenant)
    assert call(f"POST {U}/disable", {"tenantId": tenant, "userId": owner})[1]["error"] == "last_owner"
    status, body = call(f"POST {U}/disable", {"tenantId": tenant, "userId": staff})
    assert status == 200 and body["user"]["status"] == "disabled"
    assert _audit(tenant)[0]["action"] == "user_disabled"
    assert call(f"POST {U}/enable", {"tenantId": tenant, "userId": staff})[1]["user"]["status"] == "active"
    assert _audit(tenant)[0]["action"] == "user_enabled"


def test_remove_staff_and_owner(fns, tenant):
    first = _owner(tenant, "owner@roma.se", "Maria")
    staff = _staff(tenant, access={"add": ["personal"], "remove": [], "version": 3})
    assert call(f"DELETE {U}", {"tenantId": tenant, "userId": first})[1]["error"] == "last_owner"
    assert call(f"DELETE {U}", {"tenantId": tenant, "userId": staff})[0] == 200
    assert ("manage-user", "DELETE", f"/users/{staff}", None) in fns.calls
    assert fns.access["users"][staff] is None                    # their own permissions cleared
    assert _audit(tenant)[0]["action"] == "user_removed"
    _owner(tenant, "luca@roma.se", "Luca")
    assert call(f"DELETE {U}", {"tenantId": tenant, "userId": first})[0] == 200
    t = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["tenant"]
    assert t["ownerEmail"] == "luca@roma.se"                     # the contact owner moved on


def test_owner_email_change_moves_the_contact_and_resends(fns, tenant):
    sub = _owner(tenant, "owner@roma.se", "Maria")
    status, body = call(f"PATCH {U}", {"tenantId": tenant, "userId": sub}, {"email": "Maria@Roma.se"})
    assert status == 200, body
    assert ("manage-user", "PUT", f"/users/{sub}", {"email": "maria@roma.se"}) in fns.calls
    # the fake left Cognito's address as it was; the invite went to the sign-in's own address
    assert body["inviteResent"] is True                           # never signed in
    assert call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["tenant"]["ownerEmail"] == "maria@roma.se"
    assert _audit(tenant)[0]["details"]["from"] == "owner@roma.se"


def test_resend_invite_for_staff(fns, tenant, aws):
    sub = _staff(tenant)
    status, body = call(f"POST {U}/resend-invite", {"tenantId": tenant, "userId": sub})
    # the fake invite made no Cognito user, so it is "not invited": the plain 409
    assert status == 409 and body["error"] == "already_signed_in_user"


def test_system_account_is_listed_and_untouchable(fns, tenant, aws):
    aws["ddb"].put_item(TableName="dev-user", Item={
        "PK": {"S": "USER#agent:loc-1"}, "SK": {"S": "PROFILE"}, "cognitoSub": {"S": "agent:loc-1"},
        "tenantId": {"S": tenant}, "role": {"S": "staff_user"}, "name": {"S": "Telefonassistent"},
        "status": {"S": "system"}, "locationId": {"S": LOC}})
    row = next(u for u in _users(tenant)["users"] if u["cognitoSub"] == "agent:loc-1")
    assert row["system"] is True and "invited" not in row
    for route, body in ((f"PATCH {U}", {"name": "X"}), (f"DELETE {U}", None), (f"POST {U}/disable", None)):
        status, out = call(route, {"tenantId": tenant, "userId": "agent:loc-1"}, body)
        assert status == 409 and out["error"] == "system_account"
    assert all(fn == "tenant-account" for fn, *_ in fns.calls)        # only the list read the permissions


def test_errors_say_who_acts(fns, tenant):
    fns.fail = (409, {"error": "user already exists"})
    status, body = call("POST /platform/tenants/{tenantId}/users", {"tenantId": tenant},
                        {"role": "staff_user", "email": "kim@roma.se", "name": "Kim", "phone": "0701234567", "locationId": LOC})
    assert status == 409 and body["fields"]["email"]
    fns.fail = (403, {"error": "tenant_inactive"})
    status, body = call("POST /platform/tenants/{tenantId}/users", {"tenantId": tenant},
                        {"role": "staff_user", "email": "k@roma.se", "name": "Kim", "phone": "0701234567", "locationId": LOC})
    assert status == 409 and body["error"] == "customer_not_active"
    status, body = call("POST /platform/tenants/{tenantId}/users", {"tenantId": tenant},
                        {"role": "staff_user", "email": "k@roma.se", "name": "Kim", "phone": "12", "locationId": LOC})
    assert status == 400 and "phone" in body["fields"]


def test_list_without_the_permissions_service_still_lists(aws, tenant):
    _owner(tenant, "owner@roma.se", "Maria")
    out = _users(tenant)
    assert out["access"] is None and out["users"][0]["invited"] is True
