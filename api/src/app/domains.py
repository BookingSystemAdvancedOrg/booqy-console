"""Custom domains (www.restaurang.se). Attaching/detaching is done by the
domain workflows; this checks the request and starts them.

Dev (owner 2026-11-15): no domain is ever attached for real outside prod. A
test customer's "own domain" example.se (or www.example.se) is mapped onto
the test sites zones, example-se.test.booqy.se (main, primary) and
example-se.test-dev.booqy.se (dev): both hosts are claimed and live at once
(the sandbox distribution's wildcard certificate covers them), and the
label example-se goes into the sandbox's host map through site-repo
(testHost). No workflow, no distribution tenant, no certificate. Real
customers' domains are managed from prod. Once mapped (the site's primary),
the slug's own test hosts answer with a 301 to it, as <slug>.booqy.se does
in prod (testHost redirect); unmapping the primary sets them back."""

import hashlib
import json

from . import validation as v
from botocore.exceptions import ClientError

from .core import (ApiError, cancellation_codes, client, env, from_ddb, new_id, not_found, now_iso, tenant_table,
                   to_ddb, write_audit)
from .core import not_while
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
            raise ApiError(409, "domain_in_use", f"{host} is used by another customer. Remove it there first.",
                           fields={"domain": "Used by another customer."}) from e
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
                       "Own domains aren't switched on here yet. Booqy has to set this up.")
    if host == platform_domain or host.endswith("." + platform_domain):
        raise ApiError(400, "validation_failed", "Booqy makes this address by itself. Add the customer's own domain instead.",
                       fields={"domain": f"Use the customer's own domain, e.g. restaurang.se, not *.{platform_domain}."})
    for zone in (z for z in _test_zones() if z):
        if host == zone or host.endswith("." + zone):
            raise ApiError(400, "validation_failed", "Test site addresses are made by themselves. Add the domain itself instead.",
                           fields={"domain": f"Write the domain itself, e.g. example.se, not *.{zone}."})


def start_attach(tenant_id: str, host: str, actor: str, make_primary: bool = False) -> bool:
    """Claim the host and start domain-attach. False: this tenant already has
    it attaching or live (nothing started)."""
    if claim_host(tenant_id, host, actor) == "exists":
        return False
    client("stepfunctions").start_execution(
        stateMachineArn=env("DOMAIN_ATTACH_STATE_MACHINE_ARN"), name=_execution_name("attach", host),
        input=json.dumps({"tenantId": tenant_id, "domain": host, "makePrimary": make_primary,
                          "requestedBy": actor}))
    write_audit(tenant_id, "domain_attach_started", actor, {"domain": host, "makePrimary": make_primary})
    return True


def test_hosts(domain: str) -> dict:
    """example.se or www.example.se -> {main: example-se.<test main zone>,
    dev: example-se.<test dev zone>}."""
    main_zone, dev_zone = _test_zones()
    label = domain.removeprefix("www.").replace(".", "-")
    if len(label) > 63:
        raise ApiError(400, "validation_failed", "This domain is too long for a test site. Use a shorter one.",
                       fields={"domain": "Use a shorter domain."})
    return {"main": f"{label}.{main_zone}", "dev": f"{label}.{dev_zone}"}


def _site_repo(payload: dict) -> dict:
    from . import site                                  # site imports this module
    return site.invoke(payload)


def slug_redirect(tenant_id: str, label: str) -> None:
    """<slug>.test(-dev).booqy.se -> 301 to <label>.test(-dev).booqy.se;
    an empty label sets the slug's hosts back to serving the site."""
    _site_repo({"action": "testHost", "op": "redirect", "tenantId": tenant_id, "label": label})


def _test_items(tenant_id: str, hosts: dict, mapped_from: str, actor: str) -> list[dict]:
    items = []
    for stage, host in hosts.items():
        items.append({"PK": f"DOMAIN#{host}", "SK": "TENANT", "tenantId": tenant_id})
        items.append({"PK": f"TENANT#{tenant_id}", "SK": f"DOMAIN#{host}", "tenantId": tenant_id, "domain": host,
                      "kind": "custom", "status": "active", "stage": stage, "mappedFrom": mapped_from,
                      "sandbox": True, "requestedBy": actor, "requestedAt": now_iso()})
    return items


def map_test_domain(tenant_id: str, host: str, actor: str) -> dict:
    """example.se (or www.example.se) onto the test sites, both stages:
    claims, rows, the sandbox host map and the primary domain. Also the end
    of a simulated own-domain order (own_domains)."""
    mapped_from = host.removeprefix("www.")
    hosts = test_hosts(host)
    label = hosts["main"].split(".")[0]
    items = _test_items(tenant_id, hosts, mapped_from, actor)
    try:
        client("dynamodb").transact_write_items(TransactItems=[
            {"Put": {"TableName": tenant_table(), "Item": to_ddb(item),
                     "ConditionExpression": "attribute_not_exists(PK)"}} for item in items])
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        mine = (_domain_row(tenant_id, hosts["main"]) or {}).get("mappedFrom") == mapped_from
        if mine:
            raise ApiError(409, "domain_exists", f"{mapped_from} is already added. Nothing more to do.", fields={"domain": "Already added."}) from e
        raise ApiError(409, "domain_in_use", f"{label} is used by another customer. Remove it there first.",
                       fields={"domain": "Used by another customer."}) from e
    try:
        _site_repo({"action": "testHost", "op": "put", "tenantId": tenant_id, "label": label})
    except ApiError:
        _delete_test_items(tenant_id, hosts)
        raise
    _set_primary(tenant_id, hosts["main"])            # the site's own domain section (site-repo booqy.json "test")
    write_audit(tenant_id, "domain_test_mapped", actor, {"domain": mapped_from, **hosts})
    return hosts


