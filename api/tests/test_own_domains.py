"""Own domains (owner 2026-11-15): move to Booqy (transfer in), keep the
registrar with DNS records, the common pipeline (canonical host, 301s, dev
side, booqy.json), Retry, removal, offboarding, the transfer-out code, the
daily health check and the dev console's simulation."""

import io
import json
import os
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from botocore.exceptions import ClientError

from conftest import REGION, call
from test_zones import CONTACT, PRICE, FakeDomains, _executions, _zone

KVS_ARN = "arn:aws:cloudfront::123456789012:key-value-store/kvs-1"


class FakeKVS:
    def __init__(self):
        self.keys = {}
        self.etag = 0

    def describe_key_value_store(self, KvsARN):
        assert KvsARN == KVS_ARN
        return {"ETag": str(self.etag)}

    def get_key(self, KvsARN, Key):
        if Key not in self.keys:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "no"}}, "GetKey")
        return {"Key": Key, "Value": self.keys[Key]}

    def put_key(self, KvsARN, Key, Value, IfMatch):
        assert IfMatch == str(self.etag)
        self.keys[Key] = Value
        self.etag += 1

    def delete_key(self, KvsARN, Key, IfMatch):
        if Key not in self.keys:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "no"}}, "DeleteKey")
        del self.keys[Key]
        self.etag += 1


class FakeSiteRepo:
    """site-repo (and through it the dev side): answers per op."""

    def __init__(self):
        self.calls = []
        self.dev = {"state": "not_mounted", "cnameTarget": "ddev.cloudfront.net"}

    def invoke(self, **kwargs):
        payload = json.loads(kwargs["Payload"])
        self.calls.append(payload)
        answer = {}
        if payload.get("action") == "devDomain":
            if payload["op"] == "mount":
                self.dev = {**self.dev, "state": "attaching"}
            answer = dict(self.dev)
        return {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(answer).encode())}


class Mails(list):
    def __call__(self, profile, kind, **context):
        self.append((kind, context))
        return True

    def kinds(self):
        return [k for k, _ in self]


@pytest.fixture
def od(aws, monkeypatch):
    """Prod, restaurant domains on, fake Route 53 Domains, KVS, site-repo and mail."""
    from app import core, domain_mail, own_domains, zones
    monkeypatch.setenv("ENVIRONMENT", "prod")
    zones._PRICES.clear()
    fake = FakeDomains()
    fake.resent = []
    fake.resend_operation_authorization = lambda OperationId: fake.resent.append(OperationId)
    fake.retrieve_domain_auth_code = lambda DomainName: {"AuthCode": "s3cret-Code"}
    monkeypatch.setattr(zones, "_domains", lambda: fake)
    kvs = FakeKVS()
    monkeypatch.setattr(own_domains, "_kvs", lambda: kvs)
    monkeypatch.setattr(own_domains, "ds_present", lambda domain: False)
    monkeypatch.setattr(own_domains, "forwarding_ok", lambda apex: None)
    dns = {}
    monkeypatch.setattr(own_domains, "cname_of", lambda host: dns.get(host))
    monkeypatch.setattr(zones, "_lookup", lambda name, rtype: (dns.get((name, rtype), []), 300, False))
    mails = Mails()
    monkeypatch.setattr(domain_mail, "send", mails)
    site_repo = FakeSiteRepo()
    core._clients["lambda"] = site_repo
    s3 = boto3.client("s3", region_name=REGION)
    s3.create_bucket(Bucket="dev-domain-documents", CreateBucketConfiguration={"LocationConstraint": REGION})
    monkeypatch.setattr(zones, "_s3", lambda: s3)
    monkeypatch.setenv("PLATFORM_DOMAIN", "booqy.se")
    monkeypatch.setenv("TENANT_DOMAIN_CNAME_TARGET", "d111.cloudfront.net")
    monkeypatch.setenv("DOMAIN_DOCUMENTS_BUCKET", "dev-domain-documents")
    monkeypatch.setenv("SITE_REDIRECT_KVS_ARN", KVS_ARN)
    monkeypatch.setenv("SITE_REPO_FUNCTION_ARN", "arn:aws:lambda:eu-north-1:123456789012:function:site-repo:live")
    monkeypatch.setenv("SITE_REPOS_ENABLED", "true")

    class Env:
        pass
    e = Env()
    e.domains, e.kvs, e.dns, e.mails, e.site, e.aws = fake, kvs, dns, mails, site_repo, aws
    yield e
    os.environ["PLATFORM_DOMAIN"] = ""


def _put(aws, tenant_id, sk, **fields):
    from app.core import tenant_table, to_ddb
    aws["ddb"].put_item(TableName=tenant_table(), Item=to_ddb({"PK": f"TENANT#{tenant_id}", "SK": sk, **fields}))


def _update(aws, tenant, sk, **fields):
    from app.core import to_ddb
    names = {f"#k{i}": k for i, k in enumerate(fields)}
    values = {f":v{i}": to_ddb({"x": val})["x"] for i, val in enumerate(fields.values())}
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": sk}},
                           UpdateExpression="SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(fields))),
                           ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def _profile(aws, tenant):
    from app.core import from_ddb
    return from_ddb(aws["ddb"].get_item(TableName="dev-tenant",
                                        Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}})["Item"])


def _task(name, tenant, domain, **extra):
    from app.handler import handler
    return handler({"workflowTask": name, "tenantId": tenant, "domain": domain, **extra}, None)


def _slug(aws, tenant, host="pizzeria-roma.booqy.se"):
    _put(aws, tenant, f"DOMAIN#{host}", domain=host, kind="platform", status="active")


def _activate_hosts(aws, tenant, *hosts):
    for host in hosts:
        _put(aws, tenant, f"DOMAIN#{host}", domain=host, kind="custom", status="active")


