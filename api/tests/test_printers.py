"""Printer status and the operator's add, rename, test print and remove
(app/printers.py) against the application's Print table rows."""

import hashlib
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Key

from conftest import REGION, call


def _print():
    return boto3.resource("dynamodb", region_name=REGION).Table("dev-print")


def _audit(aws, tenant_id):
    rows = aws["ddb"].query(TableName="dev-tenant", KeyConditionExpression="PK = :pk AND begins_with(SK, :a)",
                            ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":a": {"S": "AUDIT#"}})
    return [r["action"]["S"] for r in rows["Items"]]


def _location_id(tenant_id):
    status, body = call("GET /platform/tenants/{tenantId}/locations", {"tenantId": tenant_id})
    assert status == 200
    return body["locations"][0]["locationId"]


def _path(tenant_id, location_id, device_id=None):
    return {"tenantId": tenant_id, "locationId": location_id, **({"deviceId": device_id} if device_id else {})}


ADD = "POST /platform/tenants/{tenantId}/locations/{locationId}/printers"
ONE = "/platform/tenants/{tenantId}/locations/{locationId}/printers/{deviceId}"


def test_status_none_skipped_ok_offline(aws, tenant):
    loc = _location_id(tenant)
    status, body = call("GET /platform/tenants/{tenantId}/printers", {"tenantId": tenant})
    assert status == 200 and body["status"] == "none"
    assert body["locations"] == [{"locationId": loc, "status": "none", "setupSkipped": False, "autoPrint": False,
                                  "printers": []}]
    _print().put_item(Item={"PK": f"LOCATION#{loc}", "SK": "SETTINGS", "printerSetup": "skipped"})
    assert call("GET /platform/tenants/{tenantId}/printers", {"tenantId": tenant})[1]["status"] == "skipped"

    now = datetime.now(timezone.utc)
    seen = (now - timedelta(seconds=10)).isoformat(timespec="seconds").replace("+00:00", "Z")
    _print().put_item(Item={"PK": f"LOCATION#{loc}", "SK": "DEVICE#" + "a" * 32, "deviceId": "a" * 32,
                            "name": "Köket", "kind": "kok", "protocol": "star", "lastSeenAt": seen,
                            "createdAt": "2026-11-01T00:00:00Z", "secretHash": "x"})
    _, body = call("GET /platform/tenants/{tenantId}/printers", {"tenantId": tenant})
    assert body["status"] == "ok"
    (printer,) = body["locations"][0]["printers"]
    assert printer["online"] is True and printer["lastSeenAt"] == seen and "secretHash" not in printer

    _print().put_item(Item={"PK": f"LOCATION#{loc}", "SK": "DEVICE#" + "b" * 32, "deviceId": "b" * 32,
                            "name": "Baren", "kind": "dryck", "protocol": "star",
                            "createdAt": "2026-11-02T00:00:00Z"})
    assert call("GET /platform/tenants/{tenantId}/printers", {"tenantId": tenant})[1]["status"] == "offline"
    status, body = call("GET /platform/printers")
    assert status == 200
    assert body["tenants"][tenant] == {"status": "offline", "printers": 2, "offline": 1, "locations": 1}


def test_add_returns_the_secret_once_and_marks_the_sync(aws, tenant):
    loc = _location_id(tenant)
    status, body = call(ADD, _path(tenant, loc), {"name": "Baren", "kind": "dryck"})
    assert status == 201, body
    device_id = body["printer"]["deviceId"]
    assert body["username"] == device_id and body["secret"]
    assert body["serverUrl"] == f"https://api.example.se/print/cloudprnt/{device_id}"
    row = _print().get_item(Key={"PK": f"LOCATION#{loc}", "SK": f"DEVICE#{device_id}"})["Item"]
    assert row["secretHash"] == hashlib.sha256(body["secret"].encode()).hexdigest() and "secret" not in row
    assert row["kind"] == "dryck" and row["deviceKey"] == device_id and row["tenantId"] == tenant
    settings = _print().get_item(Key={"PK": f"LOCATION#{loc}", "SK": "SETTINGS"})["Item"]
    assert settings["printerId"] == device_id and settings["autoPrint"] is True and settings["syncRouting"]
    assert "printer_added" in _audit(aws, tenant)
    # the list never shows the secret again
    _, status_body = call("GET /platform/tenants/{tenantId}/printers", {"tenantId": tenant})
    assert "secret" not in str(status_body)

    # a second printer does not take the order printer role
    _, second = call(ADD, _path(tenant, loc), {"name": "Köket", "kind": "kok", "protocol": "epson"})
    assert second["serverUrl"].startswith("https://api.example.se/print/epson/")
    settings = _print().get_item(Key={"PK": f"LOCATION#{loc}", "SK": "SETTINGS"})["Item"]
    assert settings["printerId"] == device_id


