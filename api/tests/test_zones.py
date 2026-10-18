"""Domains we run DNS for: search, buy (.se with registreringsbevis), connect
(record import) and the domain-provision workflow's tasks."""

import json
import os
from decimal import Decimal

import boto3
import pytest
from botocore.exceptions import ClientError

from conftest import REGION, call

PRICE = {"amount": 14.0, "currency": "USD"}
CONTACT = {"legalName": "Roma Restaurang AB", "orgNumber": "5566778899", "firstName": "Maria",
           "lastName": "Rossi", "email": "info@roma.se", "phone": "08-123 45 67",
           "address": {"street": "Storgatan 1", "postalCode": "111 22", "city": "Stockholm"}}


class FakeDomains:
    def __init__(self):
        self.available = {"roma.se": "AVAILABLE", "roma.com": "UNAVAILABLE", "roma.eu": "AVAILABLE",
                          "pizzaroma.com": "AVAILABLE"}
        self.registered = []
        self.op = {"Status": "IN_PROGRESS", "StatusFlag": "PENDING_SUPPORT_CASE"}
        self.refuse = None

    def check_domain_availability(self, DomainName):
        return {"Availability": self.available.get(DomainName, "AVAILABLE")}

    def list_prices(self, Tld):
        return {"Prices": [{"Name": Tld, "RegistrationPrice": {"Price": 14.0, "Currency": "USD"},
                            "RenewalPrice": {"Price": 14.0, "Currency": "USD"},
                            "TransferPrice": {"Price": 14.0, "Currency": "USD"}}]}

    def get_domain_suggestions(self, DomainName, SuggestionCount, OnlyAvailable):
        return {"SuggestionsList": [{"DomainName": "pizzaroma.com", "Availability": "AVAILABLE"},
                                    {"DomainName": "roma.xyz", "Availability": "AVAILABLE"}]}

    def register_domain(self, **kw):
        if self.refuse:
            raise ClientError({"Error": {"Code": "InvalidInput", "Message": self.refuse}}, "RegisterDomain")
        self.registered.append(kw)
        return {"OperationId": "op-1"}

    def get_operation_detail(self, OperationId):
        return {"OperationId": OperationId, **self.op}


@pytest.fixture
def domains(aws, monkeypatch):
    from app import zones
    zones._PRICES.clear()
    fake = FakeDomains()
    monkeypatch.setattr(zones, "_domains", lambda: fake)
    monkeypatch.setattr(zones, "_s3", lambda: boto3.client("s3", region_name=REGION))
    s3 = boto3.client("s3", region_name=REGION)
    s3.create_bucket(Bucket="dev-domain-documents", CreateBucketConfiguration={"LocationConstraint": REGION})
    os.environ.update({"PLATFORM_DOMAIN": "dev.booqy.se", "TENANT_DOMAIN_CNAME_TARGET": "d111.cloudfront.net",
                       "DOMAIN_DOCUMENTS_BUCKET": "dev-domain-documents"})
    fake.s3 = s3
    yield fake
    for k in ("TENANT_DOMAIN_CNAME_TARGET", "DOMAIN_DOCUMENTS_BUCKET"):
        os.environ[k] = ""


def _upload(domains, tenant):
    status, body = call("POST /platform/tenants/{tenantId}/domains/documents", {"tenantId": tenant}, {})
    assert status == 200 and body["documentKey"].startswith(f"tenants/{tenant}/registreringsbevis/")
    assert body["upload"]["fields"]["Content-Type"] == "application/pdf"
    domains.s3.put_object(Bucket="dev-domain-documents", Key=body["documentKey"], Body=b"%PDF-1.4")
    return body["documentKey"]


def _executions(aws):
    arn = os.environ["DOMAIN_PROVISION_STATE_MACHINE_ARN"]
    return [json.loads(aws["sfn"].describe_execution(executionArn=e["executionArn"])["input"])
            for e in aws["sfn"].list_executions(stateMachineArn=arn)["executions"]]


