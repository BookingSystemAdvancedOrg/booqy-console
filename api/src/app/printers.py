"""Each location's kitchen printers, for operators (Locations tab and the
badge in the customer list): status, and add, rename, test print and remove
on the restaurant's behalf (a call to Booqy support while setting up).

The rows are the application's (application shared/printing.py, Print
table, PK LOCATION#<locationId>):
    SK SETTINGS          printerId, autoPrint, printerSetup ("skipped": the
                         owner chose "Inga skrivare än"), syncRouting
    SK DEVICE#<deviceId> name, kind (kok|dryck|annat), protocol, secretHash,
                         lastSeenAt
    SK JOB#test#<ms>     a test print
    SK SIM#...           what a simulated printer (not prod) printed
This module holds no routing: after a change it sets SETTINGS.syncRouting
to a fresh token and the application makes the stations follow the
printers on its next read (printing.sync_routing). Every location is
checked against the tenant in the path first (location table, PK
TENANT#<tenantId>), so another tenant's location doesn't exist here.

The secret of a new printer is returned once (the operator reads it to
the restaurant) and only its SHA-256 is stored, as in admin. Every write
leaves an audit row on the tenant."""

import hashlib
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .core import (ApiError, client, env, from_ddb, location_table, not_found, query_all, tenant_table, to_ddb,
                   write_audit)
from .core import not_while
from .tenants import get_profile

KINDS = ("kok", "dryck", "annat")
PROTOCOLS = ("star", "epson")
SIM = "sim"
MAX_DEVICES = 12
NAME_MAX = 40
OFFLINE_SECONDS = 120   # as printing.OFFLINE_SECONDS: no poll for this long = not connected
JOB_TTL_DAYS = 30
SIM_TTL_DAYS = 2
LOCKED_STATUSES = ("offboarding", "offboarded", "purged")
# Worst first: what the customer list shows for a customer with several locations.
STATUS_ORDER = ("offline", "none", "skipped", "ok")


def print_table() -> str:
    return env("PRINT_TABLE_NAME")


def _pk(location_id: str) -> dict:
    return {"S": f"LOCATION#{location_id}"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse(value) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def simulator_allowed() -> bool:
    return (env("ENVIRONMENT", "prod") or "prod") != "prod"


# --------------------------------------------------------------------- reads
def _devices(location_id: str) -> list[dict]:
    items = query_all(TableName=print_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :d)",
                      ExpressionAttributeValues={":pk": _pk(location_id), ":d": {"S": "DEVICE#"}},
                      ConsistentRead=True)
    return sorted(items, key=lambda d: d.get("createdAt") or "")


def _settings(location_id: str) -> dict:
    item = client("dynamodb").get_item(TableName=print_table(), Key={"PK": _pk(location_id), "SK": {"S": "SETTINGS"}},
                                       ConsistentRead=True).get("Item")
    return from_ddb(item) or {}


def online(device: dict, now: datetime) -> bool:
    if device.get("protocol") == SIM:
        return True
    seen = _parse(device.get("lastSeenAt")) if device.get("lastSeenAt") else None
    return bool(seen) and (now - seen).total_seconds() < OFFLINE_SECONDS


def _view(device: dict, now: datetime) -> dict:
    view = {"deviceId": device["deviceId"], "name": device.get("name") or "", "kind": device.get("kind") or "kok",
            "protocol": device.get("protocol") or "star", "online": online(device, now),
            "lastSeenAt": device.get("lastSeenAt"), "createdAt": device.get("createdAt")}
    if view["protocol"] == SIM:
        view["simulated"] = True
    return {k: v for k, v in view.items() if v is not None}


def location_status(location_id: str, now: datetime | None = None) -> dict:
    """{locationId, status, setupSkipped, autoPrint, printers}. status: ok
    (every printer connected), offline (one or more not), none (no printer,
    setup open), skipped (no printer, "Inga skrivare än")."""
    now = now or _now()
    settings, devices = _settings(location_id), _devices(location_id)
    printers = [_view(d, now) for d in devices]
    skipped = settings.get("printerSetup") == "skipped"
    if printers:
        status = "ok" if all(p["online"] for p in printers) else "offline"
    else:
        status = "skipped" if skipped else "none"
    return {"locationId": location_id, "status": status, "setupSkipped": skipped,
            "autoPrint": bool(settings.get("autoPrint")), "printers": printers}


def _location_ids(tenant_id: str) -> list[str]:
    items = query_all(TableName=location_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :l)",
                      ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":l": {"S": "LOCATION#"}},
                      ProjectionExpression="locationId")
    return [i["locationId"] for i in items if i.get("locationId")]


