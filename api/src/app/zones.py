"""Domains the platform runs DNS for (a Route 53 hosted zone per domain).

Two ways in, both ending with the restaurant's site on <domain> and
www.<domain> (the domain-attach workflow does the CloudFront part):

  register  buy a new domain through Route 53 Domains. .se needs the
            company's registreringsbevis (the registry verifies the owner
            through an AWS Support case before the domain goes live).
  connect   the restaurant keeps its registrar (one.com, ...); we create the
            hosted zone, copy the records they rely on (email!) into it and
            they switch the name servers at the registrar.

This module does the synchronous parts (search, price, upload, the
RegisterDomain call, the zone + record import) and answers the
domain-provision workflow's tasks (workflow_task) for the parts that wait:
the registry, the name server switch.

Rows: TENANT#<t> / ZONE#<domain> is the order and its status; DOMAIN#<domain>
/ TENANT is the global claim (the same row domain-attach uses), so a domain
can only ever be in one tenant's hands."""

import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

from botocore.config import Config
from botocore.exceptions import ClientError

from . import validation as v
from .core import (ApiError, cancellation_codes, client, env, from_ddb, log, new_id, not_found, now_iso,
                   query_all, regional_client, tenant_table, to_ddb, write_audit)
from .domains import claim_host
from .tenants import get_profile

# What we sell. .nu can't be registered through Route 53 (connect works for
# any domain). Only .se needs the registreringsbevis.
TLDS = ("se", "com", "eu", "net")
VERIFY_TLDS = {"se"}
PRIVACY_TLDS = {"com", "net"}                     # .se / .eu: WHOIS privacy not supported
SEARCH_TLDS = ("se", "com", "eu")

RETRYABLE = ("failed", "timed_out")
CLOUDFRONT_ZONE_ID = "Z2FDTNDATAQYW2"            # fixed hosted zone id of every CloudFront alias target
DOC_MAX_BYTES = 10 * 1024 * 1024
DOC_PREFIX = "tenants/{tenant}/registreringsbevis/"

APEX_RE = re.compile(r"^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,63}$")
LABEL_RE = re.compile(r"[^a-z0-9-]+")
RECORD_TYPES = ("A", "AAAA", "CNAME", "MX", "TXT", "CAA", "SRV")
DOH_URL = "https://dns.google/resolve"
DNS_TYPE_CODES = {1: "A", 2: "NS", 5: "CNAME", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 257: "CAA"}

# Names the scan looks up before a connect (relative to the domain). One.com
# and the usual mail providers (Microsoft 365, Google Workspace) live here.
# Anything else the operator adds by hand in the review table.
SCAN_NAMES = {
    "": ("A", "AAAA", "MX", "TXT", "CAA"),
    "www": ("CNAME", "A", "AAAA"),
    "_dmarc": ("TXT",),
    "default._domainkey": ("CNAME", "TXT"),
    "selector1._domainkey": ("CNAME", "TXT"),
    "selector2._domainkey": ("CNAME", "TXT"),
    "google._domainkey": ("CNAME", "TXT"),
    "k1._domainkey": ("CNAME", "TXT"),
    "rsa1._domainkey": ("CNAME", "TXT"),
    "_autodiscover._tcp": ("SRV",),
    "_sip._tls": ("SRV",),
    "_sipfederationtls._tcp": ("SRV",),
    **{n: ("CNAME", "A", "AAAA", "MX", "TXT") for n in (
        "mail", "webmail", "smtp", "imap", "pop", "autodiscover", "autoconfig", "ftp",
        "lyncdiscover", "sip", "enterpriseregistration", "enterpriseenrollment")},
}


# ---------------------------------------------------------------- clients
def _domains():
    return regional_client("route53domains", "us-east-1")


def _route53():
    return client("route53")


def _s3():
    region = env("AWS_REGION", env("AWS_DEFAULT_REGION", "eu-north-1"))
    return regional_client("s3", region, endpoint_url=f"https://s3.{region}.amazonaws.com",
                           config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


def _doc_bucket() -> str:
    bucket = env("DOMAIN_DOCUMENTS_BUCKET", "")
    if not bucket:
        raise ApiError(409, "domains_not_configured", "Domain registration isn't set up in this environment")
    return bucket


# ----------------------------------------------------------------- helpers
def _tld(domain: str) -> str:
    return domain.rsplit(".", 1)[-1]


def _apex(value, field="domain") -> str:
    if not isinstance(value, str):
        raise ApiError(400, "validation_failed", "Invalid domain", fields={field: "Required"})
    host = value.strip().lower().rstrip(".")
    for prefix in ("https://", "http://"):
        if host.startswith(prefix):
            host = host[len(prefix):]
    host = host.split("/", 1)[0]
    if host.startswith("www."):
        host = host[4:]
    if not APEX_RE.match(host):
        raise ApiError(400, "validation_failed", "Invalid domain",
                       fields={field: "The domain itself, like restaurang.se (no www, no subdomain)"})
    platform = env("PLATFORM_DOMAIN", "")
    if platform and (host == platform or host.endswith("." + platform) or platform.endswith("." + host)):
        raise ApiError(400, "validation_failed", "That's the platform's own domain",
                       fields={field: "Use the restaurant's own domain"})
    return host


def _require_sites() -> None:
    if not env("PLATFORM_DOMAIN", "") or not env("TENANT_DOMAIN_CNAME_TARGET", ""):
        raise ApiError(409, "platform_domain_not_configured",
                       "Restaurant domains aren't switched on in this environment (tenant_sites_enabled)")


def _active_tenant(tenant_id: str) -> dict:
    profile = get_profile(tenant_id)
    if profile.get("status") not in ("active", "provisioning", "suspended"):
        raise ApiError(409, "invalid_status", f"The tenant is {profile.get('status')}",
                       currentStatus=profile.get("status"))
    return profile


def _zone_key(tenant_id: str, domain: str) -> dict:
    return {"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"ZONE#{domain}"}}


def _zone_row(tenant_id: str, domain: str) -> dict | None:
    return from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), Key=_zone_key(tenant_id, domain), ConsistentRead=True).get("Item"))


