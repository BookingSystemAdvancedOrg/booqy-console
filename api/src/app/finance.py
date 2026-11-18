"""The Finance page: what the platform earns and costs, per customer and
overall, for any date range.

Reads the finance table (infrastructure storage/dynamodb/finance):
    TENANT#<id> / DAY#<yyyy-mm-dd>   usage, allocated AWS cost, revenue booked
                                     that day, MRR snapshot (finance-rollup +
                                     the senders + the Stripe webhook)
    TENANT#<id> / INVOICE#...        the invoice ledger (outstanding amounts)
    PLATFORM / DAY#<yyyy-mm-dd>      the whole AWS bill that day (costUsd,
                                     costSplitUsd, unallocatedUsd) and that
                                     day's USD/SEK rate (usdSek, usdSekDate)
    PLATFORM / COST#<yyyy-mm-dd>     the Cost Explorer pull (the newest one
                                     is the date the AWS cost is known to)
    PLATFORM / JOB#latest            when the figures were last computed

Every number is a sum of day rows, so week, month, quarter, year and any
custom range are the same code path.

Currencies (owner, 2026-11-18): every COST is USD, exactly as AWS Billing
and Cost Explorer report it (fields ending in Usd); revenue is SEK
excluding VAT, as Booqy invoices it (fields ending in Sek). Nothing is
mixed silently.

Gross margin (owner, 2026-11-18) is MRR minus AWS cost: per calendar month in
the range the month's MRR (live for the month in progress, invoiced in
advance on the 1st; else the month's last day snapshot), minus the cost
converted at each day's Riksbank USD/SEK rate. `fx` says which rates were used.
No AWS cost loaded for the range yet: `costLoaded` is false and the margin
null, never a guess.

By default only ACTIVE customers count (includeInactive=1 adds suspended,
offboarding, offboarded and purged customers, whose rows are kept forever).
`tenantId` scopes everything to one customer.

AWS cost: without a customer filter the KPIs use the platform's WHOLE AWS
bill (PLATFORM day rows), so days with no active customer and the share of
customers left out by the filter still count against the margin; the part
allocated to the customers shown is reported next to it. With a customer
filter, cost is that customer's allocated share.
"""

import json
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal

from .core import ApiError, client, env, from_ddb, location_table, log, query_all, tenant_table
from .tenants import get_profile

MAX_RANGE_DAYS = 400
ACTIVE_DEFAULT = ("active",)
SUM_FIELDS = ("requests", "bookings", "orders", "emails", "sms", "marketingEmails",
              "smsParts", "smsBooking", "smsReminder", "smsOrder", "smsCatering",
              "invoicedSek", "paidSek", "creditedSek", "refundedSek")
CENTS = Decimal("0.01")
USD4 = Decimal("0.0001")        # cost per booking or SMS can be a fraction of a cent
BUCKETS = ("baseline", "requests", "email", "sms")
# Rows written before 2026-11-18 hold the cost in SEK at this fixed rate,
# until finance-rollup's one-time migration rewrites them in USD.
LEGACY_USD_TO_SEK = Decimal("10.5")
FX_SOURCE = "Riksbank SEKUSDPMI"
FX_LATEST_URL = "https://api.riksbank.se/swea/v1/Observations/Latest/SEKUSDPMI"
_live_rate: dict = {}


def _riksbank_latest():
    """(rate, rate_day) of Riksbank's newest USD/SEK, cached 6 h per warm
    Lambda: only for a range no nightly run has recorded a rate for yet."""
    if _live_rate.get("until", 0) > time.time():
        return _live_rate.get("value")
    value = None
    try:
        req = urllib.request.Request(FX_LATEST_URL, headers={"Accept": "application/json", "User-Agent": "booqy-console"})
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - fixed https URL
            row = json.loads(resp.read().decode("utf-8"))
        value = (Decimal(str(row["value"])), str(row["date"])[:10])
    except Exception as e:  # noqa: BLE001 - no rate is a null margin, not an error page
        log.warning("Riksbank USD/SEK unavailable: %s", e)
    _live_rate.update({"value": value, "until": time.time() + (6 * 3600 if value else 300)})
    return value