def _zone(aws, tenant, domain):
    item = aws["ddb"].get_item(TableName="dev-tenant",
                               Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": f"ZONE#{domain}"}})["Item"]
    from app.core import from_ddb
    return from_ddb(item)


def test_search(domains):
    status, body = call("GET /platform/domains/search", query={"q": "Roma"})
    assert status == 200
    assert [(r["domain"], r["available"]) for r in body["results"]] == [
        ("roma.se", True), ("roma.com", False), ("roma.eu", True)]
    se = body["results"][0]
    assert se["verificationRequired"] and se["price"] == PRICE and se["renewalPrice"] == PRICE
    assert [s["domain"] for s in body["suggestions"]] == ["pizzaroma.com"]   # .xyz isn't sold
    assert call("GET /platform/domains/search", query={"q": "x"})[0] == 400
    # a full name puts that one first
    assert call("GET /platform/domains/search", query={"q": "www.roma.eu"})[1]["results"][0]["domain"] == "roma.eu"


def test_register_se_requires_registreringsbevis_and_price(domains, aws, tenant):
    p = {"tenantId": tenant}
    base = {"domain": "roma.se", "makePrimary": True, "contact": CONTACT, "acceptedPrice": PRICE}
    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", p, base)
    assert status == 400 and "documentKey" in body["fields"]
    # a key that isn't this tenant's
    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", p,
                        {**base, "documentKey": "tenants/other/registreringsbevis/x.pdf"})
    assert status == 400 and "documentKey" in body["fields"]
    # key issued but nothing uploaded
    _, up = call("POST /platform/tenants/{tenantId}/domains/documents", p, {})
    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", p, {**base, "documentKey": up["documentKey"]})
    assert status == 400 and "documentKey" in body["fields"]

    key = _upload(domains, tenant)
    # price moved since the operator saw it
    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", p,
                        {**base, "documentKey": key, "acceptedPrice": {"amount": 9, "currency": "USD"}})
    assert status == 409 and body["error"] == "price_changed" and body["price"] == PRICE
    assert domains.registered == []

    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", p, {**base, "documentKey": key})
    assert status == 202, body
    assert body["zone"]["status"] == "awaiting_verification" and body["zone"]["hasDocument"]
    assert "roma.se" in body["supportCase"]["subject"] and "556677-8899" in body["supportCase"]["body"]
    reg = domains.registered[0]
    c = reg["RegistrantContact"]
    assert c["ContactType"] == "COMPANY" and c["OrganizationName"] == "Roma Restaurang AB"
    assert c["PhoneNumber"] == "+46.81234567" and c["ZipCode"] == "11122" and c["CountryCode"] == "SE"
    assert c["ExtraParams"] == [{"Name": "SE_ID_NUMBER", "Value": "556677-8899"}]
    assert reg["AutoRenew"] is True and reg["PrivacyProtectRegistrantContact"] is False
    assert _executions(aws) == [{"tenantId": tenant, "domain": "roma.se", "mode": "register",
                                 "makePrimary": True, "requestedBy": "op-1"}]
    # shown on the tenant page; the document key itself is never returned
    _, detail = call("GET /platform/tenants/{tenantId}", p)
    assert detail["zones"][0]["domain"] == "roma.se" and "documentKey" not in detail["zones"][0]
    assert "556677-8899" in detail["zones"][0]["supportCase"]["body"]
    # double submit
    assert call("POST /platform/tenants/{tenantId}/domains/registrations", p,
                {**base, "documentKey": key})[1]["error"] == "domain_exists"
    # download link for the support case
    status, body = call("GET /platform/tenants/{tenantId}/zones/{domain}/document", {**p, "domain": "roma.se"})
    assert status == 200 and body["url"].startswith("https://")


def test_register_com_needs_no_document(domains, aws, tenant):
    p = {"tenantId": tenant}
    domains.available["roma.com"] = "AVAILABLE"
    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", p,
                        {"domain": "roma.com", "contact": CONTACT, "acceptedPrice": PRICE})
    assert status == 202 and body["zone"]["status"] == "registering" and body["supportCase"] is None
    assert domains.registered[0]["PrivacyProtectRegistrantContact"] is True


