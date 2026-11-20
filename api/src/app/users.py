"""A customer's sign-in accounts (Cognito tenant pool + user table profile):
the Users tab, where operators manage every owner and staff account.

The first owner is created by the onboarding workflow from the email on the
create form. Everything else uses the restaurant admin's own rules: staff
invites, edits, role changes, disable, enable and removal go to the
manage-user function and a staff user's permissions to tenant-account, both
invoked directly as an owner of the restaurant (application
shared/console_invoke.py). This module adds what only Booqy decides: the last
active owner stays, the customer's contact owner (ownerEmail) follows the
accounts, inviting owners (also while suspended), resending invites, and
the audit rows on the Activity tab."""

import json
import re
from dataclasses import replace

from botocore.exceptions import ClientError

from . import validation as v
from .core import (ApiError, client, env, from_ddb, log, not_found, not_while, now_iso, tenant_table, to_ddb,
                   user_table, write_audit)
from .tenants import get_profile, tenant_users, tkey

LOCKED_STATUSES = ("offboarding", "offboarded")
OWNER = "owner_user"
STAFF = "staff_user"
SYSTEM_PREFIX = "agent:"            # the phone assistant's account (application shared/tenant.py)


def _invited(sub: str | None) -> bool:
    """Never signed in yet (temporary password unused). A failed lookup
    only hides Resend invite, it never fails the list."""
    if not sub:
        return False
    idp = client("cognito-idp")
    try:
        return idp.admin_get_user(UserPoolId=env("TENANT_USER_POOL_ID"), Username=sub)["UserStatus"] == "FORCE_CHANGE_PASSWORD"
    except ClientError:
        return False


def _system(u: dict) -> bool:
    """A feature's own account (the phone assistant): no sign-in, no email."""
    return str(u.get("cognitoSub") or "").startswith(SYSTEM_PREFIX) or u.get("status") == "system"


def _role(u: dict) -> str:
    return OWNER if u.get("role") == OWNER else STAFF        # manage-user writes "staff"


