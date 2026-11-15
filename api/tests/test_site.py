"""Website tab: every action goes to the site-repo function; refusals and
its errors come back as API errors; nothing happens while site repos are
off; Archive needs the slug typed."""

import io
import json
import os

import pytest

from conftest import call
from test_api import _activate


class FakeSiteRepo:
    def __init__(self):
        self.calls = []
        self.answer = {}
        self.error = None

    def invoke(self, **kwargs):
        payload = json.loads(kwargs["Payload"])
        self.calls.append((kwargs["InvocationType"], payload))
        if self.error:
            return {"StatusCode": 200, "FunctionError": "Unhandled",
                    "Payload": io.BytesIO(json.dumps({"errorMessage": self.error, "errorType": "SiteRepoError"}).encode())}
        return {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(self.answer).encode())}


@pytest.fixture
def site_repo(aws, monkeypatch):
    from app import core
    fake = FakeSiteRepo()
    core._clients["lambda"] = fake
    monkeypatch.setenv("SITE_REPO_FUNCTION_ARN", "arn:aws:lambda:eu-north-1:123456789012:function:dev-site-repo:live")
    monkeypatch.setenv("SITE_REPOS_ENABLED", "true")
    return fake


def test_status_comes_from_site_repo(site_repo, tenant):
    site_repo.answer = {"repo": "site-pizzeria-roma", "status": "ready", "deploys": {"dev": None, "prod": None}}
    status, body = call("GET /platform/tenants/{tenantId}/site", {"tenantId": tenant})
    assert status == 200 and body["enabled"] is True and body["repo"] == "site-pizzeria-roma"
    assert site_repo.calls == [("RequestResponse", {"action": "status", "tenantId": tenant})]


def test_off_until_switched_on(site_repo, tenant, monkeypatch):
    monkeypatch.setenv("SITE_REPOS_ENABLED", "false")
    assert call("GET /platform/tenants/{tenantId}/site", {"tenantId": tenant}) == (200, {"enabled": False})
    assert call("POST /platform/tenants/{tenantId}/site/redeploy", {"tenantId": tenant})[1]["error"] == "site_repos_off"
    assert site_repo.calls == []


def test_retry_runs_the_setup_in_the_background(site_repo, aws, tenant):
    p = {"tenantId": tenant}
    assert call("POST /platform/tenants/{tenantId}/site/retry", p)[1]["error"] == "invalid_status"   # provisioning
    _activate(aws, tenant)
    assert call("POST /platform/tenants/{tenantId}/site/retry", p) == (202, {"status": "creating"})
    assert site_repo.calls == [("Event", {"action": "provision", "tenantId": tenant})]


def test_invite(site_repo, tenant):
    p = {"tenantId": tenant}
    assert call("POST /platform/tenants/{tenantId}/site/invite", p, {})[0] == 400
    site_repo.answer = {"repo": "site-pizzeria-roma", "username": "anna", "result": "invited"}
    status, body = call("POST /platform/tenants/{tenantId}/site/invite", p, {"username": " anna "})
    assert status == 200 and body["result"] == "invited"
    assert site_repo.calls[-1][1] == {"action": "invite", "tenantId": tenant, "username": "anna"}
    site_repo.error = "not a GitHub username"
    status, body = call("POST /platform/tenants/{tenantId}/site/invite", p, {"username": "a/b"})
    assert status == 400 and body["fields"] == {"username": "Not a GitHub username"}


def test_site_repo_errors_reach_the_operator(site_repo, tenant):
    site_repo.error = "GitHub POST /repos/x: 403 Resource not accessible by integration"
    status, body = call("POST /platform/tenants/{tenantId}/site/redeploy", {"tenantId": tenant})
    assert status == 502 and body["error"] == "site_repo_failed" and "403" in body["message"]


