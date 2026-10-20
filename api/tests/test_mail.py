"""News to the restaurant owners: template, preview, test send, full send."""
import base64
import json

import boto3
import pytest

from conftest import NEW_TENANT, REGION, call

# A 1x1 transparent PNG.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
OPERATOR = "ops@booqy.se"
BUCKET = "dev-mail-outbox-mail"


@pytest.fixture
def mail(aws, monkeypatch):
    monkeypatch.setenv("NO_REPLY_EMAIL_ADDRESS", "no-reply@booqy.se")
    monkeypatch.setenv("SUPPORT_EMAIL_ADDRESS", "support@ithjalparna.se")
    monkeypatch.delenv("MAIL_OUTBOX_BUCKET_NAME", raising=False)
    ses = boto3.client("ses", region_name=REGION)
    ses.verify_email_identity(EmailAddress="no-reply@booqy.se")
    aws["idp"].admin_create_user(UserPoolId=aws["ops_pool"], Username=OPERATOR,
                                 UserAttributes=[{"Name": "email", "Value": OPERATOR}])
    return ses


def _activate(aws, tenant_id):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :a", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":a": {"S": "active"}})


def test_template_defaults_and_save(mail):
    status, body = call("GET /platform/mail/template")
    assert status == 200
    t = body["template"]
    assert t["senderName"] == "Booqy" and t["replyTo"] == "support@ithjalparna.se"
    assert t["logo"]["kind"] == "booqy" and t["logo"]["dataUrl"].startswith("data:image/png;base64,")
    assert t["from"] == "no-reply@booqy.se"

    data_url = "data:image/png;base64," + base64.b64encode(PNG).decode()
    status, body = call("PUT /platform/mail/template", body={
        "senderName": "IT-hjälparna", "replyTo": "Support@ithjalparna.se", "accentColor": "#1f5a46",
        "signature": "Hälsningar\nTeamet", "footer": "IT-hjälparna AB",
        "logo": {"kind": "custom", "dataUrl": data_url, "name": "logo.png"}}, actor=OPERATOR)
    assert status == 200, body
    t = body["template"]
    assert t["replyTo"] == "support@ithjalparna.se" and t["logo"]["kind"] == "custom"
    assert t["logo"]["dataUrl"] == data_url and t["updatedBy"] == OPERATOR

    # Saving again without a new file keeps the uploaded logo.
    status, body = call("PUT /platform/mail/template", body={
        "senderName": "IT-hjälparna", "replyTo": "support@ithjalparna.se", "accentColor": "#1f5a46",
        "logo": {"kind": "custom"}})
    assert status == 200 and body["template"]["logo"]["dataUrl"] == data_url

    status, body = call("PUT /platform/mail/template", body={
        "senderName": "", "replyTo": "nope", "accentColor": "red", "logo": {"kind": "custom", "dataUrl": "data:text/plain;base64,aGk="}})
    assert status == 400
    assert set(body["fields"]) == {"senderName", "replyTo", "accentColor", "logo"}


def test_preview_renders_blocks(mail):
    status, body = call("POST /platform/mail/preview", body={
        "subject": "Nyheter i oktober", "body": "Hej!\n\n# Nytt i Booqy\n\n- Bordsbokning i 3D\n- QR vid bordet\n\nLäs mer på https://booqy.se/nyheter **nu**."})
    assert status == 200
    html = body["html"]
    assert "<h1" in html and "Nyheter i oktober" in html
    assert "<li" in html and "Bordsbokning i 3D" in html
    assert '<a href="https://booqy.se/nyheter"' in html and "<strong>nu</strong>" in html
    assert 'src="data:image/png;base64,' in html
    assert "support@ithjalparna.se" in html
    assert "NYTT I BOOQY" in body["text"] and "- QR vid bordet" in body["text"]
    # Template fields passed along are used for the preview without being saved.
    status, body = call("POST /platform/mail/preview", body={"subject": "x", "body": "y", "template": {"accentColor": "#123456", "senderName": "Prov"}})
    assert status == 200 and "#123456" in body["html"] and 'alt="Prov"' in body["html"]
    assert call("GET /platform/mail/template")[1]["template"]["senderName"] == "Booqy"


def test_recipients_are_active_owners(mail, aws):
    status, body = call("POST /platform/tenants", body=NEW_TENANT)
    tenant_id = body["tenantId"]
    status, body = call("GET /platform/mail/recipients")
    assert body == {"count": 0, "recipients": []}
    _activate(aws, tenant_id)
    status, body = call("GET /platform/mail/recipients")
    assert body["count"] == 1 and body["recipients"][0]["email"] == "owner@roma.se"
    assert body["recipients"][0]["tenantName"] == "Pizzeria Roma"


