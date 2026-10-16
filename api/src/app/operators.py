"""Operator accounts: the people who can use Booqy Console (the OPERATOR user
pool, not a tenant's users).

Every operator is in the same group and has the same rights - including
managing the other operators. Two guards keep the console reachable: you
can't delete or disable yourself, and the last active operator can't be
deleted or disabled by anyone.

Accounts listed in the infrastructure tfvars (platform_operator_emails) are
created by Terraform; deleting one here works, but the next infrastructure
apply creates it again (with a new invite)."""

from . import validation as v
from .core import ApiError, client, env, log, not_found

FIELDS = ("username", "email", "name", "status", "enabled", "createdAt", "updatedAt")


def _pool() -> str:
    return env("OPERATOR_USER_POOL_ID")


def _group() -> str:
    return env("OPERATOR_GROUP_NAME")


def _attrs(user: dict) -> dict:
    return {a["Name"]: a["Value"] for a in user.get("Attributes") or user.get("UserAttributes") or []}


def _view(user: dict) -> dict:
    a = _attrs(user)
    created, updated = user.get("UserCreateDate"), user.get("UserLastModifiedDate")
    return {
        "username": user["Username"],
        "email": a.get("email"),
        "name": a.get("name") or "",
        # FORCE_CHANGE_PASSWORD = invited, never signed in; CONFIRMED = active
        "status": user.get("UserStatus"),
        "enabled": user.get("Enabled", True),
        "createdAt": created.isoformat() if hasattr(created, "isoformat") else created,
        "updatedAt": updated.isoformat() if hasattr(updated, "isoformat") else updated,
    }


def _operators() -> list[dict]:
    idp, users, token = client("cognito-idp"), [], None
    while True:
        kwargs = {"UserPoolId": _pool(), "GroupName": _group(), "Limit": 60}
        if token:
            kwargs["NextToken"] = token
        page = idp.list_users_in_group(**kwargs)
        users.extend(_view(u) for u in page.get("Users", []))
        token = page.get("NextToken")
        if not token:
            return users


def _get(username: str) -> dict:
    """An operator by username - 404 for anyone who isn't in the operator group."""
    if username not in {u["username"] for u in _operators()}:
        raise not_found("No such operator")
    idp = client("cognito-idp")
    return _view(idp.admin_get_user(UserPoolId=_pool(), Username=username))


def _guard_lockout(req, username: str, action: str) -> None:
    if username == req.actor:
        raise ApiError(409, "self", f"You can't {action} your own account - ask another operator")
    others_active = [u for u in _operators() if u["enabled"] and u["username"] != username]
    if not others_active:
        raise ApiError(409, "last_operator", f"Can't {action} the last active operator")


def list_operators(req) -> tuple[int, dict]:
    users = sorted(_operators(), key=lambda u: (u["email"] or ""))
    return 200, {"operators": users, "me": req.actor}


def create_operator(req) -> tuple[int, dict]:
    f = v.Fields(req.body)
    email = f.email("email", required=True)
    name = f.text("name", required=True, max_len=100)
    f.done()
    idp, pool = client("cognito-idp"), _pool()
    try:
        user = idp.admin_create_user(
            UserPoolId=pool, Username=email, DesiredDeliveryMediums=["EMAIL"],
            UserAttributes=[{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"},
                            {"Name": "name", "Value": name}],
        )["User"]
    except idp.exceptions.UsernameExistsException as e:
        raise ApiError(409, "user_exists", "This email already has an operator account",
                       fields={"email": "Already an operator"}) from e
    idp.admin_add_user_to_group(UserPoolId=pool, Username=user["Username"], GroupName=_group())
    log.info("operator %s created by %s", user["Username"], req.actor)
    return 201, {"operator": _view(user)}


def update_operator(req) -> tuple[int, dict]:
    username = req.path["username"]
    f = v.Fields(req.body)
    name = f.text("name", max_len=100)
    enabled = f.boolean("enabled")
    f.done()
    current = _get(username)
    idp, pool = client("cognito-idp"), _pool()
    if name is not None and name != current["name"]:
        idp.admin_update_user_attributes(UserPoolId=pool, Username=username,
                                         UserAttributes=[{"Name": "name", "Value": name}])
    if enabled is False and current["enabled"]:
        _guard_lockout(req, username, "disable")
        idp.admin_disable_user(UserPoolId=pool, Username=username)
        idp.admin_user_global_sign_out(UserPoolId=pool, Username=username)   # end open sessions now
    elif enabled is True and not current["enabled"]:
        idp.admin_enable_user(UserPoolId=pool, Username=username)
    log.info("operator %s updated by %s", username, req.actor)
    return 200, {"operator": _get(username)}


def delete_operator(req) -> tuple[int, dict]:
    username = req.path["username"]
    _get(username)
    _guard_lockout(req, username, "delete")
    idp, pool = client("cognito-idp"), _pool()
    idp.admin_user_global_sign_out(UserPoolId=pool, Username=username)
    idp.admin_delete_user(UserPoolId=pool, Username=username)
    log.info("operator %s deleted by %s", username, req.actor)
    return 200, {"deleted": username}


def resend_invite(req) -> tuple[int, dict]:
    username = req.path["username"]
    current = _get(username)
    if current["status"] != "FORCE_CHANGE_PASSWORD":
        raise ApiError(409, "already_signed_in",
                       "This operator has already signed in - they can use 'Forgot password' instead")
    client("cognito-idp").admin_create_user(UserPoolId=_pool(), Username=current["email"],
                                            MessageAction="RESEND", DesiredDeliveryMediums=["EMAIL"])
    return 200, {"operator": current}
