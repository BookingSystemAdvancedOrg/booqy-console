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


@pytest.fixture(autouse=True)
def no_live_rate(monkeypatch):
    """No network in tests: Riksbank's live rate (the last fallback) is unknown unless a test sets it."""
    from app import finance as fin
    monkeypatch.setattr(fin, "_riksbank_latest", lambda: None)


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
    # cost in USD as AWS bills it; revenue in SEK as Booqy invoices it
    _day(finance, tenant, "2026-10-01", requests=100, bookings=4, orders=2, emails=5, costUsd=Decimal("2"),
         costSplitUsd={"requests": Decimal("1.5"), "baseline": Decimal("0.5")}, invoicedSek=Decimal("990"), mrrSek=Decimal("990"))
    _day(finance, tenant, "2026-10-02", requests=50, bookings=1, orders=0, costUsd=Decimal("1"), paidSek=Decimal("990"),
         mrrSek=Decimal("990"))
    _day(finance, other, "2026-10-01", requests=300, bookings=10, orders=5, costUsd=Decimal("4"), invoicedSek=Decimal("1990"),
         mrrSek=Decimal("1990"))
    _day(finance, other, "2026-10-02", requests=200, bookings=8, orders=4, costUsd=Decimal("3"), creditedSek=Decimal("100"),
         mrrSek=Decimal("1990"))
    _day(finance, other, "2026-09-30", requests=1, costUsd=Decimal("999"))   # outside the range
    # the whole bill per day, with that day's Riksbank USD/SEK rate (for the margin only)
    for day, usd, split, rate in (("2026-10-01", "6", {"requests": Decimal("5.5"), "baseline": Decimal("0.5")}, "10"),
                                  ("2026-10-02", "4", {"requests": Decimal("4")}, "11")):
        finance.put_item(Item={"PK": "PLATFORM", "SK": f"DAY#{day}", "costUsd": Decimal(usd), "costSplitUsd": split,
                               "unallocatedUsd": Decimal(0), "usdSek": Decimal(rate), "usdSekDate": day})
        finance.put_item(Item={"PK": "PLATFORM", "SK": f"COST#{day}", "day": day, "usd": Decimal(usd)})   # Cost Explorer pulled
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
    # cost stays USD; gross margin is MRR minus AWS cost: October's MRR (its last day, 990 + 1990) minus
    # each day's cost at that day's rate (6 x 10 + 4 x 11 = 104 kr)
    assert k["costUsd"] == 10 and k["costLoaded"] is True and k["recurringSek"] == 2980
    assert k["marginSek"] == 2876 and k["marginPct"] == 96.5 and k["costAtRateSek"] == 104
    assert "costSek" not in k and "costPerBookingSek" not in k and "smsCostSek" not in k
    assert k["mrrSek"] == 2980 and k["payingCustomers"] == 2 and k["arpuSek"] == 1490
    assert k["bookings"] == 23 and k["orders"] == 11 and k["costPerBookingUsd"] == 0.4348 and k["costPerOrderUsd"] == 0.9091
    assert body["fx"] == {"source": "Riksbank SEKUSDPMI", "from": "2026-10-01", "to": "2026-10-02", "min": 10, "max": 11,
                          "latest": 11, "latestDate": "2026-10-02", "days": 2}
    assert k["customers"] == 2 and k["activeCustomers"] == 2 and k["churnedCustomers"] == 0
    assert body["period"] == {"from": "2026-10-01", "to": "2026-10-02", "days": 2, "includeInactive": False, "tenantId": None,
                              "locationId": None, "revenueScope": None}
    rows = {t["tenantId"]: t for t in body["tenants"]}
    # 2 USD at 10 + 1 USD at 11 = 31 kr
    assert rows[tenant]["revenueSek"] == 990 and rows[tenant]["costUsd"] == 3 and rows[tenant]["marginSek"] == 990 - 31
    assert rows[tenant]["costSplitUsd"]["requests"] == 1.5 and rows[tenant]["emails"] == 5
    assert rows[other]["revenueSek"] == 1890 and rows[other]["creditedSek"] == 100 and rows[other]["outstandingSek"] == 1990
    assert rows[other]["orgNumber"] == "556000-0001" and rows[other]["billingStatus"] == "active"
    assert body["tenants"][0]["tenantId"] == other        # sorted by margin, best first
    assert [p["day"] for p in body["series"]] == ["2026-10-01", "2026-10-02"]
    assert body["series"][0]["invoicedSek"] == 2980 and body["series"][1]["costUsd"] == 4 and body["series"][1]["mrrSek"] == 2980
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
    _set_billing(aws, tenant, pastDueSince="2026-10-01T00:00:00Z")
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
    assert body["tenant"]["costUsd"] == 7 and body["days"][0]["costUsd"] == 4 and body["tenant"]["marginSek"] == 1990 - 73
    assert body["fx"]["latest"] == 11


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
    assert body["invoices"][0]["invoiceId"] == "in_x"                  # overdue first
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