def _finance_table() -> str:
    return env("FINANCE_TABLE_NAME")


def _q(value) -> Decimal:
    return Decimal(value or 0).quantize(CENTS, rounding=ROUND_HALF_UP)


def _usd(value) -> Decimal:
    return Decimal(value or 0).quantize(USD4, rounding=ROUND_HALF_UP)


def _ratio(a, b, places=CENTS) -> Decimal | None:
    if not b:
        return None
    return (Decimal(a or 0) / Decimal(b)).quantize(places, rounding=ROUND_HALF_UP)


def _cost_usd(row: dict) -> Decimal:
    """A day row's cost in USD (a row from before the migration: its SEK back at the fixed rate)."""
    if row.get("costUsd") is not None:
        return Decimal(row["costUsd"])
    return Decimal(row.get("costSek") or 0) / LEGACY_USD_TO_SEK


def _split_usd(row: dict) -> dict:
    if isinstance(row.get("costSplitUsd"), dict):
        return {k: Decimal(row["costSplitUsd"].get(k) or 0) for k in BUCKETS}
    old = row.get("costSplitSek") if isinstance(row.get("costSplitSek"), dict) else {}
    return {k: Decimal(old.get(k) or 0) / LEGACY_USD_TO_SEK for k in BUCKETS}


class Rates:
    """USD/SEK per day for the margin: the rate finance-rollup recorded on
    the PLATFORM day rows (Riksbank, the banking day before on weekends);
    a day without one takes the nearest day before it in the range, else
    after it, else the newest rate stored at all, else Riksbank's latest."""

    def __init__(self, platform_rows: list[dict]):
        self.by_day = {r["SK"][4:]: (Decimal(r["usdSek"]), r.get("usdSekDate") or r["SK"][4:])
                       for r in platform_rows if r.get("usdSek")}
        self._days = sorted(self.by_day)
        self._latest: tuple | None | bool = False
        self.used: dict = {}

    def _newest_stored(self):
        if self._latest is False:
            items = client("dynamodb").query(
                TableName=_finance_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :c)",
                ExpressionAttributeValues={":pk": {"S": "PLATFORM"}, ":c": {"S": "COST#"}},
                ScanIndexForward=False, Limit=40).get("Items", [])
            rows = [from_ddb(i) for i in items]
            hit = next((r for r in rows if r.get("usdSek")), None)
            self._latest = (Decimal(hit["usdSek"]), hit.get("usdSekDate") or hit["SK"][5:]) if hit else _riksbank_latest()
        return self._latest

    def get(self, day: str):
        """(rate, rate_day) or None."""
        hit = self.by_day.get(day)
        if hit is None and self._days:
            before = [d for d in self._days if d <= day]
            hit = self.by_day[before[-1] if before else self._days[0]]
        if hit is None:
            hit = self._newest_stored()
        if hit:
            self.used[hit[1]] = hit[0]
        return hit

    def to_sek(self, day: str, usd: Decimal) -> Decimal | None:
        if not usd:
            return Decimal(0)
        hit = self.get(day)
        return usd * hit[0] if hit else None

    def summary(self) -> dict | None:
        if not self.used:
            return None
        days = sorted(self.used)
        values = [self.used[d] for d in days]
        return {"source": FX_SOURCE, "from": days[0], "to": days[-1], "min": min(values), "max": max(values),
                "latest": values[-1], "latestDate": days[-1], "days": len(days)}


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
        raise ApiError(400, "validation_failed", "The dates look wrong. Write them like 2026-11-01.",
                       fields={"from": "Write a date like 2026-11-01."}) from e
    if first > last:
        first, last = last, first
    if (last - first).days >= MAX_RANGE_DAYS:
        raise ApiError(400, "validation_failed", f"Pick at most {MAX_RANGE_DAYS} days at a time.",
                       fields={"to": f"Pick an end date at most {MAX_RANGE_DAYS} days after the start."})
    return first.isoformat(), last.isoformat()


def _in_range(iso: str | None, first: str, last: str) -> bool:
    return bool(iso) and first <= iso[:10] <= last