def test_archive_needs_the_slug(site_repo, tenant):
    p = {"tenantId": tenant}
    assert call("POST /platform/tenants/{tenantId}/site/archive", p, {"confirmSlug": "nope"})[0] == 400
    assert site_repo.calls == []
    site_repo.answer = {"status": "archived", "repo": "site-pizzeria-roma", "repoArchived": True}
    status, body = call("POST /platform/tenants/{tenantId}/site/archive", p, {"confirmSlug": "pizzeria-roma"})
    assert status == 200 and body["repoArchived"] is True


def test_operators_only(site_repo, tenant):
    assert call("GET /platform/tenants/{tenantId}/site", {"tenantId": tenant}, groups="[owner_user]")[0] == 403
    assert os.environ["SITE_REPOS_ENABLED"] == "true" and site_repo.calls == []


def _task(task):
    from app.handler import handler
    return handler({"siteTask": task}, None)


PROD_PROFILE = {"name": "Pizzeria Roma", "slug": "pizzeria-roma", "ownerEmail": "owner@roma.se", "ownerName": "Maria Rossi",
                "planId": "growth", "legalName": "Roma Restaurang AB", "orgNumber": "556677-8899",
                "contactEmail": "info@roma.se", "prodTenantId": "t-prod-1"}


def test_prod_link_creates_an_empty_dev_tenant(site_repo, aws):
    out = _task({"action": "mirror", **PROD_PROFILE})
    assert out["status"] == "created"
    status, body = call("GET /platform/tenants/{tenantId}", {"tenantId": out["tenantId"]})
    assert body["tenant"]["slug"] == "pizzeria-roma" and body["tenant"]["planId"] == "growth"
    assert body["locations"] == []                      # no data copied
    names = [e["name"] for e in aws["sfn"].list_executions(stateMachineArn=os.environ["ONBOARDING_STATE_MACHINE_ARN"])["executions"]]
    assert names == [f"onboard-{out['tenantId']}-1"]
    # A second call adopts the same tenant instead of creating another.
    assert _task({"action": "mirror", **PROD_PROFILE}) == {"tenantId": out["tenantId"], "status": "adopted"}


def test_prod_link_mirrors_an_owner_who_already_owns_a_dev_customer(site_repo, aws, tenant):
    # test-release, 2026-10-28: the prod owner's address already signed in to
    # another dev customer, and the dev side failed with "1 field needs fixing".
    from test_api import _owner_of
    _owner_of(aws, "owner@roma.se", tenant)
    out = _task({"action": "mirror", **PROD_PROFILE, "slug": "test-release", "orgNumber": "556677-8890"})
    assert out["status"] == "created"
    created = call("GET /platform/tenants/{tenantId}", {"tenantId": out["tenantId"]})[1]["tenant"]
    assert created["ownerEmail"] == "owner+test-release@roma.se" and "orgNumber" not in created


def test_prod_link_names_the_field_it_cannot_mirror(site_repo, aws):
    out = _task({"action": "mirror", **PROD_PROFILE, "ownerName": ""})
    assert out["error"] == "validation_failed" and "ownerName: Required" in out["message"]


REPO = {"name": "site-pizzeria-roma", "id": 9001, "html_url": "https://github.com/BooqyCustomers/site-pizzeria-roma",
        "owner": {"login": "BooqyCustomers", "id": 356944191}}


def test_prod_link_adopts_an_active_dev_tenant_and_writes_its_dev_role_for_the_repo_prod_names(site_repo, aws, tenant):
    _activate(aws, tenant)
    site_repo.answer = {"tenantId": tenant, "roleArn": "arn:aws:iam::1:role/booqy-sites/dev-site-pizzeria-roma",
                        "variables": {"DEV_TENANT_ID": tenant}, "config": {"tenantId": tenant}}
    out = _task({"action": "mirror", **PROD_PROFILE, "planId": "unknown-in-dev", "repo": REPO})
    assert out == {"tenantId": tenant, "status": "adopted", "site": site_repo.answer}
    # Synchronous, AWS only: dev site-repo never calls GitHub for BooqyCustomers.
    assert site_repo.calls == [("RequestResponse", {"action": "linkProvision", "tenantId": tenant, "repo": REPO})]
    # Without a repo (an older prod): only the tenant.
    assert _task({"action": "mirror", **PROD_PROFILE}) == {"tenantId": tenant, "status": "adopted"}
    assert len(site_repo.calls) == 1