TRANSFER = {"domain": "roma.com", "authCode": "Ab12-xy", "contact": CONTACT, "acceptedPrice": PRICE,
            "records": [{"name": "@", "type": "MX", "ttl": 3600, "values": ["10 mx1.pub.mailpod.one.com."]},
                        {"name": "roma.com", "type": "A", "ttl": 3600, "values": ["1.2.3.4"]}]}


# ------------------------------------------------------------ transfer in
def test_transfer_check(od):
    status, body = call("GET /platform/domains/transfer-check", query={"domain": "roma.com"})
    assert status == 200 and body["supported"] and body["transferable"] and body["price"] == PRICE
    od.domains.transferable = "UNTRANSFERABLE"
    body = call("GET /platform/domains/transfer-check", query={"domain": "roma.com"})[1]
    assert not body["transferable"] and body["errorCode"] == "locked" and body["who"] == "restaurant"
    assert "lås upp" in body["lastErrorSv"]


def test_unsupported_tld_points_to_keeping_the_registrar(od, tenant, monkeypatch):
    from app import zones
    monkeypatch.setattr(zones, "_price", lambda tld: None if tld == "nu" else {"transfer": PRICE})
    body = call("GET /platform/domains/transfer-check", query={"domain": "roma.nu"})[1]
    assert body["supported"] is False and body["errorCode"] == "unsupported_tld"
    status, body = call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": tenant},
                        {**TRANSFER, "domain": "roma.nu"})
    assert status == 409 and body["error"] == "unsupported_tld"


def test_dnssec_blocks_a_transfer(od, tenant, monkeypatch):
    from app import own_domains
    monkeypatch.setattr(own_domains, "ds_present", lambda domain: True)
    status, body = call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": tenant}, TRANSFER)
    assert status == 409 and body["error"] == "blocked_dnssec" and "DNSSEC" in body["lastErrorSv"]
    assert od.domains.transfers == []


def test_transfer_in_copies_dns_first_then_waits_for_the_owner(od, aws, tenant):
    p = {"tenantId": tenant}
    status, body = call("POST /platform/tenants/{tenantId}/domains/transfers", p, TRANSFER)
    assert status == 202, body
    z = _zone(aws, tenant, "roma.com")
    assert z["mode"] == "transfer_in" and z["status"] == "awaiting_owner_approval" and z["attempt"] == 1
    assert z["canonicalHost"] == "roma.com" and z["aliasHosts"] == ["www.roma.com"] and z["devHost"] == "dev.roma.com"
    # the zone with the copied records (and CAA for Amazon) exists before the transfer
    r53 = boto3.client("route53", region_name=REGION)
    sets = {(r["Name"], r["Type"]): r for r in r53.list_resource_record_sets(HostedZoneId=z["hostedZoneId"])["ResourceRecordSets"]}
    assert ("roma.com.", "MX") in sets and ("roma.com.", "A") not in sets      # no site in public DNS
    assert '0 issue "amazon.com"' in [r["Value"] for r in sets[("roma.com.", "CAA")]["ResourceRecords"]]
    tr = od.domains.transfers[0]
    assert tr["AuthCode"] == "Ab12-xy" and tr["Nameservers"] == [{"Name": n} for n in z["nameServers"]]
    assert tr["AutoRenew"] is True
    assert od.mails.kinds() == ["transfer_approve"]
    names = [e["name"] for e in aws["sfn"].list_executions(stateMachineArn=os.environ["DOMAIN_PROVISION_STATE_MACHINE_ARN"])["executions"]]
    assert len(names) == 1 and names[0].startswith("transfer_in-") and names[0].endswith("-1")
    assert _executions(aws)[0]["mode"] == "transfer_in" and _executions(aws)[0]["makePrimary"] is True
    assert body["zone"]["restaurantSteps"].startswith("Nu flyttar vi roma.com")

    # waiting for the owner: reminders at 24 h, 72 h, 6 days, each once, with the approval e-mail again
    od.domains.op = {"Status": "IN_PROGRESS", "StatusFlag": "PENDING_ACCEPTANCE"}
    assert _task("transfer_in_status", tenant, "roma.com") == {"status": "pending"}
    assert od.mails.kinds() == ["transfer_approve"] and od.domains.resent == []
    old = (datetime.now(timezone.utc) - timedelta(hours=80)).isoformat()
    _update(aws, tenant, "ZONE#roma.com", requestedAt=old)
    assert _task("transfer_in_status", tenant, "roma.com") == {"status": "pending"}
    assert od.mails.kinds() == ["transfer_approve", "transfer_reminder"] and od.domains.resent == ["op-transfer"]
    assert sorted(_zone(aws, tenant, "roma.com")["remindersSent"]) == ["24", "72"]
    _task("transfer_in_status", tenant, "roma.com")
    assert od.mails.kinds().count("transfer_reminder") == 1                 # not again

    # approved: the registration is ours, then the name server check
    od.domains.op = {"Status": "SUCCESSFUL"}
    assert _task("transfer_in_status", tenant, "roma.com") == {"status": "done"}
    z = _zone(aws, tenant, "roma.com")
    assert z["status"] == "transferred_in" and z["registeredAt"]
    _, detail = call("GET /platform/tenants/{tenantId}", p)
    assert detail["zones"][0]["registrar"] == "route53" and detail["zones"][0]["registered"]


