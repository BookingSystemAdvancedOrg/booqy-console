"""The signed-in operator's own background image (shown blurred behind the
console's glass UI, on every device). Same contract as the admin app's
/me/backdrop (application functions/user-backdrop):

    GET    /platform/me/backdrop          -> {url, updatedAt} (nulls: none)
    POST   /platform/me/backdrop/upload   {contentType, size} -> {url, fields}
    DELETE /platform/me/backdrop          -> 204

One object per operator at console/<sub>/backdrop in the user-backdrops
bucket (USER_BACKDROPS_BUCKET), so no pointer row: HeadObject says whether
there is one, LastModified is updatedAt, a new upload overwrites it. The
browser uploads with a presigned POST (exact key, Content-Type, 1 B to
10 MB, 300 s); GET answers a one-hour presigned GET. The role has no
ListBucket, so HeadObject of a missing image answers 403: "no image".
Deleted with the operator (operators.delete_operator)."""

import re
from datetime import timezone

from botocore.config import Config
from botocore.exceptions import ClientError

from .core import ApiError, env, log, regional_client

CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
MAX_BYTES = 10 * 1024 * 1024
UPLOAD_EXPIRES_SECONDS = 300
VIEW_EXPIRES_SECONDS = 3600
_SAFE_SUB = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_MISSING = frozenset({"404", "NoSuchKey", "NotFound", "403", "AccessDenied", "Forbidden"})


def _s3():
    region = env("AWS_REGION", env("AWS_DEFAULT_REGION", "eu-north-1"))
    return regional_client("s3", region, endpoint_url=f"https://s3.{region}.amazonaws.com",
                           config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


def _bucket() -> str:
    bucket = env("USER_BACKDROPS_BUCKET", "")
    if not bucket:
        raise ApiError(409, "backdrops_not_configured", "Background images aren't set up in this environment")
    return bucket


def object_key(sub: str) -> str:
    return f"console/{sub}/backdrop"


def _own_key(req) -> str:
    sub = (req.claims or {}).get("sub")
    if not isinstance(sub, str) or not _SAFE_SUB.match(sub):
        raise ApiError(403, "forbidden", "Platform operators only")
    return object_key(sub)


def _iso(value):
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def get_backdrop(req) -> tuple[int, dict]:
    key, bucket = _own_key(req), _bucket()
    try:
        head = _s3().head_object(Bucket=bucket, Key=key)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in _MISSING:
            return 200, {"url": None, "updatedAt": None}
        raise
    url = _s3().generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key},
                                       ExpiresIn=VIEW_EXPIRES_SECONDS)
    return 200, {"url": url, "updatedAt": _iso(head.get("LastModified"))}


def create_upload(req) -> tuple[int, dict]:
    key, bucket = _own_key(req), _bucket()
    body = req.body or {}
    errors = {}
    unknown = sorted(set(body) - {"contentType", "size"})
    if unknown:
        errors.update({k: "Unknown field" for k in unknown})
    content_type = body.get("contentType")
    content_type = content_type.strip().lower() if isinstance(content_type, str) else ""
    if content_type not in CONTENT_TYPES:
        errors["contentType"] = "image/jpeg, image/png or image/webp"
    size = body.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= MAX_BYTES:
        errors["size"] = f"Whole bytes, 1 to {MAX_BYTES} (10 MB)"
    if errors:
        raise ApiError(400, "validation_failed", "Some fields are invalid", fields=errors)
    post = _s3().generate_presigned_post(
        Bucket=bucket, Key=key, Fields={"Content-Type": content_type},
        Conditions=[{"Content-Type": content_type}, ["content-length-range", 1, MAX_BYTES]],
        ExpiresIn=UPLOAD_EXPIRES_SECONDS)
    return 200, {"url": post["url"], "fields": post["fields"]}


def delete_backdrop(req) -> tuple[int, None]:
    _s3().delete_object(Bucket=_bucket(), Key=_own_key(req))
    return 204, None


def delete_for(sub: str | None) -> None:
    """Operator deletion: their image goes with them. Idempotent; skipped
    when the bucket isn't configured."""
    bucket = env("USER_BACKDROPS_BUCKET", "")
    if not bucket or not isinstance(sub, str) or not _SAFE_SUB.match(sub):
        return
    _s3().delete_object(Bucket=bucket, Key=object_key(sub))
    log.info("backdrop of a deleted operator removed")


ROUTES = {
    "GET /platform/me/backdrop": get_backdrop,
    "POST /platform/me/backdrop/upload": create_upload,
    "DELETE /platform/me/backdrop": delete_backdrop,
}
