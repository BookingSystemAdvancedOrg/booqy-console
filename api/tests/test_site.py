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