@pytest.mark.parametrize("message, code", [
    ("The authorization code is invalid", "bad_auth_code"),
    ("Domain has clientTransferProhibited status", "locked"),
    ("The registrant rejected the transfer", "rejected"),
    ("Domain was registered within the last 60 days", "too_recent"),
    ("Internal error", "booqy"),
])
def test_a_failed_transfer_says_who_acts(od, aws, tenant, message, code):
    from app import own_domains
    assert own_domains.classify_transfer(message) == code
    call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": tenant}, TRANSFER)
    od.domains.op = {"Status": "FAILED", "Message": message}
    assert _task("transfer_in_status", tenant, "roma.com") == {"status": "failed"}
    # MarkFailed keeps the classified status
    assert _task("mark", tenant, "roma.com", status="failed", error="TransferInFailed: x") == {"status": "transfer_rejected"}
    z = _zone(aws, tenant, "roma.com")
    assert z["status"] == "transfer_rejected" and z["errorCode"] == code
    assert z["who"] == ("booqy" if code == "booqy" else "restaurant")
    assert ("action_needed" in od.mails.kinds()) == (code != "booqy")
    _, detail = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})
    assert detail["zones"][0]["canResubmit"] and not detail["zones"][0]["canRetry"]
    # Retry needs a new code: the move is sent again, and that works
    assert call("POST /platform/tenants/{tenantId}/zones/{domain}/retry",
                {"tenantId": tenant, "domain": "roma.com"})[1]["error"] == "resubmit"
    status, body = call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": tenant},
                        {**TRANSFER, "authCode": "New-1"})
    assert status == 202 and _zone(aws, tenant, "roma.com")["attempt"] == 2


def test_transfer_refused_at_once_is_classified(od, aws, tenant):
    def refuse(**kw):
        raise ClientError({"Error": {"Code": "InvalidInput", "Message": "Invalid authorization code"}}, "TransferDomain")
    od.domains.transfer_domain = refuse
    status, body = call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": tenant}, TRANSFER)
    assert status == 409 and body["errorCode"] == "bad_auth_code" and "Flyttkoden" in body["lastErrorSv"]
    assert _zone(aws, tenant, "roma.com")["status"] == "transfer_rejected"


def test_an_unapproved_transfer_expires(od, aws, tenant):
    call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": tenant}, TRANSFER)
    assert _task("mark", tenant, "roma.com", mode="transfer_in", status="timed_out", error="not approved") == {
        "status": "transfer_expired"}
    z = _zone(aws, tenant, "roma.com")
    assert z["status"] == "transfer_expired" and z["who"] == "restaurant" and "14 dagar" in z["lastErrorSv"]
    assert "action_needed" in od.mails.kinds()


def test_removal_waits_while_the_registry_works(od, aws, tenant):
    call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": tenant}, TRANSFER)
    status, body = call("DELETE /platform/tenants/{tenantId}/zones/{domain}", {"tenantId": tenant, "domain": "roma.com"})
    assert status == 409 and body["error"] == "in_progress"


# ------------------------------------------------------------ DNS records
def test_records_mode_from_steps_to_live(od, aws, tenant):
    p = {"tenantId": tenant}
    _slug(aws, tenant)
    od.site.dev = {"state": "slug_only", "cnameTarget": "ddev.cloudfront.net"}
    status, body = call("POST /platform/tenants/{tenantId}/domains/records", p, {"domain": "www.roma.se"})
    assert status == 202, body
    zone = body["zone"]
    assert zone["mode"] == "records" and zone["status"] == "awaiting_records" and zone["canonicalHost"] == "www.roma.se"
    assert [r["name"] for r in zone["records"]] == ["www", "dev", "roma.se"]
    assert zone["records"][0]["value"] == "d111.cloudfront.net" and zone["records"][1]["value"] == "ddev.cloudfront.net"
    assert "Typ CNAME, Namn www, Värde d111.cloudfront.net" in zone["restaurantSteps"]
    assert od.mails[0][0] == "records_steps" and od.mails[0][1]["dev_target"] == "ddev.cloudfront.net"

    assert _task("records_status", tenant, "roma.se") == {"status": "pending"}
    assert _zone(aws, tenant, "roma.se")["statusDetail"] == "No www record yet"
    od.dns["www.roma.se"] = "parking.one.com"
    _task("records_status", tenant, "roma.se")
    assert "not Booqy" in _zone(aws, tenant, "roma.se")["statusDetail"]
    # Check now gives the same answer at once
    status, body = call("POST /platform/tenants/{tenantId}/zones/{domain}/check", {**p, "domain": "roma.se"})
    assert status == 200 and body["result"] == "pending"
    od.dns["www.roma.se"] = "d111.cloudfront.net"
    assert _task("records_status", tenant, "roma.se") == {"status": "done"}

    assert _task("prepare_records", tenant, "roma.se", requestedBy="op-1") == {"status": "done", "attach": True}
    _, detail = call("GET /platform/tenants/{tenantId}", p)
    assert {d["domain"] for d in detail["domains"] if d["kind"] == "custom"} == {"www.roma.se"}
    with pytest.raises(RuntimeError, match="www.roma.se: pending_dns"):
        _task("set_canonical", tenant, "roma.se")
    _activate_hosts(aws, tenant, "www.roma.se")
    assert _task("set_canonical", tenant, "roma.se") == {"status": "done"}
    assert _profile(aws, tenant)["primaryDomain"] == "www.roma.se"
    assert od.kvs.keys == {"pizzeria-roma.booqy.se": "www.roma.se"}
    assert _task("mark", tenant, "roma.se", status="live") == {"status": "live"}
    z = _zone(aws, tenant, "roma.se")
    assert z["status"] == "live" and z["devStatus"] == "waiting_for_prod" and z["liveNotifiedAt"]
    assert od.mails[-1] == ("live", {"domain": "roma.se", "canonical": "www.roma.se", "dev": None})

    # dev: the restaurant's dev CNAME first, then mount, then dev's primary + 301
    od.site.dev = {"state": "not_mounted", "cnameTarget": "ddev.cloudfront.net"}
    assert _task("dev_step", tenant, "roma.se") == {"status": "pending"}
    assert _zone(aws, tenant, "roma.se")["devStatus"] == "awaiting_dev_record"
    od.dns["dev.roma.se"] = "ddev.cloudfront.net"
    assert _task("dev_step", tenant, "roma.se") == {"status": "pending"}
    assert {"action": "devDomain", "op": "mount", "tenantId": tenant, "host": "dev.roma.se"} in od.site.calls
    od.site.dev = {"state": "live"}
    assert _task("dev_step", tenant, "roma.se") == {"status": "done"}
    assert od.site.calls[-1] == {"action": "devDomain", "op": "setCanonical", "tenantId": tenant, "host": "dev.roma.se"}
    assert _zone(aws, tenant, "roma.se")["devStatus"] == "live"
    assert _task("update_site", tenant, "roma.se") == {"status": "done"}
    assert od.site.calls[-1] == {"action": "domainLive", "tenantId": tenant}


