"""The signed-in operator's background image library (the selected image is
shown blurred behind the console's glass UI, on every device), at most
MAX_ITEMS images. Same contract as the admin app's /me/backdrops
(application functions/user-backdrop):

    GET    /platform/me/backdrops                -> {items, selectedId, max}
    POST   /platform/me/backdrops/upload         {contentType, size, width, height} -> {id, url, fields}
    POST   /platform/me/backdrops/{id}/complete  -> {item}
    PUT    /platform/me/backdrops/selected       {id | null} -> {selectedId}
    DELETE /platform/me/backdrops/{id}           -> 204

Images at console/<sub>/backdrops/<id> (+ <id>.thumb.webp, a ~400 px WebP
made here with Pillow) in the user-backdrops bucket (USER_BACKDROPS_BUCKET);
items in the user-backdrops table (USER_BACKDROPS_TABLE_NAME): PK
OPERATOR#<sub>, SK IMG#<id> (ids sort by upload time) or SELECTED
(selectedId, legacyChecked). The browser uploads with a presigned POST
(exact key, Content-Type, 1 B to 10 MB, 300 s), then calls complete.
The first version kept one image at console/<sub>/backdrop: the first GET
moves it into the library (selected). The role has no ListBucket on
HeadObject paths, so a missing object answers 403: read as missing.
Deleted with the operator (operators.delete_operator -> delete_all)."""

import io
import re
import secrets
import time
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config
from botocore.exceptions import ClientError
from PIL import Image, ImageOps, UnidentifiedImageError

from .core import ApiError, env, log, regional_client

MAX_ITEMS = 20
CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
MAX_BYTES = 10 * 1024 * 1024
MAX_SIDE = 20000
THUMB_WIDTH = 400
UPLOAD_EXPIRES_SECONDS = 300
VIEW_EXPIRES_SECONDS = 3600
# Pillow refuses images above twice this (decompression bombs).
Image.MAX_IMAGE_PIXELS = 60_000_000

_SAFE_SUB = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_IMAGE_ID = re.compile(r"^[0-9a-f]{26}$")
_MISSING = frozenset({"404", "NoSuchKey", "NotFound", "403", "AccessDenied", "Forbidden"})
_NOT_FOUND = (404, {"error": "not_found"})


