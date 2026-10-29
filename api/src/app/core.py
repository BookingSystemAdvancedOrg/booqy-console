"""Shared plumbing: config, AWS clients, DynamoDB (de)serialisation, HTTP
responses, ids and audit rows. Everything else in this package builds on it."""

import base64
import json
import logging
import os
import secrets
import time
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

log = logging.getLogger("platform-tenants")
log.setLevel(logging.INFO)


# --------------------------------------------------------------------- config
def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise RuntimeError(f"missing environment variable {name}")
    return value


def tenant_table() -> str:
    return env("TENANT_TABLE_NAME")


def location_table() -> str:
    return env("LOCATION_TABLE_NAME")


def user_table() -> str:
    return env("USER_TABLE_NAME")


# -------------------------------------------------------------------- clients
_clients: dict = {}


def client(service: str):
    # Created lazily (and per service) so tests can patch AWS before first use
    # and warm invocations reuse connections.
    if service not in _clients:
        _clients[service] = boto3.client(service)
    return _clients[service]


def regional_client(service: str, region: str, **kwargs):
    """Like client(), pinned to a region - Route 53 Domains only exists in
    us-east-1, and presigned S3 URLs must name the bucket's own region."""
    key = (service, region)
    if key not in _clients:
        _clients[key] = boto3.client(service, region_name=region, **kwargs)
    return _clients[key]


def reset_clients() -> None:
    _clients.clear()


# ------------------------------------------------------------------- dynamodb
_ser, _de = TypeSerializer(), TypeDeserializer()


def to_ddb(item: dict) -> dict:
    """Plain dict -> DynamoDB attribute map. None values are dropped."""
    return {k: _ser.serialize(v) for k, v in item.items() if v is not None}


def to_ddb_value(value):
    return _ser.serialize(value)


def from_ddb(item: dict | None) -> dict | None:
    if item is None:
        return None
    return {k: _de.deserialize(v) for k, v in item.items()}


def query_all(**kwargs) -> list[dict]:
    """Query that follows LastEvaluatedKey - for the small, bounded result sets
    this API lists (tenants, a tenant's locations/users/domains)."""
    items, start = [], None
    while True:
        if start:
            kwargs["ExclusiveStartKey"] = start
        page = client("dynamodb").query(**kwargs)
        items.extend(from_ddb(i) for i in page.get("Items", []))
        start = page.get("LastEvaluatedKey")
        if not start:
            return items


def cancellation_codes(err) -> list[str]:
    """Per-item reasons of a TransactionCanceledException, in request order."""
    reasons = err.response.get("CancellationReasons") or []
    return [r.get("Code", "None") for r in reasons]


# ----------------------------------------------------------------------- http
class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str = "", **extra):
        super().__init__(message or code)
        self.status, self.code, self.message, self.extra = status, code, message, extra


def not_found(what: str = "Not found") -> ApiError:
    return ApiError(404, "not_found", what)


def _default(o):
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    if isinstance(o, set):
        return sorted(o)
    raise TypeError(f"not JSON serialisable: {type(o)}")


def respond(status: int, body) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(body, default=_default),
    }


# Codes whose message carries a provider's or parser's own text (Stripe,
# Route 53, Step Functions, json): the caller gets this instead, the
# original goes to the log (handler.py logs it with the request id).
SAFE_MESSAGES = {
    "invalid_json": "The request body isn't valid JSON. Reload the page and try again.",
    "stripe_error": "Stripe refused the request. Check the customer's Stripe account and try again; "
                    "the reason is in the platform-tenants logs.",
    "stripe_unreachable": "Stripe didn't answer. Try again in a minute.",
    "registration_refused": "Route 53 refused the registration. Check the contact details and that the domain "
                            "is still free, then try again; the reason is in the platform-tenants logs.",
    "transfer_refused": "Route 53 refused the transfer. Check the authorization code and that the domain is "
                        "unlocked at the current registrar; the reason is in the platform-tenants logs.",
    "dns_setup_failed": "Couldn't set up DNS for the domain. Try again; the reason is in the platform-tenants logs.",
    "workflow_start_failed": "Couldn't start onboarding. Try again in a minute; the reason is in the "
                             "platform-tenants logs.",
}


def error_body(err: ApiError) -> dict:
    body = {"error": err.code, "message": SAFE_MESSAGES.get(err.code) or err.message or err.code}
    body.update(err.extra)
    return body


def parse_body(event: dict) -> dict:
    raw = event.get("body")
    if not raw:
        return {}
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8")
    try:
        # Decimal for every number: DynamoDB rejects floats.
        body = json.loads(raw, parse_float=Decimal)
    except json.JSONDecodeError as e:
        raise ApiError(400, "invalid_json", str(e)) from e
    if not isinstance(body, dict):
        raise ApiError(400, "invalid_json", "body must be a JSON object")
    return body


# ------------------------------------------------------------------ ids, time
_CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"


def new_id() -> str:
    """Lowercase ULID (26 chars of [0-9a-z]): sortable by creation time, and
    safe as an S3 prefix and inside CloudFront / Step Functions names."""
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(out))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---------------------------------------------------------------------- audit
def audit_put(tenant_id: str, action: str, actor: str, details: dict | None = None) -> dict:
    """A TransactItems entry that appends one AUDIT# row to the tenant."""
    at = now_iso()
    return {
        "Put": {
            "TableName": tenant_table(),
            "Item": to_ddb({
                "PK": f"TENANT#{tenant_id}",
                "SK": f"AUDIT#{at}#{new_id()}",
                "action": action,
                "by": actor,
                "at": at,
                "details": details or {},
            }),
        }
    }


def write_audit(tenant_id: str, action: str, actor: str, details: dict | None = None) -> None:
    put = audit_put(tenant_id, action, actor, details)["Put"]
    client("dynamodb").put_item(TableName=put["TableName"], Item=put["Item"])