def _add_test_domain(req, tenant_id: str, host: str, profile: dict) -> tuple[int, dict]:
    if profile.get("siteKind") != "test":
        raise ApiError(409, "managed_from_prod", "Change this customer's domains in the production console.")
    hosts = map_test_domain(tenant_id, host, req.actor)
    slug_redirect(tenant_id, hosts["main"].split(".")[0])
    return 202, {"domain": host.removeprefix("www."), "status": "active", "test": True,
                 "hosts": [{"stage": stage, "host": hosts[stage]} for stage in ("main", "dev")]}


def _set_primary(tenant_id: str, host: str) -> None:
    client("dynamodb").update_item(
        TableName=tenant_table(), Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}},
        UpdateExpression="SET primaryDomain = :d, updatedAt = :n",
        ExpressionAttributeValues={":d": {"S": host}, ":n": {"S": now_iso()}})


def _delete_test_items(tenant_id: str, hosts: dict) -> None:
    """The pair's claims (only while still this tenant's) and rows."""
    deletes = []
    for host in hosts.values():
        deletes.append({"Delete": {"TableName": tenant_table(), "Key": to_ddb({"PK": f"DOMAIN#{host}", "SK": "TENANT"}),
                                   "ConditionExpression": "attribute_not_exists(PK) OR tenantId = :t",
                                   "ExpressionAttributeValues": {":t": {"S": tenant_id}}}})
        deletes.append({"Delete": {"TableName": tenant_table(),
                                   "Key": to_ddb({"PK": f"TENANT#{tenant_id}", "SK": f"DOMAIN#{host}"})}})
    client("dynamodb").transact_write_items(TransactItems=deletes)


def unmap_test_domain(tenant_id: str, mapped_from: str, actor: str) -> dict:
    """Host map first (the claim is still ours), then the pair's rows; a
    primary mapped host falls back to the slug's main host."""
    hosts = test_hosts(mapped_from)
    profile = get_profile(tenant_id)
    primary = profile.get("primaryDomain") in hosts.values()
    if primary and profile.get("status") in ("active", "provisioning", "suspended", "offboarding"):
        slug_redirect(tenant_id, "")                 # the slug address serves again before the label goes
    _site_repo({"action": "testHost", "op": "delete", "tenantId": tenant_id, "label": hosts["main"].split(".")[0]})
    _delete_test_items(tenant_id, hosts)
    if primary and profile.get("slug"):
        _set_primary(tenant_id, f"{profile['slug']}.{_test_zones()[0]}")
    write_audit(tenant_id, "domain_test_unmapped", actor, {"domain": mapped_from, **hosts})
    return hosts


def _remove_test_domain(req, tenant_id: str, row: dict) -> tuple[int, dict]:
    hosts = unmap_test_domain(tenant_id, row["mappedFrom"], req.actor)
    return 202, {"domain": row["mappedFrom"], "status": "removed", "hosts": list(hosts.values())}


def add_domain(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    host = v.hostname(req.body.get("domain"))
    make_primary = bool(req.body.get("makePrimary"))
    check_custom_host(host)
    profile = get_profile(tenant_id)
    if profile.get("status") not in ("active", "provisioning", "suspended"):
        raise ApiError(409, "invalid_status", not_while(profile.get('status')), currentStatus=profile.get("status"))
    if env("ENVIRONMENT") != "prod" and env("TEST_SITES_ENABLED", "false") == "true":
        return _add_test_domain(req, tenant_id, host, profile)

    if not start_attach(tenant_id, host, req.actor, make_primary):
        raise ApiError(409, "domain_exists", "This domain is already added. Find it in the list below.",
                       fields={"domain": "Already added."})
    return 202, {"domain": host, "status": "pending_dns",
                 "dns": [{"type": "CNAME", "name": host, "value": env("TENANT_DOMAIN_CNAME_TARGET", "")}]}


def remove_domain(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    host = v.hostname(req.path.get("domain"))
    row = _domain_row(tenant_id, host)
    if row is None:
        raise not_found("We can't find this domain for the customer. Reload the page.")
    if row.get("kind") == "platform":
        raise ApiError(409, "platform_domain", "Booqy's own address for the customer can't be removed. It goes away when the customer is offboarded.")
    if row.get("sandbox") and row.get("mappedFrom"):
        return _remove_test_domain(req, tenant_id, row)        # a test mapping goes as a pair
    apex = host.removeprefix("www.")
    order = from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), ConsistentRead=True,
        Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"ZONE#{apex}"}}).get("Item")) or {}
    if order.get("status") in ("attaching", "live") and order.get("mode") != "transfer":
        raise ApiError(409, "own_domain_order", f"{host} is part of {apex}. Remove {apex} on the "
                                                "Domains card instead.")
    client("stepfunctions").start_execution(
        stateMachineArn=env("DOMAIN_DETACH_STATE_MACHINE_ARN"), name=_execution_name("detach", host),
        input=json.dumps({"tenantId": tenant_id, "domain": host}))
    write_audit(tenant_id, "domain_detach_started", req.actor, {"domain": host})
    return 202, {"domain": host, "status": "removing"}
