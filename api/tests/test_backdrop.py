"""The operator's background image library (app/backdrop.py): presigned POST
with strict input, complete (check, thumbnail, item), the cap, list newest
first, selection, delete, migration of the first version's single image,
keys from the token only, and deletion with the operator."""

import base64
import io
import json
from datetime import datetime, timezone
from urllib.parse import urlsplit

import boto3
import pytest
from botocore.exceptions import ClientError
from PIL import Image

from conftest import REGION, call

BUCKET = "dev-user-backdrops"
TABLE = "dev-user-backdrops-table"
MAX = 10 * 1024 * 1024
ME = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-8888-7777-6666-555555555555"
PREFIX = f"console/{ME}/"


def image_bytes(fmt="JPEG", size=(1200, 800)):
    out = io.BytesIO()
    Image.new("RGB", size, (60, 10, 10)).save(out, fmt)
    return out.getvalue()


@pytest.fixture
def s3(aws, monkeypatch):
    monkeypatch.setenv("USER_BACKDROPS_BUCKET", BUCKET)
    monkeypatch.setenv("USER_BACKDROPS_TABLE_NAME", TABLE)
    client = boto3.client("s3", region_name=REGION)
    client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
    boto3.client("dynamodb", region_name=REGION).create_table(
        TableName=TABLE, BillingMode="PAY_PER_REQUEST",
        KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
        AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"},
                              {"AttributeName": "SK", "AttributeType": "S"}])
    return client


def keys(s3, prefix=""):
    return sorted(o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix).get("Contents", []))


def upload(s3, data=None, content_type="image/jpeg", sub=ME):
    data = image_bytes() if data is None else data
    status, body = call("POST /platform/me/backdrops/upload",
                        body={"contentType": content_type, "size": len(data), "width": 1200, "height": 800}, sub=sub)
    assert status == 200, body
    s3.put_object(Bucket=BUCKET, Key=body["fields"]["key"], Body=data, ContentType=content_type)
    return body["id"]


def add(s3, data=None, content_type="image/jpeg", sub=ME):
    image_id = upload(s3, data, content_type, sub)
    status, body = call("POST /platform/me/backdrops/{id}/complete", {"id": image_id}, sub=sub)
    assert status == 200, body
    return body["item"]


def test_empty_library(s3):
    assert call("GET /platform/me/backdrops", sub=ME) == (200, {"items": [], "selectedId": None, "max": 20})


