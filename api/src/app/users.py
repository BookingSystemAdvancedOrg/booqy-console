"""A tenant's sign-in accounts (Cognito tenant pool + user table profile).

The first owner is created by the onboarding workflow from the email on the
create form. Operators can invite more owners; owners invite their own staff
from the restaurant admin app."""

from botocore.exceptions import ClientError

from . import validation as v
from .core import ApiError, client, env, now_iso, to_ddb, user_table, write_audit
from .core import status_words
from .tenants import get_profile, tenant_users

LOCKED_STATUSES = ("offboarding", "offboarded")


def list_users(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    get_profile(tenant_id)
    users = tenant_users(tenant_id)
    return 200, {"users": sorted(
        ({k: u.get(k) for k in ("cognitoSub", "email", "name", "role", "status", "locationId", "createdAt")}
         for u in users),
        key=lambda u: (u["role"] != "owner_user", (u["email"] or "")))}


def invite_owner(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    f = v.Fields(req.body)
    email = f.email("email", required=True)
    name = f.text("name", required=True, max_len=100)
    f.done()
    profile = get_profile(tenant_id)
    if profile.get("status") in LOCKED_STATUSES:
        raise ApiError(409, "invalid_status", f"Not possible while the customer is {status_words(profile['status'])}.", currentStatus=profile["status"])

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
