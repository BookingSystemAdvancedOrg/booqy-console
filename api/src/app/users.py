"""A tenant's sign-in accounts (Cognito tenant pool + user table profile).

The first owner is created by the onboarding workflow from the email on the
create form. Operators invite, edit and remove owners here; owners invite
their own staff from the restaurant admin app."""

from botocore.exceptions import ClientError

from . import validation as v
from .core import (ApiError, client, env, from_ddb, log, not_found, not_while, now_iso, tenant_table, to_ddb,
                   user_table, write_audit)
from .tenants import get_profile, tenant_users, tkey

LOCKED_STATUSES = ("offboarding", "offboarded")
OWNER = "owner_user"


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


def list_users(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    get_profile(tenant_id)
    users = tenant_users(tenant_id)
    rows = []
    for u in users:
        row = {k: u.get(k) for k in ("cognitoSub", "email", "name", "role", "status", "locationId", "createdAt")}
        if u.get("role") == OWNER:               # a handful per restaurant: one AdminGetUser each
            row["invited"] = _invited(u.get("cognitoSub"))
        rows.append(row)
    return 200, {"users": sorted(rows, key=lambda u: (u["role"] != OWNER, (u["email"] or "")))}


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


# ---------------------------------------------------------- edit and remove
def _owner(tenant_id: str, sub: str) -> dict:
    """The owner's profile row; 404 for a staff user or someone else's."""
    item = from_ddb(client("dynamodb").get_item(
        TableName=user_table(), Key={"PK": {"S": f"USER#{sub}"}, "SK": {"S": "PROFILE"}},
        ConsistentRead=True).get("Item"))
    if not item or item.get("tenantId") != tenant_id or item.get("role") != OWNER:
        raise not_found("We can't find this owner. They may have been removed. Reload the page.")
    return item


def _unlocked(profile: dict) -> None:
    if profile.get("status") in LOCKED_STATUSES:
        raise ApiError(409, "invalid_status", not_while(profile["status"]), currentStatus=profile["status"])


def _taken() -> ApiError:
    return ApiError(409, "user_exists", "This email is already used. Use another email.",
                    fields={"email": "Already used. Use another email."})


def _set_primary(tenant_id: str, actor: str, email: str, name: str) -> None:
    """The customer's contact owner (ownerEmail: invoices, news) follows the account."""
    client("dynamodb").update_item(
        TableName=tenant_table(), Key=tkey(tenant_id), ConditionExpression="attribute_exists(PK)",
        UpdateExpression="SET ownerEmail = :e, ownerName = :n, updatedAt = :now, updatedBy = :by",
        ExpressionAttributeValues=to_ddb({":e": email, ":n": name, ":now": now_iso(), ":by": actor}))


def update_owner(req) -> tuple[int, dict]:
    tenant_id, sub = req.path["tenantId"], req.path["userId"]
    f = v.Fields(req.body)
    name = f.text("name", max_len=100)
    email = f.email("email")
    f.done()
    profile = get_profile(tenant_id)
    _unlocked(profile)
    owner = _owner(tenant_id, sub)
    old_email, old_name = (owner.get("email") or "").lower(), owner.get("name") or ""
    new_name = name if name is not None and name != old_name else None
    new_email = email if email and email != old_email else None
    if not new_name and not new_email:
        raise ApiError(400, "validation_failed", "Nothing was changed. Change a field, then save.")

    idp, pool = client("cognito-idp"), env("TENANT_USER_POOL_ID")
    if new_email:
        try:
            idp.admin_get_user(UserPoolId=pool, Username=new_email)
            raise _taken()
        except idp.exceptions.UserNotFoundException:
            pass
    attributes = []
    if new_name:
        attributes.append({"Name": "name", "Value": new_name})
    if new_email:
        # Verified by Booqy in the same call: sign-in and Glömt lösenord move
        # to the new address at once, no code is sent and open sessions stay.
        attributes += [{"Name": "email", "Value": new_email}, {"Name": "email_verified", "Value": "true"}]
    try:
        idp.admin_update_user_attributes(UserPoolId=pool, Username=sub, UserAttributes=attributes)
    except (idp.exceptions.AliasExistsException, idp.exceptions.UsernameExistsException) as e:
        raise _taken() from e

    sets, values = ["updatedAt = :now", "updatedBy = :by"], {":now": now_iso(), ":by": req.actor}
    names = {}
    if new_name:
        sets.append("#n = :n")
        names["#n"], values[":n"] = "name", new_name
    if new_email:
        sets.append("email = :e")
        values[":e"] = new_email
    try:
        client("dynamodb").update_item(
            TableName=user_table(), Key={"PK": {"S": f"USER#{sub}"}, "SK": {"S": "PROFILE"}},
            ConditionExpression="attribute_exists(PK)", UpdateExpression="SET " + ", ".join(sets),
            ExpressionAttributeValues=to_ddb(values), **({"ExpressionAttributeNames": names} if names else {}))
    except Exception:
        # Put sign-in back as it was, so the account and the list never disagree.
        rollback = [{"Name": "name", "Value": old_name}] if new_name and old_name else []
        if new_email:
            rollback += [{"Name": "email", "Value": old_email}, {"Name": "email_verified", "Value": "true"}]
        if rollback:
            try:
                idp.admin_update_user_attributes(UserPoolId=pool, Username=sub, UserAttributes=rollback)
            except ClientError:
                log.error("owner %s: sign-in attributes not rolled back", sub)
        raise

    final_email, final_name = new_email or old_email, new_name or old_name
    if (profile.get("ownerEmail") or "").lower() == old_email:
        _set_primary(tenant_id, req.actor, final_email, final_name)
    resent = False
    if new_email and _invited(sub):
        # The temporary password went to the old address: send it to the new one.
        idp.admin_create_user(UserPoolId=pool, Username=final_email, MessageAction="RESEND",
                              DesiredDeliveryMediums=["EMAIL"])
        resent = True
    details = {"target": sub, "fields": sorted(k for k, val in (("name", new_name), ("email", new_email)) if val)}
    if new_email:
        details.update({"from": old_email, "to": new_email})
    if resent:
        details["inviteResent"] = True
    write_audit(tenant_id, "owner_updated", req.actor, details)
    return 200, {"user": {"cognitoSub": sub, "email": final_email, "name": final_name, "role": OWNER,
                          "status": owner.get("status"), "createdAt": owner.get("createdAt")},
                 "inviteResent": resent}


def resend_owner_invite(req) -> tuple[int, dict]:
    tenant_id, sub = req.path["tenantId"], req.path["userId"]
    _unlocked(get_profile(tenant_id))
    owner = _owner(tenant_id, sub)
    if not _invited(sub):
        raise ApiError(409, "owner_already_signed_in",
                       "This owner has already signed in. They can reset their password with "
                       "Glömt lösenord on the admin sign-in page.")
    client("cognito-idp").admin_create_user(UserPoolId=env("TENANT_USER_POOL_ID"), Username=owner["email"],
                                            MessageAction="RESEND", DesiredDeliveryMediums=["EMAIL"])
    write_audit(tenant_id, "owner_invite_resent", req.actor, {"target": sub, "email": owner["email"]})
    return 200, {"resent": sub}


def delete_owner(req) -> tuple[int, dict]:
    tenant_id, sub = req.path["tenantId"], req.path["userId"]
    profile = get_profile(tenant_id)
    _unlocked(profile)
    owner = _owner(tenant_id, sub)
    others = sorted((u for u in tenant_users(tenant_id)
                     if u.get("role") == OWNER and u.get("cognitoSub") != sub and (u.get("status") or "active") == "active"),
                    key=lambda u: u.get("createdAt") or "")
    if (owner.get("status") or "active") == "active" and not others:
        raise ApiError(409, "last_owner",
                       "This is the restaurant's only active owner. Invite another owner first, then remove this one.")

    idp, pool = client("cognito-idp"), env("TENANT_USER_POOL_ID")
    # Disable first (no new sign-in), end open sessions, then delete. Each step
    # tolerates a missing user, so a retry after a partial run finishes the job.
    for call in ("admin_disable_user", "admin_user_global_sign_out", "admin_delete_user"):
        try:
            getattr(idp, call)(UserPoolId=pool, Username=sub)
        except idp.exceptions.UserNotFoundException:
            pass
    client("dynamodb").delete_item(TableName=user_table(),
                                   Key={"PK": {"S": f"USER#{sub}"}, "SK": {"S": "PROFILE"}})
    email = (owner.get("email") or "").lower()
    if (profile.get("ownerEmail") or "").lower() == email and others:
        _set_primary(tenant_id, req.actor, others[0]["email"], others[0].get("name") or "")
    write_audit(tenant_id, "owner_removed", req.actor, {"target": sub, "email": email, "name": owner.get("name")})
    return 200, {"deleted": sub}