def test_prod_link_creates_the_dev_tenant_then_its_role(site_repo, aws):
    site_repo.answer = {"roleArn": "arn:aws:iam::1:role/booqy-sites/dev-site-pizzeria-roma"}
    out = _task({"action": "mirror", **PROD_PROFILE, "repo": REPO})
    assert out["status"] == "created" and out["site"] == site_repo.answer
    assert site_repo.calls == [("RequestResponse", {"action": "linkProvision", "tenantId": out["tenantId"], "repo": REPO})]
    assert _profile(aws, out["tenantId"])["siteKind"] == "prod-link"


def test_a_dev_side_site_repo_refusal_reaches_prod(site_repo, aws, tenant):
    _activate(aws, tenant)
    site_repo.error = "refused: 'site-pizzeria-roma' owner id is not 356944191 (1)"
    out = _task({"action": "mirror", **PROD_PROFILE, "repo": REPO})
    assert out["error"] == "site_repo_failed" and "owner id" in out["message"]


def test_prod_link_archives_the_dev_side(site_repo, tenant):
    site_repo.answer = {"status": "archived", "repo": "site-pizzeria-roma", "repoArchived": False}
    assert _task({"action": "archive", "slug": "pizzeria-roma"})["repoArchived"] is False
    assert site_repo.calls == [("RequestResponse", {"action": "archive", "tenantId": tenant})]
    assert _task({"action": "archive", "slug": "nobody-here"}) == {"status": "none"}


def test_site_tasks_never_run_in_prod_and_check_their_input(site_repo, monkeypatch):
    assert _task({"action": "mirror", "slug": "../x"})["error"] == "validation_failed"
    assert _task({"action": "drop-tables", "slug": "pizzeria-roma"})["error"] == "validation_failed"
    monkeypatch.setenv("ENVIRONMENT", "prod")
    assert _task({"action": "mirror", **PROD_PROFILE})["error"] == "refused"
    assert site_repo.calls == []


def _put(aws, tenant_id, sk, **fields):
    from app.core import tenant_table, to_ddb
    aws["ddb"].put_item(TableName=tenant_table(), Item=to_ddb({"PK": f"TENANT#{tenant_id}", "SK": sk, **fields}))


def test_a_site_without_an_own_domain_is_live_on_its_slug_address(site_repo, aws, tenant, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "prod")
    _put(aws, tenant, "DOMAIN#pizzeria-roma.booqy.se", domain="pizzeria-roma.booqy.se", kind="platform", status="active")
    site_repo.answer = {"state": "slug_only", "slugUrl": "https://pizzeria-roma.dev.booqy.se", "host": None}
    hosting = call("GET /platform/tenants/{tenantId}/site", {"tenantId": tenant})[1]["hosting"]
    assert hosting["prod"]["slugUrl"] == "https://pizzeria-roma.booqy.se" and hosting["prod"]["state"] == "slug_only"
    assert hosting["dev"]["slugUrl"] == "https://pizzeria-roma.dev.booqy.se" and not hosting["dev"]["canMount"]
    assert site_repo.calls[-1] == ("RequestResponse", {"action": "devDomain", "op": "status", "tenantId": tenant})
    status, body = call("POST /platform/tenants/{tenantId}/site/mount", {"tenantId": tenant}, {"environment": "dev"})
    assert status == 409 and body["error"] == "no_own_domain"