def list_users(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    rows = []
    for u in tenant_users(tenant_id):
        row = {k: u.get(k) for k in ("cognitoSub", "email", "name", "phone", "status", "locationId", "createdAt")}
        row["role"] = _role(u)
        if _system(u):
            row["system"] = True
        else:                                   # a few dozen at most: one AdminGetUser each
            row["invited"] = _invited(u.get("cognitoSub"))
        rows.append(row)
    access = None
    if profile.get("status") == "active":
        try:
            access = _call("TENANT_ACCOUNT_FUNCTION_ARN", tenant_id, req.actor, "GET", "/tenant").get("staffAccess")
        except ApiError:
            access = None                       # the list still shows; the permissions say they can't load
    return 200, {"users": sorted(rows, key=lambda u: (bool(u.get("system")), u["role"] != OWNER,
                                                      (u.get("name") or u.get("email") or "").lower())),
                 "access": access}


def invite_owner(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    f = v.Fields(req.body)
    email = f.email("email", required=True)
    name = f.text("name", required=True, max_len=100)
    f.done()
    profile = get_profile(tenant_id)
    if profile.get("status") in LOCKED_STATUSES:
        raise ApiError(409, "invalid_status", not_while(profile['status']), currentStatus=profile["status"])

    idp, pool = client("cognito-idp"), env("TENANT_USER_POOL_ID")
    try:
        user = idp.admin_create_user(
            UserPoolId=pool, Username=email, DesiredDeliveryMediums=["EMAIL"],
            UserAttributes=[{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"},
                            {"Name": "name", "Value": name}, {"Name": "custom:tenant_id", "Value": tenant_id}],
        )["User"]
    except idp.exceptions.UsernameExistsException as e:
        # custom:tenant_id is immutable - an existing account can't be moved
        # to another restaurant, so this needs a different email.
        raise ApiError(409, "user_exists", "This email is already used. Use another email.",
                       fields={"email": "Already used. Use another email."}) from e
    sub = next(a["Value"] for a in user["Attributes"] if a["Name"] == "sub")
    idp.admin_add_user_to_group(UserPoolId=pool, Username=sub, GroupName=env("OWNER_GROUP_NAME"))
    if profile.get("status") == "suspended":
        # A suspended customer's users can't sign in; resume enables this one
        # too (its profile says active).
        idp.admin_disable_user(UserPoolId=pool, Username=sub)
    try:
        client("dynamodb").put_item(
            TableName=user_table(), ConditionExpression="attribute_not_exists(PK)",
            Item=to_ddb({"PK": f"USER#{sub}", "SK": "PROFILE", "cognitoSub": sub, "tenantId": tenant_id,
                         "role": "owner_user", "email": email, "name": name, "status": "active",
                         "createdBy": req.actor, "createdAt": now_iso()}))
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    write_audit(tenant_id, "owner_invited", req.actor, {"email": email})
    return 201, {"user": {"cognitoSub": sub, "email": email, "name": name, "role": "owner_user", "status": "active"}}


# ------------------------------------------------- the admin's own functions
def _call(env_name: str, tenant_id: str, actor: str, method: str, path: str, body: dict | None = None) -> dict:
    """manage-user or tenant-account, as an owner of the restaurant
    (shared/console_invoke.py), with their answers turned into console errors."""
    payload = {"booqyConsole": {"operator": actor, "tenantId": tenant_id, "method": method, "path": path,
                                **({"body": body} if body is not None else {})}}
    try:
        response = client("lambda").invoke(FunctionName=env(env_name), InvocationType="RequestResponse",
                                           Payload=json.dumps(payload).encode("utf-8"))
        result = json.loads(response["Payload"].read() or b"null")
    except Exception as e:  # noqa: BLE001 - timeout, throttling, no permission: Booqy's side
        log.exception("%s %s %s failed", env_name, method, path)
        raise ApiError(503, "users_unavailable", "Booqy's user service didn't answer. Try again in a minute.") from e
    if response.get("FunctionError") or not isinstance(result, dict):
        log.error(json.dumps({"usersCallError": path, "function": env_name}))
        raise ApiError(503, "users_unavailable", "Booqy's user service didn't answer. Try again in a minute.")
    status = int(result.get("statusCode") or 500)
    out = json.loads(result.get("body") or "null") if result.get("body") else {}
    if status < 400:
        return out if isinstance(out, dict) else {}
    raise _error(status, (out or {}).get("error") if isinstance(out, dict) else None, path)


def _error(status: int, error, path: str) -> ApiError:
    text = str(error or "")
    log.info(json.dumps({"usersCallStatus": status, "error": text[:200], "path": path}))
    if status == 409 and text == "user already exists":
        return ApiError(409, "user_exists", "This email is already used. Use another email.",
                        fields={"email": "Already used. Use another email."})
    if status == 409 and text == "changed_retry":
        return ApiError(409, "conflict", "Someone changed the permissions just now. Reload the page and try again.")
    if status == 404:
        return not_found("We can't find this account. It may have been removed. Reload the page.")
    if status == 403 and text in ("tenant_inactive", "no_tenant"):
        return ApiError(409, "customer_not_active",
                        "Staff can only be changed while the customer is active. Resume the customer first.")
    if status == 400:
        for field, words, message in (
                ("phone", ("phone",), "Write the number with country code, like +46 70 123 45 67."),
                ("email", ("email",), "This email looks wrong. Write it like anna@restaurang.se."),
                ("locationId", ("locationid", "location"), "Pick one of the customer's locations."),
                ("name", ("name",), "Write a name.")):
            if any(w in text.lower() for w in words):
                return ApiError(400, "validation_failed", message, fields={field: message})
        return ApiError(400, "validation_failed", "Something in the form isn't accepted. Check the fields and try again.")
    # 403 forbidden, 409 inconsistent record, 5xx: nothing the operator can fix here.
    return ApiError(502, "users_failed", "Booqy's user service refused this. Reload the page and try again.")


# --------------------------------------------------------------- the account
def _account(tenant_id: str, sub: str) -> dict:
    """The profile row; 404 for someone else's, 409 for a system account."""
    item = from_ddb(client("dynamodb").get_item(
        TableName=user_table(), Key={"PK": {"S": f"USER#{sub}"}, "SK": {"S": "PROFILE"}},
        ConsistentRead=True).get("Item"))
    if not item or item.get("tenantId") != tenant_id:
        raise not_found("We can't find this account. It may have been removed. Reload the page.")
    if _system(item):
        raise ApiError(409, "system_account",
                       "This is the phone assistant's own account. It has no sign-in and follows the phone "
                       "assistant: the restaurant turns it on or off on the Telefon page in the admin app.")
    return item


def _unlocked(profile: dict) -> None:
    if profile.get("status") in LOCKED_STATUSES:
        raise ApiError(409, "invalid_status", not_while(profile["status"]), currentStatus=profile["status"])


def _other_active_owners(tenant_id: str, sub: str) -> list[dict]:
    return sorted((u for u in tenant_users(tenant_id)
                   if u.get("role") == OWNER and u.get("cognitoSub") != sub and (u.get("status") or "active") == "active"),
                  key=lambda u: u.get("createdAt") or "")


def _guard_last_owner(tenant_id: str, account: dict, doing: str) -> list[dict]:
    """The restaurant always keeps one active owner. Returns the others."""
    others = _other_active_owners(tenant_id, account["cognitoSub"])
    if account.get("role") == OWNER and (account.get("status") or "active") == "active" and not others:
        raise ApiError(409, "last_owner",
                       f"This is the restaurant's only active owner. Invite another owner first, then {doing} this one.")
    return others


def _set_primary(tenant_id: str, actor: str, email: str, name: str) -> None:
    """The customer's contact owner (ownerEmail: invoices, news) follows the account."""
    client("dynamodb").update_item(
        TableName=tenant_table(), Key=tkey(tenant_id), ConditionExpression="attribute_exists(PK)",
        UpdateExpression="SET ownerEmail = :e, ownerName = :n, updatedAt = :now, updatedBy = :by",
        ExpressionAttributeValues=to_ddb({":e": email, ":n": name, ":now": now_iso(), ":by": actor}))


def _hand_on_primary(tenant_id: str, actor: str, profile: dict, account: dict, others: list[dict]) -> None:
    if others and (profile.get("ownerEmail") or "").lower() == (account.get("email") or "").lower():
        _set_primary(tenant_id, actor, others[0]["email"], others[0].get("name") or "")


def _phone(value) -> str | None:
    """The admin's format (E.164): +46701234567. A Swedish 07x number gets +46."""
    if value in (None, ""):
        return None
    digits = re.sub(r"[\s()-]", "", str(value))
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    elif digits.startswith("0"):
        digits = "+46" + digits[1:]
    if not re.fullmatch(r"\+[1-9]\d{7,14}", digits):
        raise ApiError(400, "validation_failed", "Write the number with country code, like +46 70 123 45 67.",
                       fields={"phone": "Write the number with country code, like +46 70 123 45 67."})
    return digits


def _areas(f: v.Fields, field: str) -> dict | None:
    """A staff user's own permissions: {"add": [...], "remove": [...], "version": n};
    the areas themselves are checked by tenant-account (shared/staff_access.py)."""
    raw = f.data.get(field)
    if raw is None:
        return None
    ok = isinstance(raw, dict) and all(isinstance(raw.get(k, []), list) and all(isinstance(a, str) for a in raw.get(k, []))
                                       for k in ("add", "remove")) and isinstance(raw.get("version"), int)
    if not ok:
        f.fail(field, "Pick the permissions again.")
        return None
    return {"add": raw.get("add", []), "remove": raw.get("remove", []), "version": raw["version"]}


def _set_access(tenant_id: str, actor: str, sub: str, access: dict | None) -> None:
    """access None: this person's own changes are cleared (back to the group's)."""
    if access is None:
        current = _call("TENANT_ACCOUNT_FUNCTION_ARN", tenant_id, actor, "GET", "/tenant").get("staffAccess") or {}
        if sub not in (current.get("users") or {}):
            return
        version, entry = current.get("version") or 0, None
    else:
        version, entry = access["version"], {"add": access["add"], "remove": access["remove"]}
    _call("TENANT_ACCOUNT_FUNCTION_ARN", tenant_id, actor, "PATCH", "/tenant",
          {"staffAccess": {"version": version, "users": {sub: entry}}})


def _row(sub: str, tenant_id: str) -> dict:
    u = _account(tenant_id, sub)
    return {**{k: u.get(k) for k in ("cognitoSub", "email", "name", "phone", "status", "locationId", "createdAt")},
            "role": _role(u), "invited": _invited(sub)}


# ------------------------------------------------------------------- routes
def create_user(req) -> tuple[int, dict]:
    """POST .../users: an owner (as invite_owner) or a staff user (manage-user)."""
    role = (req.body or {}).get("role")
    if role == OWNER:
        body = {k: val for k, val in (req.body or {}).items() if k in ("email", "name")}
        return invite_owner(replace(req, body=body))
    tenant_id = req.path["tenantId"]
    f = v.Fields({k: val for k, val in (req.body or {}).items() if k != "role"})
    if role != STAFF:
        f.fail("role", "Pick Owner or Staff.")
    email = f.email("email", required=True)
    name = f.text("name", required=True, max_len=100)
    raw_phone = f.text("phone", required=True, max_len=30)
    location_id = f.text("locationId", required=True, max_len=64)
    access = _areas(f, "access")
    f.done()
    profile = get_profile(tenant_id)
    _unlocked(profile)
    phone = _phone(raw_phone)
    user = _call("MANAGE_USER_FUNCTION_ARN", tenant_id, req.actor, "POST", "/users/invite",
                 {"name": name, "email": email, "phone": phone, "group": STAFF, "locationId": location_id})
    sub = user["cognitoSub"]
    if access and (access["add"] or access["remove"]):
        _set_access(tenant_id, req.actor, sub, access)
    write_audit(tenant_id, "user_invited", req.actor, {"target": sub, "email": email, "role": STAFF,
                                                        "locationId": location_id})
    return 201, {"user": _row(sub, tenant_id)}


def update_user(req) -> tuple[int, dict]:
    tenant_id, sub = req.path["tenantId"], req.path["userId"]
    f = v.Fields(req.body)
    name = f.text("name", max_len=100)
    email = f.email("email")
    raw_phone = f.text("phone", max_len=30)
    role = f.text("role", max_len=20)
    location_id = f.text("locationId", max_len=64)
    access = _areas(f, "access")
    if role is not None and role not in (OWNER, STAFF):
        f.fail("role", "Pick Owner or Staff.")
    f.done()
    phone = _phone(raw_phone)
    profile = get_profile(tenant_id)
    _unlocked(profile)
    account = _account(tenant_id, sub)
    old_role, old_email, old_name = _role(account), (account.get("email") or "").lower(), account.get("name") or ""
    new_role = role if role and role != old_role else None
    changed: list[str] = []

    if new_role:
        others = _guard_last_owner(tenant_id, account, "make staff of") if new_role == STAFF else []
        if new_role == STAFF and not (location_id or account.get("locationId")):
            raise ApiError(400, "validation_failed", "Pick the location this staff user works at.",
                           fields={"locationId": "Pick a location."})
        _call("MANAGE_USER_FUNCTION_ARN", tenant_id, req.actor, "PUT", f"/users/{sub}/group",
              {"group": new_role, "locationId": (location_id or account.get("locationId") or "") if new_role == STAFF else ""})
        changed.append("role")
        if new_role == OWNER:
            _set_access(tenant_id, req.actor, sub, None)       # an owner has every area
        else:
            _hand_on_primary(tenant_id, req.actor, profile, account, others)

    final_role = new_role or old_role
    profile_patch = {}
    if name is not None and name != old_name:
        profile_patch["name"] = name
    if email and email != old_email:
        profile_patch["email"] = email
    if phone is not None and phone != (account.get("phone") or ""):
        profile_patch["phone"] = phone
    if final_role == STAFF and not new_role and location_id and location_id != account.get("locationId"):
        profile_patch["locationId"] = location_id
    if profile_patch:
        _call("MANAGE_USER_FUNCTION_ARN", tenant_id, req.actor, "PUT", f"/users/{sub}", profile_patch)
        changed += sorted(profile_patch)

    if access is not None and final_role == STAFF:
        _set_access(tenant_id, req.actor, sub, access)
        changed.append("access")
    if not changed:
        raise ApiError(400, "validation_failed", "Nothing was changed. Change a field, then save.")

    final_email = profile_patch.get("email", old_email)
    if final_role == OWNER and ("email" in profile_patch or "name" in profile_patch) \
            and (profile.get("ownerEmail") or "").lower() == old_email:
        _set_primary(tenant_id, req.actor, final_email, profile_patch.get("name", old_name))
    resent = False
    if "email" in profile_patch and _invited(sub):
        # The temporary password went to the old address: send it to the new one.
        resent = _resend(sub)
    details = {"target": sub, "email": final_email, "fields": changed}
    if "email" in profile_patch:
        details.update({"from": old_email, "to": final_email})
    if new_role:
        details.update({"roleFrom": old_role, "roleTo": new_role})
    if resent:
        details["inviteResent"] = True
    write_audit(tenant_id, "user_updated", req.actor, details)
    return 200, {"user": _row(sub, tenant_id), "inviteResent": resent}


def _resend(sub: str) -> bool:
    """A new temporary password to the sign-in's current address (read from
    Cognito, so an email change made a moment ago is the one used)."""
    idp, pool = client("cognito-idp"), env("TENANT_USER_POOL_ID")
    try:
        user = idp.admin_get_user(UserPoolId=pool, Username=sub)
    except idp.exceptions.UserNotFoundException:
        return False
    email = next((a["Value"] for a in user.get("UserAttributes", []) if a["Name"] == "email"), None)
    if not email:
        return False
    idp.admin_create_user(UserPoolId=pool, Username=email, MessageAction="RESEND", DesiredDeliveryMediums=["EMAIL"])
    return True


def _sign_out(sub: str) -> None:
    idp = client("cognito-idp")
    try:
        idp.admin_user_global_sign_out(UserPoolId=env("TENANT_USER_POOL_ID"), Username=sub)
    except ClientError:
        log.info("sign-out of %s skipped", sub)


def disable_user(req) -> tuple[int, dict]:
    tenant_id, sub = req.path["tenantId"], req.path["userId"]
    profile = get_profile(tenant_id)
    _unlocked(profile)
    account = _account(tenant_id, sub)
    _guard_last_owner(tenant_id, account, "disable")
    _call("MANAGE_USER_FUNCTION_ARN", tenant_id, req.actor, "POST", f"/users/{sub}/deactivate")
    _sign_out(sub)                                   # end open sessions now, not when the token runs out
    write_audit(tenant_id, "user_disabled", req.actor, {"target": sub, "email": account.get("email"), "role": _role(account)})
    return 200, {"user": _row(sub, tenant_id)}


def enable_user(req) -> tuple[int, dict]:
    tenant_id, sub = req.path["tenantId"], req.path["userId"]
    profile = get_profile(tenant_id)
    _unlocked(profile)
    account = _account(tenant_id, sub)
    _call("MANAGE_USER_FUNCTION_ARN", tenant_id, req.actor, "POST", f"/users/{sub}/reactivate")
    write_audit(tenant_id, "user_enabled", req.actor, {"target": sub, "email": account.get("email"), "role": _role(account)})
    return 200, {"user": _row(sub, tenant_id)}


def delete_user(req) -> tuple[int, dict]:
    tenant_id, sub = req.path["tenantId"], req.path["userId"]
    profile = get_profile(tenant_id)
    _unlocked(profile)
    account = _account(tenant_id, sub)
    others = _guard_last_owner(tenant_id, account, "remove")
    _sign_out(sub)
    # manage-user deletes the sign-in, the profile row and their pictures.
    _call("MANAGE_USER_FUNCTION_ARN", tenant_id, req.actor, "DELETE", f"/users/{sub}")
    if _role(account) == STAFF and profile.get("status") == "active":
        try:
            _set_access(tenant_id, req.actor, sub, None)
        except ApiError:
            log.info("permissions of removed user %s left for later", sub)   # unused without the account
    if _role(account) == OWNER:
        _hand_on_primary(tenant_id, req.actor, profile, account, others)
    write_audit(tenant_id, "user_removed", req.actor, {"target": sub, "email": account.get("email"),
                                                        "name": account.get("name"), "role": _role(account)})
    return 200, {"deleted": sub}


def resend_invite(req) -> tuple[int, dict]:
    tenant_id, sub = req.path["tenantId"], req.path["userId"]
    _unlocked(get_profile(tenant_id))
    account = _account(tenant_id, sub)
    if not _invited(sub):
        raise ApiError(409, "already_signed_in_user",
                       "This person has already signed in. They reset their password with "
                       "Glömt lösenord on the admin sign-in page.")
    if not _resend(sub):
        raise not_found("We can't find this account's sign-in. Reload the page.")
    write_audit(tenant_id, "user_invite_resent", req.actor, {"target": sub, "email": account["email"]})
    return 200, {"resent": sub}