def _update_zone(tenant_id: str, domain: str, **fields) -> None:
    fields["updatedAt"] = now_iso()
    sets, removes, names, values = [], [], {}, {}
    for i, (k, val) in enumerate(fields.items()):
        names[f"#f{i}"] = k
        if val is None:
            removes.append(f"#f{i}")
        else:
            sets.append(f"#f{i} = :v{i}")
            values[f":v{i}"] = to_ddb({"x": val})["x"]
    expr = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
    client("dynamodb").update_item(TableName=tenant_table(), Key=_zone_key(tenant_id, domain),
                                   UpdateExpression=expr, ExpressionAttributeNames=names,
                                   ExpressionAttributeValues=values)


def _claim_zone(tenant_id: str, domain: str, row: dict) -> None:
    """Global claim on the domain + the order row, in one transaction. A
    failed or timed-out order can be placed again (it resumes)."""
    try:
        client("dynamodb").transact_write_items(TransactItems=[
            {"Put": {"TableName": tenant_table(),
                     "Item": to_ddb({"PK": f"DOMAIN#{domain}", "SK": "TENANT", "tenantId": tenant_id}),
                     "ConditionExpression": "attribute_not_exists(PK) OR tenantId = :t",
                     "ExpressionAttributeValues": {":t": {"S": tenant_id}}}},
            {"Put": {"TableName": tenant_table(),
                     "Item": to_ddb({"PK": f"TENANT#{tenant_id}", "SK": f"ZONE#{domain}", "tenantId": tenant_id,
                                     "domain": domain, **row}),
                     "ConditionExpression": "attribute_not_exists(PK) OR #s IN (:r1, :r2)",
                     "ExpressionAttributeNames": {"#s": "status"},
                     "ExpressionAttributeValues": {":r1": {"S": RETRYABLE[0]}, ":r2": {"S": RETRYABLE[1]}}}},
        ])
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        codes = cancellation_codes(e)
        if codes[0] == "ConditionalCheckFailed":
            raise ApiError(409, "domain_in_use", "This domain belongs to another customer",
                           fields={"domain": "Used by another customer"}) from e
        if len(codes) > 1 and codes[1] == "ConditionalCheckFailed":
            existing = _zone_row(tenant_id, domain) or {}
            raise ApiError(409, "domain_exists", f"Already in progress ({existing.get('status', '?')})",
                           fields={"domain": "Already added"}) from e
        raise


def _release_claim(tenant_id: str, domain: str) -> None:
    try:
        client("dynamodb").delete_item(
            TableName=tenant_table(), Key={"PK": {"S": f"DOMAIN#{domain}"}, "SK": {"S": "TENANT"}},
            ConditionExpression="tenantId = :t", ExpressionAttributeValues={":t": {"S": tenant_id}})
    except ClientError:
        pass


def _start_provision(tenant_id: str, domain: str, mode: str, make_primary: bool, actor: str) -> None:
    name = f"provision-{hashlib.sha256(domain.encode()).hexdigest()[:16]}-{new_id()[:10]}"
    client("stepfunctions").start_execution(
        stateMachineArn=env("DOMAIN_PROVISION_STATE_MACHINE_ARN"), name=name,
        input=json.dumps({"tenantId": tenant_id, "domain": domain, "mode": mode,
                          "makePrimary": make_primary, "requestedBy": actor}))


def public_zone(row: dict) -> dict:
    out = {k: row.get(k) for k in (
        "domain", "mode", "status", "statusDetail", "nameServers", "price", "renewalPrice", "makePrimary",
        "lastError", "requestedAt", "requestedBy", "updatedAt", "importedRecords", "operationStatus",
        "verificationRequired") if row.get(k) is not None}
    out["hasDocument"] = bool(row.get("documentKey"))
    if row.get("status") == "awaiting_verification" and row.get("verificationRequired"):
        out["supportCase"] = support_case_text(row["domain"], row.get("registrant", ""), row.get("orgNumber", ""))
    transfer = {k: row.get(f"transfer{k[0].upper()}{k[1:]}") for k in (
        "status", "statusDetail", "price", "error", "requestedAt", "requestedBy", "completedAt")}
    transfer = {k: val for k, val in transfer.items() if val is not None}
    if transfer:
        if transfer.get("status") == "awaiting_verification":
            transfer["supportCase"] = support_case_text(row["domain"], row.get("registrant", ""),
                                                        row.get("orgNumber", ""), "transfer")
        out["transfer"] = transfer
    out["registrar"] = "route53" if row.get("mode") == "register" or row.get("transferStatus") == "transferred" else "external"
    out["transferable"] = (row.get("mode") == "connect" and row.get("status") == "live"
                           and _tld(row["domain"]) in TLDS
                           and row.get("transferStatus") not in ("transferring", "awaiting_verification", "transferred"))
    return out


def list_zones(tenant_id: str) -> list[dict]:
    rows = query_all(TableName=tenant_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :z)",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":z": {"S": "ZONE#"}})
    return [public_zone(r) for r in rows]


# ------------------------------------------------------------------ prices
_PRICES: dict[str, tuple[float, dict]] = {}
PRICE_TTL = 6 * 3600


def _price(tld: str) -> dict | None:
    """{registration, renewal, transfer} for a TLD ({amount, currency}),
    cached per warm Lambda for 6 h - prices change rarely."""
    hit = _PRICES.get(tld)
    if hit and time.time() - hit[0] < PRICE_TTL:
        return hit[1]
    try:
        prices = _domains().list_prices(Tld=tld).get("Prices") or []
    except ClientError as e:
        log.warning("list_prices %s failed: %s", tld, e)
        return None
    row = next((p for p in prices if p.get("Name") == tld), None)
    if not row:
        return None

    def money(key):
        p = row.get(key) or {}
        return {"amount": Decimal(str(p["Price"])), "currency": p.get("Currency", "USD")} if "Price" in p else None

    out = {"registration": money("RegistrationPrice"), "renewal": money("RenewalPrice"),
           "transfer": money("TransferPrice")}
    _PRICES[tld] = (time.time(), out)
    return out


def _availability(domain: str) -> str:
    try:
        return _domains().check_domain_availability(DomainName=domain).get("Availability", "DONT_KNOW")
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in ("UnsupportedTLD", "InvalidInput"):
            return "UNSUPPORTED"
        raise