def test_records_reminders_and_timeout(od, aws, tenant):
    call("POST /platform/tenants/{tenantId}/domains/records", {"tenantId": tenant}, {"domain": "roma.se"})
    _update(aws, tenant, "ZONE#roma.se", requestedAt=(datetime.now(timezone.utc) - timedelta(hours=25)).isoformat())
    _task("records_status", tenant, "roma.se")
    assert od.mails.kinds()[-1] == "records_reminder"
    assert _task("mark", tenant, "roma.se", mode="records", status="timed_out", error="x") == {"status": "records_timeout"}
    z = _zone(aws, tenant, "roma.se")
    assert z["status"] == "records_timeout" and z["who"] == "restaurant"
    # Retry starts attempt 2 (a double click is harmless)
    p = {"tenantId": tenant, "domain": "roma.se"}
    status, body = call("POST /platform/tenants/{tenantId}/zones/{domain}/retry", p)
    assert status == 202 and body["zone"]["status"] == "awaiting_records" and body["zone"]["attempt"] == 2
    names = [e["name"] for e in od.aws["sfn"].list_executions(
        stateMachineArn=os.environ["DOMAIN_PROVISION_STATE_MACHINE_ARN"])["executions"]]
    assert sorted(n.rsplit("-", 1)[1] for n in names) == ["1", "2"]
    from app import own_domains
    own_domains.start(tenant, "roma.se", "records", "op-1", 2)              # ExecutionAlreadyExists is fine
    assert call("POST /platform/tenants/{tenantId}/zones/{domain}/retry", p)[1]["error"] == "not_retryable"


def test_transfer_in_keeps_the_old_site_answering_until_prepare_dns(od, aws, tenant):
    # public DNS today: apex A + AAAA at one.com, www an A record
    od.dns.update({("roma.com", "A"): ["46.30.215.1"], ("roma.com", "AAAA"): ["2a02:2350::1"],
                   ("www.roma.com", "A"): ["46.30.215.1"]})
    assert call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": tenant}, TRANSFER)[0] == 202
    z = _zone(aws, tenant, "roma.com")
    r53 = boto3.client("route53", region_name=REGION)

    def sets():
        return {(r["Name"], r["Type"]): r for r in
                r53.list_resource_record_sets(HostedZoneId=z["hostedZoneId"])["ResourceRecordSets"]}
    before = sets()
    assert before[("roma.com.", "A")]["ResourceRecords"] == [{"Value": "46.30.215.1"}]
    assert before[("roma.com.", "A")]["TTL"] == 300
    assert before[("roma.com.", "AAAA")]["ResourceRecords"] == [{"Value": "2a02:2350::1"}]
    assert before[("www.roma.com.", "A")]["ResourceRecords"] == [{"Value": "46.30.215.1"}]
    assert ("roma.com.", "MX") in before
    # approved and the name servers answer: the site's records replace them in one batch
    _task("prepare_dns", tenant, "roma.com", requestedBy="op-1")
    after = sets()
    assert after[("roma.com.", "A")]["AliasTarget"]["DNSName"].rstrip(".") == "d111.cloudfront.net"
    assert after[("roma.com.", "AAAA")]["AliasTarget"]["DNSName"].rstrip(".") == "d111.cloudfront.net"
    assert ("www.roma.com.", "A") not in after
    assert after[("www.roma.com.", "CNAME")]["ResourceRecords"] == [{"Value": "d111.cloudfront.net"}]
    assert ("roma.com.", "MX") in after
    # a second run (Retry) finds nothing in the way
    _task("prepare_dns", tenant, "roma.com", requestedBy="op-1")
    assert sets()[("roma.com.", "A")]["AliasTarget"]


def test_steps_can_be_sent_again(od, aws, tenant):
    p = {"tenantId": tenant, "domain": "roma.se"}
    call("POST /platform/tenants/{tenantId}/domains/records", {"tenantId": tenant}, {"domain": "roma.se"})
    status, body = call("POST /platform/tenants/{tenantId}/zones/{domain}/notify", p)
    assert status == 200 and body["sentTo"] == "info@roma.se" and od.mails.kinds() == ["records_steps", "records_steps"]


# ------------------------------------------------------ common pipeline
def _connected_live(od, aws, tenant):
    _slug(aws, tenant)
    call("POST /platform/tenants/{tenantId}/domains/connections", {"tenantId": tenant}, {"domain": "roma.se", "records": []})
    _task("prepare_dns", tenant, "roma.se", requestedBy="op-1")
    _activate_hosts(aws, tenant, "roma.se", "www.roma.se")
    assert _task("set_canonical", tenant, "roma.se") == {"status": "done"}
    assert _task("mark", tenant, "roma.se", status="live") == {"status": "live"}
    return _zone(aws, tenant, "roma.se")