def _s3():
    region = env("AWS_REGION", env("AWS_DEFAULT_REGION", "eu-north-1"))
    return regional_client("s3", region, endpoint_url=f"https://s3.{region}.amazonaws.com",
                           config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


def _bucket() -> str:
    bucket = env("USER_BACKDROPS_BUCKET", "")
    if not bucket or not env("USER_BACKDROPS_TABLE_NAME", ""):
        raise ApiError(409, "backdrops_not_configured", "Background images aren't set up in this environment")
    return bucket


def _table():
    region = env("AWS_REGION", env("AWS_DEFAULT_REGION", "eu-north-1"))
    return boto3.resource("dynamodb", region_name=region).Table(env("USER_BACKDROPS_TABLE_NAME"))


class _Owner:
    def __init__(self, sub: str):
        self.pk = f"OPERATOR#{sub}"
        self.prefix = f"console/{sub}/"

    @property
    def legacy_key(self):
        return self.prefix + "backdrop"

    def image_key(self, image_id):
        return f"{self.prefix}backdrops/{image_id}"

    def thumb_key(self, image_id):
        return f"{self.prefix}backdrops/{image_id}.thumb.webp"


def _owner(req) -> _Owner:
    _bucket()
    sub = (req.claims or {}).get("sub")
    if not isinstance(sub, str) or not _SAFE_SUB.match(sub):
        raise ApiError(403, "forbidden", "Platform operators only")
    return _Owner(sub)


def new_id() -> str:
    """26 lowercase hex characters: milliseconds since 1970, then random."""
    return f"{int(time.time() * 1000):012x}{secrets.token_hex(7)}"


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def make_thumbnail(data: bytes):
    """(width, height, WebP thumbnail bytes) of a JPEG, PNG or WebP image,
    width/height as displayed (EXIF orientation applied). ValueError when it
    isn't one."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format not in _FORMATS:
                raise ValueError("not_an_image")
            width, height = img.size
            if img.getexif().get(0x0112, 1) in (5, 6, 7, 8):
                width, height = height, width
            img.draft("RGB", (THUMB_WIDTH * 2, THUMB_WIDTH * 2))
            shown = ImageOps.exif_transpose(img)
            shown = shown.convert("RGBA" if "A" in shown.getbands() else "RGB")
            if shown.width > THUMB_WIDTH:
                shown = shown.resize((THUMB_WIDTH, max(1, round(shown.height * THUMB_WIDTH / shown.width))),
                                     Image.Resampling.LANCZOS)
            out = io.BytesIO()
            shown.save(out, "WEBP", quality=80, method=4)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError, EOFError) as e:
        raise ValueError("not_an_image") from e
    return int(width), int(height), out.getvalue()


# ---------------------------------------------------------------------- store
def _query(pk: str) -> list[dict]:
    items, kwargs = [], {"KeyConditionExpression": Key("PK").eq(pk)}
    while True:
        page = _table().query(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _load(owner):
    items = _query(owner.pk)
    images = sorted((i for i in items if i["SK"].startswith("IMG#")), key=lambda i: i["SK"], reverse=True)
    return images, next((i for i in items if i["SK"] == "SELECTED"), {})


def _view(item):
    def link(key):
        return _s3().generate_presigned_url("get_object", Params={"Bucket": _bucket(), "Key": key},
                                            ExpiresIn=VIEW_EXPIRES_SECONDS)

    return {"id": item["id"], "url": link(item["key"]), "thumbUrl": link(item["thumbKey"]),
            "uploadedAt": item["uploadedAt"], "width": int(item["width"]), "height": int(item["height"])}


def _delete_objects(*keys):
    for key in keys:
        _s3().delete_object(Bucket=_bucket(), Key=key)


def _head(key):
    try:
        return _s3().head_object(Bucket=_bucket(), Key=key)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in _MISSING:
            return None
        raise


def _store(owner, image_id, content_type, size, width, height, thumb):
    _s3().put_object(Bucket=_bucket(), Key=owner.thumb_key(image_id), Body=thumb, ContentType="image/webp")
    item = {"PK": owner.pk, "SK": f"IMG#{image_id}", "id": image_id, "key": owner.image_key(image_id),
            "thumbKey": owner.thumb_key(image_id), "uploadedAt": _now(), "width": width, "height": height,
            "contentType": content_type, "size": size}
    try:
        _table().put_item(Item=item, ConditionExpression="attribute_not_exists(PK)")
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        item = _table().get_item(Key={"PK": owner.pk, "SK": f"IMG#{image_id}"}).get("Item") or item
    return item


def _set_selected(owner, selected_id, legacy_checked=None):
    expr, values = "SET selectedId = :s", {":s": selected_id}
    if legacy_checked is not None:
        expr += ", legacyChecked = :l"
        values[":l"] = legacy_checked
    _table().update_item(Key={"PK": owner.pk, "SK": "SELECTED"}, UpdateExpression=expr,
                         ExpressionAttributeValues=values)


def _migrate_legacy(owner, images, selected):
    selected_id = selected.get("selectedId")
    head = _head(owner.legacy_key)
    if head is not None:
        data = _s3().get_object(Bucket=_bucket(), Key=owner.legacy_key)["Body"].read()
        try:
            width, height, thumb = make_thumbnail(data)
        except ValueError:
            thumb = None
        if thumb is not None and len(images) < MAX_ITEMS:
            image_id = new_id()
            content_type = head.get("ContentType") if head.get("ContentType") in CONTENT_TYPES else "image/jpeg"
            _s3().put_object(Bucket=_bucket(), Key=owner.image_key(image_id), Body=data, ContentType=content_type)
            _store(owner, image_id, content_type, len(data), width, height, thumb)
            selected_id = image_id
        _delete_objects(owner.legacy_key)
    _set_selected(owner, selected_id, legacy_checked=True)


# --------------------------------------------------------------------- routes
def list_backdrops(req):
    owner = _owner(req)
    images, selected = _load(owner)
    if not selected.get("legacyChecked"):
        _migrate_legacy(owner, images, selected)
        images, selected = _load(owner)
    ids = {i["id"] for i in images}
    selected_id = selected.get("selectedId") if selected.get("selectedId") in ids else None
    return 200, {"items": [_view(i) for i in images], "selectedId": selected_id, "max": MAX_ITEMS}


def create_upload(req):
    owner = _owner(req)
    body = req.body or {}
    errors = {k: "Unknown field" for k in sorted(set(body) - {"contentType", "size", "width", "height"})}
    content_type = body.get("contentType")
    content_type = content_type.strip().lower() if isinstance(content_type, str) else ""
    if content_type not in CONTENT_TYPES:
        errors["contentType"] = "image/jpeg, image/png or image/webp"
    for name, high, msg in (("size", MAX_BYTES, f"Whole bytes, 1 to {MAX_BYTES} (10 MB)"),
                            ("width", MAX_SIDE, f"Whole pixels, 1 to {MAX_SIDE}"),
                            ("height", MAX_SIDE, f"Whole pixels, 1 to {MAX_SIDE}")):
        value = body.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= high:
            errors[name] = msg
    if errors:
        raise ApiError(400, "validation_failed", "Some fields are invalid", fields=errors)
    images, _ = _load(owner)
    if len(images) >= MAX_ITEMS:
        return 409, {"error": "limit_reached", "max": MAX_ITEMS}
    image_id = new_id()
    post = _s3().generate_presigned_post(
        Bucket=_bucket(), Key=owner.image_key(image_id), Fields={"Content-Type": content_type},
        Conditions=[{"Content-Type": content_type}, ["content-length-range", 1, MAX_BYTES]],
        ExpiresIn=UPLOAD_EXPIRES_SECONDS)
    return 200, {"id": image_id, "url": post["url"], "fields": post["fields"]}


def complete_upload(req):
    owner = _owner(req)
    image_id = req.path.get("id")
    if not isinstance(image_id, str) or not _IMAGE_ID.match(image_id):
        return _NOT_FOUND
    existing = _table().get_item(Key={"PK": owner.pk, "SK": f"IMG#{image_id}"}).get("Item")
    if existing:
        return 200, {"item": _view(existing)}
    key = owner.image_key(image_id)
    head = _head(key)
    if head is None:
        return 400, {"error": "upload_missing"}
    content_type, size = head.get("ContentType"), int(head.get("ContentLength") or 0)
    if content_type not in CONTENT_TYPES or not 1 <= size <= MAX_BYTES:
        _delete_objects(key)
        return 400, {"error": "not_an_image"}
    data = _s3().get_object(Bucket=_bucket(), Key=key)["Body"].read()
    try:
        width, height, thumb = make_thumbnail(data)
    except ValueError:
        _delete_objects(key)
        return 400, {"error": "not_an_image"}
    images, _ = _load(owner)
    if len([i for i in images if i["id"] != image_id]) >= MAX_ITEMS:
        _delete_objects(key)
        return 409, {"error": "limit_reached", "max": MAX_ITEMS}
    return 200, {"item": _view(_store(owner, image_id, content_type, size, width, height, thumb))}


def select_backdrop(req):
    owner = _owner(req)
    body = req.body or {}
    if "id" not in body or set(body) - {"id"}:
        raise ApiError(400, "validation_failed", "Some fields are invalid", fields={"id": "Required, and only id"})
    image_id = body["id"]
    if image_id is not None:
        if not isinstance(image_id, str) or not _IMAGE_ID.match(image_id):
            return _NOT_FOUND
        if not _table().get_item(Key={"PK": owner.pk, "SK": f"IMG#{image_id}"}).get("Item"):
            return _NOT_FOUND
    _set_selected(owner, image_id)
    return 200, {"selectedId": image_id}


def delete_backdrop(req):
    owner = _owner(req)
    image_id = req.path.get("id")
    if not isinstance(image_id, str) or not _IMAGE_ID.match(image_id):
        return _NOT_FOUND
    _delete_objects(owner.image_key(image_id), owner.thumb_key(image_id))
    _table().delete_item(Key={"PK": owner.pk, "SK": f"IMG#{image_id}"})
    try:
        _table().update_item(Key={"PK": owner.pk, "SK": "SELECTED"}, UpdateExpression="SET selectedId = :n",
                             ConditionExpression="selectedId = :id", ExpressionAttributeValues={":n": None, ":id": image_id})
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
    return 204, None


def delete_all(sub: str | None) -> None:
    """Operator deletion: every object under console/<sub>/ and every item.
    Idempotent; skipped when the bucket or table isn't configured."""
    if not isinstance(sub, str) or not _SAFE_SUB.match(sub):
        return
    owner = _Owner(sub)
    bucket = env("USER_BACKDROPS_BUCKET", "")
    if bucket:
        for page in _s3().get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=owner.prefix):
            objects = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objects:
                _s3().delete_objects(Bucket=bucket, Delete={"Objects": objects, "Quiet": True})
    if env("USER_BACKDROPS_TABLE_NAME", ""):
        with _table().batch_writer() as batch:
            for item in _query(owner.pk):
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
    log.info("backdrop library of a deleted operator removed")


ROUTES = {
    "GET /platform/me/backdrops": list_backdrops,
    "POST /platform/me/backdrops/upload": create_upload,
    "POST /platform/me/backdrops/{id}/complete": complete_upload,
    "PUT /platform/me/backdrops/selected": select_backdrop,
    "DELETE /platform/me/backdrops/{id}": delete_backdrop,
}