def _offer(domain: str, availability: str) -> dict:
    tld = _tld(domain)
    price = _price(tld) if tld in TLDS else None
    return {
        "domain": domain,
        "availability": availability,
        "available": availability == "AVAILABLE",
        "sellable": tld in TLDS,
        "verificationRequired": tld in VERIFY_TLDS,
        "price": (price or {}).get("registration"),
        "renewalPrice": (price or {}).get("renewal"),
    }


# ------------------------------------------------------------------ search
def search(req) -> tuple[int, dict]:
    """GET /platform/domains/search?q=arya  (or q=arya.se)"""
    raw = ((req.query or {}).get("q") or "").strip().lower()
    raw = raw.replace("å", "a").replace("ä", "a").replace("ö", "o")
    if raw.startswith("www."):
        raw = raw[4:]
    if "." in raw:
        label, tld = raw.rsplit(".", 1)
        label = LABEL_RE.sub("-", label.replace(".", "-")).strip("-")
        candidates = [f"{label}.{tld}"] + [f"{label}.{t}" for t in SEARCH_TLDS if t != tld]
    else:
        label = LABEL_RE.sub("-", raw).strip("-")
        candidates = [f"{label}.{t}" for t in SEARCH_TLDS]
    if not (2 <= len(label) <= 63) or not APEX_RE.match(candidates[0]):
        raise ApiError(400, "validation_failed", "Type a name, e.g. arya or arya.se",
                       fields={"q": "2-63 characters: a-z, 0-9 and '-'"})
    with ThreadPoolExecutor(max_workers=4) as pool:
        availability = list(pool.map(_availability, candidates))
    results = [_offer(d, a) for d, a in zip(candidates, availability)]

    suggestions = []
    try:
        seen = set(candidates)
        for s in _domains().get_domain_suggestions(DomainName=f"{label}.com", SuggestionCount=8,
                                                   OnlyAvailable=True).get("SuggestionsList", []):
            name = (s.get("DomainName") or "").lower()
            if name and name not in seen and _tld(name) in TLDS:
                seen.add(name)
                suggestions.append(_offer(name, s.get("Availability") or "AVAILABLE"))
    except ClientError as e:                       # suggestions are a nice-to-have
        log.warning("get_domain_suggestions failed: %s", e)
    return 200, {"query": raw, "results": results, "suggestions": suggestions[:6]}