def test_payments_summary_covers_the_whole_month_whatever_the_status_filter(two_tenants, finance):  # noqa: F811
    from test_billing import _ledger, _ago
    tenant, other = two_tenants
    _ledger(finance, tenant, "in_x", status="open", dueDate=_ago(3), lateFeeSek=Decimal("450"))
    _ledger(finance, other, "in_y", status="paid", dueDate=_ago(10), paidAt=_ago(2), amountPaidSek=Decimal("1237.50"),
            amountRemainingSek=Decimal(0))
    for wanted in ("all", "paid", "open", "overdue"):
        status, body = call("GET /platform/finance/invoices",
                            query={"from": "2026-10-01", "to": "2026-10-31", "status": wanted})
        assert status == 200, body
        s = body["summary"]
        assert (s["invoices"], s["paid"], s["open"], s["overdue"]) == (2, 1, 1, 1), wanted
        assert s["outstandingSek"] == 990 and s["overdueSek"] == 990 and s["lateFeesSek"] == 450, wanted
    status, body = call("GET /platform/finance/invoices", query={"from": "2026-10-01", "to": "2026-10-31", "status": "open"})
    assert [r["invoiceId"] for r in body["invoices"]] == ["in_x"]


def test_overview_scoped_to_one_location(two_tenants, finance, aws):  # noqa: F811
    tenant, other = two_tenants
    status, body = call("GET /platform/tenants/{tenantId}", {"tenantId": other})
    loc = body["locations"][0]["locationId"]
    finance.put_item(Item={"PK": f"TENANT#{other}", "SK": f"LOC#{loc}#DAY#2026-10-01", "requests": 120, "bookings": 6,
                           "orders": 3, "emails": 2, "costUsd": Decimal("2.5"), "locationId": loc})
    finance.put_item(Item={"PK": f"TENANT#{other}", "SK": f"LOC#{loc}#DAY#2026-10-02", "requests": 80, "bookings": 2,
                           "orders": 1, "costUsd": Decimal("1.5"), "locationId": loc})
    status, body = call("GET /platform/finance/overview", query={"from": "2026-10-01", "to": "2026-10-02", "tenantId": other,
                                                                 "locationId": loc})
    assert status == 200, body
    k = body["kpis"]
    assert k["costUsd"] == 4 and k["bookings"] == 8 and k["orders"] == 4 and k["requests"] == 200 and k["emails"] == 2
    assert k["revenueSek"] == 1890 and k["mrrSek"] == 1990           # the restaurant's, not the location's
    assert body["period"]["locationId"] == loc and body["period"]["revenueScope"] == "tenant"
    assert body["locations"] == [{"locationId": loc, "name": "Roma Södermalm"}]
    assert body["series"][0]["costUsd"] == 2.5 and body["series"][0]["invoicedSek"] == 1990
    status, body = call("GET /platform/finance/overview", query={"locationId": loc})
    assert status == 400