def test_dev_mount_waits_for_the_own_domain_in_prod_then_writes_its_cname(site_repo, aws, tenant, monkeypatch):
    import boto3
    monkeypatch.setenv("ENVIRONMENT", "prod")
    zone_id = boto3.client("route53").create_hosted_zone(Name="roma.se", CallerReference="r")["HostedZone"]["Id"].split("/")[-1]
    # Booqy runs the DNS: the domain itself is the canonical host (own domains, 2026-11-15)
    _put(aws, tenant, "ZONE#roma.se", domain="roma.se", mode="connect", status="live", hostedZoneId=zone_id)
    _put(aws, tenant, "DOMAIN#roma.se", domain="roma.se", kind="custom", status="pending_validation")
    site_repo.answer = {"state": "not_mounted", "host": "dev.roma.se", "cnameTarget": "ddev.cloudfront.net"}
    p = {"tenantId": tenant}
    hosting = call("GET /platform/tenants/{tenantId}/site", p)[1]["hosting"]
    assert hosting["prod"]["state"] == "attaching" and hosting["dev"]["waitsFor"] == "roma.se"
    assert call("POST /platform/tenants/{tenantId}/site/mount", p, {"environment": "dev"})[1]["error"] == "own_domain_not_live"
    _put(aws, tenant, "DOMAIN#roma.se", domain="roma.se", kind="custom", status="active")
    status, body = call("POST /platform/tenants/{tenantId}/site/mount", p, {"environment": "dev"})
    assert status == 202 and body["hosting"]["prod"]["state"] == "live" and body["hosting"]["dev"]["canMount"]
    assert ("RequestResponse", {"action": "devDomain", "op": "mount", "tenantId": tenant, "host": "dev.roma.se"}) in site_repo.calls
    records = boto3.client("route53").list_resource_record_sets(HostedZoneId=zone_id)["ResourceRecordSets"]
    cname = next(r for r in records if r["Name"] == "dev.roma.se.")
    assert cname["ResourceRecords"] == [{"Value": "ddev.cloudfront.net"}]


def test_prod_mount_retries_a_failed_own_domain(site_repo, aws, tenant, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "prod")
    monkeypatch.setenv("PLATFORM_DOMAIN", "booqy.se")
    _put(aws, tenant, "DOMAIN#www.roma.se", domain="www.roma.se", kind="custom", status="failed")
    site_repo.answer = {"state": "slug_only"}
    assert call("GET /platform/tenants/{tenantId}/site", {"tenantId": tenant})[1]["hosting"]["prod"]["canMount"]
    status, body = call("POST /platform/tenants/{tenantId}/site/mount", {"tenantId": tenant}, {"environment": "prod"})
    assert status == 202 and body["hosting"]["prod"]["state"] == "attaching"
    names = [e["name"] for e in aws["sfn"].list_executions(stateMachineArn=os.environ["DOMAIN_ATTACH_STATE_MACHINE_ARN"])["executions"]]
    assert len(names) == 1 and names[0].startswith("attach-")


def test_dev_attaches_dev_domain_for_prod_and_refuses_platform_hosts(site_repo, aws, tenant, monkeypatch):
    monkeypatch.setenv("PLATFORM_DOMAIN", "dev.booqy.se")
    monkeypatch.setenv("TENANT_DOMAIN_CNAME_TARGET", "ddev.cloudfront.net")
    out = _task({"action": "domain", "op": "mount", "slug": "pizzeria-roma", "host": "dev.roma.se"})
    assert out["state"] == "attaching" and out["cnameTarget"] == "ddev.cloudfront.net"
    assert _task({"action": "domain", "op": "status", "slug": "pizzeria-roma", "host": "dev.roma.se"})["status"] == "pending_dns"
    assert _task({"action": "domain", "op": "mount", "slug": "pizzeria-roma", "host": "x.dev.booqy.se"})["error"] == "validation_failed"
    assert _task({"action": "domain", "op": "status", "slug": "nobody-here"})["error"] == "not_found"
    assert call("POST /platform/tenants/{tenantId}/site/mount", {"tenantId": tenant}, {"environment": "dev"})[1]["error"] == "managed_from_prod"


def test_delete_customer_deletes_the_repo_now(site_repo, aws, tenant):
    from test_api import _offboarded
    _offboarded(aws, tenant)
    site_repo.answer = {"status": "deleted", "repo": "site-pizzeria-roma", "repoDeleted": True}
    status, body = call("POST /platform/tenants/{tenantId}/purge", {"tenantId": tenant}, {"confirmSlug": "pizzeria-roma"})
    assert status == 202 and body["repo"]["repoDeleted"] is True
    assert site_repo.calls == [("RequestResponse", {"action": "delete", "tenantId": tenant})]
    audit = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["audit"]
    assert {a["action"] for a in audit[:2]} == {"site_repo_deleted", "purge_requested"}


