"""Operator notices: what Booqy itself tells the operators (the bell in the
side menu, Notifications page). Today one kind:

    setup_completed  a restaurant finished Kom igång in Booqy Admin (every
                     step done or skipped): time to build its website.

The rows are written by the application (functions/tenant-setup, once per
tenant, in the same transaction that sets PROFILE.setupCompletedAt), in the
tenant table:

    PK NOTICES   SK <at>#<tenantId>#<kind>   kind, tenantId, tenantName, at,
                                             seenAt (set here), seenBy

SK order is time order. "Unseen" = no seenAt; opening the Notifications page
marks every notice seen (one shared state for all operators: a notice is
handled once someone has looked)."""

from .core import client, from_ddb, now_iso, tenant_table, to_ddb_value

PK = "NOTICES"
LIST_LIMIT = 100
KINDS = ("setup_completed",)


def _rows(limit: int = LIST_LIMIT) -> list[dict]:
    page = client("dynamodb").query(
        TableName=tenant_table(), KeyConditionExpression="PK = :pk",
        ExpressionAttributeValues={":pk": {"S": PK}}, ScanIndexForward=False, Limit=limit)
    return [from_ddb(i) for i in page.get("Items", [])]


def _public(row: dict) -> dict:
    return {
        "id": row["SK"],
        "kind": row.get("kind"),
        "tenantId": row.get("tenantId"),
        "tenantName": row.get("tenantName"),
        "at": row.get("at"),
        "seenAt": row.get("seenAt"),
    }


def list_notices(req) -> tuple[int, dict]:
    rows = [r for r in _rows() if r.get("kind") in KINDS]
    return 200, {"notices": [_public(r) for r in rows], "unseen": sum(1 for r in rows if not r.get("seenAt"))}


def mark_seen(req) -> tuple[int, dict]:
    at = now_iso()
    marked = 0
    for row in _rows():
        if row.get("seenAt"):
            continue
        try:
            client("dynamodb").update_item(
                TableName=tenant_table(), Key={"PK": {"S": PK}, "SK": {"S": row["SK"]}},
                UpdateExpression="SET seenAt = :at, seenBy = :by",
                ConditionExpression="attribute_exists(PK) AND attribute_not_exists(seenAt)",
                ExpressionAttributeValues={":at": to_ddb_value(at), ":by": to_ddb_value(req.actor)})
            marked += 1
        except client("dynamodb").exceptions.ConditionalCheckFailedException:
            continue   # another operator just marked it
    return 200, {"marked": marked, "unseen": 0}


ROUTES = {
    "GET /platform/notices": list_notices,
    "POST /platform/notices/seen": mark_seen,
}