def _all_profiles() -> list[dict]:
    return query_all(TableName=tenant_table(), IndexName="GSI1", KeyConditionExpression="GSI1PK = :t",
                     ExpressionAttributeValues={":t": {"S": "TENANT"}})


def _days(tenant_id: str, first: str, last: str, location_id: str | None = None) -> list[dict]:
    prefix = f"LOC#{location_id}#DAY#" if location_id else "DAY#"
    return query_all(TableName=_finance_table(), KeyConditionExpression="PK = :pk AND SK BETWEEN :a AND :b",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":a": {"S": f"{prefix}{first}"},
                                                ":b": {"S": f"{prefix}{last}"}})


def _platform_days(first: str, last: str) -> list[dict]:
    return query_all(TableName=_finance_table(), KeyConditionExpression="PK = :pk AND SK BETWEEN :a AND :b",
                     ExpressionAttributeValues={":pk": {"S": "PLATFORM"}, ":a": {"S": f"DAY#{first}"},
                                                ":b": {"S": f"DAY#{last}"}})


def _cost_as_of() -> str | None:
    """The newest day Cost Explorer's cost is stored for (it lags about a day)."""
    items = client("dynamodb").query(
        TableName=_finance_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :c)",
        ExpressionAttributeValues={":pk": {"S": "PLATFORM"}, ":c": {"S": "COST#"}},
        ScanIndexForward=False, Limit=1, ProjectionExpression="SK").get("Items", [])
    return items[0]["SK"]["S"][5:] if items else None


def _locations(tenant_id: str) -> list[dict]:
    rows = query_all(TableName=location_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :l)",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":l": {"S": "LOCATION#"}})
    return [{"locationId": r.get("locationId"), "name": r.get("name")} for r in rows if r.get("locationId")]


# Still owed (billing.OWED): open, or uncollectible after the last card retry.
_OWED = ("open", "uncollectible")


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


_plan_prices: dict | None = None


def _plans() -> dict:
    """{planId: priceSek}, read once per request."""
    rows = query_all(TableName=tenant_table(), IndexName="GSI1", KeyConditionExpression="GSI1PK = :p",
                     ExpressionAttributeValues={":p": {"S": "PLAN"}})
    return {r["planId"]: Decimal(r.get("priceSek") or 0) for r in rows if r.get("planId")}


def _mrr(profile: dict, plans: dict | None = None) -> Decimal:
    """The monthly price of a running agreement (own price or the plan's);
    0 on the Free plan."""
    from .billing import agreement_running          # billing imports tenants, not this module
    from .tenants import FREE_PLAN_ID
    billing = profile.get("billing") if isinstance(profile.get("billing"), dict) else {}
    if not agreement_running(billing) or profile.get("planId") == FREE_PLAN_ID:
        return Decimal(0)
    if billing.get("priceSek") is not None:
        return _q(billing["priceSek"])
    return _q((plans if plans is not None else _plans()).get(profile.get("planId") or "", Decimal(0)))


def _billing_status(profile: dict, invoices: list[dict] | None = None) -> str:
    """none | scheduled | active | ending | ended, or past_due while an
    invoice is overdue: a failed card payment, or an open invoice past its
    due date (an emailed invoice never fails a payment)."""
    from .billing import is_overdue, phase
    billing = profile.get("billing") if isinstance(profile.get("billing"), dict) else {}
    ph = phase(billing)
    overdue = any(is_overdue(i) for i in invoices or [])
    if ph in ("active", "ending", "ended") and (billing.get("pastDueSince") or overdue):
        return "past_due"
    return ph


def _new_point(day: str) -> dict:
    return {"day": day, "invoicedSek": Decimal(0), "paidSek": Decimal(0), "costUsd": Decimal(0),
            "mrrSek": Decimal(0), "bookings": 0, "orders": 0, "requests": 0, "activeTenants": 0}


