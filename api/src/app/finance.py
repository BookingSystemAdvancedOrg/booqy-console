"""The Finance page: what the platform earns and costs, per customer and
overall, for any date range.

Reads the finance table (infrastructure storage/dynamodb/finance):
    TENANT#<id> / DAY#<yyyy-mm-dd>   usage, allocated AWS cost, revenue booked
                                     that day, MRR snapshot (finance-rollup +
                                     the senders + the Stripe webhook)
    TENANT#<id> / INVOICE#...        the invoice ledger (outstanding amounts)
    PLATFORM / JOB#latest            when the figures were last computed

Every number is a sum of day rows, so week, month, quarter, year and any
custom range are the same code path. Amounts are SEK excluding VAT.

By default only ACTIVE customers count (includeInactive=1 adds suspended,
offboarding, offboarded and purged customers, whose rows are kept forever).
`tenantId` scopes everything to one customer.
"""

import json
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal

from .core import ApiError, client, env, from_ddb, log, query_all, tenant_table
from .tenants import get_profile

MAX_RANGE_DAYS = 400
ACTIVE_DEFAULT = ("active",)
SUM_FIELDS = ("requests", "bookings", "orders", "emails", "sms", "marketingEmails",
              "costSek", "invoicedSek", "paidSek", "creditedSek")
CENTS = Decimal("0.01")


def _finance_table() -> str:
    return env("FINANCE_TABLE_NAME")


def _q(value) -> Decimal:
    return Decimal(value or 0).quantize(CENTS, rounding=ROUND_HALF_UP)


def _ratio(a, b) -> Decimal | None:
    if not b:
        return None
    return (Decimal(a or 0) / Decimal(b)).quantize(CENTS, rounding=ROUND_HALF_UP)


def _pct(part, whole) -> Decimal | None:
    if not whole:
        return None
    return (Decimal(part or 0) * 100 / Decimal(whole)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


def _range(query: dict) -> tuple[str, str]:
    today = datetime.now(timezone.utc).date()
    try:
        last = date.fromisoformat((query.get("to") or today.isoformat())[:10])
        first = date.fromisoformat((query.get("from") or (last - timedelta(days=29)).isoformat())[:10])
    except ValueError as e:
        raise ApiError(400, "validation_failed", "Dates must be yyyy-mm-dd", fields={"from": "yyyy-mm-dd"}) from e
    if first > last:
        first, last = last, first
    if (last - first).days >= MAX_RANGE_DAYS:
        raise ApiError(400, "validation_failed", f"At most {MAX_RANGE_DAYS} days at a time", fields={"to": "Too far"})
    return first.isoformat(), last.isoformat()


def _in_range(iso: str | None, first: str, last: str) -> bool:
    return bool(iso) and first <= iso[:10] <= last


def _all_profiles() -> list[dict]:
    return query_all(TableName=tenant_table(), IndexName="GSI1", KeyConditionExpression="GSI1PK = :t",
                     ExpressionAttributeValues={":t": {"S": "TENANT"}})


def _days(tenant_id: str, first: str, last: str) -> list[dict]:
    return query_all(TableName=_finance_table(), KeyConditionExpression="PK = :pk AND SK BETWEEN :a AND :b",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":a": {"S": f"DAY#{first}"},
                                                ":b": {"S": f"DAY#{last}"}})


def _invoices(tenant_id: str) -> list[dict]:
    return query_all(TableName=_finance_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :i)",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":i": {"S": "INVOICE#"}})


def _outstanding(invoices: list[dict]) -> Decimal:
    """Open (and uncollectible) invoices' remaining amount, ex VAT."""
    total = Decimal(0)
    for inv in invoices:
        if inv.get("status") not in ("open", "uncollectible"):
            continue
        whole, remaining = inv.get("totalSek") or Decimal(0), inv.get("amountRemainingSek") or Decimal(0)
        total += (remaining * (inv.get("subtotalSek") or Decimal(0)) / whole) if whole else remaining
    return _q(total)


def _job() -> dict | None:
    item = from_ddb(client("dynamodb").get_item(
        TableName=_finance_table(), Key={"PK": {"S": "PLATFORM"}, "SK": {"S": "JOB#latest"}}).get("Item"))
    if not item:
        return None
    return {"startedAt": item.get("startedAt"), "finishedAt": item.get("finishedAt"), "days": item.get("days"),
            "done": item.get("done"), "warnings": item.get("warnings") or []}