def worst(statuses) -> str | None:
    found = set(statuses)
    return next((s for s in STATUS_ORDER if s in found), None)


def tenant_printers(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    get_profile(tenant_id)
    now = _now()
    ids = _location_ids(tenant_id)
    with ThreadPoolExecutor(max_workers=8) as pool:
        locations = list(pool.map(lambda lid: location_status(lid, now), ids))
    return 200, {"locations": locations, "status": worst(loc["status"] for loc in locations)}


def _tenant_summary(tenant_id: str, now: datetime) -> dict:
    locations = [location_status(lid, now) for lid in _location_ids(tenant_id)]
    printers = [p for loc in locations for p in loc["printers"]]
    return {"status": worst(loc["status"] for loc in locations), "printers": len(printers),
            "offline": sum(1 for p in printers if not p["online"]), "locations": len(locations)}


def all_printers(req) -> tuple[int, dict]:
    """The customer list's badges: {tenants: {tenantId: {status, printers,
    offline, locations}}}, one per customer that has a location."""
    items = query_all(TableName=tenant_table(), IndexName="GSI1", KeyConditionExpression="GSI1PK = :t",
                      ExpressionAttributeValues={":t": {"S": "TENANT"}}, ProjectionExpression="tenantId, #s",
                      ExpressionAttributeNames={"#s": "status"})
    ids = [t["tenantId"] for t in items if t.get("tenantId") and t.get("status") not in ("offboarded", "purged")]
    now = _now()
    with ThreadPoolExecutor(max_workers=8) as pool:
        summaries = dict(zip(ids, pool.map(lambda tid: _tenant_summary(tid, now), ids)))
    return 200, {"tenants": {tid: s for tid, s in summaries.items() if s["locations"]}}


# -------------------------------------------------------------------- writes
def _location(req) -> tuple[str, str, dict]:
    """(tenantId, locationId, profile) of a location the tenant has, else 404."""
    tenant_id, location_id = req.path["tenantId"], req.path["locationId"]
    profile = get_profile(tenant_id)
    item = client("dynamodb").get_item(TableName=location_table(), Key={
        "PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"LOCATION#{location_id}"}}).get("Item")
    if not item:
        raise not_found("We can't find this location. It may have been removed. Reload the page.")
    return tenant_id, location_id, profile


def _writable(profile: dict) -> None:
    if profile.get("status") in LOCKED_STATUSES:
        raise ApiError(409, "invalid_status", not_while(profile["status"]), currentStatus=profile["status"])


def _device_id(req) -> str:
    device_id = req.path.get("deviceId") or ""
    if len(device_id) != 32 or any(c not in "0123456789abcdef" for c in device_id):
        raise not_found("We can't find this printer. It may have been removed. Reload the page.")
    return device_id


def _device(location_id: str, device_id: str) -> dict:
    item = client("dynamodb").get_item(TableName=print_table(), Key={
        "PK": _pk(location_id), "SK": {"S": f"DEVICE#{device_id}"}}, ConsistentRead=True).get("Item")
    if not item:
        raise not_found("We can't find this printer. It may have been removed. Reload the page.")
    return from_ddb(item)


def _name(body: dict, required: bool) -> str | None:
    value = body.get("name")
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > NAME_MAX \
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise ApiError(400, "validation_failed", "Fix the marked field and save again.",
                       fields={"name": f"1 to {NAME_MAX} characters."})
    return value.strip()


def _kind(body: dict, required: bool) -> str | None:
    value = body.get("kind")
    if value is None and not required:
        return None
    if value not in KINDS:
        raise ApiError(400, "validation_failed", "Fix the marked field and save again.",
                       fields={"kind": "Kitchen, Drinks or Other."})
    return value


def _sync(tenant_id: str, location_id: str, now: datetime, *, printer_id: str | None = None,
          auto: bool = False) -> None:
    """Marks the location for the application's station sync; the first
    printer becomes the order printer (auto print on, as admin's setup).
    The order printer is set before the token, so a sync that runs in
    between never builds the stations without it."""
    ddb = client("dynamodb")
    if printer_id:
        try:
            ddb.update_item(
                TableName=print_table(), Key={"PK": _pk(location_id), "SK": {"S": "SETTINGS"}},
                UpdateExpression=("SET printerId = :p, " + ("autoPrint = :true, " if auto else "")
                                  + "version = if_not_exists(version, :zero) + :one"),
                ConditionExpression="attribute_not_exists(printerId) OR attribute_type(printerId, :null)",
                ExpressionAttributeValues={":p": {"S": printer_id}, ":zero": {"N": "0"}, ":one": {"N": "1"},
                                           ":null": {"S": "NULL"}, **({":true": {"BOOL": True}} if auto else {})})
        except ddb.exceptions.ConditionalCheckFailedException:
            pass
    ddb.update_item(TableName=print_table(), Key={"PK": _pk(location_id), "SK": {"S": "SETTINGS"}},
                    UpdateExpression="SET syncRouting = :t, tenantId = :tenant, updatedAt = :now",
                    ExpressionAttributeValues={":t": {"S": uuid.uuid4().hex}, ":tenant": {"S": tenant_id},
                                               ":now": {"S": _iso(now)}})


def add_printer(req) -> tuple[int, dict]:
    tenant_id, location_id, profile = _location(req)
    _writable(profile)
    body = req.body
    unknown = sorted(set(body) - {"name", "kind", "protocol"})
    if unknown:
        raise ApiError(400, "validation_failed", "Some of this can't be set here. Reload the page and try again.",
                       fields={k: "Can't be set here." for k in unknown})
    name, kind = _name(body, True), _kind(body, True)
    protocol = body.get("protocol") or "star"
    if protocol == SIM and not simulator_allowed():
        raise ApiError(400, "validation_failed", "Simulated printers exist in dev only.",
                       fields={"protocol": "Dev only."})
    if protocol != SIM and protocol not in PROTOCOLS:
        raise ApiError(400, "validation_failed", "Fix the marked field and save again.",
                       fields={"protocol": "Star or Epson."})
    if len(_devices(location_id)) >= MAX_DEVICES:
        raise ApiError(409, "too_many_printers", f"A location can have {MAX_DEVICES} printers. Remove one first.")
    now = _now()
    device_id = uuid.uuid4().hex
    secret = None if protocol == SIM else secrets.token_urlsafe(32)
    item = {"PK": f"LOCATION#{location_id}", "SK": f"DEVICE#{device_id}", "deviceId": device_id,
            "deviceKey": device_id, "tenantId": tenant_id, "locationId": location_id, "name": name, "kind": kind,
            "protocol": protocol, "createdAt": _iso(now), "createdBy": f"operator:{req.actor}"}
    if secret:
        item["secretHash"] = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    client("dynamodb").put_item(TableName=print_table(), Item=to_ddb(item), ConditionExpression="attribute_not_exists(PK)")
    _sync(tenant_id, location_id, now, printer_id=device_id, auto=True)
    write_audit(tenant_id, "printer_added", req.actor,
                {"locationId": location_id, "deviceId": device_id, "name": name, "kind": kind, "protocol": protocol})
    out = {"printer": _view(item, now)}
    if secret:
        server = env("PRINT_SERVER_URL", "")
        if protocol == "epson":
            server = server.replace("/print/cloudprnt", "/print/epson")
        out.update(username=device_id, secret=secret, serverUrl=f"{server}/{device_id}" if server else None)
    return 201, out


def update_printer(req) -> tuple[int, dict]:
    tenant_id, location_id, profile = _location(req)
    _writable(profile)
    device_id = _device_id(req)
    unknown = sorted(set(req.body) - {"name", "kind"})
    if unknown:
        raise ApiError(400, "validation_failed", "Some of this can't be changed here. Reload the page and try again.",
                       fields={k: "Can't be changed here." for k in unknown})
    name, kind = _name(req.body, False), _kind(req.body, False)
    if name is None and kind is None:
        raise ApiError(400, "validation_failed", "Nothing was changed. Change a field, then save.")
    before = _device(location_id, device_id)
    now = _now()
    sets, names, values = ["updatedAt = :now", "updatedBy = :by"], {}, {
        ":now": {"S": _iso(now)}, ":by": {"S": f"operator:{req.actor}"}}
    if name is not None:
        sets.append("#n = :name")
        names["#n"] = "name"
        values[":name"] = {"S": name}
    if kind is not None:
        sets.append("kind = :kind")
        values[":kind"] = {"S": kind}
    ddb = client("dynamodb")
    try:
        out = ddb.update_item(TableName=print_table(), Key={"PK": _pk(location_id), "SK": {"S": f"DEVICE#{device_id}"}},
                              UpdateExpression="SET " + ", ".join(sets), ConditionExpression="attribute_exists(PK)",
                              ExpressionAttributeValues=values, ReturnValues="ALL_NEW",
                              **({"ExpressionAttributeNames": names} if names else {}))
    except ddb.exceptions.ConditionalCheckFailedException as e:
        raise not_found("We can't find this printer. It may have been removed. Reload the page.") from e
    after = from_ddb(out["Attributes"])
    if (kind is not None and kind != before.get("kind")) or (name is not None and after.get("kind") == "annat"):
        _sync(tenant_id, location_id, now)
    write_audit(tenant_id, "printer_changed", req.actor,
                {"locationId": location_id, "deviceId": device_id,
                 "fields": sorted(k for k in ("name", "kind") if req.body.get(k) is not None)})
    return 200, {"printer": _view(after, now)}


def test_printer(req) -> tuple[int, dict]:
    tenant_id, location_id, profile = _location(req)
    _writable(profile)
    device_id = _device_id(req)
    device = _device(location_id, device_id)
    now = _now()
    ms = f"{int(now.timestamp() * 1000):013d}"
    sk = f"JOB#test#{ms}"
    job = {"PK": f"LOCATION#{location_id}", "SK": sk, "kind": "test", "status": "PENDING", "attempts": 0,
           "tenantId": tenant_id, "locationId": location_id, "deviceId": device_id, "createdAt": _iso(now),
           "queue": f"LOCATION#{location_id}", "dueAt": _iso(now),
           "ttl": int((now + timedelta(days=JOB_TTL_DAYS)).timestamp())}
    simulated = device.get("protocol") == SIM
    if simulated:  # never polls: printed at once, and shown on its on-screen paper in admin
        job = {k: v for k, v in job.items() if k not in ("queue", "dueAt")}
        job.update(status="PRINTED", attempts=1, closedAt=job["createdAt"], simulated=True)
    ddb = client("dynamodb")
    try:
        ddb.put_item(TableName=print_table(), Item=to_ddb(job), ConditionExpression="attribute_not_exists(PK)")
    except ddb.exceptions.ConditionalCheckFailedException as e:
        raise ApiError(409, "busy", "A test print was just sent. Wait a second and try again.") from e
    if simulated:
        token = sk[len("JOB#"):].replace("#", ".")
        ddb.put_item(TableName=print_table(), Item=to_ddb({
            "PK": f"LOCATION#{location_id}", "SK": f"SIM#{device_id}#{ms}#{token}", "jobSk": sk, "kind": "test",
            "createdAt": _iso(now), "ttl": int((now + timedelta(days=SIM_TTL_DAYS)).timestamp())}))
    write_audit(tenant_id, "printer_test_print", req.actor, {"locationId": location_id, "deviceId": device_id})
    return 202, {"status": job["status"]}


def remove_printer(req) -> tuple[int, dict]:
    """Revokes the printer at once (its secret stops working: the row is
    gone). The order printer role goes to the next printer (as admin: when
    the removed one had a kind), or auto print stops; the stations follow (syncRouting) and
    its open jobs are closed by the application's sweep."""
    tenant_id, location_id, profile = _location(req)
    _writable(profile)
    device_id = _device_id(req)
    removed = _device(location_id, device_id)
    ddb = client("dynamodb")
    ddb.delete_item(TableName=print_table(), Key={"PK": _pk(location_id), "SK": {"S": f"DEVICE#{device_id}"}})
    now = _now()
    rest = _devices(location_id)
    key = {"PK": _pk(location_id), "SK": {"S": "SETTINGS"}}
    common = {":now": {"S": _iso(now)}, ":zero": {"N": "0"}, ":one": {"N": "1"}, ":p": {"S": device_id}}
    try:
        if rest and removed.get("kind"):
            ddb.update_item(TableName=print_table(), Key=key, ConditionExpression="printerId = :p",
                            UpdateExpression="SET printerId = :s, updatedAt = :now, "
                                             "version = if_not_exists(version, :zero) + :one",
                            ExpressionAttributeValues={**common, ":s": {"S": rest[0]["deviceId"]}})
        else:
            ddb.update_item(TableName=print_table(), Key=key, ConditionExpression="printerId = :p",
                            UpdateExpression="SET printerId = :null, autoPrint = :false, updatedAt = :now, "
                                             "version = if_not_exists(version, :zero) + :one",
                            ExpressionAttributeValues={**common, ":null": {"NULL": True}, ":false": {"BOOL": False}})
    except ddb.exceptions.ConditionalCheckFailedException:
        pass
    _sync(tenant_id, location_id, now)
    write_audit(tenant_id, "printer_removed", req.actor,
                {"locationId": location_id, "deviceId": device_id, "name": removed.get("name")})
    return 200, location_status(location_id, now)


ROUTES = {
    "GET /platform/printers": all_printers,
    "GET /platform/tenants/{tenantId}/printers": tenant_printers,
    "POST /platform/tenants/{tenantId}/locations/{locationId}/printers": add_printer,
    "PATCH /platform/tenants/{tenantId}/locations/{locationId}/printers/{deviceId}": update_printer,
    "DELETE /platform/tenants/{tenantId}/locations/{locationId}/printers/{deviceId}": remove_printer,
    "POST /platform/tenants/{tenantId}/locations/{locationId}/printers/{deviceId}/test": test_printer,
}
