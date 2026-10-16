"""A tenant's restaurant locations, managed by operators (a customer that
opens another restaurant contacts you; you raise the plan if needed and add
the location here).

Locations live in the location table under PK TENANT#<tenantId>, so every
key used here is scoped to the tenant in the path - a locationId of another
tenant simply doesn't exist under it. The tenant's locationCount moves in
the same transaction as the location row, so the plan limit can't be
exceeded, not even by two operators at once."""

from botocore.exceptions import ClientError

from . import validation as v
from .core import (ApiError, audit_put, cancellation_codes, client, from_ddb, location_table, new_id,
                   not_found, now_iso, query_all, tenant_table, to_ddb, to_ddb_value, write_audit)
from .tenants import HIDDEN, get_profile, tkey

LOCKED_STATUSES = ("offboarding", "offboarded")


def lkey(tenant_id: str, location_id: str) -> dict:
    return {"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"LOCATION#{location_id}"}}


def _public(item: dict) -> dict:
    return {k: val for k, val in item.items() if k not in HIDDEN}


def list_locations(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    get_profile(tenant_id)
    items = query_all(TableName=location_table(), KeyConditionExpression="PK = :pk",
                      ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}})
    return 200, {"locations": [_public(i) for i in items]}


def create_location(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    fields = v.location_fields(req.body, partial=False)
    if fields.get("stripeAccountId") == "":
        fields.pop("stripeAccountId")
    profile = get_profile(tenant_id)
    if profile.get("status") in LOCKED_STATUSES:
        raise ApiError(409, "invalid_status", f"The tenant is {profile['status']}", currentStatus=profile["status"])
    location_id, now = new_id(), now_iso()
    item = {"PK": f"TENANT#{tenant_id}", "SK": f"LOCATION#{location_id}", "tenantId": tenant_id,
            "locationId": location_id, "createdAt": now, "createdBy": req.actor,
            **v.app_location_fields(fields), **fields}
    try:
        client("dynamodb").transact_write_items(TransactItems=[
            {"Update": {
                "TableName": tenant_table(), "Key": tkey(tenant_id),
                "UpdateExpression": "SET locationCount = if_not_exists(locationCount, :zero) + :one, "
                                    "updatedAt = :n, updatedBy = :b",
                "ConditionExpression": "attribute_exists(PK) AND (attribute_not_exists(locationCount) "
                                       "OR locationCount < entitlements.maxLocations)",
                "ExpressionAttributeValues": {":zero": {"N": "0"}, ":one": {"N": "1"},
                                              ":n": {"S": now}, ":b": {"S": req.actor}}}},
            {"Put": {"TableName": location_table(), "Item": to_ddb(item),
                     "ConditionExpression": "attribute_not_exists(PK)"}},
            audit_put(tenant_id, "location_created", req.actor, {"locationId": location_id, "name": fields["name"]}),
        ])
    except ClientError as e:
        if e.response["Error"]["Code"] == "TransactionCanceledException" and \
                cancellation_codes(e)[0] == "ConditionalCheckFailed":
            ent = profile.get("entitlements") or {}
            raise ApiError(409, "plan_limit_reached",
                           f"The plan allows {ent.get('maxLocations', '?')} locations. Raise the limit "
                           "(Plan) first, then add the location.",
                           maxLocations=ent.get("maxLocations"),
                           locationCount=profile.get("locationCount", 0)) from e
        raise
    return 201, {"location": _public(item)}


def update_location(req) -> tuple[int, dict]:
    tenant_id, location_id = req.path["tenantId"], req.path["locationId"]
    unknown = sorted(set(req.body) - {"name", "address", "phone", "email", "stripeAccountId"})
    if unknown:
        raise ApiError(400, "validation_failed", "These fields can't be changed here",
                       fields={k: "Not editable" for k in unknown})
    fields = v.location_fields(req.body, partial=True)
    profile = get_profile(tenant_id)
    if profile.get("status") in LOCKED_STATUSES:
        raise ApiError(409, "invalid_status", f"The tenant is {profile['status']}", currentStatus=profile["status"])
    sets, removes, names, values = [], [], {}, {}
    for i, key in enumerate(k for k in ("name", "address", "phone", "email", "stripeAccountId") if k in req.body):
        names[f"#f{i}"] = key
        if fields.get(key) in (None, ""):
            if key in ("name", "address"):
                raise ApiError(400, "validation_failed", "Required", fields={key: "Required"})
            removes.append(f"#f{i}")
        else:
            sets.append(f"#f{i} = :v{i}")
            values[f":v{i}"] = to_ddb_value(fields[key])
    if "phone" in req.body:  # the app reads the E.164 copy
        names["#pn"] = "phoneNumber"
        number = v.e164(fields.get("phone"))
        if number:
            sets.append("#pn = :pn")
            values[":pn"] = {"S": number}
        else:
            removes.append("#pn")
    if not sets and not removes:
        raise ApiError(400, "validation_failed", "Nothing to update")
    sets += ["updatedAt = :n", "updatedBy = :b"]
    values.update({":n": {"S": now_iso()}, ":b": {"S": req.actor}})
    expr = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
    try:
        out = client("dynamodb").update_item(
            TableName=location_table(), Key=lkey(tenant_id, location_id), UpdateExpression=expr,
            ConditionExpression="attribute_exists(PK)", ExpressionAttributeNames=names,
            ExpressionAttributeValues=values, ReturnValues="ALL_NEW")
    except client("dynamodb").exceptions.ConditionalCheckFailedException as e:
        raise not_found("No such location for this tenant") from e
    write_audit(tenant_id, "location_updated", req.actor,
                {"locationId": location_id, "fields": sorted(names.values())})
    return 200, {"location": _public(from_ddb(out["Attributes"]))}


def delete_location(req) -> tuple[int, dict]:
    """Removes the location row and frees a slot in the plan. The location's
    menu, reservations and orders stay in their tables (keyed by its id, which
    is never reused) - nothing reaches them any more. Card readers registered
for the location are removed from Stripe too (terminal.cleanup_location)."""
    tenant_id, location_id = req.path["tenantId"], req.path["locationId"]
    profile = get_profile(tenant_id)
    existing = client("dynamodb").get_item(TableName=location_table(), Key=lkey(tenant_id, location_id)).get("Item")
    now = now_iso()
    items = [{"Delete": {"TableName": location_table(), "Key": lkey(tenant_id, location_id),
                         "ConditionExpression": "attribute_exists(PK)"}}]
    if int(profile.get("locationCount") or 0) > 0:
        items.append({"Update": {
            "TableName": tenant_table(), "Key": tkey(tenant_id),
            "UpdateExpression": "SET locationCount = locationCount - :one, updatedAt = :n, updatedBy = :b",
            "ConditionExpression": "locationCount > :zero",
            "ExpressionAttributeValues": {":one": {"N": "1"}, ":zero": {"N": "0"}, ":n": {"S": now}, ":b": {"S": req.actor}}}})
    items.append(audit_put(tenant_id, "location_deleted", req.actor, {"locationId": location_id}))
    try:
        client("dynamodb").transact_write_items(TransactItems=items)
    except ClientError as e:
        if e.response["Error"]["Code"] != "TransactionCanceledException":
            raise
        codes = cancellation_codes(e)
        if codes[0] == "ConditionalCheckFailed":
            raise not_found("No such location for this tenant") from e
        if "ConditionalCheckFailed" in codes[1:]:
            raise ApiError(409, "count_changed", "The location count changed meanwhile - try again") from e
        raise
    from .terminal import cleanup_location   # local import: terminal imports this module
    cleanup_location(from_ddb(existing))
    return 200, {"deleted": location_id}