def test_zone_modes_make_the_apex_canonical_and_redirect_slug_and_www(od, aws, tenant):
    z = _connected_live(od, aws, tenant)
    assert od.mails.kinds()[0] == "nameserver_steps"
    assert od.kvs.keys == {"pizzeria-roma.booqy.se": "roma.se", "www.roma.se": "roma.se"}
    assert _profile(aws, tenant)["primaryDomain"] == "roma.se"
    assert z["canonicalHost"] == "roma.se" and z["redirects"] == ["pizzeria-roma.booqy.se", "www.roma.se"]
    # dev: mount, its CNAME in our zone, then live
    assert _task("dev_step", tenant, "roma.se") == {"status": "pending"}
    r53 = boto3.client("route53", region_name=REGION)
    sets = {(r["Name"], r["Type"]): r for r in r53.list_resource_record_sets(HostedZoneId=z["hostedZoneId"])["ResourceRecordSets"]}
    assert sets[("dev.roma.se.", "CNAME")]["ResourceRecords"] == [{"Value": "ddev.cloudfront.net"}]
    assert _task("dev_step", tenant, "roma.se") == {"status": "pending"}         # attaching
    od.site.dev = {"state": "live"}
    assert _task("dev_step", tenant, "roma.se") == {"status": "done"}


def test_a_failing_dev_side_leaves_prod_live_and_retries_only_dev(od, aws, tenant):
    _connected_live(od, aws, tenant)
    od.site.dev = {"state": "failed", "lastError": "validation_timeout", "cnameTarget": "ddev.cloudfront.net"}
    _update(aws, tenant, "ZONE#roma.se", devMountAttempts=2)
    assert _task("dev_step", tenant, "roma.se") == {"status": "failed"}
    assert _task("mark_dev", tenant, "roma.se", error="DevFailed: x") == {"status": "failed"}
    z = _zone(aws, tenant, "roma.se")
    assert z["status"] == "live" and z["devStatus"] == "failed"
    assert od.kvs.keys["pizzeria-roma.booqy.se"] == "roma.se"
    status, body = call("POST /platform/tenants/{tenantId}/zones/{domain}/retry", {"tenantId": tenant, "domain": "roma.se"})
    assert status == 202 and body["zone"]["status"] == "live" and body["zone"]["devStatus"] == "waiting_for_prod"
    assert _executions(aws)[0].get("devOnly") is True or any(e.get("devOnly") for e in _executions(aws))


def test_no_dev_link_skips_the_dev_side(od, aws, tenant, monkeypatch):
    _connected_live(od, aws, tenant)
    monkeypatch.setenv("SITE_REPOS_ENABLED", "false")
    assert _task("dev_step", tenant, "roma.se") == {"status": "skipped"}
    assert _task("update_site", tenant, "roma.se") == {"status": "skipped"}


def test_cancelled_while_waiting(od, aws, tenant):
    call("POST /platform/tenants/{tenantId}/domains/records", {"tenantId": tenant}, {"domain": "roma.se"})
    _update(aws, tenant, "ZONE#roma.se", status="removed")
    assert _task("records_status", tenant, "roma.se") == {"status": "cancelled"}
    assert _task("dev_step", tenant, "roma.se") == {"status": "cancelled"}


def test_remove_cleans_prod_and_dev(od, aws, tenant):
    z = _connected_live(od, aws, tenant)
    od.site.dev = {"state": "live"}
    _task("dev_step", tenant, "roma.se")
    p = {"tenantId": tenant, "domain": "roma.se"}
    status, body = call("DELETE /platform/tenants/{tenantId}/zones/{domain}", p)
    assert status == 202 and sorted(body["detached"]) == ["roma.se", "www.roma.se"]
    assert od.kvs.keys == {}
    assert _profile(aws, tenant)["primaryDomain"] == "pizzeria-roma.booqy.se"
    assert {"action": "devDomain", "op": "unmount", "tenantId": tenant, "host": "dev.roma.se"} in od.site.calls
    r53 = boto3.client("route53", region_name=REGION)
    names = {(r["Name"], r["Type"]) for r in r53.list_resource_record_sets(HostedZoneId=z["hostedZoneId"])["ResourceRecordSets"]}
    assert ("roma.se.", "A") not in names and ("www.roma.se.", "CNAME") not in names and ("dev.roma.se.", "CNAME") not in names
    assert ("roma.se.", "NS") in names                                          # the zone stays (their e-mail)
    assert _zone(aws, tenant, "roma.se")["status"] == "removed"
    detach = [e["name"] for e in aws["sfn"].list_executions(stateMachineArn=os.environ["DOMAIN_DETACH_STATE_MACHINE_ARN"])["executions"]]
    assert len(detach) == 2
    # the hosts can't be removed one by one while the order is live
    call("POST /platform/tenants/{tenantId}/domains/connections", {"tenantId": tenant}, {"domain": "roma.se", "records": []})
    assert _zone(aws, tenant, "roma.se")["attempt"] == 2


def test_hosts_of_a_live_order_are_removed_with_the_order(od, aws, tenant):
    _connected_live(od, aws, tenant)
    status, body = call("DELETE /platform/tenants/{tenantId}/domains/{domain}", {"tenantId": tenant, "domain": "www.roma.se"})
    assert status == 409 and body["error"] == "own_domain_order"


def test_remove_records_mode_mails_what_to_delete(od, aws, tenant):
    _slug(aws, tenant)
    call("POST /platform/tenants/{tenantId}/domains/records", {"tenantId": tenant}, {"domain": "roma.se"})
    status, _ = call("DELETE /platform/tenants/{tenantId}/zones/{domain}", {"tenantId": tenant, "domain": "roma.se"})
    assert status == 202 and od.mails.kinds()[-1] == "removed_records"
    assert "Item" not in aws["ddb"].get_item(TableName="dev-tenant", Key={"PK": {"S": "DOMAIN#roma.se"}, "SK": {"S": "TENANT"}})


def test_offboarding_releases_the_own_domain(od, aws, tenant):
    from test_api import _activate
    _connected_live(od, aws, tenant)
    _update(aws, tenant, "ZONE#roma.se", devStatus="live")
    _activate(aws, tenant)
    status, _ = call("POST /platform/tenants/{tenantId}/offboard", {"tenantId": tenant}, {"confirmSlug": "pizzeria-roma"})
    assert status == 202
    assert od.kvs.keys == {} and {"action": "devDomain", "op": "unmount", "tenantId": tenant, "host": "dev.roma.se"} in od.site.calls