def test_register_refused_and_unavailable(domains, aws, tenant):
    p = {"tenantId": tenant}
    domains.available["roma.com"] = "UNAVAILABLE"
    assert call("POST /platform/tenants/{tenantId}/domains/registrations", p,
                {"domain": "roma.com", "contact": CONTACT, "acceptedPrice": PRICE})[1]["error"] == "domain_unavailable"
    assert call("POST /platform/tenants/{tenantId}/domains/registrations", p,
                {"domain": "roma.nu", "contact": CONTACT, "acceptedPrice": PRICE})[0] == 400
    assert call("POST /platform/tenants/{tenantId}/domains/registrations", p,
                {"domain": "x.dev.booqy.se", "contact": CONTACT, "acceptedPrice": PRICE})[0] == 400
    domains.available["roma.eu"] = "AVAILABLE"
    domains.refuse = "Invalid contact"
    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", p,
                        {"domain": "roma.eu", "contact": CONTACT, "acceptedPrice": PRICE})
    assert status == 502 and body["error"] == "registration_refused"
    assert _zone(aws, tenant, "roma.eu")["status"] == "failed"
    # the claim was released, and the order can be placed again
    assert "Item" not in aws["ddb"].get_item(TableName="dev-tenant",
                                             Key={"PK": {"S": "DOMAIN#roma.eu"}, "SK": {"S": "TENANT"}})
    domains.refuse = None
    assert call("POST /platform/tenants/{tenantId}/domains/registrations", p,
                {"domain": "roma.eu", "contact": CONTACT, "acceptedPrice": PRICE})[0] == 202


def test_contact_validation(domains, tenant):
    status, body = call("POST /platform/tenants/{tenantId}/domains/registrations", {"tenantId": tenant},
                        {"domain": "roma.eu", "acceptedPrice": PRICE,
                         "contact": {**CONTACT, "orgNumber": "123", "phone": "abc"}})
    assert status == 400 and {"contact.orgNumber", "contact.phone"} <= set(body["fields"])


def test_dns_scan(domains, monkeypatch):
    from app import zones
    answers = {
        ("roma.se", "A"): ["1.2.3.4"], ("roma.se", "MX"): ["10 mx1.pub.mailpod.one.com."],
        ("roma.se", "TXT"): ['"v=spf1 include:_custspf.one.com ~all"'],
        ("roma.se", "NS"): ["ns01.one.com.", "ns02.one.com."],
        ("www.roma.se", "CNAME"): ["roma.se."], ("www.roma.se", "A"): ["1.2.3.4"],
        ("autodiscover.roma.se", "CNAME"): ["autodiscover.outlook.com."],
        ("autodiscover.roma.se", "A"): ["52.1.1.1"],
    }

    def doh(name, rtype):
        codes = {v: k for k, v in zones.DNS_TYPE_CODES.items()}
        return {"AD": False, "Answer": [{"name": name + ".", "type": codes[rtype], "TTL": 600, "data": d}
                                        for d in answers.get((name, rtype), [])]}
    monkeypatch.setattr(zones, "_doh", doh)
    status, body = call("GET /platform/domains/dns-scan", query={"domain": "https://www.roma.se/"})
    assert status == 200 and body["domain"] == "roma.se" and body["nameServers"] == ["ns01.one.com", "ns02.one.com"]
    recs = {(r["name"], r["type"]): r for r in body["records"]}
    assert recs[("roma.se", "MX")]["values"] == ["10 mx1.pub.mailpod.one.com."] and recs[("roma.se", "MX")]["skip"] is None
    assert recs[("roma.se", "A")]["skip"] and recs[("www.roma.se", "CNAME")]["skip"]
    assert ("autodiscover.roma.se", "A") not in recs          # CNAME names have nothing else
    assert recs[("autodiscover.roma.se", "CNAME")]["values"] == ["autodiscover.outlook.com."]