# ------------------------------------------------------------ documents
def document_upload(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/domains/documents - a presigned POST
    for the registreringsbevis (PDF, max 10 MB). The browser uploads straight
    to the private documents bucket; the key goes into the registration."""
    tenant_id = req.path["tenantId"]
    _active_tenant(tenant_id)
    bucket = _doc_bucket()
    key = DOC_PREFIX.format(tenant=tenant_id) + f"{new_id()}.pdf"
    post = _s3().generate_presigned_post(
        Bucket=bucket, Key=key, Fields={"Content-Type": "application/pdf"},
        Conditions=[{"Content-Type": "application/pdf"}, ["content-length-range", 1, DOC_MAX_BYTES]],
        ExpiresIn=600)
    return 200, {"documentKey": key, "upload": {"url": post["url"], "fields": post["fields"]},
                 "maxBytes": DOC_MAX_BYTES}


def document_download(req) -> tuple[int, dict]:
    """GET /platform/tenants/{tenantId}/zones/{domain}/document - a 5-minute
    link to the uploaded registreringsbevis, to attach to the AWS Support case."""
    tenant_id = req.path["tenantId"]
    domain = _apex(req.path.get("domain"))
    row = _zone_row(tenant_id, domain)
    if not row or not row.get("documentKey"):
        raise not_found("No registreringsbevis for this domain (it's deleted 30 days after upload)")
    try:
        _s3().head_object(Bucket=_doc_bucket(), Key=row["documentKey"])
    except ClientError as e:
        raise not_found("The registreringsbevis has been deleted (30 days after upload) - upload it again") from e
    url = _s3().generate_presigned_url("get_object", ExpiresIn=300, Params={
        "Bucket": _doc_bucket(), "Key": row["documentKey"],
        "ResponseContentDisposition": f'attachment; filename="registreringsbevis-{domain}.pdf"'})
    return 200, {"url": url, "expiresInSeconds": 300}


# ------------------------------------------------------------ registration
def _contact(f: v.Fields, profile: dict) -> dict:
    """The registrant: the restaurant's AB (it owns the domain; we hold it in
    our account). Prefilled from the profile in the Console, editable there."""
    c = v.Fields(f.data.get("contact") or {})
    org = c.text("legalName", required=True, max_len=150)
    org_number = c.text("orgNumber", required=True, max_len=11, pattern=v.ORG_NUMBER_RE, msg="Format NNNNNN-NNNN")
    first = c.text("firstName", required=True, max_len=60)
    last = c.text("lastName", required=True, max_len=60)
    email = c.email("email", required=True)
    phone = c.phone("phone", required=True)
    addr = v.address(c, required=True)
    number = v.e164(phone)
    if phone and not number:
        c.fail("phone", "Use a number like 08-123 45 67 or +46 70 123 45 67")
    for k, msg in c.errors.items():
        f.fail(f"contact.{k}", msg)
    if c.errors:
        return {}
    digits = re.sub(r"\D", "", org_number)
    org_number = f"{digits[:6]}-{digits[6:]}"
    cc = "+46" if number.startswith("+46") else number[:3]
    return {
        "FirstName": first, "LastName": last, "ContactType": "COMPANY", "OrganizationName": org,
        "AddressLine1": addr["street"], "City": addr["city"], "CountryCode": addr["country"],
        "ZipCode": addr["postalCode"].replace(" ", ""), "Email": email,
        "PhoneNumber": f"{cc}.{number[len(cc):]}",
        "ExtraParams": [{"Name": "SE_ID_NUMBER", "Value": org_number}],
        "_orgNumber": org_number,
    }


def _document_key(f: v.Fields, tenant_id: str, tld: str) -> str | None:
    """.se: the registreringsbevis is required (the registry verifies the
    owner). The key must be one this tenant was issued."""
    if tld not in VERIFY_TLDS:
        return None
    key = f.text("documentKey", required=True, max_len=200)
    if key and not key.startswith(DOC_PREFIX.format(tenant=tenant_id)):
        f.fail("documentKey", "Upload the registreringsbevis again")
        return None
    return key


def _check_document(key: str | None) -> None:
    if not key:
        return
    try:
        head = _s3().head_object(Bucket=_doc_bucket(), Key=key)
    except ClientError as e:
        raise ApiError(400, "validation_failed", "The registreringsbevis wasn't uploaded",
                       fields={"documentKey": "Upload the registreringsbevis (PDF) first"}) from e
    if head.get("ContentLength", 0) > DOC_MAX_BYTES:
        raise ApiError(400, "validation_failed", "File too large", fields={"documentKey": "At most 10 MB"})


def _accepted_price(f: v.Fields) -> dict:
    accepted = f.data.get("acceptedPrice") or {}
    if not isinstance(accepted, dict) or "amount" not in accepted:
        f.fail("acceptedPrice", "Confirm the price")
        return {}
    return accepted


def _check_price(accepted: dict, current: dict, renewal: dict | None) -> None:
    """The operator confirmed a price in the Console; never charge another."""
    try:
        same = (Decimal(str(accepted["amount"])) == current["amount"]
                and str(accepted.get("currency", current["currency"])) == current["currency"])
    except Exception:  # noqa: BLE001 - a malformed amount is just "not the same price"
        same = False
    if not same:
        raise ApiError(409, "price_changed", "The price has changed - check it and confirm again",
                       price=current, renewalPrice=renewal)


def register(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/domains/registrations
    {domain, makePrimary, documentKey (.se), contact{...}, acceptedPrice{amount, currency}}"""
    tenant_id = req.path["tenantId"]
    _require_sites()
    profile = _active_tenant(tenant_id)
    domain = _apex(req.body.get("domain"))
    tld = _tld(domain)
    if tld not in TLDS:
        raise ApiError(400, "validation_failed", f".{tld} can't be bought here",
                       fields={"domain": f"We register {', '.join('.' + t for t in TLDS)} - connect other domains instead"})
    f = v.Fields(req.body)
    make_primary = f.boolean("makePrimary")
    contact = _contact(f, profile)
    document_key = _document_key(f, tenant_id, tld)
    accepted = _accepted_price(f)
    f.done()
    _check_document(document_key)

    availability = _availability(domain)
    if availability != "AVAILABLE":
        raise ApiError(409, "domain_unavailable", f"{domain} can't be registered ({availability.lower()})",
                       availability=availability)
    price = _price(tld)
    if not price or not price.get("registration"):
        raise ApiError(502, "price_unavailable", "Couldn't get the current price - try again")
    current = price["registration"]
    _check_price(accepted, current, price.get("renewal"))

    org_number = contact.pop("_orgNumber")
    _claim_zone(tenant_id, domain, {
        "mode": "register", "status": "registering", "makePrimary": bool(make_primary),
        "price": current, "renewalPrice": price.get("renewal"), "documentKey": document_key,
        "verificationRequired": tld in VERIFY_TLDS, "registrant": contact["OrganizationName"],
        "orgNumber": org_number, "requestedBy": req.actor, "requestedAt": now_iso(),
        "lastError": None,
    })
    privacy = tld in PRIVACY_TLDS
    try:
        op = _domains().register_domain(
            DomainName=domain, DurationInYears=1, AutoRenew=True,
            AdminContact=contact, RegistrantContact=contact, TechContact=contact,
            PrivacyProtectAdminContact=privacy, PrivacyProtectRegistrantContact=privacy,
            PrivacyProtectTechContact=privacy)
    except ClientError as e:
        message = e.response["Error"].get("Message") or str(e)
        _update_zone(tenant_id, domain, status="failed", lastError=f"Route 53 refused the registration: {message}"[:1000])
        _release_claim(tenant_id, domain)
        write_audit(tenant_id, "domain_registration_refused", req.actor, {"domain": domain, "error": message[:300]})
        raise ApiError(502, "registration_refused", f"Route 53 refused the registration: {message}") from e

    status = "awaiting_verification" if tld in VERIFY_TLDS else "registering"
    _update_zone(tenant_id, domain, operationId=op["OperationId"], status=status)
    _start_provision(tenant_id, domain, "register", bool(make_primary), req.actor)
    write_audit(tenant_id, "domain_registration_started", req.actor,
                {"domain": domain, "price": f"{current['amount']} {current['currency']}",
                 "verificationRequired": tld in VERIFY_TLDS})
    return 202, {"zone": public_zone(_zone_row(tenant_id, domain) or {}),
                 "supportCase": support_case_text(domain, contact["OrganizationName"], org_number)
                 if tld in VERIFY_TLDS else None}


def support_case_text(domain: str, company: str, org_number: str, action: str = "registration") -> dict:
    return {
        "service": "Route 53 Domains", "category": "Domain registration" if action == "registration" else "Domain transfer",
        "subject": f".se {action} - identity verification for {domain}",
        "body": (f"Hello,\n\nPlease find attached the registration certificate (registreringsbevis) for the "
                 f"registrant of {domain}, as required by the .se registry (NIS2 verification).\n\n"
                 f"Domain: {domain}\nRegistrant: {company}\nOrganisation number: {org_number}\n\n"
                 f"The address on the certificate is the registrant's current address.\n\nThank you."),
    }


# ---------------------------------------------------------------- transfer
TRANSFER_BUSY = ("transferring", "awaiting_verification")
TRANSFERABILITY_TEXT = {
    "TRANSFERABLE": None,
    "UNTRANSFERABLE": "The current registrar says it can't be transferred yet - usually it's locked, or was "
                      "registered or transferred less than 60 days ago",
    "DONT_KNOW": "The registry didn't answer - try again in a while",
    "DOMAIN_IN_OWN_ACCOUNT": "It's already registered in our Route 53 account",
    "DOMAIN_IN_ANOTHER_ACCOUNT": "It's registered in another AWS account - transfer it between accounts instead",
    "PREMIUM_DOMAIN": "Premium domains can't be transferred here",
}


def _connected_zone(tenant_id: str, domain: str) -> dict:
    row = _zone_row(tenant_id, domain)
    if not row:
        raise not_found("Connect the domain first - its DNS has to be in Route 53 before the registration moves")
    if row.get("mode") != "connect":
        raise ApiError(409, "already_route53", "This domain was bought here - it's already registered in Route 53")
    if row.get("status") != "live":
        raise ApiError(409, "not_live", f"Finish connecting it first (status {row.get('status')}) - "
                                        "the site must be live on our DNS before the registration moves")
    if row.get("transferStatus") in TRANSFER_BUSY + ("transferred",):
        raise ApiError(409, "transfer_exists", f"Transfer already {row['transferStatus'].replace('_', ' ')}")
    return row