def test_upload_is_a_presigned_post_bound_to_key_type_and_size(s3):
    status, body = call("POST /platform/me/backdrops/upload",
                        body={"contentType": "image/webp", "size": 5000, "width": 10, "height": 10}, sub=ME)
    assert status == 200 and set(body) == {"id", "url", "fields"}
    assert body["url"] == f"https://{BUCKET}.s3.{REGION}.amazonaws.com/"
    key = f"{PREFIX}backdrops/{body['id']}"
    assert body["fields"]["key"] == key and body["fields"]["Content-Type"] == "image/webp"
    policy = json.loads(base64.b64decode(body["fields"]["policy"]))
    assert {"Content-Type": "image/webp"} in policy["conditions"]
    assert ["content-length-range", 1, MAX] in policy["conditions"]
    assert {"key": key} in policy["conditions"]
    expires = datetime.strptime(policy["expiration"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert 0 < (expires - datetime.now(timezone.utc)).total_seconds() <= 300


@pytest.mark.parametrize("body, field", [
    ({"contentType": "image/gif", "size": 10, "width": 1, "height": 1}, "contentType"),
    ({"contentType": "image/png", "width": 1, "height": 1}, "size"),
    ({"contentType": "image/png", "size": MAX + 1, "width": 1, "height": 1}, "size"),
    ({"contentType": "image/png", "size": 1.5, "width": 1, "height": 1}, "size"),
    ({"contentType": "image/png", "size": True, "width": 1, "height": 1}, "size"),
    ({"contentType": "image/png", "size": 1, "height": 1}, "width"),
    ({"contentType": "image/png", "size": 1, "width": 1, "height": 0}, "height"),
    ({"contentType": "image/png", "size": 1, "width": 1, "height": 1, "key": "x"}, "key"),
])
def test_upload_rejects_bad_input(s3, body, field):
    status, error = call("POST /platform/me/backdrops/upload", body=body, sub=ME)
    assert status == 400 and error["error"] == "validation_failed" and field in error["fields"]


def test_complete_makes_a_thumbnail_and_the_item(s3):
    item = add(s3, image_bytes("PNG", (1600, 900)), "image/png")
    assert set(item) == {"id", "url", "thumbUrl", "uploadedAt", "width", "height"}
    assert (item["width"], item["height"]) == (1600, 900)
    assert urlsplit(item["url"]).path == f"/{PREFIX}backdrops/{item['id']}"
    assert urlsplit(item["thumbUrl"]).path == f"/{PREFIX}backdrops/{item['id']}.thumb.webp"
    assert "X-Amz-Expires=3600" in item["url"]
    thumb = s3.get_object(Bucket=BUCKET, Key=f"{PREFIX}backdrops/{item['id']}.thumb.webp")
    with Image.open(io.BytesIO(thumb["Body"].read())) as img:
        assert img.format == "WEBP" and img.size == (400, 225)


def test_complete_of_missing_or_broken_uploads(s3):
    status, body = call("POST /platform/me/backdrops/upload",
                        body={"contentType": "image/png", "size": 10, "width": 1, "height": 1}, sub=ME)
    assert call("POST /platform/me/backdrops/{id}/complete", {"id": body["id"]}, sub=ME) == \
        (400, {"error": "upload_missing"})
    image_id = upload(s3, b"not an image", "image/png")
    assert call("POST /platform/me/backdrops/{id}/complete", {"id": image_id}, sub=ME) == \
        (400, {"error": "not_an_image"})
    assert keys(s3) == []
    assert call("POST /platform/me/backdrops/{id}/complete", {"id": "../x"}, sub=ME)[0] == 404


def test_list_newest_first_select_and_delete(s3):
    a, b = add(s3), add(s3)
    add(s3, sub=OTHER)
    body = call("GET /platform/me/backdrops", sub=ME)[1]
    assert [i["id"] for i in body["items"]] == [b["id"], a["id"]] and body["selectedId"] is None
    assert call("PUT /platform/me/backdrops/selected", body={"id": a["id"]}, sub=ME) == (200, {"selectedId": a["id"]})
    other_id = call("GET /platform/me/backdrops", sub=OTHER)[1]["items"][0]["id"]
    assert call("PUT /platform/me/backdrops/selected", body={"id": other_id}, sub=ME)[0] == 404
    assert call("PUT /platform/me/backdrops/selected", body={}, sub=ME)[0] == 400
    assert call("DELETE /platform/me/backdrops/{id}", {"id": a["id"]}, sub=ME) == (204, None)
    assert call("DELETE /platform/me/backdrops/{id}", {"id": a["id"]}, sub=ME) == (204, None)
    body = call("GET /platform/me/backdrops", sub=ME)[1]
    assert [i["id"] for i in body["items"]] == [b["id"]] and body["selectedId"] is None
    assert keys(s3, PREFIX) == [f"{PREFIX}backdrops/{b['id']}", f"{PREFIX}backdrops/{b['id']}.thumb.webp"]
    assert call("PUT /platform/me/backdrops/selected", body={"id": None}, sub=ME) == (200, {"selectedId": None})


def test_limit(s3, monkeypatch):
    from app import backdrop
    monkeypatch.setattr(backdrop, "MAX_ITEMS", 1)
    pending = upload(s3)
    add(s3)
    status, body = call("POST /platform/me/backdrops/upload",
                        body={"contentType": "image/jpeg", "size": 10, "width": 1, "height": 1}, sub=ME)
    assert (status, body) == (409, {"error": "limit_reached", "max": 1})
    assert call("POST /platform/me/backdrops/{id}/complete", {"id": pending}, sub=ME) == \
        (409, {"error": "limit_reached", "max": 1})


def test_first_version_image_moves_into_the_library(s3):
    s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}backdrop", Body=image_bytes("PNG", (800, 600)), ContentType="image/png")
    body = call("GET /platform/me/backdrops", sub=ME)[1]
    assert len(body["items"]) == 1 and body["selectedId"] == body["items"][0]["id"]
    assert f"{PREFIX}backdrop" not in keys(s3)
    s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}backdrop", Body=image_bytes(), ContentType="image/jpeg")
    assert len(call("GET /platform/me/backdrops", sub=ME)[1]["items"]) == 1   # once only


def test_missing_object_answering_403_reads_as_missing(s3, monkeypatch):
    from app import backdrop

    class Denied:
        def head_object(self, **kwargs):
            raise ClientError({"Error": {"Code": "403", "Message": "Forbidden"}}, "HeadObject")
    monkeypatch.setattr(backdrop, "_s3", lambda: Denied())
    assert call("GET /platform/me/backdrops", sub=ME) == (200, {"items": [], "selectedId": None, "max": 20})


def test_token_without_a_usable_sub_is_refused(s3):
    assert call("GET /platform/me/backdrops")[0] == 403
    assert call("GET /platform/me/backdrops", sub="../x")[0] == 403


def test_requires_operator_group(s3):
    assert call("GET /platform/me/backdrops", groups="[owner_user]", sub=ME)[0] == 403


def test_not_configured_is_409(aws, monkeypatch):
    monkeypatch.delenv("USER_BACKDROPS_BUCKET", raising=False)
    status, body = call("GET /platform/me/backdrops", sub=ME)
    assert status == 409 and body["error"] == "backdrops_not_configured"


def test_old_single_image_routes_are_gone(s3):
    assert call("GET /platform/me/backdrop", sub=ME)[0] == 404


def test_deleting_an_operator_deletes_their_library(s3):
    me = call("POST /platform/operators", body={"email": "me@x.se", "name": "Me"})[1]["operator"]["username"]
    other = call("POST /platform/operators", body={"email": "other@x.se", "name": "Other"})[1]["operator"]["username"]
    from app.core import client
    from app.operators import _attrs, _pool
    other_sub = _attrs(client("cognito-idp").admin_get_user(UserPoolId=_pool(), Username=other))["sub"]
    add(s3, sub=other_sub)
    kept = add(s3, sub=ME)
    s3.put_object(Bucket=BUCKET, Key=f"console/{other_sub}/backdrop", Body=b"old")
    assert call("DELETE /platform/operators/{username}", {"username": other}, actor=me)[0] == 200
    assert keys(s3) == [f"{PREFIX}backdrops/{kept['id']}", f"{PREFIX}backdrops/{kept['id']}.thumb.webp"]
    rows = boto3.resource("dynamodb", region_name=REGION).Table(TABLE).scan()["Items"]
    assert {r["PK"] for r in rows} == {f"OPERATOR#{ME}"}