def _mrr(profile: dict) -> Decimal:
    billing = profile.get("billing") if isinstance(profile.get("billing"), dict) else {}
    if billing.get("status") in ("active", "past_due") and not billing.get("pauseCollection"):
        return _q(billing.get("mrrSek"))
    return Decimal(0)


def _billing_status(profile: dict) -> str:
    billing = profile.get("billing") if isinstance(profile.get("billing"), dict) else {}
    status = billing.get("status")
    if not billing.get("subscriptionId") or status in ("canceled", "incomplete_expired"):
        return "none"
    if billing.get("pauseCollection"):
        return "paused"
    return status or "none"


def _tenant_totals(profile: dict, first: str, last: str, series: dict) -> dict:
    tenant_id = profile["tenantId"]
    sums = {k: Decimal(0) for k in SUM_FIELDS}
    split = {"baseline": Decimal(0), "requests": Decimal(0), "email": Decimal(0), "sms": Decimal(0)}
    active_days = 0
    for row in _days(tenant_id, first, last):
        day = row["SK"][4:]
        for k in SUM_FIELDS:
            sums[k] += Decimal(row.get(k) or 0)
        for k in split:
            split[k] += Decimal((row.get("costSplitSek") or {}).get(k) or 0)
        if row.get("active"):
            active_days += 1
        point = series.setdefault(day, {"day": day, "invoicedSek": Decimal(0), "paidSek": Decimal(0),
                                        "costSek": Decimal(0), "mrrSek": Decimal(0), "bookings": 0, "orders": 0,
                                        "requests": 0, "activeTenants": 0})
        point["invoicedSek"] += Decimal(row.get("invoicedSek") or 0) - Decimal(row.get("creditedSek") or 0)
        point["paidSek"] += Decimal(row.get("paidSek") or 0)
        point["costSek"] += Decimal(row.get("costSek") or 0)
        point["mrrSek"] += Decimal(row.get("mrrSek") or 0)
        point["bookings"] += int(row.get("bookings") or 0)
        point["orders"] += int(row.get("orders") or 0)
        point["requests"] += int(row.get("requests") or 0)
        if row.get("active"):
            point["activeTenants"] += 1
    invoices = _invoices(tenant_id)
    revenue = _q(sums["invoicedSek"] - sums["creditedSek"])
    cost = _q(sums["costSek"])
    margin = _q(revenue - cost)
    return {
        "tenantId": tenant_id, "name": profile.get("name"), "slug": profile.get("slug"),
        "orgNumber": profile.get("orgNumber"), "legalName": profile.get("legalName"),
        "status": profile.get("status"), "planId": profile.get("planId"),
        "billingStatus": _billing_status(profile),
        "pastDueSince": (profile.get("billing") or {}).get("pastDueSince") if isinstance(profile.get("billing"), dict) else None,
        "mrrSek": _mrr(profile), "revenueSek": revenue, "collectedSek": _q(sums["paidSek"]),
        "creditedSek": _q(sums["creditedSek"]), "outstandingSek": _outstanding(invoices),
        "costSek": cost, "costSplitSek": {k: _q(val) for k, val in split.items()},
        "marginSek": margin, "marginPct": _pct(margin, revenue),
        "bookings": int(sums["bookings"]), "orders": int(sums["orders"]), "requests": int(sums["requests"]),
        "emails": int(sums["emails"]), "sms": int(sums["sms"]), "marketingEmails": int(sums["marketingEmails"]),
        "costPerBookingSek": _ratio(cost, sums["bookings"]), "costPerOrderSek": _ratio(cost, sums["orders"]),
        "activeDays": active_days, "invoiceCount": len(invoices),
        "createdAt": profile.get("createdAt"), "offboardedAt": profile.get("offboardedAt"),
    }