def _transferability(domain: str, auth_code: str | None = None) -> tuple[str, str | None]:
    kwargs = {"DomainName": domain}
    if auth_code:
        kwargs["AuthCode"] = auth_code
    try:
        out = _domains().check_domain_transferability(**kwargs)
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in ("UnsupportedTLD", "InvalidInput"):
            return "UNSUPPORTED", e.response["Error"].get("Message")
        raise
    return (out.get("Transferability") or {}).get("Transferable", "DONT_KNOW"), out.get("Message")


def transfer_check(req) -> tuple[int, dict]:
    """GET /platform/tenants/{tenantId}/zones/{domain}/transfer - can the
    registration of a connected domain move to Route 53, and what it costs
    (the transfer includes one more year)."""
    tenant_id = req.path["tenantId"]
    domain = _apex(req.path.get("domain"))
    _connected_zone(tenant_id, domain)
    tld = _tld(domain)
    if tld not in TLDS:
        return 200, {"domain": domain, "transferable": False,
                     "reason": f".{tld} can't be registered through Route 53 - it stays at its registrar (DNS is ours already)"}
    status, message = _transferability(domain)
    price = _price(tld) or {}
    return 200, {"domain": domain, "transferable": status == "TRANSFERABLE", "transferability": status,
                 "reason": TRANSFERABILITY_TEXT.get(status, message), "price": price.get("transfer"),
                 "renewalPrice": price.get("renewal"), "verificationRequired": tld in VERIFY_TLDS}


