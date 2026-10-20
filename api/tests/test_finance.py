"""The Finance page: sums of day rows over a range, active customers only
by default, one customer scoped, attention list, rebuild and the job status."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from conftest import NEW_TENANT, call
from test_billing import FINANCE_TABLE, finance, stripe  # noqa: F401 - fixtures


def _day(table, tenant_id, day, **fields):
    table.put_item(Item={"PK": f"TENANT#{tenant_id}", "SK": f"DAY#{day}", "active": True, **fields})


def _invoice(table, tenant_id, day, invoice_id, **fields):
    table.put_item(Item={"PK": f"TENANT#{tenant_id}", "SK": f"INVOICE#{day}#{invoice_id}", "invoiceId": invoice_id, **fields})


@pytest.fixture
def two_tenants(finance, stripe, aws, tenant):  # noqa: F811
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "name": "Bistro Linnea", "slug": "linnea",
                                                        "ownerEmail": "owner@linnea.se", "orgNumber": "556000-0001",
                                                        "planId": "growth"})
    other = body["tenantId"]
    for t in (tenant, other):
        aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{t}"}, "SK": {"S": "PROFILE"}},
                               UpdateExpression="SET #s = :a, createdAt = :c", ExpressionAttributeNames={"#s": "status"},
                               ExpressionAttributeValues={":a": {"S": "active"}, ":c": {"S": "2026-09-01T10:00:00Z"}})
    for t in (tenant, other):
        call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": t}, body={})
    _day(finance, tenant, "2026-10-01", requests=100, bookings=4, orders=2, emails=5, costSek=Decimal("20"),
         costSplitSek={"requests": Decimal("15"), "baseline": Decimal("5")}, invoicedSek=Decimal("990"), mrrSek=Decimal("990"))
    _day(finance, tenant, "2026-10-02", requests=50, bookings=1, orders=0, costSek=Decimal("10"), paidSek=Decimal("990"),
         mrrSek=Decimal("990"))
    _day(finance, other, "2026-10-01", requests=300, bookings=10, orders=5, costSek=Decimal("40"), invoicedSek=Decimal("1990"),
         mrrSek=Decimal("1990"))
    _day(finance, other, "2026-10-02", requests=200, bookings=8, orders=4, costSek=Decimal("30"), creditedSek=Decimal("100"),
         mrrSek=Decimal("1990"))
    _day(finance, other, "2026-09-30", requests=1, costSek=Decimal("999"))   # outside the range
    _invoice(finance, tenant, "2026-10-01", "in_1", status="paid", totalSek=Decimal("1237.50"), subtotalSek=Decimal("990"),
             amountRemainingSek=Decimal(0))
    _invoice(finance, other, "2026-10-01", "in_2", status="open", totalSek=Decimal("2487.50"), subtotalSek=Decimal("1990"),
             amountRemainingSek=Decimal("2487.50"))
    finance.put_item(Item={"PK": "PLATFORM", "SK": "JOB#latest", "finishedAt": "2026-10-03T04:35:00Z",
                           "done": ["2026-10-02"], "warnings": ["Cost Explorer: not enabled"]})
    return tenant, other


def test_overview_sums_the_range_for_active_customers(two_tenants):
    tenant, other = two_tenants
    status, body = call("GET /platform/finance/overview", query={"from": "2026-10-01", "to": "2026-10-02"})
    assert status == 200, body
    k = body["kpis"]
    assert k["revenueSek"] == 2880 and k["collectedSek"] == 990 and k["outstandingSek"] == 1990
    assert k["costSek"] == 100 and k["marginSek"] == 2780 and k["marginPct"] == 96.5
    assert k["mrrSek"] == 2980 and k["payingCustomers"] == 2 and k["arpuSek"] == 1490
    assert k["bookings"] == 23 and k["orders"] == 11 and k["costPerBookingSek"] == 4.35 and k["costPerOrderSek"] == 9.09
    assert k["customers"] == 2 and k["activeCustomers"] == 2 and k["churnedCustomers"] == 0
    assert body["period"] == {"from": "2026-10-01", "to": "2026-10-02", "days": 2, "includeInactive": False, "tenantId": None}
    rows = {t["tenantId"]: t for t in body["tenants"]}
    assert rows[tenant]["revenueSek"] == 990 and rows[tenant]["costSek"] == 30 and rows[tenant]["marginSek"] == 960
    assert rows[tenant]["costSplitSek"]["requests"] == 15 and rows[tenant]["emails"] == 5
    assert rows[other]["revenueSek"] == 1890 and rows[other]["creditedSek"] == 100 and rows[other]["outstandingSek"] == 1990
    assert rows[other]["orgNumber"] == "556000-0001" and rows[other]["billingStatus"] == "active"
    assert body["tenants"][0]["tenantId"] == other        # sorted by margin, best first
    assert [p["day"] for p in body["series"]] == ["2026-10-01", "2026-10-02"]
    assert body["series"][0]["invoicedSek"] == 2980 and body["series"][1]["costSek"] == 40 and body["series"][1]["mrrSek"] == 2980
    assert body["asOf"] == "2026-10-03T04:35:00Z" and body["job"]["warnings"] == ["Cost Explorer: not enabled"]
    assert body["attention"]["noSubscription"] == [] and body["attention"]["pastDue"] == []


def test_overview_excludes_inactive_unless_asked(two_tenants, aws):
    tenant, other = two_tenants
    call("POST /platform/tenants/{tenantId}/suspend", {"tenantId": other}, body={"reason": "test"})
    status, body = call("GET /platform/finance/overview", query={"from": "2026-10-01", "to": "2026-10-02"})
    assert [t["tenantId"] for t in body["tenants"]] == [tenant] and body["kpis"]["revenueSek"] == 990
    status, body = call("GET /platform/finance/overview", query={"from": "2026-10-01", "to": "2026-10-02", "includeInactive": "1"})
    assert len(body["tenants"]) == 2 and body["kpis"]["revenueSek"] == 2880


def test_overview_scoped_to_one_customer(two_tenants):
    tenant, other = two_tenants
    status, body = call("GET /platform/finance/overview", query={"from": "2026-10-01", "to": "2026-10-02", "tenantId": other})
    assert status == 200 and [t["tenantId"] for t in body["tenants"]] == [other]
    assert body["kpis"]["revenueSek"] == 1890 and body["kpis"]["mrrSek"] == 1990
    status, body = call("GET /platform/finance/overview", query={"tenantId": "nope"})
    assert status == 404


def test_overview_defaults_and_validation(two_tenants):
    status, body = call("GET /platform/finance/overview", query=None)
    assert status == 200 and body["period"]["days"] == 30
    status, body = call("GET /platform/finance/overview", query={"from": "2020-01-01", "to": "2026-10-02"})
    assert status == 400
    status, body = call("GET /platform/finance/overview", query={"from": "yesterday"})
    assert status == 400


def test_attention_lists_past_due_and_unsubscribed(two_tenants, aws):
    tenant, other = two_tenants
    from test_billing import _set_billing
    _set_billing(aws, tenant, status="past_due", pastDueSince="2026-10-01T00:00:00Z")
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "name": "Nya Krogen", "slug": "nya",
                                                        "ownerEmail": "o@nya.se", "orgNumber": "556000-0019"})
    fresh = body["tenantId"]
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{fresh}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :a", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":a": {"S": "active"}})
    status, body = call("GET /platform/finance/overview", query={"from": "2026-10-01", "to": "2026-10-02"})
    assert [p["tenantId"] for p in body["attention"]["pastDue"]] == [tenant]
    assert [p["tenantId"] for p in body["attention"]["noSubscription"]] == [fresh]
    assert body["kpis"]["newCustomers"] == 0   # created today, outside the range
    rows = {t["tenantId"]: t for t in body["tenants"]}
    assert rows[tenant]["billingStatus"] == "past_due" and rows[fresh]["billingStatus"] == "none"


def test_tenant_detail(two_tenants):
    tenant, other = two_tenants
    status, body = call("GET /platform/finance/tenants/{tenantId}", {"tenantId": other},
                        query={"from": "2026-10-01", "to": "2026-10-02"})
    assert status == 200, body
    assert body["tenant"]["revenueSek"] == 1890 and [d["day"] for d in body["days"]] == ["2026-10-01", "2026-10-02"]
    assert body["days"][1]["creditedSek"] == 100 and len(body["invoices"]) == 1


def test_rebuild_invokes_the_rollup(two_tenants, monkeypatch):
    from app import core
    calls = []

    class FakeLambda:
        def invoke(self, **kwargs):
            calls.append(kwargs)
            return {"StatusCode": 202}
    core._clients["lambda"] = FakeLambda()
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    status, body = call("POST /platform/finance/rebuild", body={"from": "2026-10-01", "to": "2099-01-01"})
    assert status == 202 and body["to"] == yesterday and body["from"] == "2026-10-01" or status == 400
    if status == 202:
        assert calls[0]["InvocationType"] == "Event" and calls[0]["FunctionName"].endswith("dev-finance-rollup:live")
    status, body = call("POST /platform/finance/rebuild", body={"from": "2020-01-01", "to": "2020-06-01"})
    assert status == 400


def test_payments_view_lists_invoices_by_month_and_status(two_tenants, finance):  # noqa: F811
    from test_billing import _ledger, _ago
    tenant, other = two_tenants
    _ledger(finance, tenant, "in_x", status="open", dueDate=_ago(3), remindersSent=1, lateFeeSek=Decimal("450"))
    _ledger(finance, other, "in_y", status="paid", dueDate=_ago(10), paidAt=_ago(2), amountPaidSek=Decimal("1237.50"),
            amountRemainingSek=Decimal(0), interestSek=Decimal("2.71"))
    status, body = call("GET /platform/finance/invoices", query={"from": "2026-10-01", "to": "2026-10-31"})
    assert status == 200, body
    ids = {r["invoiceId"] for r in body["invoices"]}
    assert ids == {"in_x", "in_y"}          # in_1 / in_2 of the fixture carry no dates
    x = next(r for r in body["invoices"] if r["invoiceId"] == "in_x")
    assert x["name"] == "Pizzeria Roma" and x["month"] == "2026-10" and x["daysLate"] == 3 and x["remindersSent"] == 1
    assert x["lateFeeSek"] == 450 and x["outstandingSek"] == 990
    s = body["summary"]
    assert s["invoices"] == 2 and s["paid"] == 1 and s["overdue"] == 1 and s["lateFeesSek"] == 450 and s["interestSek"] == 2.71
    assert s["outstandingSek"] == 990 and s["overdueSek"] == 990 and s["collectedSek"] == 990
    status, body = call("GET /platform/finance/invoices", query={"from": "2026-10-01", "to": "2026-10-31", "status": "overdue"})
    assert [r["invoiceId"] for r in body["invoices"]] == ["in_x"]
    status, body = call("GET /platform/finance/invoices", query={"from": "2026-10-01", "to": "2026-10-31", "status": "paid"})
    assert [r["invoiceId"] for r in body["invoices"]] == ["in_y"]
    status, body = call("GET /platform/finance/invoices", query={"from": "2026-11-01", "to": "2026-11-30"})
    assert body["invoices"] == []
    status, body = call("GET /platform/finance/invoices", query={"status": "late"})
    assert status == 400
