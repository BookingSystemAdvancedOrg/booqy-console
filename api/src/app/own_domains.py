"""Own domains (owner 2026-11-15): the ways a restaurant's own domain comes
in, and the one pipeline every way ends in.

  1. Buy new           zones.register: Booqy registers it (prod; Booqy pays).
  2. Move to Booqy     transfer_in: the restaurant gives the transfer code
                       from its registrar. Its current DNS is copied into a
                       new hosted zone FIRST (email keeps working), then
                       TransferDomain names our name servers; the registry
                       e-mails the domain's owner, who approves. Reminders at
                       24 h, 72 h and 6 days; a rejection is classified (who
                       acts) and Retry starts it again.
  3. Keep the registrar
     a. DNS records    records: the restaurant adds www (and dev) CNAMEs and
                       forwards the apex to www at its registrar (a CNAME
                       can't sit at the apex). www.<domain> is canonical.
     b. Name servers   zones.connect: the restaurant points the name servers
                       at our zone (the apex works too).

Every mode ends in domain-provision's common steps: domain-attach,
SetCanonical (primary domain + the 301s from the slug address and www, in
the site-redirects key value store), MarkLive (Swedish e-mail),
dev.<domain> on the dev site through the prod->dev link (dev's primary and
dev's 301; never rolls back prod) and booqy.json. The workflow's tasks are
here (workflow_task); zones.py keeps the older ones.

Dev (DOMAINS_SIMULATE, never prod): a TEST customer can go through every
option. The order is "simulated": no Route 53 Domains call, no hosted zone,
no DNS lookup. The dev console's Simulate buttons move it (approve, reject,
expire, records added, name servers switched); the same state machine runs,
and at the end the domain is mapped onto the test sites (domains.py)
instead of attached. Real customers' domains are managed from prod.

Rows: TENANT#<t> / ZONE#<apex> is the order (zones.py), new fields here:
canonicalHost, aliasHosts, devHost, devStatus, devError, who, errorCode,
lastErrorSv, remindersSent, attempt, simulated, simState, devTarget,
expiresAt, autoRenew."""

import hashlib
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from botocore.exceptions import ClientError

from . import domain_mail
from . import validation as v
from . import zones
from .core import ApiError, client, env, from_ddb, log, not_found, now_iso, query_all, regional_client, tenant_table, \
    write_audit
from .tenants import get_profile

REMINDER_HOURS = (24, 72, 144)
ZONE_MODES = ("register", "transfer_in", "connect")
WAITING = {"register": "registering", "transfer_in": "transferring", "connect": "awaiting_nameservers",
           "records": "awaiting_records"}
TRANSFER_WAITING = ("awaiting_owner_approval", "transferring", "awaiting_verification")
RETRY_FROM = ("failed", "timed_out", "records_timeout", "nameservers_timeout")
RESUBMIT = ("transfer_rejected", "transfer_expired")
SIM_EVENTS = {"approve": ("register", "transfer_in"), "reject": ("transfer_in",), "expire": ("transfer_in", "records"),
              "records_added": ("records",), "ns_switched": ("connect",)}
SIM_PRICES = {"se": 32, "com": 16, "net": 17, "org": 16, "eu": 8, "fi": 17, "info": 30, "biz": 26, "app": 20,
              "me": 31, "io": 71}
TLD_TTL = 24 * 3600


# ------------------------------------------------------------------ helpers
def simulated() -> bool:
    return env("ENVIRONMENT") != "prod" and env("DOMAINS_SIMULATE", "false") == "true"


def sim_guard() -> bool:
    """True in the dev console's simulation; prod: False; otherwise refused."""
    if env("ENVIRONMENT") == "prod":
        return False
    if simulated():
        return True
    zones.prod_only()
    return False


def order_guard(profile: dict) -> bool:
    """Per customer: prod real, dev only a test customer (simulated)."""
    if not sim_guard():
        return False
    if profile.get("siteKind") != "test":
        raise ApiError(409, "managed_from_prod", "This customer's domains are managed from the production console")
    if env("TEST_SITES_ENABLED", "false") != "true":
        raise ApiError(409, "test_sites_off", "Test sites aren't switched on in this environment")
    return True


def hosts_for(mode: str, apex: str) -> tuple[str, list[str], str]:
    """(canonical, aliases that 301 to it, dev host) of an order."""
    if mode == "records":
        return f"www.{apex}", [], f"dev.{apex}"
    return apex, [f"www.{apex}"], f"dev.{apex}"


def _hours_since(iso: str | None) -> float:
    if not iso:
        return 0.0
    then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - then).total_seconds() / 3600


def _slug_host(tenant_id: str) -> str | None:
    rows = query_all(TableName=tenant_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :d)",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":d": {"S": "DOMAIN#"}})
    platform = sorted((r for r in rows if r.get("kind") == "platform"), key=lambda r: (r.get("stage") == "dev", r["domain"]))
    return platform[0]["domain"] if platform else None


def _domain_row(tenant_id: str, host: str) -> dict:
    return from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), ConsistentRead=True,
        Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"DOMAIN#{host}"}}).get("Item")) or {}


