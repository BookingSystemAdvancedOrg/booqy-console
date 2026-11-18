"""Operator notices (app/notices.py) and the Kom igång progress in the
customer list (tenants.setup_summary): the rows the application's
tenant-setup function writes."""

import boto3

from conftest import REGION, call


def _put_notice(tenant_id, at, name="Bistro", seen=False):
    item = {"PK": {"S": "NOTICES"}, "SK": {"S": f"{at}#{tenant_id}#setup_completed"},
            "kind": {"S": "setup_completed"}, "tenantId": {"S": tenant_id}, "tenantName": {"S": name},
            "at": {"S": at}}
    if seen:
        item["seenAt"] = {"S": at}
    boto3.client("dynamodb", region_name=REGION).put_item(TableName="dev-tenant", Item=item)


def test_lists_newest_first_and_counts_unseen(aws):
    _put_notice("t1", "2026-11-17T10:00:00.000Z", "Old", seen=True)
    _put_notice("t2", "2026-11-18T10:00:00.000Z", "New")
    status, body = call("GET /platform/notices")
    assert status == 200
    assert [n["tenantName"] for n in body["notices"]] == ["New", "Old"]
    assert body["unseen"] == 1
    assert body["notices"][0]["kind"] == "setup_completed" and body["notices"][0]["tenantId"] == "t2"


def test_mark_seen_once(aws):
    _put_notice("t1", "2026-11-18T09:00:00.000Z")
    _put_notice("t2", "2026-11-18T10:00:00.000Z")
    status, body = call("POST /platform/notices/seen", body={})
    assert status == 200 and body["marked"] == 2
    _, body = call("GET /platform/notices")
    assert body["unseen"] == 0 and all(n["seenAt"] for n in body["notices"])
    _, again = call("POST /platform/notices/seen", body={})
    assert again["marked"] == 0


def test_operators_only(aws):
    status, _ = call("GET /platform/notices", groups="[]")
    assert status == 403


def test_customer_list_shows_setup_progress(aws, tenant):
    _, body = call("GET /platform/tenants")
    assert next(t for t in body["tenants"] if t["tenantId"] == tenant)["setup"] is None
    boto3.client("dynamodb", region_name=REGION).update_item(
        TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
        UpdateExpression="SET setupState = :s",
        ExpressionAttributeValues={":s": {"M": {"complete": {"BOOL": False}, "total": {"N": "9"},
                                                "done": {"N": "6"}, "skipped": {"N": "1"}, "open": {"N": "2"},
                                                "steps": {"L": []}}}})
    _, body = call("GET /platform/tenants")
    row = next(t for t in body["tenants"] if t["tenantId"] == tenant)
    assert row["setup"] == {"finished": 7, "total": 9, "complete": False, "completedAt": None}
    _, detail = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})
    assert detail["tenant"]["setupState"]["open"] == 2