def test_connect_imports_records_and_waits_for_name_servers(domains, aws, tenant, monkeypatch):
    from app import zones
    p = {"tenantId": tenant}
    long_dkim = "v=DKIM1; k=rsa; p=" + "A" * 400
    records = [
        {"name": "@", "type": "MX", "ttl": 3600, "values": ["10 mx1.pub.mailpod.one.com."]},
        {"name": "roma.se", "type": "TXT", "ttl": 3600, "values": ['"v=spf1 include:_custspf.one.com ~all"']},
        {"name": "rsa1._domainkey", "type": "TXT", "ttl": 3600, "values": [long_dkim]},
        {"name": "roma.se", "type": "CAA", "ttl": 3600, "values": ['0 issue "letsencrypt.org"']},
        {"name": "roma.se", "type": "A", "ttl": 3600, "values": ["1.2.3.4"]},          # replaced
        {"name": "www", "type": "CNAME", "ttl": 3600, "values": ["roma.se."]},         # replaced
    ]
    status, body = call("POST /platform/tenants/{tenantId}/domains/connections", p,
                        {"domain": "roma.se", "makePrimary": True, "records": records})
    assert status == 202, body
    assert len(body["nameServers"]) == 4 and body["zone"]["status"] == "awaiting_nameservers"
    assert {(s["name"], s["type"]) for s in body["skipped"]} == {("roma.se", "A"), ("www.roma.se", "CNAME")}
    zone = _zone(aws, tenant, "roma.se")
    r53 = boto3.client("route53", region_name=REGION)
    sets = {(r["Name"], r["Type"]): r for r in r53.list_resource_record_sets(HostedZoneId=zone["hostedZoneId"])["ResourceRecordSets"]}
    assert sets[("roma.se.", "MX")]["ResourceRecords"] == [{"Value": "10 mx1.pub.mailpod.one.com."}]
    dkim = sets[("rsa1._domainkey.roma.se.", "TXT")]["ResourceRecords"][0]["Value"]
    assert dkim.count('" "') == 1                                     # split into 255-char strings
    caa = [r["Value"] for r in sets[("roma.se.", "CAA")]["ResourceRecords"]]
    assert '0 issue "amazon.com"' in caa                               # CloudFront's CA allowed
    assert ("roma.se.", "A") not in sets
    assert _executions(aws)[0]["mode"] == "connect"
    tags = r53.list_tags_for_resource(ResourceType="hostedzone", ResourceId=zone["hostedZoneId"])
    assert {"Key": "TenantId", "Value": tenant} in tags["ResourceTagSet"]["Tags"]

    # name servers: still one.com, then ours
    ours = zone["nameServers"]
    seen = {"ns": ["ns01.one.com."]}
    monkeypatch.setattr(zones, "_lookup", lambda name, rtype: (seen["ns"], 300, False))
    from app.handler import handler
    task = {"workflowTask": "nameserver_status", "tenantId": tenant, "domain": "roma.se"}
    assert handler(task, None) == {"status": "pending"}
    assert "ns01.one.com" in _zone(aws, tenant, "roma.se")["statusDetail"]
    seen["ns"] = [n + "." for n in ours]
    assert handler(task, None) == {"status": "done"}

    # prepare_dns: apex alias + www CNAME + ownership TXT, both hosts reserved
    assert handler({**task, "workflowTask": "prepare_dns", "requestedBy": "op-1"}, None) == {
        "status": "done", "hosts": ["roma.se", "www.roma.se"]}
    sets = {(r["Name"], r["Type"]): r for r in r53.list_resource_record_sets(HostedZoneId=zone["hostedZoneId"])["ResourceRecordSets"]}
    assert sets[("roma.se.", "A")]["AliasTarget"]["DNSName"].startswith("d111.cloudfront.net")
    assert sets[("www.roma.se.", "CNAME")]["ResourceRecords"] == [{"Value": "d111.cloudfront.net"}]
    assert ("_cf-challenge.roma.se.", "TXT") in sets and ("_cf-challenge.www.roma.se.", "TXT") in sets
    _, detail = call("GET /platform/tenants/{tenantId}", p)
    assert {d["domain"] for d in detail["domains"]} == {"roma.se", "www.roma.se"}
    # domain-attach hasn't issued the certificates yet: not live
    assert handler({**task, "workflowTask": "mark", "status": "live"}, None) == {"status": "failed"}
    assert "www.roma.se: pending_dns" in _zone(aws, tenant, "roma.se")["lastError"]
    for host in ("roma.se", "www.roma.se"):
        aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": f"DOMAIN#{host}"}},
                               UpdateExpression="SET #s = :a", ExpressionAttributeNames={"#s": "status"},
                               ExpressionAttributeValues={":a": {"S": "active"}})
    assert handler({**task, "workflowTask": "mark", "status": "live"}, None) == {"status": "live"}
    z = _zone(aws, tenant, "roma.se")
    assert z["status"] == "live" and "lastError" not in z

    # API events can't reach the task entry point
    from conftest import Ctx
    resp = handler({"routeKey": "GET /platform/plans", "workflowTask": "mark", "tenantId": tenant,
                    "domain": "roma.se", "status": "failed", "requestContext": {}}, Ctx())
    assert resp["statusCode"] == 403