def overview(req) -> tuple[int, dict]:
    first, last = _range(req.query or {})
    include_inactive = (req.query or {}).get("includeInactive") in ("1", "true", "yes")
    only = ((req.query or {}).get("tenantId") or "").strip() or None
    profiles = _all_profiles()
    if only and not any(p["tenantId"] == only for p in profiles):
        raise ApiError(404, "not_found", "No such customer")
    counted = [p for p in profiles if (only and p["tenantId"] == only)
               or (not only and (include_inactive or p.get("status") in ACTIVE_DEFAULT))]
    series: dict = {}
    tenants = [_tenant_totals(p, first, last, series) for p in counted]
    tenants.sort(key=lambda t: (t["marginSek"], t["name"] or ""), reverse=True)

    revenue = _q(sum((t["revenueSek"] for t in tenants), Decimal(0)))
    collected = _q(sum((t["collectedSek"] for t in tenants), Decimal(0)))
    outstanding = _q(sum((t["outstandingSek"] for t in tenants), Decimal(0)))
    cost = _q(sum((t["costSek"] for t in tenants), Decimal(0)))
    bookings = sum(t["bookings"] for t in tenants)
    orders = sum(t["orders"] for t in tenants)
    margin = _q(revenue - cost)
    mrr = _q(sum((t["mrrSek"] for t in tenants), Decimal(0)))
    paying = sum(1 for t in tenants if t["mrrSek"] > 0)
    active_now = sum(1 for t in tenants if t["status"] == "active")
    new_customers = sum(1 for p in profiles if _in_range(p.get("createdAt"), first, last)
                        and p.get("status") not in ("provisioning", "provisioning_failed"))
    churned = sum(1 for p in profiles if _in_range(p.get("offboardedAt"), first, last))
    customers_at_start = sum(1 for p in profiles if (p.get("createdAt") or "")[:10] < first
                             and not ((p.get("offboardedAt") or "")[:10] < first and p.get("offboardedAt"))
                             and p.get("status") not in ("provisioning", "provisioning_failed"))
    attention = {
        "pastDue": [{"tenantId": p["tenantId"], "name": p.get("name"), "since": p["billing"].get("pastDueSince"),
                     "status": p.get("status")}
                    for p in profiles if isinstance(p.get("billing"), dict) and p["billing"].get("pastDueSince")
                    and p.get("status") in ("active", "suspended")],
        "noSubscription": [{"tenantId": p["tenantId"], "name": p.get("name"), "createdAt": p.get("createdAt")}
                           for p in profiles if p.get("status") == "active" and _billing_status(p) == "none"],
        "noPrice": [],
    }
    job = _job()
    return 200, {
        "period": {"from": first, "to": last, "days": (date.fromisoformat(last) - date.fromisoformat(first)).days + 1,
                   "includeInactive": include_inactive, "tenantId": only},
        "kpis": {
            "mrrSek": mrr, "revenueSek": revenue, "collectedSek": collected, "outstandingSek": outstanding,
            "costSek": cost, "marginSek": margin, "marginPct": _pct(margin, revenue),
            "customers": len(tenants), "activeCustomers": active_now, "payingCustomers": paying,
            "newCustomers": new_customers, "churnedCustomers": churned,
            "churnPct": _pct(churned, customers_at_start) if customers_at_start else None,
            "arpuSek": _ratio(mrr, paying), "bookings": bookings, "orders": orders,
            "costPerBookingSek": _ratio(cost, bookings), "costPerOrderSek": _ratio(cost, orders),
            "requests": sum(t["requests"] for t in tenants), "emails": sum(t["emails"] for t in tenants),
            "sms": sum(t["sms"] for t in tenants),
        },
        "series": [series[d] for d in sorted(series)],
        "tenants": tenants,
        "attention": attention,
        "job": job,
        "asOf": (job or {}).get("finishedAt"),
    }