def test_add_is_validated(aws, tenant):
    loc = _location_id(tenant)
    assert call(ADD, _path(tenant, loc), {"name": "", "kind": "kok"})[0] == 400
    assert call(ADD, _path(tenant, loc), {"name": "X", "kind": "kassa"})[0] == 400
    assert call(ADD, _path(tenant, loc), {"name": "X", "kind": "kok", "protocol": "zebra"})[0] == 400
    assert call(ADD, _path(tenant, loc), {"name": "X", "kind": "kok", "secretHash": "x"})[0] == 400
    assert call(ADD, _path(tenant, "nope"), {"name": "X", "kind": "kok"})[0] == 404
    assert call(ADD, _path(tenant, loc), {"name": "X", "kind": "kok"}, groups="[other]")[0] == 403


def test_add_simulated_in_dev_only(aws, tenant, monkeypatch):
    loc = _location_id(tenant)
    status, body = call(ADD, _path(tenant, loc), {"name": "Sim", "kind": "kok", "protocol": "sim"})
    assert status == 201 and "secret" not in body and body["printer"]["simulated"] is True
    monkeypatch.setenv("ENVIRONMENT", "prod")
    assert call(ADD, _path(tenant, loc), {"name": "Sim", "kind": "kok", "protocol": "sim"})[0] == 400


def test_another_tenants_location_does_not_exist(aws, tenant):
    from conftest import NEW_TENANT
    status, other = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "other-one", "ownerEmail": "o@o.se"})
    assert status == 202
    loc = _location_id(tenant)
    assert call(ADD, _path(other["tenantId"], loc), {"name": "X", "kind": "kok"})[0] == 404


def test_rename_test_print_and_remove(aws, tenant):
    loc = _location_id(tenant)
    _, first = call(ADD, _path(tenant, loc), {"name": "Köket", "kind": "kok"})
    _, second = call(ADD, _path(tenant, loc), {"name": "Pizza", "kind": "annat", "protocol": "sim"})
    one, two = first["printer"]["deviceId"], second["printer"]["deviceId"]
    _print().update_item(Key={"PK": f"LOCATION#{loc}", "SK": "SETTINGS"}, UpdateExpression="REMOVE syncRouting")

    status, body = call(f"PATCH {ONE}", _path(tenant, loc, one), {"name": "Kök 1"})
    assert status == 200 and body["printer"]["name"] == "Kök 1"
    settings = _print().get_item(Key={"PK": f"LOCATION#{loc}", "SK": "SETTINGS"})["Item"]
    assert "syncRouting" not in settings  # a Kök printer's name is no station's name
    status, body = call(f"PATCH {ONE}", _path(tenant, loc, two), {"name": "Pizzaugnen"})
    assert status == 200
    assert _print().get_item(Key={"PK": f"LOCATION#{loc}", "SK": "SETTINGS"})["Item"]["syncRouting"]
    assert call(f"PATCH {ONE}", _path(tenant, loc, one), {})[0] == 400
    assert call(f"PATCH {ONE}", _path(tenant, loc, one), {"kind": "bar"})[0] == 400
    assert call(f"PATCH {ONE}", _path(tenant, loc, "f" * 32), {"name": "X"})[0] == 404
    assert call(f"PATCH {ONE}", _path(tenant, loc, "../x"), {"name": "X"})[0] == 404

    status, body = call(f"POST {ONE}/test", _path(tenant, loc, one))
    assert (status, body) == (202, {"status": "PENDING"})
    status, body = call(f"POST {ONE}/test", _path(tenant, loc, two))
    assert (status, body) == (202, {"status": "PRINTED"})
    rows = _print().query(KeyConditionExpression=Key("PK").eq(f"LOCATION#{loc}"))["Items"]
    jobs = [r for r in rows if r["SK"].startswith("JOB#test#")]
    assert {j["deviceId"]: j["status"] for j in jobs} == {one: "PENDING", two: "PRINTED"}
    assert any(r["SK"].startswith(f"SIM#{two}#") for r in rows)
    pending = next(j for j in jobs if j["deviceId"] == one)
    assert pending["queue"] == f"LOCATION#{loc}" and pending["kind"] == "test"

    status, body = call(f"DELETE {ONE}", _path(tenant, loc, one))
    assert status == 200 and [p["deviceId"] for p in body["printers"]] == [two]
    settings = _print().get_item(Key={"PK": f"LOCATION#{loc}", "SK": "SETTINGS"})["Item"]
    assert settings["printerId"] == two and settings["autoPrint"] is True and settings["syncRouting"]
    status, body = call(f"DELETE {ONE}", _path(tenant, loc, two))
    assert status == 200 and body["status"] == "none"
    settings = _print().get_item(Key={"PK": f"LOCATION#{loc}", "SK": "SETTINGS"})["Item"]
    assert settings["printerId"] is None and settings["autoPrint"] is False
    assert call(f"DELETE {ONE}", _path(tenant, loc, two))[0] == 404
    actions = _audit(aws, tenant)
    for action in ("printer_added", "printer_changed", "printer_test_print", "printer_removed"):
        assert action in actions


def test_writes_refused_while_offboarded(aws, tenant):
    loc = _location_id(tenant)
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :s", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":s": {"S": "offboarded"}})
    assert call(ADD, _path(tenant, loc), {"name": "X", "kind": "kok"})[0] == 409