def transfer(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/zones/{domain}/transfer
    {authCode, contact{...}, documentKey (.se), acceptedPrice}

    Moves the registration from the current registrar (one.com, ...) into
    Route 53, keeping our name servers - the site and email never notice."""
    tenant_id = req.path["tenantId"]
    domain = _apex(req.path.get("domain"))
    profile = _active_tenant(tenant_id)
    row = _connected_zone(tenant_id, domain)
    tld = _tld(domain)
    if tld not in TLDS:
        raise ApiError(400, "validation_failed", f".{tld} can't be registered through Route 53")
    f = v.Fields(req.body)
    auth_code = f.text("authCode", required=True, max_len=1024)
    contact = _contact(f, profile)
    document_key = _document_key(f, tenant_id, tld)
    accepted = _accepted_price(f)
    f.done()
    _check_document(document_key)

    status, message = _transferability(domain, auth_code)
    if status != "TRANSFERABLE":
        raise ApiError(409, "not_transferable", TRANSFERABILITY_TEXT.get(status) or message or status,
                       transferability=status)
    price = _price(tld) or {}
    if not price.get("transfer"):
        raise ApiError(502, "price_unavailable", "Couldn't get the current price - try again")
    _check_price(accepted, price["transfer"], price.get("renewal"))

    org_number = contact.pop("_orgNumber")
    privacy = tld in PRIVACY_TLDS
    name_servers = row.get("nameServers") or []
    try:
        op = _domains().transfer_domain(
            DomainName=domain, DurationInYears=1, AutoRenew=True, AuthCode=auth_code,
            Nameservers=[{"Name": n} for n in name_servers],
            AdminContact=contact, RegistrantContact=contact, TechContact=contact,
            PrivacyProtectAdminContact=privacy, PrivacyProtectRegistrantContact=privacy,
            PrivacyProtectTechContact=privacy)
    except ClientError as e:
        message = e.response["Error"].get("Message") or str(e)
        _update_zone(tenant_id, domain, transferStatus="failed",
                     transferError=f"Route 53 refused the transfer: {message}"[:1000])
        write_audit(tenant_id, "domain_transfer_refused", req.actor, {"domain": domain, "error": message[:300]})
        raise ApiError(502, "transfer_refused", f"Route 53 refused the transfer: {message}") from e

    _update_zone(tenant_id, domain, transferOperationId=op["OperationId"],
                 transferStatus="awaiting_verification" if tld in VERIFY_TLDS else "transferring",
                 transferPrice=price["transfer"], transferRequestedAt=now_iso(), transferRequestedBy=req.actor,
                 transferError=None, transferStatusDetail=None, documentKey=document_key,
                 verificationRequired=tld in VERIFY_TLDS, registrant=contact["OrganizationName"], orgNumber=org_number)
    _start_provision(tenant_id, domain, "transfer", False, req.actor)
    write_audit(tenant_id, "domain_transfer_started", req.actor,
                {"domain": domain, "price": f"{price['transfer']['amount']} {price['transfer']['currency']}"})
    return 202, {"zone": public_zone(_zone_row(tenant_id, domain) or {}),
                 "supportCase": support_case_text(domain, contact["OrganizationName"], org_number, "transfer")
                 if tld in VERIFY_TLDS else None}


def _task_transfer_status(tenant_id: str, domain: str) -> dict:
    row = _zone_row(tenant_id, domain) or {}
    if not row.get("transferOperationId"):
        _update_zone(tenant_id, domain, transferStatus="failed", transferError="No transfer operation recorded")
        return {"status": "failed"}
    op = _domains().get_operation_detail(OperationId=row["transferOperationId"])
    status, flag, message = op.get("Status"), op.get("StatusFlag"), op.get("Message")
    if status == "SUCCESSFUL":
        _update_zone(tenant_id, domain, transferStatus="transferred", transferStatusDetail=None,
                     transferCompletedAt=now_iso(), transferError=None)
        _delete_document(tenant_id, domain, row)
        return {"status": "done"}
    if status in ("ERROR", "FAILED"):
        _update_zone(tenant_id, domain, transferStatus="failed",
                     transferError=f"Transfer {status.lower()}: {message or 'no details from Route 53'}"[:1000])
        return {"status": "failed"}
    detail = {"PENDING_SUPPORT_CASE": "Waiting for the registry's identity check (AWS Support case)",
              "PENDING_AUTHORIZATION": "Waiting for the current registrar to release it (approve the "
                                       "transfer email at one.com to speed it up)",
              "PENDING_ACCEPTANCE": "Waiting for the registrant to accept (email)",
              "PENDING_CUSTOMER_ACTION": "Route 53 is waiting for an action - check the registrant's email",
              "PENDING_PAYMENT_VERIFICATION": "Waiting for AWS payment verification"}.get(flag)
    waiting = "awaiting_verification" if flag == "PENDING_SUPPORT_CASE" or (
        row.get("verificationRequired") and row.get("transferStatus") == "awaiting_verification"
        and flag is None) else "transferring"
    _update_zone(tenant_id, domain, transferStatus=waiting, transferStatusDetail=detail or message,
                 lastCheckedAt=now_iso())
    return {"status": "pending"}


# ------------------------------------------------------------- DNS records
def _rel(name: str, domain: str) -> str:
    name = name.strip().lower().rstrip(".")
    if name in ("", "@", domain):
        return ""
    if name.endswith("." + domain):
        return name[: -len(domain) - 1]
    return name


def _fqdn(rel: str, domain: str) -> str:
    return f"{rel}.{domain}" if rel else domain


def _txt_chunks(value: str) -> str:
    """One TXT value as Route 53 wants it: quoted strings of at most 255
    characters ('"v=spf1 ..."', long DKIM keys split into several)."""
    value = value.strip()
    if value.startswith('"') and value.endswith('"'):
        value = "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', value))
    value = value.replace("\\", "\\\\").replace('"', '\\"')
    return " ".join(f'"{value[i:i + 255]}"' for i in range(0, max(len(value), 1), 255))


def _skip_reason(rel: str, rtype: str) -> str | None:
    if rtype in ("NS", "SOA"):
        return "Managed by Route 53"
    if rel == "" and rtype in ("A", "AAAA", "CNAME"):
        return "Replaced: the domain points at the restaurant site"
    if rel == "www" or rel.endswith(".www"):
        return "Replaced: www points at the restaurant site"
    if rel.startswith("_cf-challenge"):
        return "Written by the platform"
    return None


def _records(raw, domain: str, f: v.Fields) -> tuple[list[dict], list[dict]]:
    """The reviewed record list from the Console -> (records to import,
    records skipped with the reason)."""
    if not isinstance(raw, list) or len(raw) > 200:
        f.fail("records", "A list of at most 200 records")
        return [], []
    keep, skipped, seen = [], [], {}
    for i, r in enumerate(raw):
        if not isinstance(r, dict):
            f.fail(f"records.{i}", "Must be an object")
            continue
        rtype = str(r.get("type") or "").upper()
        name = r.get("name")
        values = r.get("values")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9_.*@-]*", name.strip().lower().rstrip(".")):
            f.fail(f"records.{i}.name", "Invalid name")
            continue
        rel = _rel(name, domain)
        reason = _skip_reason(rel, rtype)
        if reason:
            skipped.append({"name": _fqdn(rel, domain), "type": rtype, "reason": reason})
            continue
        if rtype not in RECORD_TYPES:
            f.fail(f"records.{i}.type", f"One of {', '.join(RECORD_TYPES)}")
            continue
        if not isinstance(values, list) or not 1 <= len(values) <= 20 or \
                not all(isinstance(x, str) and 0 < len(x.strip()) <= 4000 for x in values):
            f.fail(f"records.{i}.values", "1-20 values")
            continue
        ttl = r.get("ttl", 3600)
        if isinstance(ttl, bool) or not isinstance(ttl, (int, Decimal)) or not 60 <= int(ttl) <= 172800:
            f.fail(f"records.{i}.ttl", "60-172800 seconds")
            continue
        vals = [_txt_chunks(x) if rtype == "TXT" else x.strip() for x in values]
        key = (rel, rtype)
        if key in seen:                       # same name+type twice: one record set with all values
            seen[key]["values"] = sorted(set(seen[key]["values"] + vals))
            continue
        rec = {"name": _fqdn(rel, domain), "type": rtype, "ttl": int(ttl), "values": vals}
        seen[key] = rec
        keep.append(rec)
    names = {}
    for rec in keep:
        names.setdefault(rec["name"], set()).add(rec["type"])
    for name, types in names.items():
        if "CNAME" in types and len(types) > 1:
            f.fail("records", f"{name}: a CNAME can't share its name with other records")
    for rec in keep:                          # CloudFront's certificate comes from Amazon's CA
        if rec["type"] == "CAA" and rec["name"] == domain and \
                not any("amazon" in val.lower() for val in rec["values"]):
            rec["values"].append('0 issue "amazon.com"')
    return keep, skipped


def _change(rec: dict) -> dict:
    return {"Action": "UPSERT", "ResourceRecordSet": {
        "Name": rec["name"], "Type": rec["type"], "TTL": rec["ttl"],
        "ResourceRecords": [{"Value": val} for val in rec["values"]]}}


def _doh(name: str, rtype: str) -> dict:
    url = f"{DOH_URL}?{urllib.parse.urlencode({'name': name, 'type': rtype})}"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/dns-json"}),
                                timeout=4) as r:  # noqa: S310 - fixed https URL
        return json.loads(r.read().decode("utf-8"))


def _lookup(name: str, rtype: str) -> tuple[list[str], int, bool]:
    """Values of exactly <name> <type> (not the CNAME chain), the TTL and
    whether the answer was DNSSEC-validated."""
    try:
        data = _doh(name, rtype)
    except Exception as e:  # noqa: BLE001 - one failed lookup shouldn't fail the scan
        log.info("doh %s %s failed: %s", name, rtype, e)
        return [], 0, False
    want = name.rstrip(".").lower()
    vals, ttl = [], 0
    for a in data.get("Answer") or []:
        if DNS_TYPE_CODES.get(a.get("type")) == rtype and str(a.get("name", "")).rstrip(".").lower() == want:
            vals.append(str(a.get("data", "")))
            ttl = max(ttl, int(a.get("TTL") or 0))
    return vals, ttl, bool(data.get("AD"))


def dns_scan(req) -> tuple[int, dict]:
    """GET /platform/domains/dns-scan?domain=restaurang.se - the records the
    domain uses today (looked up in public DNS), for the operator to review
    before connecting. Nothing is changed."""
    domain = _apex((req.query or {}).get("domain"))
    jobs = [(rel, t) for rel, types in SCAN_NAMES.items() for t in types]
    with ThreadPoolExecutor(max_workers=16) as pool:
        answers = dict(zip(jobs, pool.map(lambda j: _lookup(_fqdn(j[0], domain), j[1]), jobs)))
        ns, _, _ = _lookup(domain, "NS")
    records, dnssec = [], False
    for rel, types in SCAN_NAMES.items():
        cname = answers.get((rel, "CNAME"), ([], 0, False))
        for t in types:
            vals, ttl, ad = answers[(rel, t)]
            dnssec = dnssec or ad
            if not vals or (t != "CNAME" and cname[0]):   # a CNAME name has nothing else
                continue
            rec = {"name": _fqdn(rel, domain), "type": t, "ttl": max(300, min(ttl or 3600, 86400)),
                   "values": sorted(set(vals))}
            rec["skip"] = _skip_reason(rel, t)
            records.append(rec)
    return 200, {"domain": domain, "nameServers": sorted(n.rstrip(".").lower() for n in ns),
                 "dnssec": dnssec, "registered": bool(ns), "records": records}


# ------------------------------------------------------------------ connect
def connect(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/domains/connections
    {domain, makePrimary, records[{name, type, ttl, values[]}]}

    Creates the hosted zone with the reviewed records; the restaurant then
    switches the name servers at its registrar (the workflow waits for that)."""
    tenant_id = req.path["tenantId"]
    _require_sites()
    _active_tenant(tenant_id)
    domain = _apex(req.body.get("domain"))
    f = v.Fields(req.body)
    make_primary = f.boolean("makePrimary")
    records, skipped = _records(req.body.get("records", []), domain, f)
    f.done()

    previous = _zone_row(tenant_id, domain) or {}
    _claim_zone(tenant_id, domain, {
        "mode": "connect", "status": "creating_zone", "makePrimary": bool(make_primary),
        "hostedZoneId": previous.get("hostedZoneId"), "nameServers": previous.get("nameServers"),
        "requestedBy": req.actor, "requestedAt": now_iso(), "lastError": None,
    })
    r53 = _route53()
    zone_id, name_servers = previous.get("hostedZoneId"), previous.get("nameServers")
    try:
        if not zone_id:
            out = r53.create_hosted_zone(
                Name=domain, CallerReference=f"{tenant_id}:{domain}:{new_id()}",
                HostedZoneConfig={"Comment": f"Booqy restaurant site - tenant {tenant_id}", "PrivateZone": False})
            zone_id = out["HostedZone"]["Id"].split("/")[-1]
            name_servers = out["DelegationSet"]["NameServers"]
            # Recorded before anything else can fail, so a retry reuses this zone.
            _update_zone(tenant_id, domain, hostedZoneId=zone_id, nameServers=name_servers)
            r53.change_tags_for_resource(ResourceType="hostedzone", ResourceId=zone_id, AddTags=[
                {"Key": "TenantId", "Value": tenant_id}, {"Key": "ManagedBy", "Value": "booqy-console"},
                {"Key": "Environment", "Value": env("ENVIRONMENT", "dev")}])
        if records:
            r53.change_resource_record_sets(HostedZoneId=zone_id, ChangeBatch={
                "Comment": "Records copied from the previous DNS host", "Changes": [_change(r) for r in records]})
    except ClientError as e:
        message = e.response["Error"].get("Message") or str(e)
        _update_zone(tenant_id, domain, status="failed", lastError=f"Couldn't set up DNS: {message}"[:1000])
        raise ApiError(502, "dns_setup_failed", f"Couldn't set up DNS: {message}") from e

    _update_zone(tenant_id, domain, status="awaiting_nameservers", importedRecords=len(records))
    _start_provision(tenant_id, domain, "connect", bool(make_primary), req.actor)
    write_audit(tenant_id, "domain_connect_started", req.actor,
                {"domain": domain, "importedRecords": len(records), "hostedZoneId": zone_id})
    return 202, {"zone": public_zone(_zone_row(tenant_id, domain) or {}), "nameServers": name_servers,
                 "imported": records, "skipped": skipped}


# ---------------------------------------------------- workflow tasks
def _find_zone(domain: str) -> tuple[str, list[str]] | None:
    r53 = _route53()
    for z in r53.list_hosted_zones_by_name(DNSName=domain, MaxItems="10").get("HostedZones", []):
        if z["Name"].rstrip(".") == domain and not z.get("Config", {}).get("PrivateZone"):
            zone_id = z["Id"].split("/")[-1]
            ns = r53.get_hosted_zone(Id=zone_id).get("DelegationSet", {}).get("NameServers", [])
            return zone_id, ns
    return None


def _task_registration_status(tenant_id: str, domain: str) -> dict:
    row = _zone_row(tenant_id, domain) or {}
    if not row.get("operationId"):
        _update_zone(tenant_id, domain, status="failed", lastError="No registration operation recorded")
        return {"status": "failed"}
    op = _domains().get_operation_detail(OperationId=row["operationId"])
    status, flag, message = op.get("Status"), op.get("StatusFlag"), op.get("Message")
    if status == "SUCCESSFUL":
        found = _find_zone(domain)
        if not found:
            return {"status": "pending"}       # Route 53 creates the zone right after registering
        zone_id, ns = found
        try:
            _route53().change_tags_for_resource(ResourceType="hostedzone", ResourceId=zone_id, AddTags=[
                {"Key": "TenantId", "Value": tenant_id}, {"Key": "ManagedBy", "Value": "booqy-console"}])
        except ClientError as e:
            log.warning("tagging %s failed: %s", zone_id, e)
        _update_zone(tenant_id, domain, hostedZoneId=zone_id, nameServers=ns, operationStatus=status,
                     statusDetail=None, status="registered")
        _delete_document(tenant_id, domain, row)
        return {"status": "done"}
    if status in ("ERROR", "FAILED"):
        _update_zone(tenant_id, domain, status="failed", operationStatus=status,
                     lastError=f"Registration {status.lower()}: {message or 'no details from Route 53'}"[:1000])
        return {"status": "failed"}
    detail = {"PENDING_SUPPORT_CASE": "Waiting for the registry's identity check (AWS Support case)",
              "PENDING_CUSTOMER_ACTION": "Route 53 is waiting for an action - check the registrant's email",
              "PENDING_ACCEPTANCE": "Waiting for the registrant to accept (email)",
              "PENDING_AUTHORIZATION": "Waiting for authorization",
              "PENDING_PAYMENT_VERIFICATION": "Waiting for AWS payment verification"}.get(flag)
    status_now = "awaiting_verification" if row.get("verificationRequired") else "registering"
    _update_zone(tenant_id, domain, operationStatus=status, statusDetail=detail or message, status=status_now,
                 lastCheckedAt=now_iso())
    return {"status": "pending"}


def _delete_document(tenant_id: str, domain: str, row: dict) -> None:
    """The registreringsbevis is only needed until the registry has verified
    the owner - delete it then (the bucket also expires it after 30 days)."""
    if not row.get("documentKey"):
        return
    try:
        _s3().delete_object(Bucket=_doc_bucket(), Key=row["documentKey"])
        _update_zone(tenant_id, domain, documentKey=None, documentDeletedAt=now_iso())
    except (ClientError, ApiError) as e:
        log.warning("deleting the registreringsbevis for %s failed: %s", domain, e)


def _task_nameserver_status(tenant_id: str, domain: str) -> dict:
    row = _zone_row(tenant_id, domain) or {}
    ours = {n.rstrip(".").lower() for n in row.get("nameServers") or []}
    seen, _, _ = _lookup(domain, "NS")
    seen = {n.rstrip(".").lower() for n in seen}
    done = bool(seen) and seen <= ours
    _update_zone(tenant_id, domain, lastCheckedAt=now_iso(), observedNameServers=sorted(seen) or None,
                 statusDetail=None if done else ("Still answered by " + ", ".join(sorted(seen)) if seen
                                                 else "No name servers found yet"))
    return {"status": "done" if done else "pending"}


def _task_prepare_dns(tenant_id: str, domain: str, actor: str) -> dict:
    """Point <domain> and www.<domain> at the restaurant-site distribution and
    reserve both hosts for this tenant; the workflow then runs domain-attach
    for each. _cf-challenge TXT records prove ownership to CloudFront (an
    alias at the apex can't be checked the way a CNAME is)."""
    row = _zone_row(tenant_id, domain) or {}
    zone_id, target = row.get("hostedZoneId"), env("TENANT_DOMAIN_CNAME_TARGET", "")
    if not zone_id or not target:
        raise RuntimeError("hosted zone or CNAME target missing")
    www = f"www.{domain}"
    changes = [{"Action": "UPSERT", "ResourceRecordSet": {
        "Name": domain, "Type": t, "AliasTarget": {
            "HostedZoneId": CLOUDFRONT_ZONE_ID, "DNSName": target, "EvaluateTargetHealth": False}}}
        for t in ("A", "AAAA")]
    changes.append(_change({"name": www, "type": "CNAME", "ttl": 300, "values": [target]}))
    for host in (domain, www):
        changes.append(_change({"name": f"_cf-challenge.{host}", "type": "TXT", "ttl": 300,
                                "values": [f'"{target}"']}))
    _route53().change_resource_record_sets(HostedZoneId=zone_id, ChangeBatch={
        "Comment": "Restaurant site (Booqy)", "Changes": changes})
    for host in (domain, www):
        claim_host(tenant_id, host, actor)       # "exists" (already attached) is fine
    _update_zone(tenant_id, domain, status="attaching", statusDetail="Issuing certificates")
    return {"status": "done", "hosts": [domain, www]}


def _task_mark(tenant_id: str, domain: str, status: str, error: str | None) -> dict:
    if status not in ("live", "failed", "timed_out"):
        raise ValueError(f"bad status {status}")
    if status == "live":
        # domain-attach also ends successfully when the certificate never got
        # issued (validation_timeout) - only call it live when both are active.
        problems = []
        for host in (domain, f"www.{domain}"):
            row = from_ddb(client("dynamodb").get_item(
                TableName=tenant_table(), ConsistentRead=True,
                Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"DOMAIN#{host}"}}).get("Item")) or {}
            if row.get("status") != "active":
                problems.append(f"{host}: {row.get('status', 'missing')}"
                                + (f" ({row['lastError']})" if row.get("lastError") else ""))
        if problems:
            status, error = "failed", "Certificates not issued - " + "; ".join(problems)
    fields = {"status": status, "statusDetail": None}
    if status == "live":
        fields["lastError"] = None
        fields["liveAt"] = now_iso()
    elif error:
        fields["lastError"] = error[:1000]
    _update_zone(tenant_id, domain, **fields)
    if status != "live":
        _release_claim_if_unused(tenant_id, domain)
    return {"status": status}