def _months(first: str, last: str) -> list[str]:
    out, y, m = [], int(first[:4]), int(first[5:7])
    while f"{y:04d}-{m:02d}" <= last[:7]:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _recurring(first: str, last: str, month_mrr: dict, mrr_now: Decimal) -> Decimal:
    """MRR over the range: one month's MRR per calendar month in it. The
    month in progress counts today's MRR (invoiced in advance on the 1st),
    an earlier month its last day snapshot."""
    this_month = datetime.now(timezone.utc).date().isoformat()[:7]
    total = Decimal(0)
    for month in _months(first, last):
        total += mrr_now if month == this_month else month_mrr.get(month, ("", Decimal(0)))[1]
    return _q(total)


def _tenant_totals(profile: dict, first: str, last: str, series: dict, location_id: str | None = None,
                   plans: dict | None = None, rates: Rates | None = None) -> dict:
    """One customer's sums over the range. With a location: that location's
    usage and allocated cost (its LOC rows); revenue stays the customer's.
    Cost in USD; the margin in SEK at each day's rate."""
    tenant_id = profile["tenantId"]
    rates = rates if rates is not None else Rates([])
    sums = {k: Decimal(0) for k in SUM_FIELDS}
    split = {k: Decimal(0) for k in BUCKETS}
    cost_usd, cost_sek = Decimal(0), Decimal(0)
    month_mrr: dict = {}          # yyyy-mm -> (day, mrr) of the month's last day row
    active_days = 0
    revenue_rows = {r["SK"][4:]: r for r in _days(tenant_id, first, last)} if location_id else {}
    for row in _days(tenant_id, first, last, location_id):
        day = row["SK"].rsplit("#", 1)[1] if location_id else row["SK"][4:]
        if location_id:
            # revenue, credits and MRR are the restaurant's, not the location's
            tenant_row = revenue_rows.get(day) or {}
            row = {**row, "invoicedSek": tenant_row.get("invoicedSek"), "paidSek": tenant_row.get("paidSek"),
                   "creditedSek": tenant_row.get("creditedSek"), "refundedSek": tenant_row.get("refundedSek"),
                   "mrrSek": tenant_row.get("mrrSek"),
                   "active": tenant_row.get("active"), "marketingEmails": 0}
        for k in SUM_FIELDS:
            sums[k] += Decimal(row.get(k) or 0)
        day_usd = _cost_usd(row)
        cost_usd += day_usd
        if cost_sek is not None:
            day_sek = rates.to_sek(day, day_usd)
            cost_sek = None if day_sek is None else cost_sek + day_sek
        for k, v in (_split_usd(row) if not location_id else {}).items():
            split[k] += v
        if row.get("active"):
            active_days += 1
        point = series.setdefault(day, _new_point(day))
        point["invoicedSek"] += Decimal(row.get("invoicedSek") or 0) - Decimal(row.get("creditedSek") or 0)
        point["paidSek"] += Decimal(row.get("paidSek") or 0) - Decimal(row.get("refundedSek") or 0)
        point["costUsd"] += day_usd
        point["mrrSek"] += Decimal(row.get("mrrSek") or 0)
        if day >= month_mrr.get(day[:7], ("", 0))[0]:
            month_mrr[day[:7]] = (day, Decimal(row.get("mrrSek") or 0))
        point["bookings"] += int(row.get("bookings") or 0)
        point["orders"] += int(row.get("orders") or 0)
        point["requests"] += int(row.get("requests") or 0)
        point["smsParts"] = point.get("smsParts", 0) + int(row.get("smsParts") or 0)
        if row.get("active"):
            point["activeTenants"] += 1
    invoices = _invoices(tenant_id)
    from .billing import due_iso, is_overdue
    overdue_since = min((due_iso(i) for i in invoices if is_overdue(i) and due_iso(i)), default=None)
    revenue = _q(sums["invoicedSek"] - sums["creditedSek"])
    cost = _usd(cost_usd)
    mrr_now = _mrr(profile, plans)
    recurring = _recurring(first, last, month_mrr, mrr_now)
    margin = None if cost_sek is None else _q(recurring - cost_sek)
    return {
        "tenantId": tenant_id, "name": profile.get("name"), "slug": profile.get("slug"),
        "orgNumber": profile.get("orgNumber"), "legalName": profile.get("legalName"),
        "status": profile.get("status"), "planId": profile.get("planId"),
        "billingStatus": _billing_status(profile, invoices),
        "pastDueSince": ((profile.get("billing") or {}).get("pastDueSince") if isinstance(profile.get("billing"), dict) else None)
        or overdue_since,
        "mrrSek": mrr_now, "recurringSek": recurring, "revenueSek": revenue, "collectedSek": _q(sums["paidSek"] - sums["refundedSek"]),
        "creditedSek": _q(sums["creditedSek"]), "refundedSek": _q(sums["refundedSek"]), "outstandingSek": _outstanding(invoices),
        "costUsd": cost, "costSplitUsd": {k: _usd(val) for k, val in split.items()},
        "marginSek": margin, "marginPct": _pct(margin, recurring) if margin is not None else None,
        "bookings": int(sums["bookings"]), "orders": int(sums["orders"]), "requests": int(sums["requests"]),
        "emails": int(sums["emails"]), "sms": int(sums["sms"]), "marketingEmails": int(sums["marketingEmails"]),
        "smsParts": int(sums["smsParts"]), "smsCostUsd": _usd(split["sms"]),
        "free": profile.get("planId") == "free",
        "freeUntil": (profile.get("billing") or {}).get("freeUntil") if profile.get("planId") == "free"
        and isinstance(profile.get("billing"), dict) else None,
        "smsByType": {"booking": int(sums["smsBooking"]), "reminder": int(sums["smsReminder"]),
                      "order": int(sums["smsOrder"]), "catering": int(sums["smsCatering"])},
        "costPerBookingUsd": _ratio(cost_usd, sums["bookings"], USD4), "costPerOrderUsd": _ratio(cost_usd, sums["orders"], USD4),
        "activeDays": active_days, "invoiceCount": len(invoices),
        "createdAt": profile.get("createdAt"), "offboardedAt": profile.get("offboardedAt"),
    }


