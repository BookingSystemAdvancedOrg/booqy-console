"""Audit 2026-11-16 (api-misc): Stripe account link back to Booqy Admin,
newsletter progress saved per recipient, no owner addresses in logs,
operator changes in the audit table, create-customer start date checked."""
import logging
from datetime import date, timedelta

import boto3
import pytest

from conftest import NEW_TENANT, REGION, call

OPERATOR = "ops@booqy.se"


# --------------------------------------------------------------- 168: account link
def _with_account(aws, tenant):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET stripe = :s",
                           ExpressionAttributeValues={":s": {"M": {"accountId": {"S": "acct_1"}}}})


def _fake_stripe(monkeypatch):
    from app import stripe_connect
    seen = []

    def fake(method, path, params=None):
        seen.append(params)
        return {"url": "https://connect.stripe.com/setup/x", "expires_at": "2026-11-16T10:00:00.000Z"}

    monkeypatch.setattr(stripe_connect, "stripe_request", fake)
    return seen


def test_account_link_returns_to_booqy_admin(aws, tenant, monkeypatch):
    _with_account(aws, tenant)
    seen = _fake_stripe(monkeypatch)
    status, _ = call("POST /platform/tenants/{tenantId}/stripe/account-link", {"tenantId": tenant})
    assert status == 200
    onboarding = seen[0]["use_case"]["account_onboarding"]
    assert onboarding["return_url"] == "https://app.example.se/settings/payments?stripe=return"
    assert onboarding["refresh_url"] == "https://app.example.se/settings/payments?stripe=refresh"


def test_account_link_falls_back_to_the_console_without_admin_app_url(aws, tenant, monkeypatch):
    monkeypatch.delenv("ADMIN_APP_URL", raising=False)
    _with_account(aws, tenant)
    seen = _fake_stripe(monkeypatch)
    status, _ = call("POST /platform/tenants/{tenantId}/stripe/account-link", {"tenantId": tenant})
    assert status == 200
    onboarding = seen[0]["use_case"]["account_onboarding"]
    assert onboarding["return_url"] == f"https://ops.example.se/tenants/{tenant}?stripe=return"
    assert onboarding["refresh_url"] == f"https://ops.example.se/tenants/{tenant}?stripe=refresh"


# --------------------------------------------------------------- 169, 197: newsletter
@pytest.fixture
def mail(aws, monkeypatch):
    monkeypatch.setenv("NO_REPLY_EMAIL_ADDRESS", "no-reply@booqy.se")
    monkeypatch.setenv("SUPPORT_EMAIL_ADDRESS", "support@ithjalparna.se")
    monkeypatch.delenv("MAIL_OUTBOX_BUCKET_NAME", raising=False)
    boto3.client("ses", region_name=REGION).verify_email_identity(EmailAddress="no-reply@booqy.se")


CREATED = "2026-11-16T10:00:00Z"
EMAILS = ["a@roma.se", "b@sushi.se", "c@thai.se"]


def _newsletter(aws, cursor=0):
    from app import mail as m
    from app.core import to_ddb
    row = {"PK": m.PK, "SK": f"{m.NEWSLETTER_PREFIX}{CREATED}#nl1", "newsletterId": "nl1", "subject": "S", "body": "B",
           "status": "sending", "createdAt": CREATED, "createdBy": OPERATOR,
           "recipients": [{"email": e, "tenantName": e, "status": "pending"} for e in EMAILS],
           "recipientCount": len(EMAILS), "sentCount": 0, "failedCount": 0, "cursor": cursor}
    aws["ddb"].put_item(TableName="dev-tenant", Item=to_ddb(row))


def _stored():
    from app import mail as m
    return m._find("nl1")


def test_newsletter_retry_resumes_after_the_last_sent_owner(mail, aws, monkeypatch):
    from app import mail as m
    monkeypatch.setattr(m, "SEND_PAUSE_S", 0)
    _newsletter(aws)
    sent_to = []

    def crash_on_second(to, *args):
        if to == EMAILS[1] and "crash" not in sent_to:
            sent_to.append("crash")
            raise RuntimeError("SES timed out")
        sent_to.append(to)

    monkeypatch.setattr(m, "_send_one", crash_on_second)
    event = {"mailTask": "send", "newsletterId": "nl1", "createdAt": CREATED}
    with pytest.raises(RuntimeError):
        m.mail_task(event, None)
    row = _stored()
    assert row["cursor"] == 1 and row["sentCount"] == 1 and row["status"] == "sending"
    assert [r["status"] for r in row["recipients"]] == ["sent", "pending", "pending"]

    # Lambda's async retry: starts after the first owner, who is not mailed again.
    assert m.mail_task(event, None) == {"status": "sent", "sent": 3, "failed": 0}
    assert sent_to == [EMAILS[0], "crash", EMAILS[1], EMAILS[2]]
    row = _stored()
    assert row["cursor"] == 3 and row["status"] == "sent" and row["finishedAt"]
    assert all(r["status"] == "sent" for r in row["recipients"])


