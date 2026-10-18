"""Custom domains (www.restaurang.se). Attaching/detaching is done by the
domain workflows; this checks the request and starts them."""

import hashlib
import json

from . import validation as v
from botocore.exceptions import ClientError

from .core import (ApiError, cancellation_codes, client, env, from_ddb, new_id, not_found, now_iso, tenant_table,
                   to_ddb, write_audit)
from .tenants import get_profile

RETRYABLE = ("validation_timeout", "failed")


def _domain_row(tenant_id: str, host: str) -> dict | None:
    return from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), ConsistentRead=True,
        Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"DOMAIN#{host}"}}).get("Item"))


def _execution_name(prefix: str, host: str) -> str:
    return f"{prefix}-{hashlib.sha256(host.encode()).hexdigest()[:16]}-{new_id()[:10]}"


def claim_host(tenant_id: str, host: str, actor: str) -> str:
    """Claim the host for this tenant and create its row in ONE transaction
    before starting domain-attach - two tenants (or a double submit) can't
    both get past this. Same items the workflow's ReserveDomain writes; it
    finds them already there (owned by this tenant) and carries on.
    Re-adding after validation_timeout / failed resumes the same domain.

    "created" = claimed now, "exists" = this tenant already has the row in a
    non-retryable state. Another tenant's host raises domain_in_use."""
    try:
        client("dynamodb").transact_write_items(TransactItems=[
            {"Put": {"TableName": tenant_table(),
                     "Item": to_ddb({"PK": f"DOMAIN#{host}", "SK": "TENANT", "tenantId": tenant_id}),
                     "ConditionExpression": "attribute_not_exists(PK) OR tenantId = :t",
                     "ExpressionAttributeValues": {":t": {"S": tenant_id}}}},
            {"Put": {"TableName": tenant_table(),
                     "Item": to_ddb({"PK": f"TENANT#{tenant_id}", "SK": f"DOMAIN#{host}", "tenantId": tenant_id,
                                     "domain": host, "kind": "custom", "status": "pending_dns",
                                     "cnameTarget": env("TENANT_DOMAIN_CNAME_TARGET", ""),
                                     "requestedBy": actor, "requestedAt": now_iso()}),
                     "ConditionExpression": "attribute_not_exists(PK) OR #s IN (:r1, :r2)",
                     "ExpressionAttributeNames": {"#s": "status"},
                     "ExpressionAttributeValues": {":r1": {"S": RETRYABLE[0]}, ":r2": {"S": RETRYABLE[1]}}}},
        ])
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        codes = cancellation_codes(e)
        if codes[0] == "ConditionalCheckFailed":
            raise ApiError(409, "domain_in_use", f"{host} belongs to another customer",
                           fields={"domain": "Used by another customer"}) from e
        if len(codes) > 1 and codes[1] == "ConditionalCheckFailed":
            return "exists"
        raise
    return "created"


def add_domain(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    platform_domain = env("PLATFORM_DOMAIN", "")
    if not platform_domain:
        raise ApiError(409, "platform_domain_not_configured",
                       "Custom domains need the platform domain (var.platform_domain) to be set first")
    host = v.hostname(req.body.get("domain"))
    make_primary = bool(req.body.get("makePrimary"))
    if host == platform_domain or host.endswith("." + platform_domain):
        raise ApiError(400, "validation_failed", "Platform subdomains are created automatically",
                       fields={"domain": f"Use the customer's own domain, not *.{platform_domain}"})
    profile = get_profile(tenant_id)
    if profile.get("status") not in ("active", "provisioning", "suspended"):
        raise ApiError(409, "invalid_status", f"The tenant is {profile.get('status')}", currentStatus=profile.get("status"))

    if claim_host(tenant_id, host, req.actor) == "exists":
        row = _domain_row(tenant_id, host) or {}
        raise ApiError(409, "domain_exists", f"Already added ({row.get('status', 'in progress')})",
                       fields={"domain": "Already added"})

    client("stepfunctions").start_execution(
        stateMachineArn=env("DOMAIN_ATTACH_STATE_MACHINE_ARN"), name=_execution_name("attach", host),
        input=json.dumps({"tenantId": tenant_id, "domain": host, "makePrimary": make_primary,
                          "requestedBy": req.actor}))
    write_audit(tenant_id, "domain_attach_started", req.actor, {"domain": host, "makePrimary": make_primary})
    return 202, {"domain": host, "status": "pending_dns",
                 "dns": [{"type": "CNAME", "name": host, "value": env("TENANT_DOMAIN_CNAME_TARGET", "")}]}


def remove_domain(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    host = v.hostname(req.path.get("domain"))
    row = _domain_row(tenant_id, host)
    if row is None:
        raise not_found("No such domain for this tenant")
    if row.get("kind") == "platform":
        raise ApiError(409, "platform_domain", "The platform subdomain is removed only by offboarding")
    client("stepfunctions").start_execution(
        stateMachineArn=env("DOMAIN_DETACH_STATE_MACHINE_ARN"), name=_execution_name("detach", host),
        input=json.dumps({"tenantId": tenant_id, "domain": host}))
    write_audit(tenant_id, "domain_detach_started", req.actor, {"domain": host})
    return 202, {"domain": host, "status": "removing"}