def test_a_refused_repo_delete_is_logged_and_the_data_still_goes(site_repo, aws, tenant):
    from test_api import _offboarded
    _offboarded(aws, tenant)
    site_repo.error = "site-pizzeria-roma NOT deleted: GitHub refused (403)"
    status, body = call("POST /platform/tenants/{tenantId}/purge", {"tenantId": tenant}, {"confirmSlug": "pizzeria-roma"})
    assert status == 202 and "NOT deleted" in body["repoError"] and body["purgeAt"]
    audit = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["audit"]
    assert "site_repo_delete_failed" in {a["action"] for a in audit[:2]}


def test_prod_link_restores_an_offboarded_dev_tenant(site_repo, aws, tenant):
    from test_api import _offboarded
    _offboarded(aws, tenant)
    site_repo.answer = {"roleArn": "arn:aws:iam::1:role/booqy-sites/dev-site-pizzeria-roma"}
    out = _task({"action": "mirror", **PROD_PROFILE, "repo": REPO})
    assert out == {"tenantId": tenant, "status": "restored", "site": site_repo.answer}
    assert call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})[1]["tenant"]["status"] == "active"
    assert _profile(aws, tenant)["siteKind"] == "prod-link"


def test_prod_link_replaces_a_purged_dev_tenant(site_repo, aws, tenant):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :p", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":p": {"S": "purged"}})
    out = _task({"action": "mirror", **PROD_PROFILE, "ownerEmail": "new@roma.se"})
    assert out["status"] == "created" and out["tenantId"] != tenant


# ------------------------------------------------- test sites (dev, 2026-11-15)
@pytest.fixture
def test_sites(monkeypatch):
    monkeypatch.setenv("TEST_SITES_ENABLED", "true")
    monkeypatch.setenv("TEST_MAIN_DOMAIN", "test.booqy.se")
    monkeypatch.setenv("TEST_DEV_DOMAIN", "test-dev.booqy.se")
    monkeypatch.setenv("PLATFORM_DOMAIN", "dev.booqy.se")
    monkeypatch.setenv("TENANT_DOMAIN_CNAME_TARGET", "ddev.cloudfront.net")


def _profile(aws, tenant_id):
    from app.core import from_ddb
    return from_ddb(aws["ddb"].get_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant_id}"},
                                                                       "SK": {"S": "PROFILE"}})["Item"])


def test_a_customer_created_in_the_dev_console_is_a_test_customer(site_repo, aws, test_sites):
    from conftest import NEW_TENANT
    status, body = call("POST /platform/tenants", body=NEW_TENANT)
    assert status == 202 and _profile(aws, body["tenantId"])["siteKind"] == "test"
    # One prod creates through the link is the dev side of a real customer.
    out = _task({"action": "mirror", **PROD_PROFILE, "slug": "roma-real", "ownerEmail": "real@roma.se"})
    assert _profile(aws, out["tenantId"])["siteKind"] == "prod-link"


def test_no_site_kind_before_test_sites_are_on_or_in_prod(site_repo, aws, monkeypatch):
    from conftest import NEW_TENANT
    status, body = call("POST /platform/tenants", body=NEW_TENANT)
    assert "siteKind" not in _profile(aws, body["tenantId"])
    monkeypatch.setenv("ENVIRONMENT", "prod")
    monkeypatch.setenv("TEST_SITES_ENABLED", "true")
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "roma-prod", "ownerEmail": "p@roma.se"})
    assert status == 202 and "siteKind" not in _profile(aws, body["tenantId"])