def overview(req) -> tuple[int, dict]:
    first, last = _range(req.query or {})
    include_inactive = (req.query or {}).get("includeInactive") in ("1", "true", "yes")
    only = ((req.query or {}).get("tenantId") or "").strip() or None
    location_id = ((req.query or {}).get("locationId") or "").strip() or None
    if location_id and not only:
        raise ApiError(400, "validation_failed", "Pick a customer first, then a location.", fields={"locationId": "Pick a customer first."})
    profiles = _all_profiles()
    if only and not any(p["tenantId"] == only for p in profiles):
        raise ApiError(404, "not_found", "We can't find this customer. Reload the page.")
    counted = [p for p in profiles if (only and p["tenantId"] == only)
               or (not only and (include_inactive or p.get("status") in ACTIVE_DEFAULT))]
    series: dict = {}
    plans = _plans()
    platform_rows = _platform_days(first, last)
    rates = Rates(platform_rows)
    tenants = [_tenant_totals(p, first, last, series, location_id, plans, rates) for p in counted]
    tenants.sort(key=lambda t: (t["marginSek"] if t["marginSek"] is not None else Decimal("-Infinity"),
                                t["name"] or ""), reverse=True)

    revenue = _q(sum((t["revenueSek"] for t in tenants), Decimal(0)))
    # Collected is net of refunds (paid back to the card); shown on its own too
    collected = _q(sum((t["collectedSek"] for t in tenants), Decimal(0)))
    refunded = _q(sum((t["refundedSek"] for t in tenants), Decimal(0)))
    outstanding = _q(sum((t["outstandingSek"] for t in tenants), Decimal(0)))
    allocated = _usd(sum((t["costUsd"] for t in tenants), Decimal(0)))
    cost, cost_split, cost_scope = allocated, None, "allocated"
    cost_sek = None if any(t["marginSek"] is None for t in tenants) else \
        sum((t["recurringSek"] - t["marginSek"] for t in tenants), Decimal(0))
    if platform_rows and not only:   # none before the rollup's first run: fall back to the allocated sum
        bill = {k: Decimal(0) for k in BUCKETS}
        total, cost_sek = Decimal(0), Decimal(0)
        for row in platform_rows:
            day = row["SK"][4:]
            day_cost = _cost_usd(row)
            total += day_cost
            if cost_sek is not None:
                day_sek = rates.to_sek(day, day_cost)
                cost_sek = None if day_sek is None else cost_sek + day_sek
            for k, v in _split_usd(row).items():
                bill[k] += v
            point = series.setdefault(day, _new_point(day))
            point["allocatedCostUsd"] = point["costUsd"]
            point["costUsd"] = day_cost
        cost, cost_split, cost_scope = _usd(total), {k: _usd(v) for k, v in bill.items()}, "platform"
    for point in series.values():
        point["costUsd"] = _usd(point["costUsd"])
        if "allocatedCostUsd" in point:
            point["allocatedCostUsd"] = _usd(point["allocatedCostUsd"])
    bookings = sum(t["bookings"] for t in tenants)
    orders = sum(t["orders"] for t in tenants)
    recurring = _q(sum((t["recurringSek"] for t in tenants), Decimal(0)))
    cost_as_of = _cost_as_of()
    # AWS cost is loaded once Cost Explorer has a day in (or after) the range's start.
    cost_loaded = bool(cost_as_of) and cost_as_of >= first
    margin = None if cost_sek is None or not cost_loaded else _q(recurring - cost_sek)
    mrr = _q(sum((t["mrrSek"] for t in tenants), Decimal(0)))
    paying = sum(1 for t in tenants if t["mrrSek"] > 0)
    active_now = sum(1 for t in tenants if t["status"] == "active")
    new_customers = sum(1 for p in profiles if _in_range(p.get("createdAt"), first, last)
                        and p.get("status") not in ("provisioning", "provisioning_failed"))
    churned = sum(1 for p in profiles if _in_range(p.get("offboardedAt"), first, last))
    customers_at_start = sum(1 for p in profiles if (p.get("createdAt") or "")[:10] < first
                             and not ((p.get("offboardedAt") or "")[:10] < first and p.get("offboardedAt"))
                             and p.get("status") not in ("provisioning", "provisioning_failed"))
    overdue = {t["tenantId"]: t["pastDueSince"] for t in tenants if t["billingStatus"] == "past_due"}
    attention = {
        "pastDue": [{"tenantId": p["tenantId"], "name": p.get("name"), "since": p["billing"].get("pastDueSince") or overdue.get(p["tenantId"]),
                     "status": p.get("status")}
                    for p in profiles if isinstance(p.get("billing"), dict)
                    and (p["billing"].get("pastDueSince") or p["tenantId"] in overdue)
                    and p.get("status") in ("active", "suspended")],
        "noSubscription": [{"tenantId": p["tenantId"], "name": p.get("name"), "createdAt": p.get("createdAt")}
                           for p in profiles if p.get("status") == "active" and _billing_status(p) in ("none", "ended")],
        "noPrice": [],
    }
    job = _job()
    return 200, {
        "period": {"from": first, "to": last, "days": (date.fromisoformat(last) - date.fromisoformat(first)).days + 1,
                   "includeInactive": include_inactive, "tenantId": only, "locationId": location_id,
                   "revenueScope": "tenant" if location_id else None},
        "locations": _locations(only) if only else [],
        "kpis": {
            "mrrSek": mrr, "revenueSek": revenue, "collectedSek": collected, "refundedSek": refunded,
            "outstandingSek": outstanding,
            "costUsd": cost if cost_loaded else None, "costLoaded": cost_loaded, "recurringSek": recurring,
            "marginSek": margin, "marginPct": _pct(margin, recurring) if margin is not None else None,
            "costAtRateSek": _q(cost_sek) if cost_sek is not None and cost_loaded else None,
            "costScope": cost_scope, "allocatedCostUsd": allocated,
            "unallocatedUsd": max(_usd(cost - allocated), Decimal(0)) if cost_scope == "platform" else Decimal(0),
            "costSplitUsd": cost_split,
            "customers": len(tenants), "activeCustomers": active_now, "payingCustomers": paying,
            "freeCustomers": sum(1 for t in tenants if t["free"] and t["status"] == "active"),
            "newCustomers": new_customers, "churnedCustomers": churned,
            "churnPct": _pct(churned, customers_at_start) if customers_at_start else None,
            "arpuSek": _ratio(mrr, paying), "bookings": bookings, "orders": orders,
            "costPerBookingUsd": _ratio(cost, bookings, USD4), "costPerOrderUsd": _ratio(cost, orders, USD4),
            "requests": sum(t["requests"] for t in tenants), "emails": sum(t["emails"] for t in tenants),
            "sms": sum(t["sms"] for t in tenants),
            # SMS are included in the monthly price: the parts sent and their share of the AWS bill (our cost)
            "smsParts": sum(t["smsParts"] for t in tenants),
            "smsCostUsd": cost_split["sms"] if cost_split else _usd(sum((t["smsCostUsd"] for t in tenants), Decimal(0))),
        },
        # The USD/SEK rates the margin used (cost itself stays USD).
        "fx": rates.summary(),
        "series": [series[d] for d in sorted(series)],
        "tenants": tenants,
        "attention": attention,
        "job": job,
        "asOf": (job or {}).get("finishedAt"),
        "costAsOf": cost_as_of,
    }


