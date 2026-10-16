"""The restaurant's Stripe connected account under the platform account.

The onboarding workflow creates the account with Accounts v2 (equivalent
to Standard: the restaurant gets its own full Stripe Dashboard, pays its own
fees, Stripe carries losses and collects KYC). What's left for a human is
Stripe's KYC form, which the restaurant fills in through an Account Link -
these endpoints create that link (v2) and pull the account's current state
on demand (v1 retrieve - Stripe answers for v2 accounts in the v1 shape)."""

import json
import urllib.error
import urllib.parse
import urllib.request

from .core import ApiError, client, env, now_iso, tenant_table, to_ddb_value, write_audit
from .tenants import get_profile, tkey

_API = "https://api.stripe.com"
_key_cache: dict = {}


def _api_key() -> str:
    arn = env("STRIPE_SECRET_ARN")
    if arn not in _key_cache:
        secret = client("secretsmanager").get_secret_value(SecretId=arn)["SecretString"]
        _key_cache[arn] = json.loads(secret)["apiKey"]
    return _key_cache[arn]


def stripe_request(method: str, path: str, params: dict | None = None, *, account: str | None = None,
                   idempotency_key: str | None = None) -> dict:
    """One Stripe API call with the platform key. `path` without a version
    prefix is a v1 call (form-encoded); a path starting with /v2/ is an API
    v2 call (JSON body). `account` = act on a connected account
    (Stripe-Account header) - how every restaurant-side object (Terminal
    locations, readers) is created, so it belongs to the restaurant, not to
    the platform."""
    v2 = path.startswith("/v2/")
    if v2:
        query = ""
        data = json.dumps(params or {}).encode() if method == "POST" else None
        url = f"{_API}{path}"
        content_type = "application/json"
    else:
        query = urllib.parse.urlencode(params or {})
        data = query.encode() if method == "POST" else None
        url = f"{_API}/v1{path}" + (f"?{query}" if method == "GET" and query else "")
        content_type = "application/x-www-form-urlencoded"
    headers = {
        "Authorization": f"Bearer {_api_key()}",
        "Stripe-Version": env("STRIPE_API_VERSION"),
        "Content-Type": content_type,
    }
    if account:
        headers["Stripe-Account"] = account
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            message = json.loads(e.read()).get("error", {}).get("message", str(e))
        except Exception:  # noqa: BLE001 - best effort message extraction
            message = str(e)
        raise ApiError(502, "stripe_error", f"Stripe: {message}", stripeStatus=e.code) from e
    except urllib.error.URLError as e:
        raise ApiError(502, "stripe_unreachable", f"Stripe: {e.reason}") from e


def _account_id(tenant_id: str) -> str:
    profile = get_profile(tenant_id)
    account_id = (profile.get("stripe") or {}).get("accountId")
    if not account_id:
        raise ApiError(409, "no_stripe_account",
                       "The connected account is created by onboarding - wait for it, or retry onboarding")
    return account_id


def account_link(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    account_id = _account_id(tenant_id)
    base = env("PLATFORM_ADMIN_APP_URL").rstrip("/")
    link = stripe_request("POST", "/v2/core/account_links", {
        "account": account_id,
        "use_case": {
            "type": "account_onboarding",
            "account_onboarding": {
                "configurations": ["merchant"],
                "refresh_url": f"{base}/tenants/{tenant_id}?stripe=refresh",
                "return_url": f"{base}/tenants/{tenant_id}?stripe=return",
            },
        },
    })
    write_audit(tenant_id, "stripe_link_created", req.actor, {"accountId": account_id})
    return 200, {"url": link["url"], "expiresAt": link.get("expires_at")}


def sync_account(req) -> tuple[int, dict]:
    """Reads the account from Stripe and stores its state - same result as
    the account.updated webhook, for when an operator doesn't want to wait."""
    tenant_id = req.path["tenantId"]
    account_id = _account_id(tenant_id)
    acct = stripe_request("GET", f"/accounts/{urllib.parse.quote(account_id)}")
    state = {
        "chargesEnabled": bool(acct.get("charges_enabled")),
        "payoutsEnabled": bool(acct.get("payouts_enabled")),
        "detailsSubmitted": bool(acct.get("details_submitted")),
        "requirementsDue": list((acct.get("requirements") or {}).get("currently_due") or []),
    }
    client("dynamodb").update_item(
        TableName=tenant_table(), Key=tkey(tenant_id),
        UpdateExpression="SET stripe.chargesEnabled = :c, stripe.payoutsEnabled = :p, "
                         "stripe.detailsSubmitted = :d, stripe.requirementsDue = :r, stripe.updatedAt = :n",
        ConditionExpression="attribute_exists(stripe.accountId)",
        ExpressionAttributeValues={":c": {"BOOL": state["chargesEnabled"]}, ":p": {"BOOL": state["payoutsEnabled"]},
                                   ":d": {"BOOL": state["detailsSubmitted"]},
                                   ":r": to_ddb_value(state["requirementsDue"]), ":n": {"S": now_iso()}})
    return 200, {"stripe": {"accountId": account_id, **state}}
