"""Card terminals (Stripe Terminal) for a tenant's restaurant locations.

Everything is created ON THE RESTAURANT'S connected Stripe account (the
location's own stripeAccountId if it has one, else the tenant's), so the
readers - and every in-person payment they take - belong to the restaurant;
the money goes to its Stripe balance and bank account.

Per restaurant location:
  1. enable  -> a Stripe Terminal Location with the restaurant's Swedish
                address (Stripe requires one per physical place; readers
                download their country config from it). Its id is stored on
                the location row as terminal.locationId.
  2. readers -> register a reader with the pairing code it shows on screen
                (sandbox: "simulated-wpe" gives a simulated WisePOS E),
                list them with online/offline status, remove them.

Taking a payment on a reader is NOT done here - that's the restaurant's till
(application backend: PaymentIntent with card_present on the connected
account, then process it on the chosen reader). See infrastructure
docs/handoff/TERMINAL.md."""

import re
import urllib.parse

from . import validation as v
from .core import ApiError, client, from_ddb, location_table, log, not_found, now_iso, to_ddb_value, write_audit
from .locations import lkey
from .stripe_connect import stripe_request
from .tenants import get_profile

FEATURE = "terminal"
POSTAL_CODE_RE = re.compile(r"^\d{3} ?\d{2}$")
LOCKED_STATUSES = ("offboarding", "offboarded", "suspended")
READER_FIELDS = ("id", "label", "device_type", "status", "serial_number", "ip_address", "last_seen_at")


# ---------------------------------------------------------------- helpers
def _location(tenant_id: str, location_id: str) -> dict:
    item = client("dynamodb").get_item(TableName=location_table(), Key=lkey(tenant_id, location_id)).get("Item")
    if not item:
        raise not_found("No such location for this tenant")
    return from_ddb(item)


def _account_for(profile: dict, location: dict) -> str:
    account = location.get("stripeAccountId") or (profile.get("stripe") or {}).get("accountId")
    if not account:
        raise ApiError(409, "no_stripe_account",
                       "This customer has no Stripe account yet - onboarding creates it")
    return account


def _require_ready(profile: dict, account: str) -> None:
    """Terminals need a restaurant that is allowed to use them and can take money."""
    if profile.get("status") in LOCKED_STATUSES:
        raise ApiError(409, "invalid_status", f"The customer is {profile['status']}", currentStatus=profile["status"])
    features = (profile.get("entitlements") or {}).get("features") or {}
    if not features.get(FEATURE):
        raise ApiError(403, "feature_not_in_plan",
                       "Card terminals aren't included in this customer's plan - change the plan or add the "
                       "'terminal' feature as an override")
    acct = stripe_request("GET", f"/accounts/{urllib.parse.quote(account)}")
    if not acct.get("charges_enabled"):
        raise ApiError(409, "payments_not_ready",
                       "The restaurant hasn't finished Stripe onboarding - charges aren't enabled yet. "
                       "Send them the Stripe onboarding link first.")


def _address(body: dict, partial: bool) -> dict:
    f = v.Fields(body)
    out = {
        "line1": f.text("line1", required=not partial, max_len=100),
        "postalCode": f.text("postalCode", required=not partial, max_len=6, pattern=POSTAL_CODE_RE,
                             msg="Swedish postal code, e.g. 118 21"),
        "city": f.text("city", required=not partial, max_len=60),
        "displayName": f.text("displayName", max_len=100),
    }
    f.done()
    return {k: val for k, val in out.items() if val is not None}


def _stripe_address(a: dict) -> dict:
    return {"address[line1]": a["line1"], "address[postal_code]": a["postalCode"],
            "address[city]": a["city"], "address[country]": "SE"}


def _reader(r: dict) -> dict:
    return {k: r.get(k) for k in READER_FIELDS}


def _readers(account: str, terminal_location_id: str) -> list[dict]:
    page = stripe_request("GET", "/terminal/readers",
                          {"location": terminal_location_id, "limit": 100}, account=account)
    return [_reader(r) for r in page.get("data", [])]


def _save_terminal(tenant_id: str, location_id: str, terminal: dict, actor: str, *, first: bool) -> None:
    cond = "attribute_exists(PK)" + (" AND attribute_not_exists(terminal)" if first else "")
    try:
        client("dynamodb").update_item(
            TableName=location_table(), Key=lkey(tenant_id, location_id),
            UpdateExpression="SET terminal = :t, updatedAt = :n, updatedBy = :b", ConditionExpression=cond,
            ExpressionAttributeValues={":t": to_ddb_value(terminal), ":n": {"S": now_iso()}, ":b": {"S": actor}})
    except client("dynamodb").exceptions.ConditionalCheckFailedException as e:
        raise ApiError(409, "location_changed", "The location was changed or removed meanwhile - reload") from e


# ---------------------------------------------------------------- routes
def get_terminal(req) -> tuple[int, dict]:
    tenant_id, location_id = req.path["tenantId"], req.path["locationId"]
    profile = get_profile(tenant_id)
    loc = _location(tenant_id, location_id)
    term = loc.get("terminal")
    features = (profile.get("entitlements") or {}).get("features") or {}
    body = {"enabled": bool(term), "inPlan": bool(features.get(FEATURE)), "terminal": term, "readers": []}
    if term:
        body["readers"] = _readers(term["accountId"], term["locationId"])
    return 200, body