def tenant_detail(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    first, last = _range(req.query or {})
    profile = get_profile(tenant_id)
    series: dict = {}
    totals = _tenant_totals(profile, first, last, series)
    days = [{"day": r["SK"][4:], **{k: r.get(k) for k in SUM_FIELDS}, "mrrSek": r.get("mrrSek"),
             "costSplitSek": r.get("costSplitSek"), "active": r.get("active")}
            for r in sorted(_days(tenant_id, first, last), key=lambda r: r["SK"])]
    from .billing import list_invoices           # billing imports tenants, not this module
    return 200, {"period": {"from": first, "to": last}, "tenant": totals, "series": [series[d] for d in sorted(series)],
                 "days": days, "invoices": list_invoices(tenant_id)}


def invoices(req) -> tuple[int, dict]:
    """The Payments view: every invoice whose period (or date) falls in the
    range, with days late, reminders and fees. status filter: open, paid,
    overdue (open and past due), all (default)."""
    q = req.query or {}
    first, last = _range(q)
    wanted = (q.get("status") or "all").strip()
    if wanted not in ("all", "open", "paid", "overdue", "void", "uncollectible"):
        raise ApiError(400, "validation_failed", "status: all, open, paid, overdue, void or uncollectible",
                       fields={"status": "Unknown"})
    from .billing import list_invoices           # billing imports tenants, not this module
    rows = []
    for p in _all_profiles():
        if not isinstance(p.get("billing"), dict) or not p["billing"].get("customerId"):
            continue
        for inv in list_invoices(p["tenantId"], limit=1000):
            when = (inv.get("periodStart") or inv.get("createdAt") or "")[:10]
            if not (first <= when <= last):
                continue
            late = inv["daysLate"]
            if wanted == "overdue" and not (inv["status"] == "open" and late > 0):
                continue
            if wanted not in ("all", "overdue") and inv["status"] != wanted:
                continue
            rows.append({**inv, "tenantId": p["tenantId"], "name": p.get("name"), "slug": p.get("slug"),
                         "orgNumber": p.get("orgNumber"), "tenantStatus": p.get("status")})
    rows.sort(key=lambda r: ((r.get("month") or ""), (r.get("name") or "").lower()), reverse=True)
    paid = sum(1 for r in rows if r["status"] == "paid")
    overdue = [r for r in rows if r["status"] == "open" and r["daysLate"] > 0]
    return 200, {
        "period": {"from": first, "to": last, "status": wanted},
        "summary": {"invoices": len(rows), "paid": paid, "open": sum(1 for r in rows if r["status"] == "open"),
                    "overdue": len(overdue),
                    "invoicedSek": _q(sum((Decimal(r.get("subtotalSek") or 0) for r in rows if r["status"] != "void"), Decimal(0))),
                    "collectedSek": _q(sum((Decimal(r.get("subtotalSek") or 0) for r in rows if r["status"] == "paid"), Decimal(0))),
                    "outstandingSek": _q(sum((Decimal(r.get("outstandingSek") or 0) for r in rows), Decimal(0))),
                    "overdueSek": _q(sum((Decimal(r.get("outstandingSek") or 0) for r in overdue), Decimal(0))),
                    "lateFeesSek": _q(sum((Decimal(r.get("lateFeeSek") or 0) for r in rows), Decimal(0))),
                    "interestSek": _q(sum((Decimal(r.get("interestSek") or 0) for r in rows), Decimal(0)))},
        "invoices": rows,
    }


def rebuild(req) -> tuple[int, dict]:
    """Recomputes a date range (finance-rollup, asynchronously): after a
    changed exchange rate or allocation, or when a night was missed.
    Requests older than the Lambda logs' retention get no request counts."""
    first, last = _range(req.body or {})
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    if last > yesterday:
        last = yesterday
    if first > last:
        raise ApiError(400, "validation_failed", "Figures exist from yesterday backwards", fields={"from": "Too new"})
    if (date.fromisoformat(last) - date.fromisoformat(first)).days >= 92:
        raise ApiError(400, "validation_failed", "At most 92 days per rebuild", fields={"to": "Too far"})
    arn = env("FINANCE_ROLLUP_FUNCTION_ARN")
    client("lambda").invoke(FunctionName=arn, InvocationType="Event",
                            Payload=json.dumps({"from": first, "to": last, "requestedBy": req.actor}).encode("utf-8"))
    log.info(json.dumps({"financeRebuild": {"from": first, "to": last}, "actor": req.actor}))
    return 202, {"from": first, "to": last, "status": "started"}


def stripe_sync(req) -> tuple[int, dict]:
    """Re-reads subscriptions and invoices from Stripe into the ledger."""
    from .billing import sync_from_stripe
    summary = sync_from_stripe(req.actor)
    return 200, {"sync": summary}
