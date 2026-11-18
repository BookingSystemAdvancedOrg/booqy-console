"""Owners on the Users tab: invite, edit (name, email), resend invite, remove."""

from conftest import call

O = "/platform/tenants/{tenantId}/owners/{userId}"


def _attrs(aws, sub):
    user = aws["idp"].admin_get_user(UserPoolId=aws["pool"], Username=sub)
    return {a["Name"]: a["Value"] for a in user["UserAttributes"]}


def _invite(tenant, email, name):
    status, body = call("POST /platform/tenants/{tenantId}/owners", {"tenantId": tenant}, {"email": email, "name": name})
    assert status == 201, body
    return body["user"]["cognitoSub"]


def _audit(tenant):
    return call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["audit"]


def test_list_marks_invited_owners(aws, tenant):
    sub = _invite(tenant, "luca@roma.se", "Luca")
    users = call("GET /platform/tenants/{tenantId}/users", {"tenantId": tenant})[1]["users"]
    assert next(u for u in users if u["cognitoSub"] == sub)["invited"] is True


def test_edit_name_and_email_moves_sign_in(aws, tenant):
    sub = _invite(tenant, "luca@roma.se", "Luca")
    p = {"tenantId": tenant, "userId": sub}
    status, body = call(f"PATCH {O}", p, {"name": "Luca Bianchi", "email": "Luca.B@Roma.se"})
    assert status == 200, body
    assert body["user"]["email"] == "luca.b@roma.se" and body["user"]["name"] == "Luca Bianchi"
    assert body["inviteResent"] is True                      # still invited: the password goes to the new address
    attrs = _attrs(aws, sub)
    assert attrs["email"] == "luca.b@roma.se" and attrs["email_verified"] == "true" and attrs["name"] == "Luca Bianchi"
    # signs in with the new address
    assert aws["idp"].admin_get_user(UserPoolId=aws["pool"], Username="luca.b@roma.se")["Username"]
    users = call("GET /platform/tenants/{tenantId}/users", {"tenantId": tenant})[1]["users"]
    assert next(u for u in users if u["cognitoSub"] == sub)["email"] == "luca.b@roma.se"
    entry = _audit(tenant)[0]
    assert entry["action"] == "owner_updated"
    assert entry["details"]["from"] == "luca@roma.se" and entry["details"]["to"] == "luca.b@roma.se"
    assert entry["details"]["fields"] == ["email", "name"]


def test_edit_rejects_a_taken_email_and_no_change(aws, tenant):
    sub = _invite(tenant, "luca@roma.se", "Luca")
    _invite(tenant, "anna@roma.se", "Anna")
    p = {"tenantId": tenant, "userId": sub}
    status, body = call(f"PATCH {O}", p, {"email": "anna@roma.se"})
    assert status == 409 and body["error"] == "user_exists" and "email" in body["fields"]
    assert call(f"PATCH {O}", p, {"name": "Luca"})[0] == 400
    assert call(f"PATCH {O}", p, {"email": "bad"})[0] == 400
    assert _attrs(aws, sub)["email"] == "luca@roma.se"


def test_the_primary_owner_email_follows_the_account(aws, tenant):
    users = call("GET /platform/tenants/{tenantId}/users", {"tenantId": tenant})[1]["users"]
    if not users:                                              # onboarding creates the first owner; here by hand
        sub = _invite(tenant, "owner@roma.se", "Maria Rossi")
    else:
        sub = users[0]["cognitoSub"]
    status, _ = call(f"PATCH {O}", {"tenantId": tenant, "userId": sub}, {"email": "maria@roma.se"})
    assert status == 200
    t = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["tenant"]
    assert t["ownerEmail"] == "maria@roma.se"


def test_not_an_owner_of_this_customer_is_404(aws, tenant):
    sub = _invite(tenant, "luca@roma.se", "Luca")
    assert call(f"PATCH {O}", {"tenantId": "t-other", "userId": sub}, {"name": "X"})[0] == 404
    assert call(f"DELETE {O}", {"tenantId": tenant, "userId": "nope"})[0] == 404


def test_resend_invite_only_before_first_sign_in(aws, tenant):
    sub = _invite(tenant, "luca@roma.se", "Luca")
    p = {"tenantId": tenant, "userId": sub}
    status, body = call(f"POST {O}/resend-invite", p)
    assert status == 200, body
    assert _audit(tenant)[0]["action"] == "owner_invite_resent"
    aws["idp"].admin_set_user_password(UserPoolId=aws["pool"], Username=sub, Password="Secret-123456", Permanent=True)
    status, body = call(f"POST {O}/resend-invite", p)
    assert status == 409 and body["error"] == "owner_already_signed_in"


def test_delete_owner_and_last_owner_guard(aws, tenant):
    keep = _invite(tenant, "owner@roma.se", "Maria")
    gone = _invite(tenant, "luca@roma.se", "Luca")
    # an owner an admin disabled earlier does not count as active
    aws["ddb"].update_item(TableName="dev-user", Key={"PK": {"S": f"USER#{gone}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :d", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":d": {"S": "disabled"}})
    status, body = call(f"DELETE {O}", {"tenantId": tenant, "userId": keep})
    assert status == 409 and body["error"] == "last_owner" and "Invite another owner" in body["message"]

    status, body = call(f"DELETE {O}", {"tenantId": tenant, "userId": gone})
    assert status == 200, body
    try:
        aws["idp"].admin_get_user(UserPoolId=aws["pool"], Username=gone)
        raise AssertionError("still in the pool")
    except aws["idp"].exceptions.UserNotFoundException:
        pass
    users = call("GET /platform/tenants/{tenantId}/users", {"tenantId": tenant})[1]["users"]
    assert gone not in {u["cognitoSub"] for u in users}
    entry = _audit(tenant)[0]
    assert entry["action"] == "owner_removed" and entry["details"]["email"] == "luca@roma.se"
    # repeated (double click): the owner is gone, so 404
    assert call(f"DELETE {O}", {"tenantId": tenant, "userId": gone})[0] == 404


def test_removing_the_primary_owner_hands_the_contact_to_another(aws, tenant):
    first = _invite(tenant, "owner@roma.se", "Maria")
    _invite(tenant, "luca@roma.se", "Luca")
    assert call(f"DELETE {O}", {"tenantId": tenant, "userId": first})[0] == 200
    t = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["tenant"]
    assert t["ownerEmail"] == "luca@roma.se" and t["ownerName"] == "Luca"
