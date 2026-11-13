"""Operator profile pictures (app/avatar.py): presigned POST to the staging
key, complete (decode, centre square, 256x256 WebP, staging deleted), GET,
DELETE, avatarUrl on the operator list, and deletion with the operator."""

import base64
import io
import json
from urllib.parse import urlsplit

import boto3
import pytest
from PIL import Image

from conftest import REGION, call

BUCKET = "dev-user-backdrops"
ME = "11111111-2222-3333-4444-555555555555"
MAX = 5 * 1024 * 1024


def image_bytes(fmt="PNG", size=(600, 400)):
    out = io.BytesIO()
    Image.new("RGB", size, (60, 10, 10)).save(out, fmt)
    return out.getvalue()


@pytest.fixture
def s3(aws, monkeypatch):
    monkeypatch.setenv("USER_BACKDROPS_BUCKET", BUCKET)
    client = boto3.client("s3", region_name=REGION)
    client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
    return client


def keys(s3):
    return sorted(o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET).get("Contents", []))


def stage(s3, data, sub=ME, content_type="image/png"):
    status, body = call("POST /platform/me/avatar/upload", body={"contentType": content_type, "size": len(data)},
                        sub=sub)
    assert status == 200, body
    s3.put_object(Bucket=BUCKET, Key=body["fields"]["key"], Body=data, ContentType=content_type)
    return body


def test_none_yet(s3):
    assert call("GET /platform/me/avatar", sub=ME) == (200, {"url": None})


def test_upload_is_a_presigned_post_to_the_staging_key(s3):
    status, body = call("POST /platform/me/avatar/upload", body={"contentType": "image/jpeg", "size": 1000}, sub=ME)
    assert status == 200 and set(body) == {"url", "fields"}
    assert body["url"] == f"https://{BUCKET}.s3.{REGION}.amazonaws.com/"
    assert body["fields"]["key"] == f"console/{ME}/avatar.upload"
    policy = json.loads(base64.b64decode(body["fields"]["policy"]))
    assert {"Content-Type": "image/jpeg"} in policy["conditions"]
    assert ["content-length-range", 1, MAX] in policy["conditions"]


@pytest.mark.parametrize("body, field", [
    ({"contentType": "image/gif", "size": 10}, "contentType"),
    ({"contentType": "image/png", "size": MAX + 1}, "size"),
    ({"contentType": "image/png"}, "size"),
    ({"contentType": "image/png", "size": 1, "x": 1}, "x"),
])
def test_upload_rejects_bad_input(s3, body, field):
    status, error = call("POST /platform/me/avatar/upload", body=body, sub=ME)
    assert status == 400 and field in error["fields"]


def test_complete_makes_a_256_square_webp_and_removes_the_staging_object(s3):
    stage(s3, image_bytes("PNG", (600, 400)))
    status, body = call("POST /platform/me/avatar/complete", sub=ME)
    assert status == 200 and urlsplit(body["url"]).path == f"/console/{ME}/avatar.webp"
    assert keys(s3) == [f"console/{ME}/avatar.webp"]
    obj = s3.get_object(Bucket=BUCKET, Key=f"console/{ME}/avatar.webp")
    assert obj["ContentType"] == "image/webp"
    with Image.open(io.BytesIO(obj["Body"].read())) as img:
        assert img.format == "WEBP" and img.size == (256, 256)
    url = call("GET /platform/me/avatar", sub=ME)[1]["url"]
    assert "X-Amz-Expires=3600" in url


def test_complete_without_upload_or_with_junk(s3):
    assert call("POST /platform/me/avatar/complete", sub=ME) == (400, {"error": "upload_missing"})
    stage(s3, b"junk")
    assert call("POST /platform/me/avatar/complete", sub=ME) == (400, {"error": "not_an_image"})
    assert keys(s3) == []


def test_delete(s3):
    stage(s3, image_bytes())
    call("POST /platform/me/avatar/complete", sub=ME)
    stage(s3, image_bytes())
    assert call("DELETE /platform/me/avatar", sub=ME) == (204, None)
    assert call("DELETE /platform/me/avatar", sub=ME) == (204, None)
    assert keys(s3) == []


def test_token_without_a_usable_sub_is_refused(s3):
    assert call("GET /platform/me/avatar")[0] == 403
    assert call("POST /platform/me/avatar/complete", sub="../x")[0] == 403


def test_operator_list_carries_avatar_urls_and_deletion_removes_them(s3):
    me = call("POST /platform/operators", body={"email": "me@x.se", "name": "Me"})[1]["operator"]["username"]
    other = call("POST /platform/operators", body={"email": "other@x.se", "name": "Other"})[1]["operator"]["username"]
    from app.core import client
    from app.operators import _attrs, _pool
    other_sub = _attrs(client("cognito-idp").admin_get_user(UserPoolId=_pool(), Username=other))["sub"]
    stage(s3, image_bytes(), sub=other_sub)
    assert call("POST /platform/me/avatar/complete", sub=other_sub)[0] == 200
    listed = {o["email"]: o for o in call("GET /platform/operators")[1]["operators"]}
    assert listed["me@x.se"]["avatarUrl"] is None
    assert urlsplit(listed["other@x.se"]["avatarUrl"]).path == f"/console/{other_sub}/avatar.webp"
    s3.put_object(Bucket=BUCKET, Key=f"console/{other_sub}/avatar.upload", Body=b"x")
    assert call("DELETE /platform/operators/{username}", {"username": other}, actor=me)[0] == 200
    assert keys(s3) == []


def test_operator_list_without_bucket_has_null_avatars(aws, monkeypatch):
    monkeypatch.delenv("USER_BACKDROPS_BUCKET", raising=False)
    call("POST /platform/operators", body={"email": "me@x.se", "name": "Me"})
    assert [o["avatarUrl"] for o in call("GET /platform/operators")[1]["operators"]] == [None]