def test_overview_shows_the_whole_aws_bill_with_the_allocated_part(two_tenants, finance):  # noqa: F811
    tenant, other = two_tenants
    # 2026-10-01 and -02 as allocated (10 USD); 2026-09-30's 999 USD belongs to a customer outside the range anyway.
    # The bill also has a day nobody was active (all unallocated, no rate yet) and a share left to a customer the
    # active-only filter hides.
    finance.put_item(Item={"PK": "PLATFORM", "SK": "DAY#2026-10-01", "costUsd": Decimal("7.5"), "unallocatedUsd": Decimal(0),
                           "usdSek": Decimal("10"), "usdSekDate": "2026-10-01",
                           "costSplitUsd": {"baseline": Decimal("2.5"), "requests": Decimal("5"), "email": Decimal(0), "sms": Decimal(0)}})
    finance.put_item(Item={"PK": "PLATFORM", "SK": "DAY#2026-10-02", "costUsd": Decimal("4"), "unallocatedUsd": Decimal(0),
                           "usdSek": Decimal("11"), "usdSekDate": "2026-10-02",
                           "costSplitUsd": {"baseline": Decimal("1"), "requests": Decimal("3"), "email": Decimal(0), "sms": Decimal(0)}})
    finance.put_item(Item={"PK": "PLATFORM", "SK": "DAY#2026-10-03", "costUsd": Decimal("2.5"), "unallocatedUsd": Decimal("2.5"),
                           "costSplitUsd": {"baseline": Decimal("2.5"), "requests": Decimal(0), "email": Decimal(0), "sms": Decimal(0)}})
    for day in ("2026-10-02", "2026-10-03"):
        finance.put_item(Item={"PK": "PLATFORM", "SK": f"COST#{day}", "day": day})
    status, body = call("GET /platform/finance/overview", query={"from": "2026-10-01", "to": "2026-10-03"})
    assert status == 200, body
    k = body["kpis"]
    assert k["costScope"] == "platform" and k["costUsd"] == 14 and k["allocatedCostUsd"] == 10 and k["unallocatedUsd"] == 4
    assert k["costSplitUsd"] == {"baseline": 6, "requests": 8, "email": 0, "sms": 0}
    # the 3rd has no rate yet: it takes the 2nd's. 75 + 44 + 27.5 = 146.5 kr
    assert k["marginSek"] == 2980 - 146.5 and k["costPerBookingUsd"] == round(14 / 23, 4)
    assert [p["day"] for p in body["series"]] == ["2026-10-01", "2026-10-02", "2026-10-03"]
    assert body["series"][2]["costUsd"] == 2.5 and body["series"][0]["allocatedCostUsd"] == 6
    assert body["costAsOf"] == "2026-10-03"
    # one customer: its allocated share, as before
    status, body = call("GET /platform/finance/overview", query={"from": "2026-10-01", "to": "2026-10-03", "tenantId": other})
    assert body["kpis"]["costScope"] == "allocated" and body["kpis"]["costUsd"] == 7 and body["kpis"]["unallocatedUsd"] == 0
    assert body["kpis"]["marginSek"] == 1990 - 73


def test_margin_waits_for_the_aws_cost_and_counts_this_months_mrr(two_tenants, finance, monkeypatch):  # noqa: F811
    from app import finance as fin
    tenant, other = two_tenants
    month = datetime.now(timezone.utc).date().isoformat()[:7]
    # no Cost Explorer day this month yet: say so, never a made-up margin
    status, body = call("GET /platform/finance/overview", query={"from": f"{month}-01", "to": f"{month}-01"})
    k = body["kpis"]
    assert k["costLoaded"] is False and k["costUsd"] is None and k["marginSek"] is None and k["mrrSek"] > 0
    # once it is: this month's MRR is today's (invoiced in advance on the 1st), the rate Riksbank's latest
    finance.put_item(Item={"PK": "PLATFORM", "SK": f"COST#{month}-01", "day": f"{month}-01", "usd": Decimal("2")})
    finance.put_item(Item={"PK": "PLATFORM", "SK": f"DAY#{month}-01", "costUsd": Decimal("2")})
    monkeypatch.setattr(fin, "_riksbank_latest", lambda: (Decimal("10"), "2026-11-17"))
    status, body = call("GET /platform/finance/overview", query={"from": f"{month}-01", "to": f"{month}-01"})
    k = body["kpis"]
    assert k["costLoaded"] is True and k["costUsd"] == 2 and k["recurringSek"] == k["mrrSek"]
    assert k["marginSek"] == k["mrrSek"] - 20 and body["fx"]["latestDate"] == "2026-11-17"


def test_rows_from_before_the_usd_migration_read_back_in_usd(two_tenants, finance):  # noqa: F811
    tenant, other = two_tenants
    # written in SEK at the old fixed 10.5, not yet rewritten by finance-rollup
    _day(finance, tenant, "2026-09-15", costSek=Decimal("21"), costSplitSek={"requests": Decimal("21")})
    finance.put_item(Item={"PK": "PLATFORM", "SK": "DAY#2026-09-15", "costSek": Decimal("31.50"),
                           "costSplitSek": {"requests": Decimal("31.50")}})
    status, body = call("GET /platform/finance/overview", query={"from": "2026-09-15", "to": "2026-09-15"})
    k = body["kpis"]
    assert k["costUsd"] == 3 and k["allocatedCostUsd"] == 2 and k["costSplitUsd"]["requests"] == 3
    # no rate for that day: the nearest stored one (here the 1st and 2nd of October are in another range,
    # so none is known) leaves the margin empty instead of guessing
    assert k["marginSek"] is None and k["marginPct"] is None and body["fx"] is None
    finance.put_item(Item={"PK": "PLATFORM", "SK": "COST#2026-11-17", "usdSek": Decimal("10.11"), "usdSekDate": "2026-11-17"})
    status, body = call("GET /platform/finance/overview", query={"from": "2026-09-15", "to": "2026-09-15"})
    assert body["kpis"]["marginSek"] == round(-3 * 10.11, 2) and body["fx"]["latestDate"] == "2026-11-17"