def _task_mark_transfer(tenant_id: str, domain: str, status: str, error: str | None) -> dict:
    """A transfer that fails or times out leaves the domain where it was (at
    its registrar, still on our DNS) - only the transfer fields change; the
    site stays live."""
    if status not in ("failed", "timed_out"):
        raise ValueError(f"bad transfer status {status}")
    _update_zone(tenant_id, domain, transferStatus=status, transferStatusDetail=None,
                 transferError=(error or "")[:1000] or None)
    return {"status": status}


def _release_claim_if_unused(tenant_id: str, domain: str) -> None:
    """A registration that never happened shouldn't keep the domain reserved.
    A connected zone (or attached domain) keeps its claim - a retry resumes."""
    row = _zone_row(tenant_id, domain) or {}
    if row.get("mode") == "register" and not row.get("hostedZoneId"):
        attached = client("dynamodb").get_item(
            TableName=tenant_table(), Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"DOMAIN#{domain}"}}).get("Item")
        if not attached:
            _release_claim(tenant_id, domain)


def workflow_task(event: dict) -> dict:
    """Entry point for the domain-provision state machine (invoked directly,
    never through API Gateway - see handler.handler)."""
    task = event.get("workflowTask")
    tenant_id = event["tenantId"]
    domain = _apex(event["domain"])
    if task == "registration_status":
        return _task_registration_status(tenant_id, domain)
    if task == "nameserver_status":
        return _task_nameserver_status(tenant_id, domain)
    if task == "prepare_dns":
        return _task_prepare_dns(tenant_id, domain, event.get("requestedBy") or "workflow")
    if task == "transfer_status":
        return _task_transfer_status(tenant_id, domain)
    if task == "mark":
        if event.get("mode") == "transfer":
            return _task_mark_transfer(tenant_id, domain, event.get("status", ""), event.get("error"))
        return _task_mark(tenant_id, domain, event.get("status", ""), event.get("error"))
    raise ValueError(f"unknown workflow task {task!r}")