# ------------------------------------------------------- transfer-out code
def test_auth_code_only_for_domains_registered_here(od, aws, tenant):
    p = {"tenantId": tenant, "domain": "roma.se"}
    _put(aws, tenant, "ZONE#roma.se", domain="roma.se", mode="connect", status="live")
    assert call("POST /platform/tenants/{tenantId}/zones/{domain}/auth-code", p, {})[1]["error"] == "not_registered_here"
    _update(aws, tenant, "ZONE#roma.se", mode="register")
    status, body = call("POST /platform/tenants/{tenantId}/zones/{domain}/auth-code", p, {})
    assert status == 200 and body == {"authCode": "s3cret-Code"}
    status, body = call("POST /platform/tenants/{tenantId}/zones/{domain}/auth-code", p, {"send": True})
    assert status == 200 and body == {"sentTo": "info@roma.se"} and od.mails[-1][1]["code"] == "s3cret-Code"
    actions = [a["action"] for a in call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["audit"]]
    assert "domain_auth_code_shown" in actions and "domain_auth_code_sent" in actions
    assert all("s3cret" not in json.dumps(a) for a in call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["audit"])


# ------------------------------------------------------------ health
def test_daily_health_check_puts_metrics_and_updates_orders(od, aws, tenant, monkeypatch):
    from app import core
    from app.handler import handler
    soon = datetime.now(timezone.utc) + timedelta(days=10)
    later = datetime.now(timezone.utc) + timedelta(days=300)
    od.domains.list_domains = lambda **kw: {"Domains": [{"DomainName": "roma.se"}, {"DomainName": "roma.com"}]}
    details = {"roma.se": {"ExpirationDate": soon, "AutoRenew": True},
               "roma.com": {"ExpirationDate": later, "AutoRenew": False}}
    od.domains.get_domain_detail = lambda DomainName: details[DomainName]
    od.domains.get_contact_reachability_status = lambda domainName: {"status": "PENDING"}
    od.domains.list_operations = lambda **kw: {"Operations": [{"OperationId": "op-x", "Status": "FAILED"}]}
    _put(aws, tenant, "ZONE#roma.se", domain="roma.se", mode="register", status="live")
    aws["ddb"].put_item(TableName="dev-tenant", Item={"PK": {"S": "DOMAIN#roma.se"}, "SK": {"S": "TENANT"}, "tenantId": {"S": tenant}})
    aws["ddb"].put_item(TableName="dev-tenant", Item={"PK": {"S": "DOMAIN#roma.com"}, "SK": {"S": "TENANT"}, "tenantId": {"S": tenant}})
    metrics = []

    class CW:
        def put_metric_data(self, Namespace, MetricData):
            metrics.append((Namespace, {m["MetricName"]: m["Value"] for m in MetricData}))
    core._clients["cloudwatch"] = CW()
    out = handler({"domainTask": "health"}, None)
    assert out["status"] == "done" and out["domains"] == 2
    assert metrics == [("Booqy/Domains", {"ExpiringUnder30Days": 1.0, "FailedOperations": 1.0, "AutoRenewOff": 1.0,
                                          "ReachabilityPending": 1.0})]
    z = _zone(aws, tenant, "roma.se")
    assert z["autoRenew"] is True and z["expiresAt"].startswith(soon.date().isoformat())
    monkeypatch.setenv("ENVIRONMENT", "dev")
    assert handler({"domainTask": "health"}, None) == {"status": "skipped"}


# ------------------------------------------------------- dev side (link)
def test_dev_side_set_canonical_and_unmount(od, aws, tenant, monkeypatch):
    from app.handler import handler
    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("PLATFORM_DOMAIN", "dev.booqy.se")
    _slug(aws, tenant, "pizzeria-roma.dev.booqy.se")
    task = {"action": "domain", "slug": "pizzeria-roma", "host": "dev.roma.se"}
    assert handler({"siteTask": {**task, "op": "setCanonical"}}, None)["error"] == "not_live"
    _activate_hosts(aws, tenant, "dev.roma.se")
    out = handler({"siteTask": {**task, "op": "setCanonical"}}, None)
    assert out["state"] == "live"
    assert od.kvs.keys == {"pizzeria-roma.dev.booqy.se": "dev.roma.se"}
    assert _profile(aws, tenant)["primaryDomain"] == "dev.roma.se"
    out = handler({"siteTask": {**task, "op": "unmount"}}, None)
    assert out == {"state": "removed", "host": "dev.roma.se"}
    assert od.kvs.keys == {} and _profile(aws, tenant)["primaryDomain"] == "pizzeria-roma.dev.booqy.se"
    detach = aws["sfn"].list_executions(stateMachineArn=os.environ["DOMAIN_DETACH_STATE_MACHINE_ARN"])["executions"]
    assert len(detach) == 1


def test_redirect_writer_never_loops(od):
    from app import own_domains
    od.kvs.keys["roma.se"] = "old.se"
    assert own_domains.redirect(["slug.booqy.se", "roma.se", "www.roma.se"], "roma.se") == ["slug.booqy.se", "www.roma.se"]
    assert "roma.se" not in od.kvs.keys
    own_domains.unredirect(["slug.booqy.se"], "other.se")                       # points elsewhere: kept
    assert od.kvs.keys["slug.booqy.se"] == "roma.se"


