"""Operator accounts: the people who can use Booqy Console (the OPERATOR user
pool, not a tenant's users).

Every operator is in platform_admin. Two roles:
- operator: everything, including adding, renaming, disabling and deleting
  other operators (but not owners), and editing their own name and picture.
- owner (also in the platform_owner group, set in the infrastructure
  tfvars): in addition changes the e-mail of any operator, and is the only
  one who can disable or delete an owner.

The e-mail is the sign-in name (the pool's username_attributes=email; the
real Cognito username is the sub and never changes). An e-mail change sets
email_verified=true in the same call, so sign-in, password reset and MFA
move to the new address at once and nobody is locked out.

Two guards keep the console reachable: you can't delete or disable yourself,
and the last active operator can't be deleted or disabled by anyone.

Every change is a permanent AUDIT# row under TENANT#PLATFORM (write_audit),
not only a log line: the log group keeps 30 days and gets no e-mails."""

from . import avatar, backdrop, validation as v
from .core import ApiError, client, env, groups, log, not_found, write_audit

# Platform-wide audit rows (the same partition as features/_forward.py).
AUDIT_TENANT = "PLATFORM"

FIELDS = ("username", "email", "name", "status", "enabled", "createdAt", "updatedAt")


def _pool() -> str:
    return env("OPERATOR_USER_POOL_ID")


def _group() -> str:
    return env("OPERATOR_GROUP_NAME")


def _owner_group() -> str:
    return env("OPERATOR_OWNER_GROUP_NAME", "platform_owner")


def is_owner(req) -> bool:
    """From the caller's access token (cognito:groups), not from the request body."""
    return _owner_group() in groups(req.claims)


def _owners() -> set[str]:
    """Usernames in the owner group; none while the group doesn't exist yet."""
    idp, names, token = client("cognito-idp"), set(), None
    while True:
        kwargs = {"UserPoolId": _pool(), "GroupName": _owner_group(), "Limit": 60}
        if token:
            kwargs["NextToken"] = token
        try:
            page = idp.list_users_in_group(**kwargs)
        except idp.exceptions.ResourceNotFoundException:
            return set()
        names.update(u["Username"] for u in page.get("Users", []))
        token = page.get("NextToken")
        if not token:
            return names


def _owner_only(req, message: str) -> None:
    if not is_owner(req):
        raise ApiError(403, "owner_only", message)


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


def _operators(raw: bool = False) -> list[dict]:
    idp, users, token = client("cognito-idp"), [], None
    while True:
        kwargs = {"UserPoolId": _pool(), "GroupName": _group(), "Limit": 60}
        if token:
            kwargs["NextToken"] = token
        page = idp.list_users_in_group(**kwargs)
        users.extend(page.get("Users", []) if raw else (_view(u) for u in page.get("Users", [])))
        token = page.get("NextToken")
        if not token:
            return users


def _email_taken(email: str) -> bool:
    """Someone in the pool signs in with this e-mail (AdminGetUser resolves the alias)."""
    idp = client("cognito-idp")
    try:
        idp.admin_get_user(UserPoolId=_pool(), Username=email)
    except idp.exceptions.UserNotFoundException:
        return False
    return True


def _get(username: str) -> dict:
    """An operator by username - 404 for anyone who isn't in the operator group."""
    if username not in {u["username"] for u in _operators()}:
        raise not_found("No such operator")
    idp = client("cognito-idp")
    return _view(idp.admin_get_user(UserPoolId=_pool(), Username=username))


def _guard_lockout(req, username: str, action: str) -> None:
    if username in _owners():
        _owner_only(req, f"Only an owner can {action} an owner. Ask an owner.")
    if username == req.actor:
        raise ApiError(409, "self", f"You can't {action} your own account - ask another operator")
    others_active = [u for u in _operators() if u["enabled"] and u["username"] != username]
    if not others_active:
        raise ApiError(409, "last_operator", f"Can't {action} the last active operator")


def list_operators(req) -> tuple[int, dict]:
    # Each operator's profile picture: one HeadObject each (a handful of operators).
    owners = _owners()
    users = sorted(({**_view(u), "avatarUrl": avatar.url_for(_attrs(u).get("sub")),
                     "role": "owner" if u["Username"] in owners else "operator"} for u in _operators(raw=True)),
                   key=lambda u: (u["email"] or ""))
    return 200, {"operators": users, "me": req.actor, "canChangeEmail": is_owner(req)}


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
    write_audit(AUDIT_TENANT, "operator_created", req.actor, {"target": user["Username"], "email": email})
    log.info("operator %s created by %s", user["Username"], req.actor)
    return 201, {"operator": _view(user)}


def update_operator(req) -> tuple[int, dict]:
    username = req.path["username"]
    f = v.Fields(req.body)
    name = f.text("name", max_len=100)
    email = f.email("email")
    enabled = f.boolean("enabled")
    f.done()
    current = _get(username)
    idp, pool = client("cognito-idp"), _pool()
    attributes = []
    if name is not None and name != current["name"]:
        attributes.append({"Name": "name", "Value": name})
    new_email = email if email and email != (current["email"] or "").lower() else None
    if new_email:
        # The role comes from the caller's token; applies to your own e-mail too.
        _owner_only(req, "Only an owner can change an e-mail. Ask an owner.")
        if _email_taken(new_email):
            raise ApiError(409, "user_exists", "This email already has an account",
                           fields={"email": "Already an operator"})
        # Verified in the same call: sign-in and password reset move to the new
        # address at once (no code to confirm, no session ends).
        attributes += [{"Name": "email", "Value": new_email}, {"Name": "email_verified", "Value": "true"}]
    if attributes:
        try:
            idp.admin_update_user_attributes(UserPoolId=pool, Username=username, UserAttributes=attributes)
        except (idp.exceptions.AliasExistsException, idp.exceptions.UsernameExistsException) as e:
            raise ApiError(409, "user_exists", "This email already has an account",
                           fields={"email": "Already an operator"}) from e
    if new_email:
        write_audit(AUDIT_TENANT, "operator_email_changed", req.actor,
                    {"target": username, "from": current["email"], "to": new_email})
    if enabled is False and current["enabled"]:
        _guard_lockout(req, username, "disable")
        idp.admin_disable_user(UserPoolId=pool, Username=username)
        idp.admin_user_global_sign_out(UserPoolId=pool, Username=username)   # end open sessions now
        write_audit(AUDIT_TENANT, "operator_disabled", req.actor, {"target": username})
    elif enabled is True and not current["enabled"]:
        idp.admin_enable_user(UserPoolId=pool, Username=username)
        write_audit(AUDIT_TENANT, "operator_enabled", req.actor, {"target": username})
    log.info("operator %s updated by %s", username, req.actor)
    return 200, {"operator": _get(username)}


def delete_operator(req) -> tuple[int, dict]:
    username = req.path["username"]
    current = _get(username)
    _guard_lockout(req, username, "delete")
    idp, pool = client("cognito-idp"), _pool()
    # Their background image library first: a failure leaves the account for a retry.
    sub = _attrs(idp.admin_get_user(UserPoolId=pool, Username=username)).get("sub")
    backdrop.delete_all(sub)
    idp.admin_user_global_sign_out(UserPoolId=pool, Username=username)
    idp.admin_delete_user(UserPoolId=pool, Username=username)
    write_audit(AUDIT_TENANT, "operator_deleted", req.actor, {"target": username, "email": current["email"]})
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
    write_audit(AUDIT_TENANT, "operator_invite_resent", req.actor, {"target": username})
    log.info("operator %s invite resent by %s", username, req.actor)
    return 200, {"operator": current}
