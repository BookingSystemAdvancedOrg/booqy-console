import json
import os

import boto3
import pytest
from moto import mock_aws

REGION = "eu-north-1"
os.environ.update({
    "AWS_DEFAULT_REGION": REGION, "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test",
    "ENVIRONMENT": "dev", "TENANT_TABLE_NAME": "dev-tenant", "LOCATION_TABLE_NAME": "dev-location",
    "LOCATION_ID_INDEX_NAME": "byLocationId", "USER_TABLE_NAME": "dev-user",
    "USER_TENANT_INDEX_NAME": "byTenant", "OWNER_GROUP_NAME": "owner_user",
    "STRIPE_API_VERSION": "2026-07-29.dahlia", "PLATFORM_DOMAIN": "",
    "TENANT_DOMAIN_CNAME_TARGET": "", "ADMIN_APP_URL": "https://app.example.se",
    "PLATFORM_ADMIN_APP_URL": "https://ops.example.se",
})


def _table(ddb, name, gsis=()):
    attrs = {"PK", "SK"}
    spec = []
    for gname, hash_key, range_key in gsis:
        attrs.update(k for k in (hash_key, range_key) if k)
        keys = [{"AttributeName": hash_key, "KeyType": "HASH"}]
        if range_key:
            keys.append({"AttributeName": range_key, "KeyType": "RANGE"})
        spec.append({"IndexName": gname, "KeySchema": keys, "Projection": {"ProjectionType": "ALL"}})
    kwargs = {}
    if spec:
        kwargs["GlobalSecondaryIndexes"] = spec
    ddb.create_table(TableName=name, BillingMode="PAY_PER_REQUEST",
                     AttributeDefinitions=[{"AttributeName": a, "AttributeType": "S"} for a in sorted(attrs)],
                     KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
                     **kwargs)


@pytest.fixture
def aws():
    with mock_aws():
        from app import core
        core.reset_clients()
        ddb = boto3.client("dynamodb", region_name=REGION)
        _table(ddb, "dev-tenant", [("GSI1", "GSI1PK", "GSI1SK")])
        _table(ddb, "dev-location", [("byLocationId", "locationId", None)])
        _table(ddb, "dev-user", [("byTenant", "tenantId", "PK")])
        for plan_id, name, max_loc, catering in (("starter", "Starter", 1, False), ("growth", "Growth", 3, True)):
            ddb.put_item(TableName="dev-tenant", Item={
                "PK": {"S": f"PLAN#{plan_id}"}, "SK": {"S": "PLAN"}, "GSI1PK": {"S": "PLAN"},
                "GSI1SK": {"S": plan_id}, "planId": {"S": plan_id}, "name": {"S": name},
                "maxLocations": {"N": str(max_loc)},
                "features": {"M": {"reservations": {"BOOL": True}, "ordering": {"BOOL": True},
                                   "catering": {"BOOL": catering}}}})

        idp = boto3.client("cognito-idp", region_name=REGION)
        pool = idp.create_user_pool(PoolName="tenants", UsernameAttributes=["email"], Schema=[
            {"Name": "tenant_id", "AttributeDataType": "String", "Mutable": False}])["UserPool"]["Id"]
        idp.create_group(UserPoolId=pool, GroupName="owner_user")
        idp.create_group(UserPoolId=pool, GroupName="staff_user")
        os.environ["TENANT_USER_POOL_ID"] = pool
        ops_pool = idp.create_user_pool(PoolName="operators", UsernameAttributes=["email"])["UserPool"]["Id"]
        idp.create_group(UserPoolId=ops_pool, GroupName="platform_admin")
        os.environ["OPERATOR_USER_POOL_ID"] = ops_pool
        os.environ["OPERATOR_GROUP_NAME"] = "platform_admin"

        sfn = boto3.client("stepfunctions", region_name=REGION)
        role = "arn:aws:iam::123456789012:role/sfn"
        for key in ("ONBOARDING", "DOMAIN_ATTACH", "DOMAIN_DETACH", "OFFBOARDING"):
            arn = sfn.create_state_machine(name=key.lower(), roleArn=role, definition=json.dumps(
                {"StartAt": "Done", "States": {"Done": {"Type": "Succeed"}}}))["stateMachineArn"]
            os.environ[f"{key}_STATE_MACHINE_ARN"] = arn

        sm = boto3.client("secretsmanager", region_name=REGION)
        os.environ["STRIPE_SECRET_ARN"] = sm.create_secret(
            Name="dev-stripe/api-key", SecretString=json.dumps({"apiKey": "rk_test_x"}))["ARN"]
        yield {"ddb": ddb, "idp": idp, "sfn": sfn, "pool": pool, "ops_pool": ops_pool}
        os.environ["PLATFORM_DOMAIN"] = ""


class Ctx:
    aws_request_id = "req-1"


def call(route, path=None, body=None, groups="[platform_admin]", query=None, actor="op-1"):
    from app.handler import handler
    claims = {"username": actor}
    if groups is not None:
        claims["cognito:groups"] = groups
    event = {"routeKey": route, "pathParameters": path or {}, "queryStringParameters": query,
             "body": json.dumps(body) if body is not None else None,
             "requestContext": {"authorizer": {"jwt": {"claims": claims}}}}
    resp = handler(event, Ctx())
    return resp["statusCode"], json.loads(resp["body"])


NEW_TENANT = {
    "name": "Pizzeria Roma", "slug": "pizzeria-roma", "ownerEmail": "Owner@Roma.se", "ownerName": "Maria Rossi",
    "planId": "starter", "legalName": "Roma Restaurang AB", "orgNumber": "556677-8899",
    "contactEmail": "info@roma.se", "senderName": "Roma",
    "address": {"street": "Storgatan 1", "postalCode": "111 22", "city": "Stockholm"},
    "locations": [{"name": "Roma Södermalm", "address": "Götgatan 10, Stockholm", "phone": "+46 8 123 45"}],
}


@pytest.fixture
def tenant(aws):
    status, body = call("POST /platform/tenants", body=NEW_TENANT)
    assert status == 202, body
    return body["tenantId"]
