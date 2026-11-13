"""The signed-in operator's profile picture in Booqy Console. Every operator
sees everyone's (GET /platform/operators: avatarUrl); each changes only
their own (the routes use the caller's sub):

    GET    /platform/me/avatar             -> {url | null}
    POST   /platform/me/avatar/upload      {contentType, size} -> {url, fields}
    POST   /platform/me/avatar/complete    -> {url}
    DELETE /platform/me/avatar             -> 204

The browser posts its square crop to a staging key console/<sub>/avatar.upload
(presigned POST: JPEG, PNG or WebP, max 5 MB, 300 s); complete decodes it,
centre-crops to a square, writes a 256x256 WebP at console/<sub>/avatar.webp
and deletes the staging object. No pointer row: HeadObject says whether
there is one (403/404 = none, the role has no ListBucket on that path).
Links are one-hour presigned GETs. The objects are in the user-backdrops
bucket (USER_BACKDROPS_BUCKET), under the operator's console/<sub>/ prefix,
so operator deletion (backdrop.delete_all) removes them too."""

import io
import re

from botocore.exceptions import ClientError
from PIL import Image, ImageOps, UnidentifiedImageError

from .backdrop import _s3
from .core import ApiError, env

CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
_FORMATS = frozenset({"JPEG", "PNG", "WEBP"})
MAX_BYTES = 5 * 1024 * 1024
SIDE = 256
UPLOAD_EXPIRES_SECONDS = 300
VIEW_EXPIRES_SECONDS = 3600
_SAFE_SUB = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_MISSING = frozenset({"404", "NoSuchKey", "NotFound", "403", "AccessDenied", "Forbidden"})


def avatar_key(sub: str) -> str:
    return f"console/{sub}/avatar.webp"


def staging_key(sub: str) -> str:
    return f"console/{sub}/avatar.upload"


def _bucket() -> str:
    bucket = env("USER_BACKDROPS_BUCKET", "")
    if not bucket:
        raise ApiError(409, "avatars_not_configured", "Profile pictures aren't set up in this environment")
    return bucket


def _own_sub(req) -> str:
    _bucket()
    sub = (req.claims or {}).get("sub")
    if not isinstance(sub, str) or not _SAFE_SUB.match(sub):
        raise ApiError(403, "forbidden", "Platform operators only")
    return sub


def _head(bucket: str, key: str):
    try:
        return _s3().head_object(Bucket=bucket, Key=key)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in _MISSING:
            return None
        raise


def url_for(sub) -> str | None:
    """A one-hour link to an operator's picture, or None (none, or not set up)."""
    bucket = env("USER_BACKDROPS_BUCKET", "")
    if not bucket or not isinstance(sub, str) or not _SAFE_SUB.match(sub):
        return None
    if _head(bucket, avatar_key(sub)) is None:
        return None
    return _s3().generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": avatar_key(sub)},
                                        ExpiresIn=VIEW_EXPIRES_SECONDS)


def make_avatar(data: bytes) -> bytes:
    """A 256x256 WebP of the centre square. ValueError when it isn't a JPEG,
    PNG or WebP image."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format not in _FORMATS:
                raise ValueError("not_an_image")
            img.draft("RGB", (SIDE * 2, SIDE * 2))
            shown = ImageOps.exif_transpose(img)
            shown = shown.convert("RGBA" if "A" in shown.getbands() else "RGB")
            shown = ImageOps.fit(shown, (SIDE, SIDE), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
            out = io.BytesIO()
            shown.save(out, "WEBP", quality=85, method=4)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError, EOFError) as e:
        raise ValueError("not_an_image") from e
    return out.getvalue()


def get_avatar(req):
    return 200, {"url": url_for(_own_sub(req))}


def create_upload(req):
    sub = _own_sub(req)
    body = req.body or {}
    errors = {k: "Unknown field" for k in sorted(set(body) - {"contentType", "size"})}
    content_type = body.get("contentType")
    content_type = content_type.strip().lower() if isinstance(content_type, str) else ""
    if content_type not in CONTENT_TYPES:
        errors["contentType"] = "image/jpeg, image/png or image/webp"
    size = body.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= MAX_BYTES:
        errors["size"] = f"Whole bytes, 1 to {MAX_BYTES} (5 MB)"
    if errors:
        raise ApiError(400, "validation_failed", "Some fields are invalid", fields=errors)
    post = _s3().generate_presigned_post(
        Bucket=_bucket(), Key=staging_key(sub), Fields={"Content-Type": content_type},
        Conditions=[{"Content-Type": content_type}, ["content-length-range", 1, MAX_BYTES]],
        ExpiresIn=UPLOAD_EXPIRES_SECONDS)
    return 200, {"url": post["url"], "fields": post["fields"]}


def complete_upload(req):
    sub = _own_sub(req)
    bucket, staging = _bucket(), staging_key(sub)
    head = _head(bucket, staging)
    if head is None:
        return 400, {"error": "upload_missing"}
    if int(head.get("ContentLength") or 0) > MAX_BYTES:
        _s3().delete_object(Bucket=bucket, Key=staging)
        return 400, {"error": "not_an_image"}
    data = _s3().get_object(Bucket=bucket, Key=staging)["Body"].read()
    try:
        webp = make_avatar(data)
    except ValueError:
        _s3().delete_object(Bucket=bucket, Key=staging)
        return 400, {"error": "not_an_image"}
    _s3().put_object(Bucket=bucket, Key=avatar_key(sub), Body=webp, ContentType="image/webp")
    _s3().delete_object(Bucket=bucket, Key=staging)
    url = _s3().generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": avatar_key(sub)},
                                       ExpiresIn=VIEW_EXPIRES_SECONDS)
    return 200, {"url": url}


def delete_avatar(req):
    sub = _own_sub(req)
    for key in (avatar_key(sub), staging_key(sub)):
        _s3().delete_object(Bucket=_bucket(), Key=key)
    return 204, None


ROUTES = {
    "GET /platform/me/avatar": get_avatar,
    "POST /platform/me/avatar/upload": create_upload,
    "POST /platform/me/avatar/complete": complete_upload,
    "DELETE /platform/me/avatar": delete_avatar,
}