def _set_primary(tenant_id: str, host: str | None) -> None:
    ddb = client("dynamodb")
    key = {"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}}
    if host:
        ddb.update_item(TableName=tenant_table(), Key=key, UpdateExpression="SET primaryDomain = :d, updatedAt = :n",
                        ExpressionAttributeValues={":d": {"S": host}, ":n": {"S": now_iso()}})
    else:
        ddb.update_item(TableName=tenant_table(), Key=key, UpdateExpression="REMOVE primaryDomain")


def execution_name(mode: str, apex: str, attempt: int) -> str:
    return f"{mode}-{hashlib.sha256(apex.encode()).hexdigest()[:16]}-{attempt}"


def start(tenant_id: str, apex: str, mode: str, actor: str, attempt: int, **extra) -> None:
    """domain-provision for this order and attempt. A double click finds the
    execution already there: fine."""
    sfn = client("stepfunctions")
    try:
        sfn.start_execution(stateMachineArn=env("DOMAIN_PROVISION_STATE_MACHINE_ARN"),
                            name=execution_name(mode, apex, attempt),
                            input=json.dumps({"tenantId": tenant_id, "domain": apex, "mode": mode, "makePrimary": True,
                                              "requestedBy": actor, "attempt": attempt, **extra}))
    except ClientError as e:
        if e.response["Error"]["Code"] != "ExecutionAlreadyExists":
            raise


def start_failed(tenant_id: str, apex: str, e: Exception) -> None:
    """The order is placed (a bought domain is paid for) but its workflow
    didn't start: failed, Booqy acts, and the operation ids stay on the row
    so Retry resumes the same order."""
    log.error("domain-provision for %s didn't start: %s", apex, e)
    topic = env("ALERT_TOPIC_ARN", "")
    if topic:
        try:
            client("sns").publish(
                TopicArn=topic, Subject=f"[{env('ENVIRONMENT', 'dev')}] domain workflow didn't start: {apex}"[:100],
                Message=f"Tenant {tenant_id}, domain {apex}: the domain-provision workflow didn't start ({e}). "
                        "The order is failed and waits for Retry in the console.")
        except Exception:  # noqa: BLE001 - the alert never fails the order
            log.warning("domain workflow alert not published", exc_info=True)
    _fail(tenant_id, apex, "booqy", lastError=f"The setup workflow didn't start: {e}"[:1000])


def start_or_fail(tenant_id: str, apex: str, mode: str, actor: str, attempt: int, **extra) -> bool:
    try:
        start(tenant_id, apex, mode, actor, attempt, **extra)
    except Exception as e:  # noqa: BLE001 - the order stays, Retry starts it
        start_failed(tenant_id, apex, e)
        return False
    return True


# ---------------------------------------------------------- redirects (KVS)
def _kvs():
    return regional_client("cloudfront-keyvaluestore", "us-east-1")


def _kvs_arn() -> str:
    return env("SITE_REDIRECT_KVS_ARN", "")


def kvs_get(host: str) -> str | None:
    if not _kvs_arn():
        return None
    try:
        return _kvs().get_key(KvsARN=_kvs_arn(), Key=host).get("Value")
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceNotFoundException":
            return None
        raise


def _kvs_write(op: str, key: str, value: str | None = None) -> None:
    kvs = _kvs()
    for _ in range(5):
        etag = kvs.describe_key_value_store(KvsARN=_kvs_arn())["ETag"]
        try:
            if op == "put":
                kvs.put_key(KvsARN=_kvs_arn(), Key=key, Value=value, IfMatch=etag)
            else:
                kvs.delete_key(KvsARN=_kvs_arn(), Key=key, IfMatch=etag)
            return
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if op == "delete" and code == "ResourceNotFoundException":
                return
            if code not in ("ConflictException", "PreconditionFailed", "ValidationException"):
                raise
            time.sleep(0.2)
    raise RuntimeError("the site-redirects store kept changing, try again")


def redirect(hosts: list[str], target: str) -> list[str]:
    """host -> target for each host (the slug address, www). Never a loop:
    the target itself is never a key, nor a host pointing at itself."""
    if not _kvs_arn():
        return []
    if kvs_get(target):
        _kvs_write("delete", target)
    written = []
    for host in hosts:
        if host and host != target:
            _kvs_write("put", host, target)
            written.append(host)
    return written


def unredirect(hosts: list[str], target: str | None = None) -> None:
    """Removes the keys (only those that still point at target, when given)."""
    if not _kvs_arn():
        return
    for host in hosts:
        if not host:
            continue
        if target and kvs_get(host) not in (None, target):
            continue
        _kvs_write("delete", host)


# ------------------------------------------------------------ DNS lookups
def ds_present(domain: str) -> bool:
    """DNSSEC: a DS record at the parent. Changing the name servers while
    one is published takes the domain offline."""
    try:
        data = zones._doh(domain, "DS")
    except Exception:  # noqa: BLE001 - unknown counts as off; the scan shows it too
        return False
    return any(a.get("type") == 43 for a in data.get("Answer") or [])


def cname_of(host: str) -> str | None:
    vals, _, _ = zones._lookup(host, "CNAME")
    return vals[0].rstrip(".").lower() if vals else None


def forwarding_ok(apex: str) -> bool | None:
    """Does http://<apex> answer with a redirect to www? None: unknown."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(urllib.request.Request(f"http://{apex}/", method="HEAD"), timeout=4)  # noqa: S310
        return False
    except urllib.error.HTTPError as e:
        location = (e.headers.get("Location") or "").lower()
        return e.code in (301, 302, 307, 308) and f"www.{apex}" in location
    except Exception:  # noqa: BLE001
        return None


# ------------------------------------------------------------ simulation
class SimDomains:
    """Route 53 Domains for the dev console's simulated orders: prices from
    a fixed table, everything available except names starting with taken,
    transfers refused for names starting with locked."""

    @staticmethod
    def _refuse(op: str):
        raise ClientError({"Error": {"Code": "UnsupportedTLD", "Message": "TLD not supported (simulated)"}}, op)

    def check_domain_availability(self, DomainName):
        if zones._tld(DomainName) not in SIM_PRICES:
            self._refuse("CheckDomainAvailability")
        return {"Availability": "UNAVAILABLE" if DomainName.startswith("taken") else "AVAILABLE"}

    def list_prices(self, Tld=None, **_):
        def row(t, amount):
            money = {"Price": amount, "Currency": "USD"}
            return {"Name": t, "RegistrationPrice": money, "RenewalPrice": money,
                    "TransferPrice": {"Price": 0 if t in ("se", "fi") else amount, "Currency": "USD"}}
        if Tld:
            return {"Prices": [row(Tld, SIM_PRICES[Tld])] if Tld in SIM_PRICES else []}
        return {"Prices": [row(t, a) for t, a in SIM_PRICES.items()]}

    def get_domain_suggestions(self, **_):
        return {"SuggestionsList": []}

    def check_domain_transferability(self, DomainName, AuthCode=None):
        if zones._tld(DomainName) not in SIM_PRICES:
            self._refuse("CheckDomainTransferability")
        return {"Transferability": {"Transferable": "UNTRANSFERABLE" if DomainName.startswith("locked") else "TRANSFERABLE"}}

    def register_domain(self, **kw):
        return {"OperationId": f"sim-register-{kw['DomainName']}"}

    def transfer_domain(self, **kw):
        return {"OperationId": f"sim-transfer-{kw['DomainName']}"}


def sim_operation(row: dict) -> dict:
    state = row.get("simState") or "pending"
    if state == "approve":
        return {"Status": "SUCCESSFUL"}
    if state == "reject":
        return {"Status": "FAILED", "Message": "The registrant rejected the transfer (simulated)"}
    if row.get("mode") == "transfer_in":
        return {"Status": "IN_PROGRESS",
                "StatusFlag": "PENDING_SUPPORT_CASE" if row.get("verificationRequired") else "PENDING_ACCEPTANCE"}
    return {"Status": "IN_PROGRESS", "StatusFlag": "PENDING_SUPPORT_CASE" if row.get("verificationRequired") else None}


def sim_scan(domain: str) -> dict:
    return {"domain": domain, "nameServers": ["ns01.one.com", "ns02.one.com"], "dnssec": domain.startswith("dnssec"),
            "registered": True, "simulated": True, "records": [
                {"name": domain, "type": "MX", "ttl": 3600, "values": ["10 mx1.pub.mailpod.one.com."], "skip": None},
                {"name": domain, "type": "TXT", "ttl": 3600, "values": ['"v=spf1 include:_custspf.one.com ~all"'],
                 "skip": None},
                {"name": domain, "type": "A", "ttl": 3600, "values": ["46.30.215.1"],
                 "skip": "Replaced: the domain points at the restaurant site"}]}


def sim_map(tenant_id: str, apex: str, actor: str) -> dict:
    """The end of a simulated order: the domain mapped onto the test sites."""
    from . import domains
    hosts = domains.test_hosts(apex)
    if domains._domain_row(tenant_id, hosts["main"]):
        return hosts                                        # mapped already (a retry)
    domains.map_test_domain(tenant_id, apex, actor)
    return hosts


# ------------------------------------------------------------- the order
def _order(tenant_id: str, apex: str) -> dict:
    row = zones._zone_row(tenant_id, apex)
    if not row:
        raise not_found("No such domain order for this customer")
    return row


def _fail(tenant_id: str, apex: str, code: str, status: str = "failed", **extra) -> None:
    fields = {**domain_mail.error(code, apex), **extra}         # extra (a precise lastError) wins
    zones._update_zone(tenant_id, apex, status=status, statusDetail=None, **fields)


def _notify_action_needed(tenant_id: str, apex: str, code: str) -> None:
    if domain_mail.ERRORS.get(code, ("booqy",))[0] != "restaurant":
        return
    profile = get_profile(tenant_id, required=False) or {}
    domain_mail.send(profile, "action_needed", domain=apex, text=domain_mail.error(code, apex)["lastErrorSv"])


def classify_transfer(message: str | None) -> str:
    m = (message or "").lower()
    if any(k in m for k in ("auth", "epp", "authinfo", "transfer code", "password")):
        return "bad_auth_code"
    if any(k in m for k in ("lock", "prohibited")):
        return "locked"
    if "60" in m and "day" in m or "recently" in m:
        return "too_recent"
    if any(k in m for k in ("reject", "denied", "declin", "nack", "refus", "cancel")):
        return "rejected"
    return "booqy"


def _remind(tenant_id: str, apex: str, row: dict, kind: str, **context) -> None:
    """Reminder e-mails at 24 h, 72 h and 6 days after the order, once each."""
    sent = set(row.get("remindersSent") or [])
    age = _hours_since(row.get("retriedAt") or row.get("requestedAt"))          # a Retry starts the count again
    due = [h for h in REMINDER_HOURS if age >= h and str(h) not in sent]
    if not due:
        return
    profile = get_profile(tenant_id, required=False) or {}
    if kind == "transfer_reminder" and not row.get("simulated") and row.get("transferInOperationId"):
        try:
            zones._domains().resend_operation_authorization(OperationId=row["transferInOperationId"])
        except (ClientError, AttributeError) as e:
            log.info("resend authorization for %s: %s", apex, e)
    domain_mail.send(profile, kind, domain=apex, **context)
    zones._update_zone(tenant_id, apex, remindersSent=sorted(sent | {str(h) for h in due}), lastReminderAt=now_iso())


# ------------------------------------------------------------------- API
def tlds(req) -> tuple[int, dict]:
    """GET /platform/domains/tlds - what can be bought and moved in, with
    prices (Route 53 Domains ListPrices, cached for a day). A TLD not in the
    list (.nu, .dk, .no) can only stay at its registrar (option 3)."""
    sim_guard()
    out = _all_prices()
    return 200, {"tlds": out, "sellable": list(zones.TLDS)}


_TLDS: dict = {}


def _all_prices() -> list[dict]:
    hit = _TLDS.get("all")
    if hit and time.time() - hit[0] < TLD_TTL:
        return hit[1]
    rows, token = [], None
    while True:
        kwargs = {"MaxItems": 1000, **({"Marker": token} if token else {})}
        page = zones._domains().list_prices(**kwargs)
        rows.extend(page.get("Prices") or [])
        token = page.get("NextPageMarker")
        if not token:
            break

    def amount(p, key):
        price = p.get(key) or {}
        return {"amount": price["Price"], "currency": price.get("Currency", "USD")} if "Price" in price else None

    out = sorted(({"tld": p["Name"], "register": amount(p, "RegistrationPrice"), "transfer": amount(p, "TransferPrice"),
                   "renew": amount(p, "RenewalPrice"), "sellable": p["Name"] in zones.TLDS}
                  for p in rows if p.get("Name")), key=lambda r: r["tld"])
    _TLDS["all"] = (time.time(), out)
    return out


def transfer_check(req) -> tuple[int, dict]:
    """GET /platform/domains/transfer-check?domain=roma.se - before a move to
    Booqy: is the TLD supported, can it move (lock, 60 days), the price, and
    whether DNSSEC must be switched off first. Nothing is changed."""
    sim = sim_guard()
    apex = zones._apex((req.query or {}).get("domain"))
    tld = zones._tld(apex)
    price = zones._price(tld) or {}
    if not price.get("transfer"):
        return 200, {"domain": apex, "supported": False, "transferable": False,
                     **domain_mail.error("unsupported_tld", apex)}
    status, message = zones._transferability(apex)
    dnssec = apex.startswith("dnssec") if sim else ds_present(apex)
    out = {"domain": apex, "supported": True, "transferable": status == "TRANSFERABLE" and not dnssec,
           "transferability": status, "reason": zones.TRANSFERABILITY_TEXT.get(status, message),
           "price": price.get("transfer"), "renewalPrice": price.get("renewal"),
           "verificationRequired": tld in zones.VERIFY_TLDS, "dnssec": dnssec, "simulated": sim}
    if dnssec:
        out.update(domain_mail.error("dnssec", apex))
    elif status == "UNTRANSFERABLE":
        out.update(domain_mail.error("locked", apex))
    return 200, out


def transfer_in(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/domains/transfers
    {domain, authCode, records[...], contact{...}, documentKey (.se), acceptedPrice}

    Move a domain the restaurant has at another registrar to Booqy: zone
    with its current records first (nothing changes yet: the registrar's
    name servers keep answering), then TransferDomain naming our name
    servers. The owner approves by e-mail; domain-provision waits."""
    tenant_id = req.path["tenantId"]
    profile = zones._active_tenant(tenant_id)
    sim = order_guard(profile)
    if not sim:
        zones._require_sites()
    apex = zones._apex(req.body.get("domain"))
    tld = zones._tld(apex)
    f = v.Fields(req.body)
    auth_code = f.text("authCode", required=True, max_len=1024)
    records, skipped = zones._records(req.body.get("records", []), apex, f)
    contact = zones._contact(f, profile)
    document_key = zones._document_key(f, tenant_id, tld)
    accepted = zones._accepted_price(f)
    f.done()
    price = zones._price(tld) or {}
    if not price.get("transfer"):
        raise ApiError(409, "unsupported_tld", f".{tld} can't be moved to Booqy - keep it at its registrar instead",
                       **domain_mail.error("unsupported_tld", apex))
    zones._check_document(document_key)
    if (apex.startswith("dnssec") if sim else ds_present(apex)):
        raise ApiError(409, "blocked_dnssec", f"DNSSEC is on for {apex}: it must be switched off first",
                       **domain_mail.error("dnssec", apex))
    status, message = zones._transferability(apex, auth_code)
    if status != "TRANSFERABLE":
        code = "locked" if status == "UNTRANSFERABLE" else "booqy"
        raise ApiError(409, "not_transferable", zones.TRANSFERABILITY_TEXT.get(status) or message or status,
                       transferability=status, **domain_mail.error(code, apex))
    zones._check_price(accepted, price["transfer"], price.get("renewal"))

    previous = zones._zone_row(tenant_id, apex) or {}
    attempt = int(previous.get("attempt") or 0) + 1
    org_number = contact.pop("_orgNumber")
    zones._claim_zone(tenant_id, apex, {
        "mode": "transfer_in", "status": "creating_zone", "makePrimary": True, "simulated": sim or None,
        "simState": None, "attempt": attempt, "hostedZoneId": previous.get("hostedZoneId"),
        "nameServers": previous.get("nameServers"), "price": price["transfer"], "renewalPrice": price.get("renewal"),
        "documentKey": document_key, "verificationRequired": tld in zones.VERIFY_TLDS,
        "registrant": contact["OrganizationName"], "registrantEmail": contact["Email"], "orgNumber": org_number,
        "requestedBy": req.actor, "requestedAt": now_iso(), "lastError": None, "lastErrorSv": None, "who": None,
        "errorCode": None, "remindersSent": None, **dict(zip(("canonicalHost", "aliasHosts", "devHost"),
                                                             hosts_for("transfer_in", apex))),
    })
    zone_id, name_servers = _ensure_zone(tenant_id, apex, previous, records, sim, caa=True)
    privacy = tld in zones.PRIVACY_TLDS
    try:
        op = zones._domains().transfer_domain(
            DomainName=apex, DurationInYears=1, AutoRenew=True, AuthCode=auth_code,
            Nameservers=[{"Name": n} for n in name_servers],
            AdminContact=contact, RegistrantContact=contact, TechContact=contact,
            PrivacyProtectAdminContact=privacy, PrivacyProtectRegistrantContact=privacy,
            PrivacyProtectTechContact=privacy)
    except ClientError as e:
        message = e.response["Error"].get("Message") or str(e)
        code = classify_transfer(message)
        _fail(tenant_id, apex, code, status="transfer_rejected")
        write_audit(tenant_id, "domain_transfer_in_refused", req.actor, {"domain": apex, "error": message[:300]})
        raise ApiError(409, "transfer_refused", f"Route 53 refused the transfer: {message}",
                       **domain_mail.error(code, apex)) from e
    waiting = "awaiting_verification" if tld in zones.VERIFY_TLDS else "awaiting_owner_approval"
    zones._update_zone(tenant_id, apex, transferInOperationId=op["OperationId"], status=waiting,
                       importedRecords=len(records))
    start_or_fail(tenant_id, apex, "transfer_in", req.actor, attempt)
    if tld not in zones.VERIFY_TLDS:
        domain_mail.send(profile, "transfer_approve", domain=apex)
    write_audit(tenant_id, "domain_transfer_in_started", req.actor,
                {"domain": apex, "price": f"{price['transfer']['amount']} {price['transfer']['currency']}",
                 "importedRecords": len(records), "simulated": sim})
    return 202, {"zone": zones.public_zone(zones._zone_row(tenant_id, apex) or {}), "imported": records,
                 "skipped": skipped, "nameServers": name_servers,
                 "supportCase": zones.support_case_text(apex, contact["OrganizationName"], org_number, "transfer")
                 if tld in zones.VERIFY_TLDS else None}


def _ensure_zone(tenant_id: str, apex: str, previous: dict, records: list[dict], sim: bool,
                 caa: bool = False) -> tuple[str, list[str]]:
    """The hosted zone with the copied records (a retry reuses it).
    Simulated: no zone, made-up name servers."""
    if sim:
        ns = [f"ns-{i}.awsdns-sim.{t}" for i, t in ((1, "org"), (2, "co.uk"), (3, "com"), (4, "net"))]
        zones._update_zone(tenant_id, apex, hostedZoneId="sim", nameServers=ns)
        return "sim", ns
    if caa:
        # The site's current apex and www records too: the registry switches
        # the name servers the moment the owner approves, and until PrepareDns
        # points both at Booqy the old site keeps answering (no downtime).
        have = {(r["name"], r["type"]) for r in records}
        records = [*records, *(r for r in interim_site_records(apex) if (r["name"], r["type"]) not in have)]
    if caa and not any(r["type"] == "CAA" and r["name"] == apex for r in records):
        records = [*records, {"name": apex, "type": "CAA", "ttl": 3600,
                              "values": ['0 issue "amazon.com"', '0 issue "amazontrust.com"']}]
    r53 = zones._route53()
    zone_id, name_servers = previous.get("hostedZoneId"), previous.get("nameServers")
    try:
        if not zone_id or zone_id == "sim":
            out = r53.create_hosted_zone(
                Name=apex, CallerReference=f"{tenant_id}:{apex}:{time.time_ns()}",
                HostedZoneConfig={"Comment": f"Booqy restaurant site - tenant {tenant_id}", "PrivateZone": False})
            zone_id = out["HostedZone"]["Id"].split("/")[-1]
            name_servers = out["DelegationSet"]["NameServers"]
            zones._update_zone(tenant_id, apex, hostedZoneId=zone_id, nameServers=name_servers)
            r53.change_tags_for_resource(ResourceType="hostedzone", ResourceId=zone_id, AddTags=[
                {"Key": "TenantId", "Value": tenant_id}, {"Key": "ManagedBy", "Value": "booqy-console"},
                {"Key": "Environment", "Value": env("ENVIRONMENT", "dev")}])
        if records:
            r53.change_resource_record_sets(HostedZoneId=zone_id, ChangeBatch={
                "Comment": "Records copied from the previous DNS host", "Changes": [zones._change(r) for r in records]})
    except ClientError as e:
        # recordsImported False: Retry would go live without the restaurant's
        # e-mail records, so it is refused (Connect again with the records).
        message = e.response["Error"].get("Message") or str(e)
        _fail(tenant_id, apex, "booqy", lastError=f"Couldn't set up DNS: {message}"[:1000], recordsImported=False)
        if e.response["Error"].get("Code") == "InvalidChangeBatch":
            raise ApiError(400, "validation_failed", f"Route 53 refused a record: {message}",
                           fields={"records": f"Route 53 refused a record: {message}"[:500]}) from e
        raise ApiError(502, "dns_setup_failed", f"Couldn't set up DNS: {message}") from e
    zones._update_zone(tenant_id, apex, recordsImported=True)
    return zone_id, name_servers


def interim_site_records(apex: str) -> list[dict]:
    """The apex A/AAAA and the www record (CNAME, else A/AAAA) as public DNS
    has them now, with a short TTL. Only for a move to Booqy: PrepareDns
    replaces them with the site's records."""
    out = []
    for name, types in ((apex, ("A", "AAAA")), (f"www.{apex}", ("CNAME", "A", "AAAA"))):
        for rtype in types:
            vals, _, _ = zones._lookup(name, rtype)
            vals = sorted({x.strip() for x in vals if x and x.strip()})
            if vals:
                out.append({"name": name, "type": rtype, "ttl": 300, "values": vals})
                if rtype == "CNAME":
                    break
    return out


def records(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/domains/records {domain}

    The restaurant keeps its registrar and its DNS: it adds www (and dev)
    CNAMEs and forwards the apex to www. The restaurant gets the steps by
    e-mail; domain-provision checks DNS until www points at us."""
    tenant_id = req.path["tenantId"]
    profile = zones._active_tenant(tenant_id)
    sim = order_guard(profile)
    if not sim:
        zones._require_sites()
    apex = zones._apex(req.body.get("domain"))
    previous = zones._zone_row(tenant_id, apex) or {}
    attempt = int(previous.get("attempt") or 0) + 1
    if sim:                                    # the dev record shows too: the sandbox's dev host
        from . import domains
        dev_target = domains.test_hosts(apex)["dev"]
    else:
        dev_target = _dev_target(tenant_id)
    zones._claim_zone(tenant_id, apex, {
        "mode": "records", "status": "awaiting_records", "makePrimary": True, "simulated": sim or None,
        "simState": None, "attempt": attempt, "requestedBy": req.actor, "requestedAt": now_iso(),
        "lastError": None, "lastErrorSv": None, "who": None, "errorCode": None, "remindersSent": None,
        # a zone an earlier order made (a rejected move) stays referenced, so it is never orphaned
        "hostedZoneId": previous.get("hostedZoneId"), "nameServers": previous.get("nameServers"),
        "devTarget": dev_target, **dict(zip(("canonicalHost", "aliasHosts", "devHost"), hosts_for("records", apex))),
        **kept_registration(previous),
    })
    start_or_fail(tenant_id, apex, "records", req.actor, attempt)
    target = env("TENANT_DOMAIN_CNAME_TARGET", "") or "booqy-sites.example"
    domain_mail.send(profile, "records_steps", domain=apex, target=target, dev_target=dev_target)
    write_audit(tenant_id, "domain_records_started", req.actor, {"domain": apex, "simulated": sim})
    return 202, {"zone": zones.public_zone(zones._zone_row(tenant_id, apex) or {})}


def _dev_target(tenant_id: str) -> str | None:
    """The dev site's CNAME target, read through the prod->dev link."""
    from . import site
    if not site.enabled():
        return None
    try:
        return site.invoke({"action": "devDomain", "op": "status", "tenantId": tenant_id}).get("cnameTarget") or None
    except ApiError as e:
        log.info("dev target for %s: %s", tenant_id, e.message)
        return None


def required_records(row: dict) -> list[dict]:
    """What the restaurant adds in DNS records mode (shown and e-mailed)."""
    apex = row["domain"]
    out = [{"type": "CNAME", "name": "www", "host": f"www.{apex}",
            "value": env("TENANT_DOMAIN_CNAME_TARGET", "") or "-", "purpose": "site"}]
    if row.get("devTarget"):
        out.append({"type": "CNAME", "name": "dev", "host": f"dev.{apex}", "value": row["devTarget"],
                    "purpose": "dev site"})
    out.append({"type": "Forwarding", "name": apex, "host": apex, "value": f"https://www.{apex}",
                "purpose": "apex (permanent / 301)"})
    return out


def restaurant_steps(row: dict) -> str | None:
    """The Swedish text the restaurant gets for what it must do now."""
    apex, status = row["domain"], row.get("status")
    if row.get("lastErrorSv") and row.get("who") == "restaurant":
        return row["lastErrorSv"]
    if status == "awaiting_records" or (row.get("mode") == "records" and row.get("devStatus") == "awaiting_dev_record"):
        return domain_mail.records_steps(apex, env("TENANT_DOMAIN_CNAME_TARGET", "") or "-", row.get("devTarget"))
    if status in ("awaiting_nameservers", "blocked_dnssec") and row.get("nameServers"):
        return domain_mail.nameserver_steps(apex, row["nameServers"], status == "blocked_dnssec")
    if status == "awaiting_owner_approval":
        return domain_mail.transfer_steps(apex)
    return None


def public_extra(row: dict) -> dict:
    """Own-domain fields of zones.public_zone."""
    out = {k: row.get(k) for k in ("canonicalHost", "aliasHosts", "devHost", "devStatus", "devError", "who",
                                     "errorCode", "lastErrorSv", "attempt", "simulated", "simState", "expiresAt",
                                     "autoRenew", "liveAt", "registrantEmail") if row.get(k) is not None}
    out["remindersSent"] = len(row.get("remindersSent") or [])
    status = row.get("status")
    out["canRetry"] = (status in RETRY_FROM and not retry_block(row)) or (
        status == "live" and row.get("devStatus") == "failed")
    out["canResubmit"] = status in RESUBMIT
    # removing: an earlier Remove stopped half way; it runs again
    out["canRemove"] = status not in TRANSFER_WAITING + ("removed", "registering")
    out["registered"] = registered_here(row)
    if row.get("mode") == "records":
        out["records"] = required_records(row)
    steps = restaurant_steps(row)
    if steps:
        out["restaurantSteps"] = steps
    return out


def registered_here(row: dict) -> bool:
    """Is the registration in Booqy's Route 53 account (bought, or moved in)?"""
    return bool(row.get("registeredAt")) or row.get("transferStatus") == "transferred" or (
        row.get("mode") == "register" and row.get("status") in ("registered", "attaching", "live", "removing", "removed"))


def kept_registration(previous: dict) -> dict:
    """A domain Booqy bought or moved in stays in our Route 53 account after
    a removal: a new order for it (Connect) keeps that, so the transfer-out
    code still works and no paid transfer is offered."""
    if not previous or not (previous.get("registeredAt") or previous.get("transferStatus") == "transferred"):
        return {}   # a refused or failed registration never held the domain
    return {"registeredAt": previous.get("registeredAt") or previous.get("transferCompletedAt"),
            "expiresAt": previous.get("expiresAt"), "autoRenew": previous.get("autoRenew")}


def retry_block(row: dict) -> str | None:
    """Why Retry can't resume this order (None: it can). Retry only resumes:
    a Route 53 call that never happened, or records that were never
    imported, need the order placed again."""
    mode = row.get("mode")
    if mode == "register" and not row.get("operationId"):
        return "Route 53 never took the registration: place the order again"
    if mode == "transfer_in" and not row.get("transferInOperationId"):
        return "Route 53 never took the move: start the move again"
    if mode in ("connect", "transfer_in") and row.get("recordsImported") is False:
        return "The records weren't imported: connect the domain again with the records"
    if mode == "connect" and not row.get("hostedZoneId"):
        return "Connect the domain again (no zone yet)"
    return None


def _check_status(tenant_id: str, apex: str, row: dict) -> dict:
    """The current waiting step, run once now (Check now)."""
    status = row.get("status")
    mode = row.get("mode")
    if mode == "transfer_in" and status in TRANSFER_WAITING:
        return task_transfer_in_status(tenant_id, apex)
    if mode == "records" and status == "awaiting_records":
        return task_records_status(tenant_id, apex)
    if mode == "connect" and status in ("awaiting_nameservers", "blocked_dnssec"):
        return zones._task_nameserver_status(tenant_id, apex)
    if mode == "register" and status in ("registering", "awaiting_verification"):
        return zones._task_registration_status(tenant_id, apex)
    if status == "live" and row.get("devStatus") in ("mounting", "awaiting_dev_record"):
        return task_dev_step(tenant_id, apex)
    return {"status": "nothing_to_check"}


def check_now(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/zones/{domain}/check - runs the
    current check at once and records what it saw; the workflow picks the
    result up at its next check."""
    tenant_id = req.path["tenantId"]
    apex = zones._apex(req.path.get("domain"))
    row = _order(tenant_id, apex)
    result = _check_status(tenant_id, apex, row)
    return 200, {"result": result.get("status"), "zone": zones.public_zone(zones._zone_row(tenant_id, apex) or {})}


def retry(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/zones/{domain}/retry - starts the
    order's workflow again (finished steps are found done). A move to
    Booqy that was rejected or expired needs a new transfer code instead:
    send the move again (POST .../domains/transfers)."""
    tenant_id = req.path["tenantId"]
    apex = zones._apex(req.path.get("domain"))
    row = _order(tenant_id, apex)
    status, mode = row.get("status"), row.get("mode")
    if status in RESUBMIT:
        raise ApiError(409, "resubmit", "Start the move again with a new transfer code")
    dev_only = status == "live" and row.get("devStatus") == "failed"
    if status not in RETRY_FROM and not dev_only:
        raise ApiError(409, "not_retryable", f"Nothing to retry ({status})")
    if mode == "transfer":
        raise ApiError(409, "not_retryable", "Start the transfer again from the Domains tab")
    block = None if dev_only else retry_block(row)
    if block:
        raise ApiError(409, "not_retryable", block)
    attempt = int(row.get("attempt") or 1) + 1
    fields = {"attempt": attempt}
    if row.get("simulated"):
        fields["simState"] = None              # the retried order waits again (Simulate moves it on)
    if dev_only:
        fields.update(devStatus="waiting_for_prod", devError=None, devMountAttempts=0)
    else:
        # the reminders start again from now (24 h, 72 h, 6 days)
        fields.update(status=WAITING.get(mode, "attaching"), lastError=None, lastErrorSv=None, who=None,
                      errorCode=None, statusDetail="Retrying", remindersSent=None, retriedAt=now_iso())
    zones._update_zone(tenant_id, apex, **fields)
    try:
        start(tenant_id, apex, mode, req.actor, attempt, **({"devOnly": True} if dev_only else {}))
    except Exception as e:  # noqa: BLE001 - never left waiting with no workflow
        if dev_only:
            zones._update_zone(tenant_id, apex, devStatus="failed",
                               devError=f"The setup workflow didn't start: {e}"[:1000])
        else:
            start_failed(tenant_id, apex, e)
        raise ApiError(502, "workflow_not_started",
                       "Booqy's fault: the setup workflow didn't start. Booqy is notified; press Retry again") from e
    write_audit(tenant_id, "domain_retried", req.actor, {"domain": apex, "attempt": attempt, "devOnly": dev_only})
    return 202, {"zone": zones.public_zone(zones._zone_row(tenant_id, apex) or {})}


def notify(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/zones/{domain}/notify - e-mails the
    restaurant its steps again (records, name servers, approval)."""
    tenant_id = req.path["tenantId"]
    apex = zones._apex(req.path.get("domain"))
    row = _order(tenant_id, apex)
    profile = get_profile(tenant_id)
    status = row.get("status")
    if row.get("who") == "restaurant" and row.get("lastErrorSv"):
        sent = domain_mail.send(profile, "action_needed", domain=apex, text=row["lastErrorSv"])
    elif row.get("mode") == "records" and (status == "awaiting_records" or row.get("devStatus") == "awaiting_dev_record"):
        sent = domain_mail.send(profile, "records_steps", domain=apex, target=env("TENANT_DOMAIN_CNAME_TARGET", ""),
                                dev_target=row.get("devTarget"))
    elif status in ("awaiting_nameservers", "blocked_dnssec") and row.get("nameServers"):
        sent = domain_mail.send(profile, "nameserver_steps", domain=apex, name_servers=row["nameServers"],
                                dnssec=status == "blocked_dnssec")
    elif status == "awaiting_owner_approval":
        sent = domain_mail.send(profile, "transfer_approve", domain=apex)
    else:
        raise ApiError(409, "nothing_to_send", "The restaurant has nothing to do for this domain right now")
    if not sent:
        raise ApiError(502, "mail_failed", "The e-mail couldn't be sent (no contact address, or the send failed)")
    write_audit(tenant_id, "domain_steps_sent", req.actor, {"domain": apex, "to": domain_mail.recipient(profile)})
    return 200, {"sentTo": domain_mail.recipient(profile)}


def simulate(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/zones/{domain}/simulate {event}
    (dev console only): moves a simulated order as the registry, the owner
    or the restaurant would, then runs the check at once."""
    if env("ENVIRONMENT") == "prod" or not simulated():
        raise ApiError(409, "not_simulated", "Simulation is only in the dev console")
    tenant_id = req.path["tenantId"]
    apex = zones._apex(req.path.get("domain"))
    row = _order(tenant_id, apex)
    if not row.get("simulated"):
        raise ApiError(409, "not_simulated", "This order is real")
    event = (req.body or {}).get("event")
    if event not in SIM_EVENTS or row.get("mode") not in SIM_EVENTS[event]:
        raise ApiError(400, "validation_failed", "Not an event for this order",
                       fields={"event": ", ".join(k for k, modes in SIM_EVENTS.items() if row.get("mode") in modes)})
    zones._update_zone(tenant_id, apex, simState=event)
    result = _check_status(tenant_id, apex, {**row, "simState": event})
    write_audit(tenant_id, "domain_simulated", req.actor, {"domain": apex, "event": event})
    return 200, {"result": result.get("status"), "zone": zones.public_zone(zones._zone_row(tenant_id, apex) or {})}


def auth_code(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/zones/{domain}/auth-code {send}
    - the transfer-out code of a domain Booqy registered or moved in: the
    domain is the restaurant's. send true e-mails it to the restaurant;
    otherwise it is shown once. Never logged or stored; audited."""
    tenant_id = req.path["tenantId"]
    apex = zones._apex(req.path.get("domain"))
    row = _order(tenant_id, apex)
    if not registered_here(row):
        raise ApiError(409, "not_registered_here", "This domain is registered elsewhere: its registrar has the code")
    if row.get("simulated"):
        code = "SIM-" + hashlib.sha256(apex.encode()).hexdigest()[:10].upper()
    else:
        if env("ENVIRONMENT") != "prod":
            zones.prod_only()
        code = zones._domains().retrieve_domain_auth_code(DomainName=apex)["AuthCode"]
    send = bool((req.body or {}).get("send"))
    profile = get_profile(tenant_id, required=False) or {}
    if send:
        if not domain_mail.send(profile, "auth_code", domain=apex, code=code):
            raise ApiError(502, "mail_failed", "The e-mail couldn't be sent - show the code instead")
        write_audit(tenant_id, "domain_auth_code_sent", req.actor, {"domain": apex, "to": domain_mail.recipient(profile)})
        return 200, {"sentTo": domain_mail.recipient(profile)}
    write_audit(tenant_id, "domain_auth_code_shown", req.actor, {"domain": apex})
    return 200, {"authCode": code}


def remove(req) -> tuple[int, dict]:
    """DELETE /platform/tenants/{tenantId}/zones/{domain} - the restaurant
    stops using this domain for its site. In order: the 301s go (the slug
    address answers at once), the primary domain falls back to the slug
    address, dev.<domain> leaves the dev site, the site records leave our
    zone, the hosts are detached. A domain Booqy registered stays the
    restaurant's (and in our account, renewing) until it leaves Booqy; a
    zone the name servers point at is kept (their e-mail)."""
    tenant_id = req.path["tenantId"]
    apex = zones._apex(req.path.get("domain"))
    row = _order(tenant_id, apex)
    status = row.get("status")
    if status in TRANSFER_WAITING or status == "registering":
        raise ApiError(409, "in_progress", "The registry is still working on it: wait until it's done or has expired")
    if status == "removed":                    # removing: an earlier Remove stopped half way; every step runs again
        raise ApiError(409, "already_removed", "Already removed")
    zones._update_zone(tenant_id, apex, status="removing", statusDetail="Removing")
    notes = release(tenant_id, row, req.actor)
    detached = []
    if not row.get("simulated"):
        from . import domains
        mode = row.get("mode") or "connect"
        canonical, aliases, _ = hosts_for(mode, apex)
        for host in [canonical, *aliases]:
            host_row = _domain_row(tenant_id, host)
            if host_row and host_row.get("kind") == "custom" and host_row.get("status") != "removing":
                client("stepfunctions").start_execution(
                    stateMachineArn=env("DOMAIN_DETACH_STATE_MACHINE_ARN"),
                    name=domains._execution_name("detach", host),
                    input=json.dumps({"tenantId": tenant_id, "domain": host}))
                detached.append(host)
        if mode in ZONE_MODES and row.get("hostedZoneId") not in (None, "sim"):
            notes += _delete_site_records(row)
        if mode == "records":
            domain_mail.send(get_profile(tenant_id, required=False) or {}, "removed_records", domain=apex)
            zones._release_claim(tenant_id, apex)
    zones._update_zone(tenant_id, apex, status="removed", statusDetail=None, removedAt=now_iso(), removedBy=req.actor,
                       lastError="; ".join(notes)[:1000] or None, devStatus="removed" if row.get("devStatus") else None)
    write_audit(tenant_id, "domain_removed", req.actor, {"domain": apex, "detached": detached, "notes": notes[:5]})
    return 202, {"zone": zones.public_zone(zones._zone_row(tenant_id, apex) or {}), "detached": detached}


def release(tenant_id: str, row: dict, actor: str) -> list[str]:
    """The guest-facing part of a removal or an offboarding, both sides:
    redirects, primary domain, dev.<domain>. Best effort; returns notes."""
    apex = row["domain"]
    mode = row.get("mode") or "connect"
    canonical, aliases, dev_host = hosts_for(mode, apex)
    notes = []
    if row.get("simulated"):
        from . import domains
        hosts = domains.test_hosts(apex)
        if domains._domain_row(tenant_id, hosts["main"]):
            domains.unmap_test_domain(tenant_id, apex, actor)
        return notes
    try:
        unredirect([_slug_host(tenant_id), *aliases], canonical)
    except Exception as e:  # noqa: BLE001
        notes.append(f"301s not removed: {e}")
    profile = get_profile(tenant_id, required=False) or {}
    if profile.get("primaryDomain") in (canonical, *aliases):
        _set_primary(tenant_id, _slug_host(tenant_id))
    if row.get("devStatus") not in (None, "skipped", "removed"):
        from . import site
        try:
            site.invoke({"action": "devDomain", "op": "unmount", "tenantId": tenant_id, "host": dev_host})
        except ApiError as e:
            notes.append(f"dev.{apex} not removed from the dev site: {e.message}")
    return notes


def _delete_site_records(row: dict) -> list[str]:
    """apex/www/dev site records and the _cf-challenge TXTs leave our zone;
    everything the restaurant had (e-mail) stays."""
    apex, zone_id = row["domain"], row["hostedZoneId"]
    def ours(s: dict) -> bool:
        name, rtype = s["Name"].rstrip("."), s["Type"]
        return ((name == apex and rtype in ("A", "AAAA") and bool(s.get("AliasTarget")))
                or (name in (f"www.{apex}", f"dev.{apex}") and rtype == "CNAME")
                or (name.startswith("_cf-challenge.") and rtype == "TXT"))
    r53 = zones._route53()
    try:
        sets = r53.list_resource_record_sets(HostedZoneId=zone_id).get("ResourceRecordSets", [])
        changes = [{"Action": "DELETE", "ResourceRecordSet": s} for s in sets if ours(s)]
        if changes:
            r53.change_resource_record_sets(HostedZoneId=zone_id, ChangeBatch={
                "Comment": "Restaurant site removed (Booqy)", "Changes": changes})
    except ClientError as e:
        return [f"site records not removed from the zone: {e.response['Error'].get('Code')}"]
    return []


def release_for_offboarding(tenant_id: str, actor: str) -> list[str]:
    """Offboarding: every live own domain's 301s, dev side and primary go
    (the offboarding workflow then detaches the hosts)."""
    notes = []
    for row in query_all(TableName=tenant_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :z)",
                         ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":z": {"S": "ZONE#"}}):
        if row.get("status") in ("removed",) or row.get("mode") == "transfer":
            continue
        try:
            notes += release(tenant_id, row, actor)
        except Exception as e:  # noqa: BLE001 - offboarding goes on
            notes.append(f"{row.get('domain')}: {e}")
    return notes


# --------------------------------------------------------- workflow tasks
def _cancelled(row: dict) -> bool:
    return row.get("status") in ("removing", "removed")


def task_transfer_in_status(tenant_id: str, apex: str) -> dict:
    row = zones._zone_row(tenant_id, apex) or {}
    if _cancelled(row):
        return {"status": "cancelled"}
    if row.get("simulated") and row.get("simState") == "expire":
        _fail(tenant_id, apex, "transfer_expired", status="transfer_expired")
        _notify_action_needed(tenant_id, apex, "transfer_expired")
        return {"status": "failed"}
    if not row.get("transferInOperationId"):
        _fail(tenant_id, apex, "booqy", lastError="No transfer operation recorded")
        return {"status": "failed"}
    op = sim_operation(row) if row.get("simulated") else \
        zones._domains().get_operation_detail(OperationId=row["transferInOperationId"])
    status, flag, message = op.get("Status"), op.get("StatusFlag"), op.get("Message")
    if status == "SUCCESSFUL":
        zones._update_zone(tenant_id, apex, status="transferred_in", statusDetail="Moved to Booqy",
                           operationStatus=status, transferCompletedAt=now_iso(), registeredAt=now_iso())
        zones._delete_document(tenant_id, apex, row)
        return {"status": "done"}
    if status in ("ERROR", "FAILED"):
        code = classify_transfer(message)
        _fail(tenant_id, apex, code, status="transfer_rejected", operationStatus=status,
              operationMessage=(message or "")[:500])
        _notify_action_needed(tenant_id, apex, code)
        return {"status": "failed"}
    if flag == "PENDING_SUPPORT_CASE":
        state, detail = "awaiting_verification", "Waiting for the .se registry's identity check (AWS Support case)"
    elif flag in ("PENDING_ACCEPTANCE", "PENDING_CUSTOMER_ACTION", "PENDING_AUTHORIZATION", None):
        state, detail = "awaiting_owner_approval", ("Waiting for the domain owner to approve the e-mail"
                                                    if flag != "PENDING_AUTHORIZATION"
                                                    else "Waiting for the old registrar to release it")
    else:
        state, detail = "transferring", message or flag
    zones._update_zone(tenant_id, apex, status=state, statusDetail=detail, operationStatus=status,
                       lastCheckedAt=now_iso())
    if state == "awaiting_owner_approval":
        _remind(tenant_id, apex, row, "transfer_reminder")
    return {"status": "pending"}


def task_records_status(tenant_id: str, apex: str) -> dict:
    row = zones._zone_row(tenant_id, apex) or {}
    if _cancelled(row):
        return {"status": "cancelled"}
    target = env("TENANT_DOMAIN_CNAME_TARGET", "").rstrip(".").lower()
    if row.get("simulated"):
        state = row.get("simState")
        if state == "expire":
            _fail(tenant_id, apex, "records_timeout", status="records_timeout")
            return {"status": "failed"}
        seen = {"www": state == "records_added", "dev": state == "records_added", "forwarding": state == "records_added"}
    else:
        www = cname_of(f"www.{apex}")
        dev = cname_of(f"dev.{apex}") if row.get("devTarget") else None
        seen = {"www": bool(www) and www == target, "wwwValue": www,
                "dev": bool(dev) and dev == (row.get("devTarget") or "").rstrip(".").lower(),
                "forwarding": forwarding_ok(apex)}
        if not www:
            a, _, _ = zones._lookup(f"www.{apex}", "A")
            if a:
                seen["wwwConflict"] = "www has an A record: remove it first"
    detail = None if seen["www"] else (seen.get("wwwConflict") or
                                       (f"www points at {seen['wwwValue']}, not Booqy" if seen.get("wwwValue")
                                        else "No www record yet"))
    zones._update_zone(tenant_id, apex, recordsSeen=seen, statusDetail=detail, lastCheckedAt=now_iso())
    if seen["www"]:
        return {"status": "done"}
    _remind(tenant_id, apex, row, "records_reminder", target=target, dev_target=row.get("devTarget"))
    return {"status": "pending"}


def task_prepare_records(tenant_id: str, apex: str, actor: str) -> dict:
    row = zones._zone_row(tenant_id, apex) or {}
    if row.get("simulated"):
        sim_map(tenant_id, apex, actor)
        zones._update_zone(tenant_id, apex, status="attaching", statusDetail="Mapping onto the test sites")
        return {"status": "done", "attach": False}
    from .domains import claim_host
    claim_host(tenant_id, f"www.{apex}", actor)              # "exists" (already attached) is fine
    zones._update_zone(tenant_id, apex, status="attaching", statusDetail="Issuing the certificate")
    return {"status": "done", "attach": True}


def task_set_canonical(tenant_id: str, apex: str) -> dict:
    row = zones._zone_row(tenant_id, apex) or {}
    if _cancelled(row):
        return {"status": "cancelled"}
    mode = row.get("mode") or "connect"
    if row.get("simulated"):
        from . import domains
        hosts = domains.test_hosts(apex)
        _set_primary(tenant_id, hosts["main"])
        domains.slug_redirect(tenant_id, hosts["main"].split(".")[0])
        slug = (get_profile(tenant_id, required=False) or {}).get("slug")
        zones._update_zone(tenant_id, apex, canonicalHost=hosts["main"], aliasHosts=[], devHost=hosts["dev"],
                           redirects=[f"{slug}.{zone}" for zone in domains._test_zones() if slug and zone])
        return {"status": "done"}
    canonical, aliases, dev_host = hosts_for(mode, apex)
    problems = []
    for host in (canonical, *aliases):
        host_row = _domain_row(tenant_id, host)
        if host_row.get("status") != "active":
            problems.append(f"{host}: {host_row.get('status', 'missing')}"
                            + (f" ({host_row['lastError']})" if host_row.get("lastError") else ""))
    if problems:
        raise RuntimeError("Certificates not issued - " + "; ".join(problems))
    _set_primary(tenant_id, canonical)
    written = redirect([_slug_host(tenant_id), *aliases], canonical)
    zones._update_zone(tenant_id, apex, canonicalHost=canonical, aliasHosts=aliases, devHost=dev_host,
                       redirects=written, statusDetail=None)
    return {"status": "done"}


def task_dev_step(tenant_id: str, apex: str) -> dict:
    """dev.<domain> on the dev site, one step per call (the workflow loops):
    mount it, wait until it is live, then make it dev's primary + 301."""
    row = zones._zone_row(tenant_id, apex) or {}
    if _cancelled(row):
        return {"status": "cancelled"}
    if row.get("simulated"):
        zones._update_zone(tenant_id, apex, devStatus="live", devError=None)
        return {"status": "done"}
    from . import site
    if not site.enabled():
        zones._update_zone(tenant_id, apex, devStatus="skipped")
        return {"status": "skipped"}
    dev_host = f"dev.{apex}"
    try:
        dev = site.invoke({"action": "devDomain", "op": "status", "tenantId": tenant_id, "host": dev_host})
    except ApiError as e:
        if "no dev link" in e.message:
            zones._update_zone(tenant_id, apex, devStatus="skipped")
            return {"status": "skipped"}
        raise
    state = dev.get("state")
    if state == "live":
        site.invoke({"action": "devDomain", "op": "setCanonical", "tenantId": tenant_id, "host": dev_host})
        zones._update_zone(tenant_id, apex, devStatus="live", devError=None, devHost=dev_host)
        return {"status": "done"}
    if state in ("not_mounted", "failed"):
        attempts = int(row.get("devMountAttempts") or 0)
        if state == "failed" and attempts >= 2:
            zones._update_zone(tenant_id, apex, devStatus="failed", devError=dev.get("lastError") or "dev attach failed")
            return {"status": "failed"}
        target = (dev.get("cnameTarget") or row.get("devTarget") or "").rstrip(".").lower()
        if row.get("mode") == "records" and cname_of(dev_host) != target:
            zones._update_zone(tenant_id, apex, devStatus="awaiting_dev_record", devTarget=target or None)
            return {"status": "pending"}
        mounted = site.invoke({"action": "devDomain", "op": "mount", "tenantId": tenant_id, "host": dev_host})
        target = (mounted.get("cnameTarget") or target).rstrip(".")
        if row.get("mode") in ZONE_MODES and row.get("hostedZoneId") and target:
            zones._route53().change_resource_record_sets(HostedZoneId=row["hostedZoneId"], ChangeBatch={
                "Comment": "Restaurant dev site (Booqy)", "Changes": [zones._change(
                    {"name": dev_host, "type": "CNAME", "ttl": 300, "values": [target]})]})
        zones._update_zone(tenant_id, apex, devStatus="mounting", devMountAttempts=attempts + 1, devTarget=target or None)
        return {"status": "pending"}
    zones._update_zone(tenant_id, apex, devStatus="mounting")
    return {"status": "pending"}


def task_mark_dev(tenant_id: str, apex: str, error: str | None) -> dict:
    zones._update_zone(tenant_id, apex, devStatus="failed", devError=(error or "dev site failed")[:1000])
    return {"status": "failed"}


def task_update_site(tenant_id: str, apex: str) -> dict:
    row = zones._zone_row(tenant_id, apex) or {}
    from . import site
    if row.get("simulated") or not site.enabled():
        return {"status": "skipped"}
    site.invoke({"action": "domainLive", "tenantId": tenant_id}, wait=False)
    return {"status": "done"}


def notify_live(tenant_id: str, apex: str, row: dict) -> None:
    if row.get("liveNotifiedAt"):
        return
    profile = get_profile(tenant_id, required=False) or {}
    canonical = row.get("canonicalHost") or apex
    dev = row.get("devHost") if row.get("simulated") else None
    if domain_mail.send(profile, "live", domain=apex, canonical=canonical, dev=dev):
        zones._update_zone(tenant_id, apex, liveNotifiedAt=now_iso())


WORKFLOW_TASKS = {
    "transfer_in_status": lambda e, t, d: task_transfer_in_status(t, d),
    "records_status": lambda e, t, d: task_records_status(t, d),
    "prepare_records": lambda e, t, d: task_prepare_records(t, d, e.get("requestedBy") or "workflow"),
    "set_canonical": lambda e, t, d: task_set_canonical(t, d),
    "dev_step": lambda e, t, d: task_dev_step(t, d),
    "mark_dev": lambda e, t, d: task_mark_dev(t, d, e.get("error")),
    "update_site": lambda e, t, d: task_update_site(t, d),
}


WAITING_TASKS = ("registration_status", "transfer_in_status", "nameserver_status", "records_status")


def superseded(event: dict) -> bool:
    """An execution of an older attempt of this order (a Retry, or a move
    started again with a new code, started a newer one): its waiting step
    ends it (Cancelled) instead of carrying on beside the new one."""
    try:
        mine = int(event.get("attempt") or 0)
    except (TypeError, ValueError):
        return False
    if not mine:
        return False
    row = zones._zone_row(event["tenantId"], zones._apex(event["domain"])) or {}
    return int(row.get("attempt") or 0) > mine


def workflow_task(event: dict) -> dict:
    """Entry point for domain-provision (invoked directly, never through
    API Gateway): the own-domain tasks here, the older ones in zones."""
    task = event.get("workflowTask")
    if task in WAITING_TASKS and superseded(event):
        log.info(json.dumps({"workflowTask": task, "domain": event.get("domain"), "superseded": event.get("attempt")}))
        return {"status": "cancelled"}
    if task in WORKFLOW_TASKS:
        return WORKFLOW_TASKS[task](event, event["tenantId"], zones._apex(event["domain"]))
    return zones.workflow_task(event)


# ------------------------------------------------------------ health (daily)
def health_task(event: dict) -> dict:
    """{"domainTask": "health"} (EventBridge Scheduler, daily, prod): the
    registered domains' expiry and auto-renew onto their orders, and the
    Booqy/Domains metrics the alarms watch."""
    if env("ENVIRONMENT") != "prod":
        return {"status": "skipped"}
    domains_api = zones._domains()
    now = datetime.now(timezone.utc)
    counts = {"ExpiringUnder30Days": 0, "FailedOperations": 0, "AutoRenewOff": 0, "ReachabilityPending": 0}
    names, marker = [], None
    while True:
        page = domains_api.list_domains(**({"Marker": marker} if marker else {}))
        names += [d["DomainName"] for d in page.get("Domains", [])]
        marker = page.get("NextPageMarker")
        if not marker:
            break
    for name in names:
        detail = domains_api.get_domain_detail(DomainName=name)
        expiry = detail.get("ExpirationDate")
        auto = bool(detail.get("AutoRenew"))
        claim = from_ddb(client("dynamodb").get_item(
            TableName=tenant_table(), Key={"PK": {"S": f"DOMAIN#{name}"}, "SK": {"S": "TENANT"}}).get("Item")) or {}
        tenant_id = claim.get("tenantId")
        purged = tenant_id and (get_profile(tenant_id, required=False) or {}).get("status") in ("offboarded", "purged")
        if expiry and expiry - now < timedelta(days=30) and auto and not purged:
            counts["ExpiringUnder30Days"] += 1
        if not auto and tenant_id and not purged:
            counts["AutoRenewOff"] += 1
        if zones._tld(name) not in ("se", "nu", "eu", "fi"):
            try:
                reach = domains_api.get_contact_reachability_status(domainName=name).get("status")
                if reach == "PENDING":
                    counts["ReachabilityPending"] += 1
            except ClientError as e:
                log.info("reachability %s: %s", name, e)
        if tenant_id and zones._zone_row(tenant_id, name):
            zones._update_zone(tenant_id, name, expiresAt=expiry.isoformat() if expiry else None, autoRenew=auto)
    since = now - timedelta(days=2)
    marker = None
    while True:
        page = domains_api.list_operations(SubmittedSince=since, Status=["ERROR", "FAILED"],
                                           **({"Marker": marker} if marker else {}))
        counts["FailedOperations"] += len(page.get("Operations", []))
        marker = page.get("NextPageMarker")
        if not marker:
            break
    client("cloudwatch").put_metric_data(Namespace="Booqy/Domains", MetricData=[
        {"MetricName": k, "Value": float(n), "Unit": "Count"} for k, n in counts.items()])
    log.info(json.dumps({"domainTask": "health", "domains": len(names), **counts}))
    return {"status": "done", "domains": len(names), **counts}

