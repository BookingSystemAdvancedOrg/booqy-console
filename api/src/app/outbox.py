"""Dev mail outbox: every email (and a copy of every SMS) the platform would
have sent, saved by the notification Lambda to a private S3 bucket while
the sending domain isn't verified in SES (infrastructure var.mail_outbox).
Never on in prod - there MAIL_OUTBOX_BUCKET_NAME is empty and the list
answers {"enabled": false}.

Objects are outbox/<inverted epoch ms>-<id>.json, so S3's ascending key
order is newest first and a page is one ListObjectsV2 call."""

import json
import re
from concurrent.futures import ThreadPoolExecutor

from botocore.exceptions import ClientError

from .core import ApiError, client, env, not_found

PREFIX = "outbox/"
DEFAULT_LIMIT = 50
MAX_LIMIT = 100
MESSAGE_ID = re.compile(r"^\d{13}-[0-9a-f]{12}$")


def _bucket() -> str | None:
    if env("ENVIRONMENT", "") == "prod":
        return None
    return env("MAIL_OUTBOX_BUCKET_NAME", "") or None


def _read(bucket: str, key: str) -> dict:
    body = client("s3").get_object(Bucket=bucket, Key=key)["Body"].read()
    return json.loads(body)


def _summary(message: dict) -> dict:
    text = message.get("text") or ""
    return {
        "id": message.get("id"),
        "at": message.get("at"),
        "channel": message.get("channel"),
        "to": message.get("to"),
        "subject": message.get("subject") if message.get("channel") == "email" else text[:120],
    }


def list_messages(req):
    bucket = _bucket()
    if not bucket:
        return 200, {"enabled": False, "messages": []}
    try:
        limit = int(req.query.get("limit") or DEFAULT_LIMIT)
    except ValueError:
        raise ApiError(400, "invalid_limit", "limit must be a number") from None
    limit = max(1, min(limit, MAX_LIMIT))
    kwargs = {"Bucket": bucket, "Prefix": PREFIX, "MaxKeys": limit}
    after = req.query.get("after")
    if after:
        if not MESSAGE_ID.fullmatch(after):
            raise ApiError(400, "invalid_cursor", "after must be a message id")
        kwargs["StartAfter"] = f"{PREFIX}{after}.json"
    page = client("s3").list_objects_v2(**kwargs)
    keys = [o["Key"] for o in page.get("Contents", [])]
    # One GET per message for the subject line - fine for a dev page of <= 100.
    with ThreadPoolExecutor(max_workers=8) as pool:
        messages = list(pool.map(lambda k: _summary(_read(bucket, k)), keys))
    next_after = messages[-1]["id"] if page.get("IsTruncated") and messages else None
    return 200, {"enabled": True, "messages": messages, "next": next_after}


def get_message(req):
    bucket = _bucket()
    if not bucket:
        raise not_found("The mail outbox is off")
    message_id = req.path.get("messageId") or ""
    if not MESSAGE_ID.fullmatch(message_id):
        raise not_found("No such message")
    try:
        return 200, {"message": _read(bucket, f"{PREFIX}{message_id}.json")}
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            raise not_found("No such message") from None
        raise