def test_connect_validation(domains, tenant):
    p = {"tenantId": tenant}
    assert call("POST /platform/tenants/{tenantId}/domains/connections", p,
                {"domain": "shop.roma.se", "records": []})[0] == 400
    status, body = call("POST /platform/tenants/{tenantId}/domains/connections", p, {"domain": "roma.se", "records": [
        {"name": "mail", "type": "CNAME", "ttl": 300, "values": ["x.one.com."]},
        {"name": "mail", "type": "A", "ttl": 300, "values": ["1.1.1.1"]},
        {"name": "x", "type": "PTR", "ttl": 300, "values": ["a"]}]})
    assert status == 400 and "records" in body["fields"] and "records.2.type" in body["fields"]


def test_registration_status_task(domains, aws, tenant):
    from app.handler import handler
    p = {"tenantId": tenant}
    key = _upload(domains, tenant)
    call("POST /platform/tenants/{tenantId}/domains/registrations", p,
         {"domain": "roma.se", "contact": CONTACT, "acceptedPrice": PRICE, "documentKey": key})
    task = {"workflowTask": "registration_status", "tenantId": tenant, "domain": "roma.se"}
    assert handler(task, None) == {"status": "pending"}
    z = _zone(aws, tenant, "roma.se")
    assert z["status"] == "awaiting_verification" and "identity check" in z["statusDetail"]
    # Route 53 finished: it created the zone
    domains.op = {"Status": "SUCCESSFUL"}
    r53 = boto3.client("route53", region_name=REGION)
    r53.create_hosted_zone(Name="roma.se", CallerReference="r53-auto")
    assert handler(task, None) == {"status": "done"}
    z = _zone(aws, tenant, "roma.se")
    assert z["status"] == "registered" and z["hostedZoneId"] and len(z["nameServers"]) == 4
    assert "documentKey" not in z and z["documentDeletedAt"]                  # registreringsbevis deleted
    assert "Contents" not in domains.s3.list_objects_v2(Bucket="dev-domain-documents")


def test_registration_failure_releases_claim(domains, aws, tenant):
    from app.handler import handler
    domains.available["roma.com"] = "AVAILABLE"
    call("POST /platform/tenants/{tenantId}/domains/registrations", {"tenantId": tenant},
         {"domain": "roma.com", "contact": CONTACT, "acceptedPrice": PRICE})
    domains.op = {"Status": "FAILED", "Message": "Registry rejected"}
    task = {"workflowTask": "registration_status", "tenantId": tenant, "domain": "roma.com"}
    assert handler(task, None) == {"status": "failed"}
    assert "Registry rejected" in _zone(aws, tenant, "roma.com")["lastError"]
    assert handler({**task, "workflowTask": "mark", "status": "failed", "error": "x"}, None) == {"status": "failed"}
    assert "Item" not in aws["ddb"].get_item(TableName="dev-tenant",
                                             Key={"PK": {"S": "DOMAIN#roma.com"}, "SK": {"S": "TENANT"}})