# ------------------------------------------------------ dev simulation
@pytest.fixture
def sim(aws, monkeypatch):
    """The dev console with test sites and simulation on; a test customer."""
    from app import core, domain_mail, zones
    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("DOMAINS_SIMULATE", "true")
    monkeypatch.setenv("TEST_SITES_ENABLED", "true")
    monkeypatch.setenv("TEST_MAIN_DOMAIN", "test.booqy.se")
    monkeypatch.setenv("TEST_DEV_DOMAIN", "test-dev.booqy.se")
    monkeypatch.setenv("SITE_REPO_FUNCTION_ARN", "arn:aws:lambda:eu-north-1:123456789012:function:site-repo:live")
    monkeypatch.setenv("SITE_REPOS_ENABLED", "true")
    monkeypatch.setenv("PLATFORM_DOMAIN", "dev.booqy.se")
    zones._PRICES.clear()
    site_repo = FakeSiteRepo()
    core._clients["lambda"] = site_repo
    mails = Mails()
    monkeypatch.setattr(domain_mail, "send", mails)
    from conftest import NEW_TENANT
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "test-roma"})
    assert status == 202, body
    yield {"tenant": body["tenantId"], "site": site_repo, "mails": mails}
    os.environ["PLATFORM_DOMAIN"] = ""


def test_simulated_transfer_end_to_end(sim, aws):
    t = sim["tenant"]
    status, body = call("GET /platform/domains/transfer-check", query={"domain": "roma.se"})
    assert status == 200 and body["simulated"] and body["price"] == {"amount": 0, "currency": "USD"}
    status, body = call("GET /platform/domains/dns-scan", query={"domain": "roma.com"})
    assert status == 200 and body["simulated"]
    status, body = call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": t},
                        {**TRANSFER, "acceptedPrice": {"amount": 16, "currency": "USD"}})
    assert status == 202, body
    z = _zone(aws, t, "roma.com")
    assert z["simulated"] and z["hostedZoneId"] == "sim" and z["status"] == "awaiting_owner_approval"
    assert boto3.client("route53", region_name=REGION).list_hosted_zones()["HostedZones"] == []
    p = {"tenantId": t, "domain": "roma.com"}
    assert call("POST /platform/tenants/{tenantId}/zones/{domain}/simulate", p, {"event": "records_added"})[0] == 400
    status, body = call("POST /platform/tenants/{tenantId}/zones/{domain}/simulate", p, {"event": "approve"})
    assert status == 200 and body["result"] == "done" and body["zone"]["status"] == "transferred_in"
    assert _task("nameserver_status", t, "roma.com") == {"status": "done"}
    out = _task("prepare_dns", t, "roma.com", requestedBy="op-1")
    assert out == {"status": "done", "attach": False}
    assert {"action": "testHost", "op": "put", "tenantId": t, "label": "roma-com"} in sim["site"].calls
    assert _task("set_canonical", t, "roma.com") == {"status": "done"}
    assert {"action": "testHost", "op": "redirect", "tenantId": t, "label": "roma-com"} in sim["site"].calls
    assert _zone(aws, t, "roma.com")["redirects"] == ["test-roma.test.booqy.se", "test-roma.test-dev.booqy.se"]
    assert _task("mark", t, "roma.com", status="live") == {"status": "live"}
    assert _task("dev_step", t, "roma.com") == {"status": "done"}
    assert _task("update_site", t, "roma.com") == {"status": "skipped"}
    z = _zone(aws, t, "roma.com")
    assert z["status"] == "live" and z["canonicalHost"] == "roma-com.test.booqy.se" and z["devStatus"] == "live"
    assert _profile(aws, t)["primaryDomain"] == "roma-com.test.booqy.se"
    # transfer-out code, simulated
    assert call("POST /platform/tenants/{tenantId}/zones/{domain}/auth-code", p, {})[1]["authCode"].startswith("SIM-")
    # removal unmaps the test hosts
    status, _ = call("DELETE /platform/tenants/{tenantId}/zones/{domain}", p)
    assert status == 202 and {"action": "testHost", "op": "delete", "tenantId": t, "label": "roma-com"} in sim["site"].calls
    calls = sim["site"].calls
    assert calls.index({"action": "testHost", "op": "redirect", "tenantId": t, "label": ""}) < \
        calls.index({"action": "testHost", "op": "delete", "tenantId": t, "label": "roma-com"})
    assert _profile(aws, t)["primaryDomain"] == "test-roma.test.booqy.se"


@pytest.mark.parametrize("event, status, code", [("reject", "transfer_rejected", "rejected"),
                                                 ("expire", "transfer_expired", "transfer_expired")])
def test_simulated_transfer_rejection_and_expiry(sim, aws, event, status, code):
    t = sim["tenant"]
    call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": t},
         {**TRANSFER, "acceptedPrice": {"amount": 16, "currency": "USD"}})
    body = call("POST /platform/tenants/{tenantId}/zones/{domain}/simulate", {"tenantId": t, "domain": "roma.com"},
                {"event": event})[1]
    assert body["result"] == "failed" and body["zone"]["status"] == status and body["zone"]["errorCode"] == code
    # The move started again (new code): the first execution, still waiting, ends at its next check.
    status_code, body = call("POST /platform/tenants/{tenantId}/domains/transfers", {"tenantId": t},
                             {**TRANSFER, "authCode": "NEW-CODE", "acceptedPrice": {"amount": 16, "currency": "USD"}})
    assert status_code == 202 and body["zone"]["attempt"] == 2
    machine = os.environ["DOMAIN_PROVISION_STATE_MACHINE_ARN"]
    inputs = [json.loads(aws["sfn"].describe_execution(executionArn=e["executionArn"])["input"])
              for e in aws["sfn"].list_executions(stateMachineArn=machine)["executions"]]
    assert sorted(i["attempt"] for i in inputs) == [1, 2]
    assert _task("transfer_in_status", t, "roma.com", attempt=1) == {"status": "cancelled"}
    assert _task("transfer_in_status", t, "roma.com", attempt=2) == {"status": "pending"}
    assert _task("transfer_in_status", t, "roma.com") == {"status": "pending"}     # older executions: no attempt