def enable_terminal(req) -> tuple[int, dict]:
    tenant_id, location_id = req.path["tenantId"], req.path["locationId"]
    addr = _address(req.body, partial=False)
    profile = get_profile(tenant_id)
    loc = _location(tenant_id, location_id)
    if loc.get("terminal"):
        raise ApiError(409, "already_enabled", "Card terminals are already enabled for this location")
    account = _account_for(profile, loc)
    _require_ready(profile, account)
    params = {"display_name": addr.get("displayName") or loc.get("name") or "Restaurant", **_stripe_address(addr),
              "metadata[tenantId]": tenant_id, "metadata[locationId]": location_id}
    tl = stripe_request("POST", "/terminal/locations", params, account=account,
                        idempotency_key=f"terminal-location-{location_id}-{now_iso()[:10]}")
    terminal = {"locationId": tl["id"], "accountId": account, "displayName": params["display_name"],
                "address": {k: addr[k] for k in ("line1", "postalCode", "city")} | {"country": "SE"},
                "enabledAt": now_iso(), "enabledBy": req.actor}
    _save_terminal(tenant_id, location_id, terminal, req.actor, first=True)
    write_audit(tenant_id, "terminal_enabled", req.actor,
                {"locationId": location_id, "terminalLocationId": tl["id"]})
    return 201, {"enabled": True, "terminal": terminal, "readers": []}


def update_terminal(req) -> tuple[int, dict]:
    """Change the terminal location's address / display name (e.g. the
    restaurant moved). Readers stay paired."""
    tenant_id, location_id = req.path["tenantId"], req.path["locationId"]
    addr = _address(req.body, partial=True)
    if not addr:
        raise ApiError(400, "validation_failed", "Nothing to update")
    get_profile(tenant_id)
    loc = _location(tenant_id, location_id)
    term = loc.get("terminal")
    if not term:
        raise ApiError(409, "not_enabled", "Card terminals aren't enabled for this location")
    new_addr = {**term["address"], **{k: addr[k] for k in ("line1", "postalCode", "city") if k in addr}}
    params = _stripe_address(new_addr)
    if addr.get("displayName"):
        params["display_name"] = addr["displayName"]
    stripe_request("POST", f"/terminal/locations/{urllib.parse.quote(term['locationId'])}", params,
                   account=term["accountId"])
    term = {**term, "address": new_addr | {"country": "SE"},
            "displayName": addr.get("displayName") or term.get("displayName")}
    _save_terminal(tenant_id, location_id, term, req.actor, first=False)
    write_audit(tenant_id, "terminal_updated", req.actor, {"locationId": location_id})
    return 200, {"enabled": True, "terminal": term}


def register_reader(req) -> tuple[int, dict]:
    tenant_id, location_id = req.path["tenantId"], req.path["locationId"]
    f = v.Fields(req.body)
    code = f.text("registrationCode", required=True, max_len=64)
    label = f.text("label", required=True, max_len=60)
    f.done()
    profile = get_profile(tenant_id)
    loc = _location(tenant_id, location_id)
    term = loc.get("terminal")
    if not term:
        raise ApiError(409, "not_enabled", "Enable card terminals for this location first")
    _require_ready(profile, term["accountId"])
    try:
        reader = stripe_request("POST", "/terminal/readers",
                                {"registration_code": code, "label": label, "location": term["locationId"],
                                 "metadata[tenantId]": tenant_id, "metadata[locationId]": location_id},
                                account=term["accountId"])
    except ApiError as e:
        if e.code == "stripe_error" and e.extra.get("stripeStatus") == 400:
            raise ApiError(400, "validation_failed", e.message,
                           fields={"registrationCode": "Stripe didn't accept this code - check the reader's screen "
                                                       "(codes expire after a few minutes)"}) from e
        raise
    write_audit(tenant_id, "terminal_reader_registered", req.actor,
                {"locationId": location_id, "readerId": reader["id"], "label": label,
                 "deviceType": reader.get("device_type")})
    return 201, {"reader": _reader(reader)}


def remove_reader(req) -> tuple[int, dict]:
    tenant_id, location_id, reader_id = req.path["tenantId"], req.path["locationId"], req.path["readerId"]
    get_profile(tenant_id)
    loc = _location(tenant_id, location_id)
    term = loc.get("terminal")
    if not term:
        raise not_found("No such reader for this location")
    # Only readers of THIS location's terminal location can be removed here.
    if reader_id not in {r["id"] for r in _readers(term["accountId"], term["locationId"])}:
        raise not_found("No such reader for this location")
    stripe_request("DELETE", f"/terminal/readers/{urllib.parse.quote(reader_id)}", account=term["accountId"])
    write_audit(tenant_id, "terminal_reader_removed", req.actor, {"locationId": location_id, "readerId": reader_id})
    return 200, {"deleted": reader_id}


def cleanup_location(location: dict) -> None:
    """Best effort when a location is deleted: remove its readers and its
    Stripe Terminal Location, so nothing keeps taking payments for a
    restaurant location that no longer exists. Never blocks the delete."""
    term = (location or {}).get("terminal")
    if not term:
        return
    try:
        for r in _readers(term["accountId"], term["locationId"]):
            stripe_request("DELETE", f"/terminal/readers/{urllib.parse.quote(r['id'])}", account=term["accountId"])
        stripe_request("DELETE", f"/terminal/locations/{urllib.parse.quote(term['locationId'])}",
                       account=term["accountId"])
    except Exception:  # noqa: BLE001 - logged; the operator can remove leftovers in Stripe
        log.exception("terminal cleanup failed for %s", term.get("locationId"))
