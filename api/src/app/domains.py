"""Custom domains (www.restaurang.se). Attaching/detaching is done by the
domain workflows; this checks the request and starts them.

Dev (owner 2026-11-15): no domain is ever attached for real outside prod. A
test customer's "own domain" example.se (or www.example.se) is mapped onto
the test sites zones, example-se.test.booqy.se (main, primary) and
example-se.test-dev.booqy.se (dev), through the same domain-attach workflow
on the sandbox distribution. Real customers' domains are managed from prod."""

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


def claim_host(tenant_id: str, host: str, actor: str, extra: dict | None = None) -> str:
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
                                     "requestedBy": actor, "requestedAt": now_iso(), **(extra or {})}),
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


def _test_zones() -> tuple[str, str]:
    return env("TEST_MAIN_DOMAIN", ""), env("TEST_DEV_DOMAIN", "")


def check_custom_host(host: str) -> None:
    platform_domain = env("PLATFORM_DOMAIN", "")
    if not platform_domain:
        raise ApiError(409, "platform_domain_not_configured",
                       "Custom domains need the platform domain (var.platform_domain) to be set first")
    if host == platform_domain or host.endswith("." + platform_domain):
        raise ApiError(400, "validation_failed", "Platform subdomains are created automatically",
                       fields={"domain": f"Use the customer's own domain, not *.{platform_domain}"})
    for zone in (z for z in _test_zones() if z):
        if host == zone or host.endswith("." + zone):
            raise ApiError(400, "validation_failed", "Test site hosts are made by the test mapping",
                           fields={"domain": f"Enter the domain itself (example.se), not *.{zone}"})


def start_attach(tenant_id: str, host: str, actor: str, make_primary: bool = False, sandbox: dict | None = None) -> bool:
    """Claim the host and start domain-attach. False: this tenant already has
    it attaching or live (nothing started). sandbox {stage, mappedFrom}: a
    test customer's mapped host on the test sites distribution (dev)."""
    if claim_host(tenant_id, host, actor, sandbox) == "exists":
        return False
    client("stepfunctions").start_execution(
        stateMachineArn=env("DOMAIN_ATTACH_STATE_MACHINE_ARN"), name=_execution_name("attach", host),
        input=json.dumps({"tenantId": tenant_id, "domain": host, "makePrimary": make_primary,
                          "requestedBy": actor, **({"sandbox": True, **sandbox} if sandbox else {})}))
    write_audit(tenant_id, "domain_attach_started", actor,
                {"domain": host, "makePrimary": make_primary, **(sandbox or {})})
    return True


def test_hosts(domain: str) -> dict:
    """example.se or www.example.se -> {main: example-se.<test main zone>,
    dev: example-se.<test dev zone>}."""
    main_zone, dev_zone = _test_zones()
    label = domain.removeprefix("www.").replace(".", "-")
    if len(label) > 63:
        raise ApiError(400, "validation_failed", "Too long for a test host", fields={"domain": "Use a shorter domain"})
    return {"main": f"{label}.{main_zone}", "dev": f"{label}.{dev_zone}"}


def _add_test_domain(req, tenant_id: str, host: str, profile: dict) -> tuple[int, dict]:
    if profile.get("siteKind") != "test":
        raise ApiError(409, "managed_from_prod", "This customer's domains are managed from the production console")
    mapped_from = host.removeprefix("www.")
    hosts = test_hosts(host)
    started = [start_attach(tenant_id, hosts[stage], req.actor, make_primary=(stage == "main"),
                            sandbox={"stage": stage, "mappedFrom": mapped_from})
               for stage in ("main", "dev")]
    if not any(started):
        raise ApiError(409, "domain_exists", f"{mapped_from} is already mapped", fields={"domain": "Already added"})
    return 202, {"domain": mapped_from, "status": "attaching", "test": True,
                 "hosts": [{"stage": stage, "host": hosts[stage]} for stage in ("main", "dev")]}


def add_domain(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    host = v.hostname(req.body.get("domain"))
    make_primary = bool(req.body.get("makePrimary"))
    check_custom_host(host)
    profile = get_profile(tenant_id)
    if profile.get("status") not in ("active", "provisioning", "suspended"):
        raise ApiError(409, "invalid_status", f"The tenant is {profile.get('status')}", currentStatus=profile.get("status"))
    if env("ENVIRONMENT") != "prod" and env("TEST_SITES_ENABLED", "false") == "true":
        return _add_test_domain(req, tenant_id, host, profile)

    if not start_attach(tenant_id, host, req.actor, make_primary):
        row = _domain_row(tenant_id, host) or {}
        raise ApiError(409, "domain_exists", f"Already added ({row.get('status', 'in progress')})",
                       fields={"domain": "Already added"})
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
    # A test mapping goes as a pair (its main and dev hosts).
    hosts = [host]
    if row.get("mappedFrom"):
        hosts = [h for h in test_hosts(row["mappedFrom"]).values() if h == host or _domain_row(tenant_id, h)]
    for h in hosts:
        client("stepfunctions").start_execution(
            stateMachineArn=env("DOMAIN_DETACH_STATE_MACHINE_ARN"), name=_execution_name("detach", h),
            input=json.dumps({"tenantId": tenant_id, "domain": h}))
        write_audit(tenant_id, "domain_detach_started", req.actor, {"domain": h})
    return 202, {"domain": host, "status": "removing", **({"hosts": hosts} if len(hosts) > 1 else {})}