def test_prod_cannot_link_to_a_dev_test_customer_with_the_same_slug(site_repo, aws, test_sites):
    from conftest import NEW_TENANT
    tenant_id = call("POST /platform/tenants", body=NEW_TENANT)[1]["tenantId"]
    _activate(aws, tenant_id)
    out = _task({"action": "mirror", **PROD_PROFILE, "slug": NEW_TENANT["slug"]})
    assert out["error"] == "slug_used_by_test_customer" and "delete it there first" in out["message"]
    assert site_repo.calls == []


def test_an_adopted_dev_tenant_becomes_a_prod_link(site_repo, aws, tenant):
    _activate(aws, tenant)
    assert _task({"action": "mirror", **PROD_PROFILE})["status"] == "adopted"
    assert _profile(aws, tenant)["siteKind"] == "prod-link"


def _make_test(aws, tenant):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET siteKind = :k", ExpressionAttributeValues={":k": {"S": "test"}})


def test_a_test_customers_own_domain_is_mapped_onto_the_test_zones(site_repo, aws, tenant, test_sites):
    _make_test(aws, tenant)
    p = {"tenantId": tenant}
    site_repo.answer = {"label": "example-se", "op": "put", "result": "done"}
    status, body = call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "www.example.se"})
    assert status == 202 and body["domain"] == "example.se" and body["test"] is True and body["status"] == "active"
    assert body["hosts"] == [{"stage": "main", "host": "example-se.test.booqy.se"},
                             {"stage": "dev", "host": "example-se.test-dev.booqy.se"}]
    # No workflow and no distribution tenant: the label goes into the sandbox's host map.
    assert aws["sfn"].list_executions(stateMachineArn=os.environ["DOMAIN_ATTACH_STATE_MACHINE_ARN"])["executions"] == []
    assert site_repo.calls == [("RequestResponse", {"action": "testHost", "op": "put", "tenantId": tenant,
                                                    "label": "example-se"}),
                               # guests only see it: the slug's test hosts answer with a 301 to it
                               ("RequestResponse", {"action": "testHost", "op": "redirect", "tenantId": tenant,
                                                    "label": "example-se"})]
    from app.domains import _domain_row
    for stage, host in (("main", "example-se.test.booqy.se"), ("dev", "example-se.test-dev.booqy.se")):
        row = _domain_row(tenant, host)
        assert row["kind"] == "custom" and row["stage"] == stage and row["mappedFrom"] == "example.se"
        assert row["status"] == "active" and row["sandbox"] is True
        claim = aws["ddb"].get_item(TableName="dev-tenant", Key={"PK": {"S": f"DOMAIN#{host}"}, "SK": {"S": "TENANT"}})
        assert claim["Item"]["tenantId"]["S"] == tenant
    assert _profile(aws, tenant)["primaryDomain"] == "example-se.test.booqy.se"
    # Again: already mapped.
    assert call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "example.se"})[1]["error"] == "domain_exists"
    # Removing one removes the pair, host map first.
    site_repo.answer = {"label": "example-se", "op": "delete", "result": "done"}
    status, body = call("DELETE /platform/tenants/{tenantId}/domains/{domain}", {**p, "domain": "example-se.test-dev.booqy.se"})
    assert status == 202 and body["hosts"] == ["example-se.test.booqy.se", "example-se.test-dev.booqy.se"]
    assert site_repo.calls[-2:] == [("RequestResponse", {"action": "testHost", "op": "redirect", "tenantId": tenant,
                                                         "label": ""}),
                                    ("RequestResponse", {"action": "testHost", "op": "delete", "tenantId": tenant,
                                                         "label": "example-se"})]
    assert _domain_row(tenant, "example-se.test.booqy.se") is None and _domain_row(tenant, "example-se.test-dev.booqy.se") is None
    assert "Item" not in aws["ddb"].get_item(TableName="dev-tenant", Key={"PK": {"S": "DOMAIN#example-se.test.booqy.se"},
                                                                          "SK": {"S": "TENANT"}})
    assert _profile(aws, tenant)["primaryDomain"] == "pizzeria-roma.test.booqy.se"
    assert aws["sfn"].list_executions(stateMachineArn=os.environ["DOMAIN_DETACH_STATE_MACHINE_ARN"])["executions"] == []


