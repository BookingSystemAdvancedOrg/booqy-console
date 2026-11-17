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


# ------------------------------------------------------------ roles and e-mail
OWNER = "[platform_admin platform_owner]"


def owner_group(aws, *usernames):
    aws["idp"].create_group(UserPoolId=aws["ops_pool"], GroupName="platform_owner")
    for u in usernames:
        aws["idp"].admin_add_user_to_group(UserPoolId=aws["ops_pool"], Username=u, GroupName="platform_owner")


def test_owner_changes_any_email_and_it_stays_verified(aws):
    me, other = add("me@x.se"), add("other@x.se")
    owner_group(aws, me)
    status, body = call("PATCH /platform/operators/{username}", {"username": other},
                        body={"email": " New@X.se ", "name": "Other"}, actor=me, groups=OWNER)
    assert status == 200, body
    assert body["operator"]["email"] == "new@x.se" and body["operator"]["name"] == "Other"
    user = aws["idp"].admin_get_user(UserPoolId=aws["ops_pool"], Username=other)
    attrs = {a["Name"]: a["Value"] for a in user["UserAttributes"]}
    assert attrs["email"] == "new@x.se" and attrs["email_verified"] == "true"
    assert user["Username"] == other                                           # same account, same sub
    # and their own
    assert call("PATCH /platform/operators/{username}", {"username": me}, body={"email": "me2@x.se"},
                actor=me, groups=OWNER)[0] == 200
    assert set(ops()) == {"new@x.se", "me2@x.se"}


def test_non_owner_cannot_change_any_email(aws):
    me, other = add("me@x.se"), add("other@x.se")
    for target in (me, other):
        status, body = call("PATCH /platform/operators/{username}", {"username": target},
                            body={"email": "nope@x.se"}, actor=me)
        assert status == 403 and body["error"] == "owner_only"
    assert set(ops()) == {"me@x.se", "other@x.se"}
    # the same e-mail (any case) is not a change, so a non-owner can save their name with it
    assert call("PATCH /platform/operators/{username}", {"username": me},
                body={"email": "ME@x.se", "name": "Me"}, actor=me)[0] == 200


def test_email_change_to_a_taken_address(aws):
    me, other = add("me@x.se"), add("other@x.se")
    owner_group(aws, me)
    status, body = call("PATCH /platform/operators/{username}", {"username": other},
                        body={"email": "me@x.se"}, actor=me, groups=OWNER)
    assert status == 409 and body["fields"] == {"email": "Already used. Use another email."}


def test_roles_in_the_list(aws):
    me, other = add("me@x.se"), add("other@x.se")
    status, body = call("GET /platform/operators", actor=other)
    assert body["canChangeEmail"] is False
    assert {o["role"] for o in body["operators"]} == {"operator"}               # no owner group yet
    owner_group(aws, me)
    status, body = call("GET /platform/operators", actor=me, groups=OWNER)
    assert body["canChangeEmail"] is True
    assert {o["email"]: o["role"] for o in body["operators"]} == {"me@x.se": "owner", "other@x.se": "operator"}


def test_only_an_owner_disables_or_deletes_an_owner(aws):
    owner, a, b = add("owner@x.se"), add("a@x.se"), add("b@x.se")
    owner_group(aws, owner)
    for route, body in (("PATCH /platform/operators/{username}", {"enabled": False}),
                        ("DELETE /platform/operators/{username}", None)):
        status, resp = call(route, {"username": owner}, body=body, actor=a)
        assert status == 403 and resp["error"] == "owner_only"
    assert call("PATCH /platform/operators/{username}", {"username": a}, body={"enabled": False},
                actor=owner, groups=OWNER)[0] == 200
    assert call("DELETE /platform/operators/{username}", {"username": b}, actor=owner, groups=OWNER)[0] == 200
