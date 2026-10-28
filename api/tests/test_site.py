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


def test_prod_link_adopts_an_active_dev_tenant_and_sets_up_its_site(site_repo, aws, tenant):
    _activate(aws, tenant)
    out = _task({"action": "mirror", **PROD_PROFILE, "planId": "unknown-in-dev"})
    assert out == {"tenantId": tenant, "status": "adopted"}
    assert site_repo.calls == [("Event", {"action": "provision", "tenantId": tenant})]


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
    _put(aws, tenant, "ZONE#roma.se", domain="roma.se", status="live", hostedZoneId=zone_id)
    _put(aws, tenant, "DOMAIN#www.roma.se", domain="www.roma.se", kind="custom", status="pending_validation")
    site_repo.answer = {"state": "not_mounted", "host": "dev.roma.se", "cnameTarget": "ddev.cloudfront.net"}
    p = {"tenantId": tenant}
    hosting = call("GET /platform/tenants/{tenantId}/site", p)[1]["hosting"]
    assert hosting["prod"]["state"] == "attaching" and hosting["dev"]["waitsFor"] == "www.roma.se"
    assert call("POST /platform/tenants/{tenantId}/site/mount", p, {"environment": "dev"})[1]["error"] == "own_domain_not_live"
    _put(aws, tenant, "DOMAIN#www.roma.se", domain="www.roma.se", kind="custom", status="active")
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