def test_a_mapped_label_another_customer_holds_is_refused_and_a_failed_map_is_rolled_back(site_repo, aws, tenant, test_sites):
    _make_test(aws, tenant)
    p = {"tenantId": tenant}
    aws["ddb"].put_item(TableName="dev-tenant", Item={"PK": {"S": "DOMAIN#example-se.test.booqy.se"}, "SK": {"S": "TENANT"},
                                                       "tenantId": {"S": "t-other"}})
    status, body = call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "example.se"})
    assert status == 409 and body["error"] == "domain_in_use" and site_repo.calls == []
    site_repo.error = "the test sites host map kept changing, try again"
    status, body = call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "other.se"})
    assert status == 502
    from app.domains import _domain_row
    assert _domain_row(tenant, "other-se.test.booqy.se") is None and _domain_row(tenant, "other-se.test-dev.booqy.se") is None


def test_test_hosts_are_never_added_directly_and_real_customers_are_managed_from_prod(site_repo, aws, tenant, test_sites):
    p = {"tenantId": tenant}
    status, body = call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "x.test.booqy.se"})
    assert status == 400 and "test mapping" in body["message"]
    assert call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "x.test-dev.booqy.se"})[0] == 400
    # tenant has no siteKind: the dev side of a real customer.
    status, body = call("POST /platform/tenants/{tenantId}/domains", p, {"domain": "roma.se"})
    assert status == 409 and body["error"] == "managed_from_prod"


def test_a_test_customers_hosting_has_main_and_dev(site_repo, aws, tenant, test_sites):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET siteKind = :k", ExpressionAttributeValues={":k": {"S": "test"}})
    _put(aws, tenant, "DOMAIN#pizzeria-roma.test.booqy.se", domain="pizzeria-roma.test.booqy.se", kind="platform",
         stage="main", status="active")
    _put(aws, tenant, "DOMAIN#pizzeria-roma.test-dev.booqy.se", domain="pizzeria-roma.test-dev.booqy.se", kind="platform",
         stage="dev", status="active")
    _put(aws, tenant, "DOMAIN#example-se.test.booqy.se", domain="example-se.test.booqy.se", kind="custom",
         stage="main", status="active", mappedFrom="example.se")
    site_repo.answer = {"repo": "site-pizzeria-roma", "status": "ready", "kind": "test"}
    hosting = call("GET /platform/tenants/{tenantId}/site", {"tenantId": tenant})[1]["hosting"]
    assert hosting["main"] == {"slugUrl": "https://pizzeria-roma.test.booqy.se", "host": "example-se.test.booqy.se",
                               "mappedFrom": "example.se", "state": "live", "status": "active", "lastError": None}
    assert hosting["dev"]["slugUrl"] == "https://pizzeria-roma.test-dev.booqy.se" and hosting["dev"]["state"] == "slug_only"


def test_a_test_customer_redeploys_either_branch(site_repo, aws, tenant):
    p = {"tenantId": tenant}
    assert call("POST /platform/tenants/{tenantId}/site/redeploy", p, {"branch": "main"})[0] == 400   # not a test customer
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET siteKind = :k", ExpressionAttributeValues={":k": {"S": "test"}})
    site_repo.answer = {"repo": "site-pizzeria-roma", "branch": "main", "result": "started"}
    assert call("POST /platform/tenants/{tenantId}/site/redeploy", p, {"branch": "main"})[0] == 202
    assert site_repo.calls[-1] == ("RequestResponse", {"action": "redeploy", "tenantId": tenant, "branch": "main"})
    assert call("POST /platform/tenants/{tenantId}/site/redeploy", p, {"branch": "prod"})[0] == 400


@pytest.mark.parametrize("slug", ["test", "test-dev"])
def test_the_test_zones_are_never_a_customer_slug(aws, slug):
    from conftest import NEW_TENANT
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "slug": slug})
    assert status == 400 and body["fields"]["slug"].startswith("Reserved")