def test_newsletter_stops_when_another_invocation_moved_on(mail, aws, monkeypatch):
    from app import mail as m
    monkeypatch.setattr(m, "SEND_PAUSE_S", 0)
    _newsletter(aws)
    sent_to = []

    def send_and_race(to, *args):
        sent_to.append(to)
        # A duplicate invocation saved this recipient first.
        aws["ddb"].update_item(TableName="dev-tenant", Key=m._newsletter_key("nl1", CREATED),
                               UpdateExpression="SET #c = :c", ExpressionAttributeNames={"#c": "cursor"},
                               ExpressionAttributeValues={":c": {"N": "1"}})

    monkeypatch.setattr(m, "_send_one", send_and_race)
    result = m.mail_task({"mailTask": "send", "newsletterId": "nl1", "createdAt": CREATED}, None)
    assert result == {"status": "superseded", "cursor": 0} and sent_to == [EMAILS[0]]


def test_newsletter_failure_logs_no_address(mail, aws, monkeypatch, caplog):
    from botocore.exceptions import ClientError
    from app import mail as m
    monkeypatch.setattr(m, "SEND_PAUSE_S", 0)
    _newsletter(aws, cursor=2)

    def reject(to, *args):
        raise ClientError({"Error": {"Code": "MessageRejected", "Message": f"Email address is not verified: {to}"}},
                          "SendRawEmail")

    monkeypatch.setattr(m, "_send_one", reject)
    with caplog.at_level(logging.INFO):
        result = m.mail_task({"mailTask": "send", "newsletterId": "nl1", "createdAt": CREATED}, None)
    assert result == {"status": "failed", "sent": 0, "failed": 1}
    assert caplog.records and not any("@" in r.getMessage() for r in caplog.records)
    row = _stored()
    # The address and the error stay on the newsletter row.
    assert row["recipients"][2]["status"] == "failed" and EMAILS[2] in row["recipients"][2]["error"]
    assert row["lastError"].startswith("MessageRejected") and row["failedCount"] == 1


# --------------------------------------------------------------- 170: operator audit
def _platform_audit(aws):
    rows = aws["ddb"].query(TableName="dev-tenant", KeyConditionExpression="PK = :pk AND begins_with(SK, :a)",
                            ExpressionAttributeValues={":pk": {"S": "TENANT#PLATFORM"}, ":a": {"S": "AUDIT#"}})["Items"]
    return [(r["action"]["S"], r["by"]["S"], r["details"]["M"]["target"]["S"]) for r in rows]


def test_operator_changes_are_audited(aws, monkeypatch, caplog):
    monkeypatch.setenv("OPERATOR_OWNER_GROUP_NAME", "platform_owner")
    status, body = call("POST /platform/operators", body={"email": "me@x.se", "name": "Me"})
    me = body["operator"]["username"]
    status, body = call("POST /platform/operators", body={"email": "other@x.se", "name": "Other"}, actor=me)
    other = body["operator"]["username"]
    path = {"username": other}
    with caplog.at_level(logging.INFO):
        assert call("PATCH /platform/operators/{username}", path, body={"email": "new@x.se"}, actor=me,
                    groups="[platform_admin,platform_owner]")[0] == 200
    assert not any("new@x.se" in r.getMessage() or "other@x.se" in r.getMessage() for r in caplog.records)
    assert call("PATCH /platform/operators/{username}", path, body={"enabled": False}, actor=me)[0] == 200
    assert call("PATCH /platform/operators/{username}", path, body={"enabled": True}, actor=me)[0] == 200
    assert call("POST /platform/operators/{username}/resend-invite", path, actor=me)[0] == 200
    assert call("DELETE /platform/operators/{username}", path, actor=me)[0] == 200
    audit = _platform_audit(aws)
    assert sorted(a for a, _, _ in audit) == sorted([
        "operator_created", "operator_created", "operator_email_changed", "operator_disabled", "operator_enabled",
        "operator_invite_resent", "operator_deleted"])
    assert ("operator_deleted", me, other) in audit and ("operator_created", me, other) in audit


# --------------------------------------------------------------- 200: start date
@pytest.mark.parametrize("start", ["2026-13-01", "next week", (date.today() + timedelta(days=400)).isoformat()])
def test_create_customer_rejects_a_bad_start_date_before_writing(aws, start):
    body = {**NEW_TENANT, "billing": {"startInvoicing": True, "startDate": start}}
    status, resp = call("POST /platform/tenants", body=body)
    assert status == 400 and "billing.startDate" in resp["fields"], resp
    assert call("GET /platform/tenants")[1]["tenants"] == []
