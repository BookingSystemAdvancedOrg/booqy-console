import json

import boto3
import pytest

from conftest import REGION, call

BUCKET = "dev-mail-outbox-test"


@pytest.fixture
def outbox(aws, monkeypatch):
    s3 = boto3.client("s3", region_name=REGION)
    s3.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
    monkeypatch.setenv("MAIL_OUTBOX_BUCKET_NAME", BUCKET)

    def put(message_id, **message):
        s3.put_object(Bucket=BUCKET, Key=f"outbox/{message_id}.json",
                      Body=json.dumps({"id": message_id, **message}).encode())
    return put


def ids(n):
    # Smaller inverted timestamp = newer message.
    return [f"{1000000000000 + i:013d}-{i:012x}" for i in range(n)]


def test_off_when_no_bucket(aws, monkeypatch):
    monkeypatch.delenv("MAIL_OUTBOX_BUCKET_NAME", raising=False)
    status, body = call("GET /platform/outbox")
    assert status == 200 and body == {"enabled": False, "messages": []}
    status, _ = call("GET /platform/outbox/{messageId}", {"messageId": ids(1)[0]})
    assert status == 404


def test_never_on_in_prod(outbox, monkeypatch):
    outbox(ids(1)[0], channel="email", subject="x")
    monkeypatch.setenv("ENVIRONMENT", "prod")
    status, body = call("GET /platform/outbox")
    assert body["enabled"] is False


def test_lists_newest_first_with_paging(outbox):
    a, b, c = ids(3)
    outbox(a, channel="email", to="anna@example.se", subject="Kvitto", text="t", html="<p>t</p>", at="2026-10-13T10:02:00Z")
    outbox(b, channel="sms", to="+46701234567", text="Roma: din mat är klar", at="2026-10-13T10:01:00Z")
    outbox(c, channel="email", to="x@example.se", subject="Äldst", at="2026-10-13T10:00:00Z")

    status, body = call("GET /platform/outbox", query={"limit": "2"})
    assert status == 200 and body["enabled"] is True
    assert [m["id"] for m in body["messages"]] == [a, b]
    assert body["messages"][0] == {"id": a, "at": "2026-10-13T10:02:00Z", "channel": "email",
                                   "to": "anna@example.se", "subject": "Kvitto"}
    assert body["messages"][1]["subject"] == "Roma: din mat är klar"
    assert body["next"] == b

    status, body = call("GET /platform/outbox", query={"after": b})
    assert [m["id"] for m in body["messages"]] == [c] and body["next"] is None


def test_reads_one_message(outbox):
    (a,) = ids(1)
    outbox(a, channel="email", subject="Offert", html="<h1>Offert</h1>")
    status, body = call("GET /platform/outbox/{messageId}", {"messageId": a})
    assert status == 200 and body["message"]["html"] == "<h1>Offert</h1>"


def test_rejects_bad_ids_and_unknown(outbox):
    assert call("GET /platform/outbox/{messageId}", {"messageId": "../secret"})[0] == 404
    assert call("GET /platform/outbox/{messageId}", {"messageId": ids(1)[0]})[0] == 404
    assert call("GET /platform/outbox", query={"after": "x/../y"})[0] == 400


def test_operators_only(outbox):
    assert call("GET /platform/outbox", groups="[owner_user]")[0] == 403