def tenant_detail(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    first, last = _range(req.query or {})
    profile = get_profile(tenant_id)
    series: dict = {}
    rates = Rates(_platform_days(first, last))
    totals = _tenant_totals(profile, first, last, series, rates=rates)
    for point in series.values():
        point["costUsd"] = _usd(point["costUsd"])
    days = [{"day": r["SK"][4:], **{k: r.get(k) for k in SUM_FIELDS}, "mrrSek": r.get("mrrSek"),
             "costUsd": _usd(_cost_usd(r)), "costSplitUsd": {k: _usd(v) for k, v in _split_usd(r).items()},
             "active": r.get("active")}
            for r in sorted(_days(tenant_id, first, last), key=lambda r: r["SK"])]
    from .billing import list_invoices           # billing imports tenants, not this module
    return 200, {"period": {"from": first, "to": last}, "tenant": totals, "fx": rates.summary(),
                 "series": [series[d] for d in sorted(series)],
                 "days": days, "invoices": list_invoices(tenant_id), "locations": _locations(tenant_id)}


def _refunded_ex(inv: dict) -> Decimal:
    """The part of an invoice paid back to the card, ex VAT (its credit
    notes' refunds are incl VAT)."""
    refunded, total = Decimal(inv.get("refundedSek") or 0), Decimal(inv.get("totalSek") or 0)
    if not refunded or not total:
        return Decimal(0)
    return refunded * Decimal(inv.get("subtotalSek") or 0) / total


def invoices(req) -> tuple[int, dict]:
    """The Payments view: every invoice whose period (or date) falls in the
    range, with days late, reminders and fees. status filter: open, paid,
    overdue (open and past due), all (default)."""
    q = req.query or {}
    first, last = _range(q)
    wanted = (q.get("status") or "all").strip()
    if wanted not in ("all", "open", "paid", "overdue", "void", "uncollectible"):
        raise ApiError(400, "validation_failed", "Pick one of the listed invoice filters.",
                       fields={"status": "Pick one of the listed filters."})
    from .billing import list_invoices           # billing imports tenants, not this module
    rows = []
    for p in _all_profiles():
        if not isinstance(p.get("billing"), dict) or not p["billing"].get("customerId"):
            continue
        for inv in list_invoices(p["tenantId"], limit=1000):
            # The month an invoice belongs to: the month it pays for (in
            # advance, its first day), on the old cycle the one its period
            # ended in.
            when = ((inv.get("periodStart") if inv.get("kind") in ("advance", "closing") else inv.get("periodEnd"))
                    or inv.get("createdAt") or "")[:10]
            if not (first <= when <= last):
                continue
            rows.append({**inv, "tenantId": p["tenantId"], "name": p.get("name"), "slug": p.get("slug"),
                         "orgNumber": p.get("orgNumber"), "tenantStatus": p.get("status")})
    # Overdue first (the most days late on top), then by month, newest first.
    rows.sort(key=lambda r: ((r.get("month") or ""), (r.get("name") or "").lower()), reverse=True)
    rows.sort(key=lambda r: -(r["daysLate"] if r["status"] in _OWED else 0))
    # The summary covers every invoice of the month, whatever the status
    # filter, so the chip counts and the KPIs stay put when a chip is picked.
    paid = sum(1 for r in rows if r["status"] == "paid")
    overdue = [r for r in rows if r["status"] in _OWED and r["daysLate"] > 0]
    if wanted == "overdue":
        shown = overdue
    elif wanted == "all":
        shown = rows
    else:
        shown = [r for r in rows if r["status"] == wanted]
    return 200, {
        "period": {"from": first, "to": last, "status": wanted},
        "summary": {"invoices": len(rows), "paid": paid, "open": sum(1 for r in rows if r["status"] == "open"),
                    "overdue": len(overdue),
                    "invoicedSek": _q(sum((Decimal(r.get("subtotalSek") or 0) for r in rows if r["status"] != "void"), Decimal(0))),
                    "collectedSek": _q(sum((Decimal(r.get("subtotalSek") or 0) - _refunded_ex(r) for r in rows if r["status"] == "paid"),
                                           Decimal(0))),
                    "refundedSek": _q(sum((_refunded_ex(r) for r in rows), Decimal(0))),
                    "outstandingSek": _q(sum((Decimal(r.get("outstandingSek") or 0) for r in rows), Decimal(0))),
                    "overdueSek": _q(sum((Decimal(r.get("outstandingSek") or 0) for r in overdue), Decimal(0))),
                    "lateFeesSek": _q(sum((Decimal(r.get("lateFeeSek") or 0) for r in rows), Decimal(0))),
                    "interestSek": _q(sum((Decimal(r.get("interestSek") or 0) for r in rows), Decimal(0)))},
        "invoices": shown,
    }


def rebuild(req) -> tuple[int, dict]:
    """Recomputes a date range (finance-rollup, asynchronously): after a
    changed allocation, or when a night was missed.
    Requests older than the Lambda logs' retention get no request counts."""
    first, last = _range(req.body or {})
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    if last > yesterday:
        last = yesterday
    if first > last:
        raise ApiError(400, "validation_failed", "There are only figures up to yesterday. Pick an earlier start.",
                       fields={"from": "Pick yesterday or earlier."})
    if (date.fromisoformat(last) - date.fromisoformat(first)).days >= 92:
        raise ApiError(400, "validation_failed", "Pick at most 92 days at a time.",
                       fields={"to": "Pick an end date at most 92 days after the start."})
    arn = env("FINANCE_ROLLUP_FUNCTION_ARN")
    client("lambda").invoke(FunctionName=arn, InvocationType="Event",
                            Payload=json.dumps({"from": first, "to": last, "requestedBy": req.actor}).encode("utf-8"))
    log.info(json.dumps({"financeRebuild": {"from": first, "to": last}, "actor": req.actor}))
    return 202, {"from": first, "to": last, "status": "started"}


def stripe_sync(req) -> tuple[int, dict]:
    """Re-reads every customer's invoices from Stripe into the ledger (for
    webhook deliveries that were missed)."""
    from .billing import record_invoice, stripe_request
    summary = {"tenants": 0, "invoices": 0, "booked": 0, "errors": []}
    for profile in _all_profiles():
        billing = profile.get("billing") if isinstance(profile.get("billing"), dict) else {}
        customer_id = billing.get("customerId")
        if not customer_id:
            continue
        summary["tenants"] += 1
        try:
            after = None
            while True:
                params = {"customer": customer_id, "limit": 100}
                if after:
                    params["starting_after"] = after
                page = stripe_request("GET", "/invoices", params)
                for invoice in page.get("data") or []:
                    after = invoice["id"]               # also past a draft, or the next page repeats it
                    if invoice.get("status") == "draft":
                        continue
                    summary["invoices"] += 1
                    summary["booked"] += len(record_invoice(profile["tenantId"], invoice))
                if not page.get("has_more") or not after:
                    break
        except ApiError as e:
            summary["errors"].append(f"{profile.get('name')}: {e.message}"[:300])
    log.info(json.dumps({"stripeSync": summary, "actor": req.actor}, default=str))
    return 200, {"sync": summary}