def test_test_send_goes_to_the_operator(mail):
    status, body = call("POST /platform/mail/newsletters", body={"subject": "Test", "body": "Hej", "test": True}, actor=OPERATOR)
    assert status == 200, body
    assert body == {"test": True, "sentTo": OPERATOR}
    assert mail.get_send_quota()["SentLast24Hours"] > 0        # moto counts per recipient and part
    assert call("GET /platform/mail/newsletters")[1]["newsletters"] == []


def test_send_to_every_owner(mail, aws):
    status, body = call("POST /platform/mail/newsletters", body={"subject": "Nyheter", "body": "Hej alla"})
    assert status == 400 and body["error"] == "no_recipients"
    _, created = call("POST /platform/tenants", body=NEW_TENANT)
    _activate(aws, created["tenantId"])
    _, second = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "sushi", "name": "Sushi", "ownerEmail": "kenji@sushi.se"})
    _activate(aws, second["tenantId"])

    status, body = call("POST /platform/mail/newsletters", body={"subject": "Nyheter", "body": "Hej alla"}, actor=OPERATOR)
    assert status == 202, body
    n = body["newsletter"]
    assert n["status"] == "sent" and n["recipientCount"] == 2 and n["sentCount"] == 2 and n["failedCount"] == 0
    assert mail.get_send_quota()["SentLast24Hours"] > 0

    status, body = call("GET /platform/mail/newsletters")
    assert [x["subject"] for x in body["newsletters"]] == ["Nyheter"]
    status, body = call("GET /platform/mail/newsletters/{newsletterId}", path={"newsletterId": n["newsletterId"]})
    assert status == 200 and {r["email"] for r in body["recipients"]} == {"owner@roma.se", "kenji@sushi.se"}
    assert all(r["status"] == "sent" for r in body["recipients"])


def test_send_lands_in_the_dev_outbox(mail, aws, monkeypatch):
    s3 = boto3.client("s3", region_name=REGION)
    s3.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
    monkeypatch.setenv("MAIL_OUTBOX_BUCKET_NAME", BUCKET)
    status, body = call("POST /platform/mail/newsletters", body={"subject": "Test", "body": "Hej", "test": True}, actor=OPERATOR)
    assert status == 200, body
    keys = [o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET, Prefix="outbox/")["Contents"]]
    assert len(keys) == 1
    saved = json.loads(s3.get_object(Bucket=BUCKET, Key=keys[0])["Body"].read())
    assert saved["to"] == OPERATOR and saved["replyTo"] == ["support@ithjalparna.se"]
    assert saved["from"].endswith("<no-reply@booqy.se>") and "data:image/png;base64," in saved["html"]
    assert mail.get_send_quota()["SentLast24Hours"] == 0


def test_mail_task_event_resumes_a_send(mail, aws):
    from app.handler import handler
    _, created = call("POST /platform/tenants", body=NEW_TENANT)
    _activate(aws, created["tenantId"])
    # Create the row the way send() does, then run the task as the event the function hands itself.
    from app import mail as m
    from app.core import to_ddb
    row = {"PK": m.PK, "SK": f"{m.NEWSLETTER_PREFIX}2026-10-20T10:00:00Z#abc", "newsletterId": "abc",
           "subject": "S", "body": "B", "status": "sending", "createdAt": "2026-10-20T10:00:00Z", "createdBy": OPERATOR,
           "recipients": [{"email": "owner@roma.se", "tenantName": "Pizzeria Roma", "status": "pending"}],
           "recipientCount": 1, "sentCount": 0, "failedCount": 0, "cursor": 0}
    aws["ddb"].put_item(TableName="dev-tenant", Item=to_ddb(row))

    class Ctx:
        aws_request_id = "req-2"
        invoked_function_arn = "arn:aws:lambda:eu-north-1:123456789012:function:dev-platform-tenants:live"

        def get_remaining_time_in_millis(self):
            return 20_000

    result = handler({"mailTask": "send", "newsletterId": "abc", "createdAt": "2026-10-20T10:00:00Z"}, Ctx())
    assert result == {"status": "sent", "sent": 1, "failed": 0}
    status, body = call("GET /platform/mail/newsletters/{newsletterId}", path={"newsletterId": "abc"})
    assert body["newsletter"]["status"] == "sent" and body["newsletter"]["finishedAt"]
    # Running it again is a no-op.
    assert handler({"mailTask": "send", "newsletterId": "abc", "createdAt": "2026-10-20T10:00:00Z"}, Ctx()) == {"status": "skipped"}