def test_simulated_buy_records_and_connect(sim, aws):
    t = sim["tenant"]
    status, body = call("GET /platform/domains/search", query={"q": "roma"})
    assert status == 200 and body["results"][0]["price"] == {"amount": 32, "currency": "USD"}
    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", {"tenantId": t},
                        {"domain": "roma.eu", "contact": CONTACT, "acceptedPrice": {"amount": 8, "currency": "USD"}})
    assert status == 202, body
    assert _task("registration_status", t, "roma.eu") == {"status": "pending"}
    body = call("POST /platform/tenants/{tenantId}/zones/{domain}/simulate", {"tenantId": t, "domain": "roma.eu"},
                {"event": "approve"})[1]
    assert body["result"] == "done" and body["zone"]["status"] == "registered"

    status, body = call("POST /platform/tenants/{tenantId}/domains/records", {"tenantId": t}, {"domain": "roma.nu"})
    assert status == 202 and body["zone"]["simulated"]
    # every record shows in the dev console too, dev's on the sandbox's dev host
    assert [(r["name"], r["value"]) for r in body["zone"]["records"]][1] == ("dev", "roma-nu.test-dev.booqy.se")
    assert "Namn dev, Värde roma-nu.test-dev.booqy.se" in body["zone"]["restaurantSteps"]
    assert "\n1. Logga in" in body["zone"]["restaurantSteps"] and "- 1." not in body["zone"]["restaurantSteps"]
    body = call("POST /platform/tenants/{tenantId}/zones/{domain}/simulate", {"tenantId": t, "domain": "roma.nu"},
                {"event": "records_added"})[1]
    assert body["result"] == "done"
    assert _task("prepare_records", t, "roma.nu", requestedBy="op-1") == {"status": "done", "attach": False}

    # a simulated timeout, then Retry: the order waits again instead of timing out at once
    call("POST /platform/tenants/{tenantId}/domains/records", {"tenantId": t}, {"domain": "roma.dk"})
    p = {"tenantId": t, "domain": "roma.dk"}
    body = call("POST /platform/tenants/{tenantId}/zones/{domain}/simulate", p, {"event": "expire"})[1]
    assert body["result"] == "failed" and body["zone"]["status"] == "records_timeout" and body["zone"]["canRetry"]
    status, body = call("POST /platform/tenants/{tenantId}/zones/{domain}/retry", p)
    assert status == 202 and body["zone"]["status"] == "awaiting_records" and "simState" not in body["zone"]
    assert _task("records_status", t, "roma.dk", attempt=2) == {"status": "pending"}

    status, body = call("POST /platform/tenants/{tenantId}/domains/connections", {"tenantId": t},
                        {"domain": "roma.fi", "records": []})
    assert status == 202 and body["nameServers"][0].startswith("ns-1.awsdns-sim")
    assert _task("nameserver_status", t, "roma.fi") == {"status": "pending"}
    body = call("POST /platform/tenants/{tenantId}/zones/{domain}/simulate", {"tenantId": t, "domain": "roma.fi"},
                {"event": "ns_switched"})[1]
    assert body["result"] == "done"


def test_a_simulated_se_registration_deletes_the_registreringsbevis_once_registered(sim, aws, monkeypatch):
    from app import zones
    t = sim["tenant"]
    s3 = boto3.client("s3", region_name=REGION)
    s3.create_bucket(Bucket="dev-domain-documents", CreateBucketConfiguration={"LocationConstraint": REGION})
    monkeypatch.setattr(zones, "_s3", lambda: s3)
    monkeypatch.setenv("DOMAIN_DOCUMENTS_BUCKET", "dev-domain-documents")
    key = f"tenants/{t}/registreringsbevis/doc1.pdf"
    s3.put_object(Bucket="dev-domain-documents", Key=key, Body=b"%PDF-1.4", ContentType="application/pdf")
    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", {"tenantId": t},
                        {"domain": "roma.se", "contact": CONTACT, "documentKey": key,
                         "acceptedPrice": {"amount": 32, "currency": "USD"}})
    assert status == 202 and body["zone"]["status"] == "awaiting_verification", body
    body = call("POST /platform/tenants/{tenantId}/zones/{domain}/simulate", {"tenantId": t, "domain": "roma.se"},
                {"event": "approve"})[1]
    assert body["zone"]["status"] == "registered" and not body["zone"]["hasDocument"]
    assert s3.list_objects_v2(Bucket="dev-domain-documents").get("KeyCount") == 0


def test_simulation_is_never_in_prod_nor_for_real_customers(sim, aws, monkeypatch, tenant):
    # a dev customer that isn't a test customer (prod-linked): managed from prod
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET siteKind = :k", ExpressionAttributeValues={":k": {"S": "prod-link"}})
    from test_api import _activate
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/domains/records", {"tenantId": tenant}, {"domain": "roma.se"})
    assert status == 409 and body["error"] == "managed_from_prod"
    # simulate in prod: refused
    t = sim["tenant"]
    call("POST /platform/tenants/{tenantId}/domains/records", {"tenantId": t}, {"domain": "roma.se"})
    monkeypatch.setenv("ENVIRONMENT", "prod")
    status, body = call("POST /platform/tenants/{tenantId}/zones/{domain}/simulate", {"tenantId": t, "domain": "roma.se"},
                        {"event": "records_added"})
    assert status == 409 and body["error"] == "not_simulated"
    # simulation off in dev: prod only
    monkeypatch.setenv("ENVIRONMENT", "dev")
    monkeypatch.setenv("DOMAINS_SIMULATE", "false")
    assert call("GET /platform/domains/tlds")[1]["error"] == "prod_only"


def test_tld_list(sim):
    status, body = call("GET /platform/domains/tlds")
    assert status == 200 and {t["tld"] for t in body["tlds"]} >= {"se", "com", "eu"} and "nu" not in {t["tld"] for t in body["tlds"]}
    assert next(t for t in body["tlds"] if t["tld"] == "se")["sellable"]
