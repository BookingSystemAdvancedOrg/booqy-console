from conftest import call


def add(email, name="Op"):
    status, body = call("POST /platform/operators", body={"email": email, "name": name})
    assert status == 201, body
    return body["operator"]["username"]


def ops():
    status, body = call("GET /platform/operators")
    assert status == 200
    return {o["email"]: o for o in body["operators"]}


def test_create_list_and_duplicate(aws):
    add("Lamo@Ithjalparna.se", "Lamo")
    add("arya@ithjalparna.se", "Arya")
    listed = ops()
    assert set(listed) == {"lamo@ithjalparna.se", "arya@ithjalparna.se"}      # normalised
    assert listed["lamo@ithjalparna.se"]["name"] == "Lamo"
    assert listed["lamo@ithjalparna.se"]["status"] == "FORCE_CHANGE_PASSWORD"
    status, body = call("POST /platform/operators", body={"email": "arya@ithjalparna.se", "name": "Again"})
    assert status == 409 and body["error"] == "user_exists"


def test_validation(aws):
    status, body = call("POST /platform/operators", body={"email": "not-an-email"})
    assert status == 400 and set(body["fields"]) == {"email", "name"}


def test_rename_disable_enable(aws):
    me, other = add("me@x.se"), add("other@x.se")
    status, body = call("PATCH /platform/operators/{username}", {"username": other},
                        body={"name": "New name", "enabled": False}, actor=me)
    assert status == 200 and body["operator"]["name"] == "New name" and body["operator"]["enabled"] is False
    status, body = call("PATCH /platform/operators/{username}", {"username": other}, body={"enabled": True}, actor=me)
    assert status == 200 and body["operator"]["enabled"] is True


def test_cannot_disable_or_delete_yourself(aws):
    me, _ = add("me@x.se"), add("other@x.se")
    assert call("PATCH /platform/operators/{username}", {"username": me}, body={"enabled": False}, actor=me)[1]["error"] == "self"
    assert call("DELETE /platform/operators/{username}", {"username": me}, actor=me)[1]["error"] == "self"
    # renaming yourself is fine
    assert call("PATCH /platform/operators/{username}", {"username": me}, body={"name": "Me"}, actor=me)[0] == 200


def test_last_active_operator_is_protected(aws):
    a, b = add("a@x.se"), add("b@x.se")
    assert call("PATCH /platform/operators/{username}", {"username": b}, body={"enabled": False}, actor=a)[0] == 200
    # b is disabled, so a is the last active one - nobody (e.g. a script acting as b) can remove a
    status, body = call("DELETE /platform/operators/{username}", {"username": a}, actor="someone-else")
    assert status == 409 and body["error"] == "last_operator"


def test_delete(aws):
    me, other = add("me@x.se"), add("other@x.se")
    assert call("DELETE /platform/operators/{username}", {"username": other}, actor=me)[0] == 200
    assert set(ops()) == {"me@x.se"}
    assert call("DELETE /platform/operators/{username}", {"username": other}, actor=me)[0] == 404


def test_non_operators_are_not_reachable(aws):
    # a user in the pool but not in the operator group is invisible to this API
    aws["idp"].admin_create_user(UserPoolId=aws["ops_pool"], Username="stranger@x.se")
    stranger = aws["idp"].admin_get_user(UserPoolId=aws["ops_pool"], Username="stranger@x.se")["Username"]
    add("me@x.se")
    assert call("DELETE /platform/operators/{username}", {"username": stranger})[0] == 404


def test_resend_invite(aws):
    me, other = add("me@x.se"), add("other@x.se")
    assert call("POST /platform/operators/{username}/resend-invite", {"username": other}, actor=me)[0] == 200


def test_requires_operator_group(aws):
    assert call("GET /platform/operators", groups="[owner_user]")[0] == 403
