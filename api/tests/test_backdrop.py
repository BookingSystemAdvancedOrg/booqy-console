"""The operator's own background image (app/backdrop.py): presigned POST with
strict input, GET answering a presigned URL or nulls, DELETE (204,
idempotent), keys from the token only, and deletion with the operator."""

import base64
import json
from datetime import datetime, timezone
from urllib.parse import urlsplit

import boto3
import pytest
from botocore.exceptions import ClientError

from conftest import REGION, call

BUCKET = "dev-user-backdrops"
MAX = 10 * 1024 * 1024
ME = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-8888-7777-6666-555555555555"


@pytest.fixture
def s3(aws, monkeypatch):
    monkeypatch.setenv("USER_BACKDROPS_BUCKET", BUCKET)
    client = boto3.client("s3", region_name=REGION)
    client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
    return client


def keys(s3):
    return sorted(o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET).get("Contents", []))


def test_get_without_an_image_answers_nulls(s3):
    assert call("GET /platform/me/backdrop", sub=ME) == (200, {"url": None, "updatedAt": None})


def test_get_answers_a_one_hour_presigned_url_of_the_own_key(s3):
    s3.put_object(Bucket=BUCKET, Key=f"console/{ME}/backdrop", Body=b"img", ContentType="image/webp")
    status, body = call("GET /platform/me/backdrop", sub=ME)
    assert status == 200
    url = urlsplit(body["url"])
    assert url.netloc == f"{BUCKET}.s3.{REGION}.amazonaws.com"
    assert url.path == f"/console/{ME}/backdrop"
    assert "X-Amz-Expires=3600" in url.query
    datetime.fromisoformat(body["updatedAt"].replace("Z", "+00:00"))
    assert call("GET /platform/me/backdrop", sub=OTHER)[1]["url"] is None


def test_upload_is_a_presigned_post_bound_to_key_type_and_size(s3):
    status, body = call("POST /platform/me/backdrop/upload", body={"contentType": "image/jpeg", "size": 5000}, sub=ME)
    assert status == 200 and set(body) == {"url", "fields"}
    assert body["url"] == f"https://{BUCKET}.s3.{REGION}.amazonaws.com/"
    fields = body["fields"]
    assert fields["key"] == f"console/{ME}/backdrop" and fields["Content-Type"] == "image/jpeg"
    policy = json.loads(base64.b64decode(fields["policy"]))
    assert {"Content-Type": "image/jpeg"} in policy["conditions"]
    assert ["content-length-range", 1, MAX] in policy["conditions"]
    assert {"key": f"console/{ME}/backdrop"} in policy["conditions"]
    expires = datetime.strptime(policy["expiration"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert 0 < (expires - datetime.now(timezone.utc)).total_seconds() <= 300


@pytest.mark.parametrize("body, field", [
    ({"contentType": "image/gif", "size": 10}, "contentType"),
    ({"size": 10}, "contentType"),
    ({"contentType": "image/png"}, "size"),
    ({"contentType": "image/png", "size": MAX + 1}, "size"),
    ({"contentType": "image/png", "size": 0}, "size"),
    ({"contentType": "image/png", "size": 1.5}, "size"),
    ({"contentType": "image/png", "size": True}, "size"),
    ({"contentType": "image/png", "size": 1, "key": "x"}, "key"),
])
def test_upload_rejects_bad_input(s3, body, field):
    status, error = call("POST /platform/me/backdrop/upload", body=body, sub=ME)
    assert status == 400 and error["error"] == "validation_failed" and field in error["fields"]


def test_delete_is_204_idempotent_and_only_the_own_image(s3):
    for sub in (ME, OTHER):
        s3.put_object(Bucket=BUCKET, Key=f"console/{sub}/backdrop", Body=b"img")
    assert call("DELETE /platform/me/backdrop", sub=ME) == (204, None)
    assert call("DELETE /platform/me/backdrop", sub=ME) == (204, None)
    assert keys(s3) == [f"console/{OTHER}/backdrop"]


def test_missing_object_answering_403_reads_as_no_image(s3, monkeypatch):
    from app import backdrop

    class Denied:
        def head_object(self, **kwargs):
            raise ClientError({"Error": {"Code": "403", "Message": "Forbidden"}}, "HeadObject")
    monkeypatch.setattr(backdrop, "_s3", lambda: Denied())
    assert call("GET /platform/me/backdrop", sub=ME) == (200, {"url": None, "updatedAt": None})


def test_token_without_a_usable_sub_is_refused(s3):
    assert call("GET /platform/me/backdrop")[0] == 403
    assert call("POST /platform/me/backdrop/upload", body={"contentType": "image/png", "size": 1},
                sub="../x")[0] == 403


def test_requires_operator_group(s3):
    assert call("GET /platform/me/backdrop", groups="[owner_user]", sub=ME)[0] == 403


def test_not_configured_is_409(aws, monkeypatch):
    monkeypatch.delenv("USER_BACKDROPS_BUCKET", raising=False)
    status, body = call("GET /platform/me/backdrop", sub=ME)
    assert status == 409 and body["error"] == "backdrops_not_configured"


def test_deleting_an_operator_deletes_their_image(s3):
    me = call("POST /platform/operators", body={"email": "me@x.se", "name": "Me"})[1]["operator"]["username"]
    other = call("POST /platform/operators", body={"email": "other@x.se", "name": "Other"})[1]["operator"]["username"]
    from app.core import client
    from app.operators import _attrs, _pool
    other_sub = _attrs(client("cognito-idp").admin_get_user(UserPoolId=_pool(), Username=other))["sub"]
    s3.put_object(Bucket=BUCKET, Key=f"console/{other_sub}/backdrop", Body=b"img")
    s3.put_object(Bucket=BUCKET, Key=f"console/{ME}/backdrop", Body=b"img")
    assert call("DELETE /platform/operators/{username}", {"username": other}, actor=me)[0] == 200
    assert keys(s3) == [f"console/{ME}/backdrop"]
