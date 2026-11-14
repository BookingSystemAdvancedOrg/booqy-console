"""The customers' agreements and their monthly invoices, in arrears.

One Stripe Customer per restaurant company on the PLATFORM account; no
Stripe subscriptions. The agreement lives on PROFILE.billing: status
(active, ended), startsAt, endsAt, terms (trial = try-out period: leaves
with the current period and becomes a subscription after
BILLING_TRIAL_MONTHS; subscription = BILLING_NOTICE_MONTHS notice),
priceSek (own monthly price, else the plan's; kept while on Free as the
price after it), collectionMethod,
lastInvoicedPeriodEnd, offboardAtEnd, priceHistory ([{from, monthlySek,
planName, exact?}]: a change applies from the next period; an `exact` one,
a move onto or off the Free plan, from its own day, pro rata),
freeUntil / freeThenPlanId / freeSince / freeNoticeFor (the Free plan:
its last free day, none = no end date, the plan after it, the day it began
and the end date the owner was told about), freeSwitchAgreementPending
(the day a switch off Free should have started an agreement that has not
started yet: retried daily), previous (earlier agreements,
[{startsAt, endsAt}], that ended but are not invoiced in full yet: a
customer who leaves and comes back in the same period pays for both
stretches on the same invoice).

Billing periods run from the 25th to the 24th. On the 25th (financeTask
"invoice", EventBridge Scheduler) every agreement that ran in the period
just ended gets one Stripe invoice: the monthly price (pro rata by days
for a part period), plus any pending late fee or interest items; 25 % VAT
on every line. SMS are included in the price: they are counted (the
finance table) and their AWS cost shows on the Finance page, but never
invoiced. A period with nothing to charge (Free) gets no invoice. Emailed invoices are due BILLING_DAYS_UNTIL_DUE
days later; a card on file is charged at once. The webhook writes the
ledger row and the revenue; reminders, late fee, interest and suspension
(dunning_task) act on the invoices. The ledger rows mirror those
platform-stripe-webhook writes (application shared/billing.py), with the
same booking flags, so both can write safely.
"""

import json
import time
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal

from botocore.exceptions import BotoCoreError, ClientError

from . import validation as v
from .core import (ApiError, client, env, log, now_iso, query_all, tenant_table, to_ddb,
                   to_ddb_value, write_audit)
from .stripe_connect import stripe_request
from .tenants import (FREE_NOTICE_DAYS, FREE_PLAN_ID, add_months, apply_plan, ensure_billing_map, get_plan, get_profile, offboard_tenant,
                      resume_tenant, suspend_tenant, tkey)

COLLECTION_METHODS = ("send_invoice", "charge_automatically")
TERMS = ("trial", "subscription")
SUBSCRIPTION_FIELDS = ("subscriptionId", "status", "priceId", "planId", "mrrSek", "collectionMethod",
                       "currentPeriodStart", "currentPeriodEnd", "cancelAt", "canceledAt", "pauseCollection",
                       "trialEnd")
CENTS = Decimal("0.01")


def finance_table() -> str:
    return env("FINANCE_TABLE_NAME")


def _iso(ts) -> str | None:
    if not isinstance(ts, (int, float)) or ts <= 0:
        return None
    return datetime.fromtimestamp(int(ts), timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sek(minor) -> Decimal:
    if not isinstance(minor, (int, float)):
        return Decimal("0.00")
    return (Decimal(int(minor)) / Decimal(100)).quantize(CENTS, rounding=ROUND_HALF_UP)


def _id(value):
    if isinstance(value, dict):
        value = value.get("id")
    return value if isinstance(value, str) and value else None


def _billing(profile: dict) -> dict:
    raw = profile.get("billing")
    return dict(raw) if isinstance(raw, dict) else {}


# ------------------------------------------------------------- the customer
def _customer_params(tenant_id: str, profile: dict) -> dict:
    address = profile.get("address") or {}
    params = {
        "name": profile.get("legalName") or profile.get("name"),
        "email": profile.get("billingEmail") or profile.get("ownerEmail") or profile.get("contactEmail"),
        "description": f"{profile.get('name')} ({profile.get('slug')})",
        "preferred_locales[0]": "sv-SE",
        "metadata[tenantId]": tenant_id,
        "metadata[slug]": profile.get("slug") or "",
        "metadata[environment]": env("ENVIRONMENT", "dev"),
    }
    if profile.get("orgNumber"):
        params["metadata[orgNumber]"] = profile["orgNumber"]
    if address.get("street"):
        params.update({"address[line1]": address.get("street"), "address[postal_code]": address.get("postalCode") or "",
                       "address[city]": address.get("city") or "", "address[country]": address.get("country") or "SE"})
    return {k: val for k, val in params.items() if val}


def ensure_customer(tenant_id: str, profile: dict, actor: str) -> str:
    """The tenant's Stripe customer, created on first use and claimed in the
    same transaction as the first PROFILE.billing write."""
    existing = _billing(profile).get("customerId")
    if existing:
        return existing
    customer = stripe_request("POST", "/customers", _customer_params(tenant_id, profile),
                              idempotency_key=f"customer-{tenant_id}")
    customer_id = customer["id"]
    if profile.get("vatNumber"):
        try:
            stripe_request("POST", f"/customers/{customer_id}/tax_ids", {"type": "eu_vat", "value": profile["vatNumber"]},
                           idempotency_key=f"customer-vat-{tenant_id}")
        except ApiError as e:
            log.warning("VAT number not registered on %s: %s", customer_id, e.message)
    ensure_billing_map(tenant_id)
    try:
        client("dynamodb").transact_write_items(TransactItems=[
            {"Put": {"TableName": tenant_table(), "ConditionExpression": "attribute_not_exists(PK)",
                     "Item": to_ddb({"PK": f"STRIPE_CUSTOMER#{customer_id}", "SK": "TENANT", "tenantId": tenant_id})}},
            {"Update": {"TableName": tenant_table(), "Key": tkey(tenant_id),
                        "UpdateExpression": "SET billing.customerId = :c, billing.customerCreatedAt = :n, "
                                            "billing.customerCreatedBy = :by, updatedAt = :n",
                        "ConditionExpression": "attribute_exists(PK) AND attribute_not_exists(billing.customerId)",
                        "ExpressionAttributeValues": {":c": {"S": customer_id}, ":n": {"S": now_iso()}, ":by": {"S": actor}}}},
        ])
    except ClientError as e:
        if e.response["Error"]["Code"] == "TransactionCanceledException":
            # Someone else just did it: use what the profile now says.
            current = _billing(get_profile(tenant_id)).get("customerId")
            if current:
                return current
        raise
    write_audit(tenant_id, "stripe_customer_created", actor, {"customerId": customer_id})
    return customer_id


# ------------------------------------------------------------- the ledger
def _invoice_row(tenant_id: str, invoice: dict) -> dict:
    transitions = invoice.get("status_transitions") or {}
    metadata = invoice.get("metadata") or {}
    total, ex = invoice.get("total") or 0, invoice.get("total_excluding_tax")
    if ex is None:
        ex = total - (invoice.get("tax") or 0)
    created_day = (_iso(invoice.get("created")) or now_iso())[:10]
    return {
        "PK": f"TENANT#{tenant_id}", "SK": f"INVOICE#{created_day}#{invoice['id']}",
        "invoiceId": invoice["id"], "number": invoice.get("number"), "status": invoice.get("status"),
        "customerId": _id(invoice.get("customer")), "subscriptionId": _id(invoice.get("subscription")),
        "currency": (invoice.get("currency") or "sek").lower(),
        "subtotalSek": sek(ex), "taxSek": sek(invoice.get("tax") or 0), "totalSek": sek(total),
        "amountPaidSek": sek(invoice.get("amount_paid") or 0), "amountDueSek": sek(invoice.get("amount_due") or 0),
        "amountRemainingSek": sek(invoice.get("amount_remaining") or 0),
        "createdAt": _iso(invoice.get("created")), "finalizedAt": _iso(transitions.get("finalized_at")),
        "paidAt": _iso(transitions.get("paid_at")), "voidedAt": _iso(transitions.get("voided_at")),
        "uncollectibleAt": _iso(transitions.get("marked_uncollectible_at")),
        # The billed period (25th to 24th) is in the metadata, like the webhook
        # reads it; Stripe's own period of a one-off invoice is its creation.
        "dueDate": _iso(invoice.get("due_date")),
        "periodStart": metadata.get("periodStart") or _iso(invoice.get("period_start")),
        "periodEnd": metadata.get("periodEnd") or _iso(invoice.get("period_end")),
        "hostedInvoiceUrl": invoice.get("hosted_invoice_url"),
        "invoicePdf": invoice.get("invoice_pdf"), "paidOutOfBand": bool(invoice.get("paid_out_of_band")),
        "collectionMethod": invoice.get("collection_method"),
        # Read from Stripe now: a webhook event created before this is older
        # news and must not overwrite it (the webhook's own guard).
        "eventCreated": int(time.time()),
        "updatedAt": now_iso(),
    }


def _book(key: dict, flag: str, tenant_id: str, day: str, field: str, amount: Decimal) -> bool:
    if not amount:
        return False
    try:
        client("dynamodb").transact_write_items(TransactItems=[
            {"Update": {"TableName": finance_table(), "Key": {"PK": {"S": key["PK"]}, "SK": {"S": key["SK"]}},
                        "UpdateExpression": "SET #f = :d",
                        "ConditionExpression": "attribute_exists(PK) AND attribute_not_exists(#f)",
                        "ExpressionAttributeNames": {"#f": flag}, "ExpressionAttributeValues": {":d": {"S": day}}}},
            {"Update": {"TableName": finance_table(),
                        "Key": {"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"DAY#{day}"}},
                        "UpdateExpression": "ADD #a :a SET bookedAt = :now",
                        "ExpressionAttributeNames": {"#a": field},
                        "ExpressionAttributeValues": {":a": {"N": str(amount)}, ":now": {"S": now_iso()}}}},
        ])
    except ClientError as e:
        if e.response["Error"]["Code"] == "TransactionCanceledException":
            return False
        raise
    return True


def record_invoice(tenant_id: str, invoice: dict) -> list[str]:
    """Upserts the ledger row (never over a newer webhook write) and books
    revenue the way the webhook does. Returns what was booked."""
    row = _invoice_row(tenant_id, invoice)
    key = {"PK": row["PK"], "SK": row["SK"]}
    names, values, sets = {}, {}, []
    for i, (k, val) in enumerate(row.items()):
        if k in ("PK", "SK") or val is None:
            continue
        names[f"#f{i}"] = k
        values[f":v{i}"] = to_ddb_value(val)
        sets.append(f"#f{i} = :v{i}")
    client("dynamodb").update_item(TableName=finance_table(), Key={"PK": {"S": key["PK"]}, "SK": {"S": key["SK"]}},
                                   UpdateExpression="SET " + ", ".join(sets),
                                   ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    booked = []
    status = row["status"]
    if status in ("open", "paid", "uncollectible", "void"):
        day = (row["finalizedAt"] or row["createdAt"] or now_iso())[:10]
        if _book(key, "bookedInvoiced", tenant_id, day, "invoicedSek", row["subtotalSek"]):
            booked.append("invoiced")
    if status == "paid" and row["amountPaidSek"]:
        total = invoice.get("total") or 0
        paid_ex = row["amountPaidSek"]
        if total > 0:
            paid_ex = (Decimal(int(invoice.get("amount_paid") or 0)) * row["subtotalSek"]
                       / Decimal(int(total))).quantize(CENTS, rounding=ROUND_HALF_UP)
        if _book(key, "bookedPaid", tenant_id, (row["paidAt"] or now_iso())[:10], "paidSek", paid_ex):
            booked.append("paid")
    if status == "void":
        if _book(key, "bookedVoided", tenant_id, (row["voidedAt"] or now_iso())[:10], "invoicedSek", -row["subtotalSek"]):
            booked.append("voided")
    return booked


def list_invoices(tenant_id: str, limit: int = 60) -> list[dict]:
    rows = query_all(TableName=finance_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :i)",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":i": {"S": "INVOICE#"}},
                     ScanIndexForward=False)
    out = []
    for r in rows[:limit]:
        total = r.get("totalSek") or Decimal(0)
        remaining = r.get("amountRemainingSek") or Decimal(0)
        out.append({
            "invoiceId": r.get("invoiceId"), "number": r.get("number"), "status": r.get("status"),
            "month": (r.get("periodEnd") or r.get("createdAt") or "")[:7] or None,
            "daysLate": days_late(r), "remindersSent": int(r.get("remindersSent") or 0),
            "lastReminderAt": r.get("lastReminderAt"), "lateFeeSek": r.get("lateFeeSek"),
            "interestSek": r.get("interestSek"), "collectionMethod": r.get("collectionMethod"),
            "subtotalSek": r.get("subtotalSek"), "taxSek": r.get("taxSek"), "totalSek": total,
            "amountPaidSek": r.get("amountPaidSek"), "amountRemainingSek": remaining,
            "outstandingSek": (remaining * (r.get("subtotalSek") or Decimal(0)) / total).quantize(CENTS)
            if total and r.get("status") in ("open", "uncollectible") else Decimal(0),
            "createdAt": r.get("createdAt"), "dueDate": r.get("dueDate"), "paidAt": r.get("paidAt"),
            "periodStart": r.get("periodStart"), "periodEnd": r.get("periodEnd"),
            "hostedInvoiceUrl": r.get("hostedInvoiceUrl"), "invoicePdf": r.get("invoicePdf"),
            "paidOutOfBand": r.get("paidOutOfBand", False),
        })
    return out


# ------------------------------------------------------------- periods: the 25th to the 24th
SV_MONTHS = ("jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec")


def period_of(day: date) -> tuple[date, date]:
    """The billing period a day falls in: from the 25th to the 24th."""
    start = day.replace(day=25) if day.day >= 25 else (day.replace(day=1) - timedelta(days=1)).replace(day=25)
    end = (start + timedelta(days=31)).replace(day=24)
    return start, end


def next_period(end: date) -> tuple[date, date]:
    return period_of(end + timedelta(days=1))


def period_days(start: date, end: date) -> int:
    return (end - start).days + 1


def period_text(start: date, end: date) -> str:
    return f"{start.day} {SV_MONTHS[start.month - 1]} till {end.day} {SV_MONTHS[end.month - 1]} {end.year}"


def active_days(starts_at: date | None, ends_at: date | None, start: date, end: date) -> int:
    """Days of the period the agreement ran: from its start to its end."""
    if starts_at is None:
        return 0
    a = max(start, starts_at)
    b = min(end, ends_at) if ends_at else end
    return max(0, (b - a).days + 1)


def stints(billing: dict) -> list[tuple[date, date | None]]:
    """The stretches to invoice: earlier agreements still waiting for
    their last invoice, then the current one (open-ended if no end)."""
    out = []
    for s in billing.get("previous") or []:
        a, b = _date(s.get("startsAt")), _date(s.get("endsAt"))
        if a and b:
            out.append((a, b))
    starts_at = _date(billing.get("startsAt"))
    if starts_at:
        out.append((starts_at, _date(billing.get("endsAt"))))
    return out


def fee_for(price_sek: int, starts_at: date | None, ends_at: date | None, start: date, end: date) -> Decimal:
    """The monthly price for the period, pro rata by days for a part period."""
    return prorate(price_sek, active_days(starts_at, ends_at, start, end), period_days(start, end))


def prorate(price_sek: int, active: int, days: int) -> Decimal:
    """The monthly price for `active` of the period's `days`."""
    if active <= 0:
        return Decimal("0.00")
    if active >= days:
        return Decimal(int(price_sek)).quantize(CENTS)
    return (Decimal(int(price_sek)) * Decimal(active) / Decimal(days)).quantize(CENTS, rounding=ROUND_HALF_UP)


def _add_months(when: datetime, months: int) -> datetime:
    month = when.month - 1 + months
    year = when.year + month // 12
    month = month % 12 + 1
    last = [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    return when.replace(year=year, month=month, day=min(when.day, last))


def _date(iso) -> date | None:
    if not iso:
        return None
    try:
        return date.fromisoformat(str(iso)[:10])
    except ValueError:
        return None


# ------------------------------------------------------------- the agreement on PROFILE.billing
def _write_billing(tenant_id: str, fields: dict) -> None:
    """SET the given billing.<field>s (None = REMOVE)."""
    ensure_billing_map(tenant_id)
    names, values, sets, removes = {"#b": "billing"}, {}, [], []
    for i, (key, value) in enumerate(fields.items()):
        names[f"#f{i}"] = key
        if value is None:
            removes.append(f"#b.#f{i}")
        else:
            values[f":v{i}"] = to_ddb_value(value)
            sets.append(f"#b.#f{i} = :v{i}")
    values[":now"] = {"S": now_iso()}
    sets.append("#b.updatedAt = :now")
    expression = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
    client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id), UpdateExpression=expression,
                                   ConditionExpression="attribute_exists(PK)",
                                   ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def plan_of(profile: dict) -> dict:
    return get_plan(profile.get("planId") or "") or {}


def monthly_price(profile: dict, plan: dict | None = None) -> int:
    """What the customer pays per period, ex VAT: nothing on Free, else
    their own price or the plan's."""
    plan = plan if plan is not None else plan_of(profile)
    if plan.get("free"):
        return 0
    billing = _billing(profile)
    if billing.get("priceSek") is not None:
        return int(billing["priceSek"])
    return int(plan.get("priceSek") or 0)


def record_price(tenant_id: str, profile: dict, plan: dict | None = None, *, on: date | None = None,
                 exact: bool = False) -> None:
    """Remembers the price in force from `on` (today): the period running
    keeps the price it began with, a change applies from the next one.
    `exact` (onto or off Free): from `on` itself, the days before and after
    it pro rata."""
    plan = plan if plan is not None else plan_of(profile)
    day = (on or datetime.now(timezone.utc).date()).isoformat()
    history = [h for h in _billing(profile).get("priceHistory") or [] if h.get("from") != day]
    entry = {"from": day, "monthlySek": monthly_price(profile, plan), "planName": plan.get("name") or profile.get("planId") or ""}
    if exact:
        entry["exact"] = True
    history.append(entry)
    _write_billing(tenant_id, {"priceHistory": sorted(history, key=lambda h: h["from"])})


def price_drift(profile: dict) -> bool:
    """The prices in force differ from the last ones recorded (or none are)."""
    history = sorted(_billing(profile).get("priceHistory") or [], key=lambda h: h.get("from") or "")
    if not history:
        return True
    plan, last = plan_of(profile), history[-1]
    return (int(last.get("monthlySek") or 0) != monthly_price(profile, plan)
            or (last.get("planName") or "") != (plan.get("name") or profile.get("planId") or ""))


def prices_for(billing: dict, first_day: date) -> dict | None:
    """The prices a period is invoiced at: those in force on its first
    active day. None for an agreement from before price history."""
    history = sorted(billing.get("priceHistory") or [], key=lambda h: h.get("from") or "")
    before = [h for h in history if (h.get("from") or "") <= first_day.isoformat()]
    return before[-1] if before else (history[0] if history else None)


def price_on(billing: dict, first_day: date, day: date) -> dict | None:
    """The price entry for one day of a period whose first active day is
    `first_day`: the one in force then, or an exact change (Free) since."""
    base = prices_for(billing, first_day)
    later = [h for h in billing.get("priceHistory") or [] if h.get("exact")
             and first_day.isoformat() < (h.get("from") or "") <= day.isoformat()]
    return max([h for h in [base, *later] if h], key=lambda h: h.get("from") or "", default=None)


def phase(billing: dict, today: date | None = None) -> str:
    """none | scheduled (starts later) | active | ending (an end date is
    set) | ended."""
    today = today or datetime.now(timezone.utc).date()
    status = billing.get("status")
    if status == "ended":
        return "ended"
    if status != "active":
        return "none"
    starts_at, ends_at = _date(billing.get("startsAt")), _date(billing.get("endsAt"))
    if starts_at and starts_at > today:
        return "scheduled"
    if ends_at:
        return "ending"
    return "active"


def agreement_running(billing: dict, today: date | None = None) -> bool:
    return phase(billing, today) in ("scheduled", "active", "ending")


def migrate_legacy(tenant_id: str, profile: dict, actor: str) -> dict | None:
    """A Stripe subscription from the first version (billed in advance):
    cancelled without a final invoice, its open advance invoice voided, and
    the agreement continues in arrears from the same start date."""
    billing = _billing(profile)
    sub_id = billing.get("subscriptionId")
    if not sub_id:
        return None
    customer_id = billing.get("customerId")
    voided = []
    if billing.get("status") not in ("canceled", "incomplete_expired"):
        stripe_request("DELETE", f"/subscriptions/{sub_id}", {"invoice_now": "false", "prorate": "false"})
        if customer_id:
            page = stripe_request("GET", "/invoices", {"customer": customer_id, "subscription": sub_id, "status": "open", "limit": 100})
            for invoice in page.get("data") or []:
                stripe_request("POST", f"/invoices/{invoice['id']}/void", {})
                voided.append(invoice["id"])
    started = _date(billing.get("startedAt")) or _date(billing.get("termsSince")) or datetime.now(timezone.utc).date()
    ended = billing.get("status") in ("canceled", "incomplete_expired")
    fields = {
        "status": "ended" if ended else "active", "startsAt": started.isoformat(),
        "endsAt": (_date(billing.get("canceledAt")) or started).isoformat() if ended else None,
        "legacySubscriptionId": sub_id, "subscriptionId": None, "priceId": None, "mrrSek": None,
        "currentPeriodStart": None, "currentPeriodEnd": None, "cancelAt": None, "canceledAt": None,
        "pauseCollection": None, "trialEnd": None, "eventCreated": None,
    }
    _write_billing(tenant_id, fields)
    write_audit(tenant_id, "billing_migrated_to_arrears", actor, {"subscriptionId": sub_id, "voidedInvoices": voided})
    return {"subscriptionId": sub_id, "voided": voided}


# ------------------------------------------------------------- what a period costs
def invoice_plan(profile: dict, start: date, end: date, plan: dict | None = None) -> dict:
    """What one period's invoice would carry for the customer: the monthly
    price for the days the agreement ran, at the price of each day."""
    billing = _billing(profile)
    plan = plan if plan is not None else plan_of(profile)
    ends_at = _date(billing.get("endsAt"))
    days = period_days(start, end)
    active_set: set[date] = set()
    for a, b in stints(billing):
        first, last = max(start, a), min(end, b) if b else end
        while first <= last:
            active_set.add(first)
            first += timedelta(days=1)
    active = len(active_set)
    first_day = min(active_set) if active_set else start
    fallback = {"monthlySek": monthly_price(profile, plan), "planName": plan.get("name") or profile.get("planId") or ""}
    # A plan or price changed during the period applies from the next one;
    # onto or off Free from its own day.
    by_entry: dict = {}
    for day in sorted(active_set):
        entry = price_on(billing, first_day, day) or fallback
        key = (int(entry.get("monthlySek") or 0), entry.get("planName") or "")
        by_entry[key] = by_entry.get(key, 0) + 1
    fee = sum((prorate(price, n, days) for (price, _name), n in by_entry.items()), Decimal("0.00"))
    paid = [(name, n) for (price, name), n in by_entry.items() if price > 0]
    paid_days = sum(n for _name, n in paid)
    last_entry = price_on(billing, first_day, max(active_set)) if active_set else prices_for(billing, start)
    price = int((last_entry or fallback).get("monthlySek") or 0)
    names = list(dict.fromkeys(name for name, _n in paid)) or [(last_entry or fallback).get("planName") or ""]
    period = period_text(start, end)
    fee_text = f"Booqy {' och '.join(names)}, {period}".strip()
    if 0 < paid_days < days:
        fee_text += f" ({paid_days} av {days} dagar)"
    return {
        "periodStart": start.isoformat(), "periodEnd": end.isoformat(), "period": period,
        "days": days, "activeDays": active, "billedDays": paid_days, "monthlySek": price, "feeSek": fee.quantize(CENTS),
        "feeText": fee_text, "totalSek": fee.quantize(CENTS), "final": bool(ends_at and ends_at <= end),
        "nothingToInvoice": fee == 0,
    }


def pending_periods(billing: dict, today: date) -> list[tuple[date, date]]:
    """Complete periods (ended before today) the agreement ran in and that
    are not invoiced yet."""
    ranges = stints(billing)
    if not _date(billing.get("startsAt")) or billing.get("status") not in ("active", "ended"):
        return []
    first = min(a for a, _b in ranges)
    ends_at = _date(billing.get("endsAt"))
    done = _date(billing.get("lastInvoicedPeriodEnd"))
    start, end = period_of(max(first, done + timedelta(days=1)) if done else first)
    out = []
    while end < today:
        if ends_at and start > ends_at:
            break
        out.append((start, end))
        start, end = next_period(end)
    return out


# ------------------------------------------------------------- the Billing tab
def _view(profile: dict, today: date | None = None) -> dict:
    today = today or datetime.now(timezone.utc).date()
    billing = _billing(profile)
    plan = plan_of(profile)
    ph = phase(billing, today)
    since = _parse(billing.get("termsSince"))
    trial_months = int(_env_num("BILLING_TRIAL_MONTHS", "6"))
    view = {
        "customerId": billing.get("customerId"), "status": ph, "subscribed": ph in ("scheduled", "active", "ending"),
        "terms": billing.get("terms") or "subscription", "termsSince": billing.get("termsSince"),
        "trialEndsAt": (_add_months(since, trial_months).isoformat() if billing.get("terms") == "trial" and since and trial_months > 0
                        and ph in ("scheduled", "active") else None),
        "startsAt": billing.get("startsAt"), "endsAt": billing.get("endsAt"),
        "priceSek": int(billing["priceSek"]) if billing.get("priceSek") is not None else None,
        "monthlySek": monthly_price(profile, plan),
        "free": free_view(profile),
        "collectionMethod": billing.get("collectionMethod") or "send_invoice",
        "hasCard": bool(billing.get("defaultPaymentMethod")),
        "pastDueSince": billing.get("pastDueSince"), "autoSuspended": bool(billing.get("autoSuspended")),
        "lastPaidAt": billing.get("lastPaidAt"), "lastPaymentFailedAt": billing.get("lastPaymentFailedAt"),
        "startedAt": billing.get("startedAt"), "startedBy": billing.get("startedBy"),
        "lastInvoicedPeriodEnd": billing.get("lastInvoicedPeriodEnd"), "offboardAtEnd": bool(billing.get("offboardAtEnd")),
        "noticeMonths": int(_env_num("BILLING_NOTICE_MONTHS", "3")), "trialMonths": trial_months,
        "daysUntilDue": int(env("BILLING_DAYS_UNTIL_DUE", "30")), "suspendAfterDays": int(env("BILLING_SUSPEND_AFTER_DAYS", "14")),
        "plan": {"planId": plan.get("planId"), "name": plan.get("name"), "priceSek": plan.get("priceSek"),
                 "free": bool(plan.get("free"))},
        "legacySubscriptionId": billing.get("legacySubscriptionId"), "pendingSubscriptionId": billing.get("subscriptionId"),
        "nextInvoice": None, "pendingPeriods": len(pending_periods(billing, today)),
        "previous": [{"startsAt": s.get("startsAt"), "endsAt": s.get("endsAt")} for s in billing.get("previous") or []],
    }
    if ph in ("active", "ending") or (ph == "scheduled" and view["previous"]):
        start, end = period_of(today)
        current = invoice_plan(profile, start, end, plan)
        view["nextInvoice"] = {**current, "date": (end + timedelta(days=1)).isoformat(),
                               "dueDate": (end + timedelta(days=1 + view["daysUntilDue"])).isoformat()
                               if view["collectionMethod"] == "send_invoice" else (end + timedelta(days=1)).isoformat()}
    return view


def get_billing(req) -> tuple[int, dict]:
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    return 200, {"billing": _view(profile), "invoices": list_invoices(tenant_id)}


def _start_day(f: v.Fields, field: str = "startDate") -> date | None:
    raw = f.text(field, max_len=10)
    if not raw:
        return None
    try:
        day = date.fromisoformat(raw)
    except ValueError:
        f.fail(field, "Use yyyy-mm-dd")
        return None
    if day > datetime.now(timezone.utc).date() + timedelta(days=365):
        f.fail(field, "At most a year ahead")
    return day


def start_subscription(req) -> tuple[int, dict]:
    """Starts the agreement (Billing tab): from `startDate` (today by
    default; a past date backdates the first invoice, a future one
    schedules it), on `terms` (trial or subscription), at `priceSek` (the
    customer's own monthly price) and `collectionMethod`."""
    tenant_id = req.path["tenantId"]
    f = v.Fields(req.body)
    method = f.text("collectionMethod", max_len=30) or "send_invoice"
    if method not in COLLECTION_METHODS:
        f.fail("collectionMethod", "send_invoice (emailed invoice) or charge_automatically (card on file)")
    start_day = _start_day(f)
    terms = f.text("terms", max_len=20)
    if terms is not None and terms not in TERMS:
        f.fail("terms", "trial (try-out period) or subscription")
    price_sek = f.integer("priceSek", minimum=0, maximum=1_000_000)
    f.done()
    profile = get_profile(tenant_id)
    view = start_for(tenant_id, profile, actor=req.actor, method=method, start_day=start_day.isoformat() if start_day else None,
                     price_sek=price_sek, terms=terms)
    return 201, {"billing": view}


def start_for(tenant_id: str, profile: dict, *, actor: str, method: str = "send_invoice", start_day: str | None = None,
              price_sek: int | None = None, terms: str | None = None) -> dict:
    """Creates the Stripe customer (if needed) and the agreement. Nothing
    is invoiced now: the first invoice comes on the 25th after the first
    period, in arrears. A customer whose agreement has ended (but is not
    invoiced in full yet) can start again from the day after it ended: the
    ended stretch moves to `previous` and both are on the next invoice."""
    if profile.get("status") not in ("provisioning", "active"):
        raise ApiError(409, "invalid_status", f"Not possible while the customer is {profile.get('status')}",
                       currentStatus=profile.get("status"))
    billing = _billing(profile)
    today = datetime.now(timezone.utc).date()
    first_day = date.fromisoformat(start_day) if start_day else today
    done = _date(billing.get("lastInvoicedPeriodEnd"))
    previous = list(billing.get("previous") or [])
    old_start, old_end = _date(billing.get("startsAt")), _date(billing.get("endsAt"))
    if agreement_running(billing, today):
        if not (old_end and old_end < today and old_end < first_day):
            hint = (f" until {old_end.isoformat()}: undo the cancellation with Keep the agreement, or start a new one "
                    f"once it has ended" if old_end else "")
            raise ApiError(409, "already_subscribed", f"The customer already has a running agreement{hint}")
        if old_start and (not done or old_end > done):
            previous.append({"startsAt": max(old_start, done + timedelta(days=1)).isoformat() if done else old_start.isoformat(),
                             "endsAt": old_end.isoformat()})
    if done and first_day <= done:
        nxt = (done + timedelta(days=1)).isoformat()
        raise ApiError(409, "already_invoiced", f"The period to {done.isoformat()} is already invoiced: start on {nxt} or later",
                       earliestStart=nxt)
    plan = plan_of(profile)
    if not plan:
        raise ApiError(409, "no_plan", "The customer has no plan - set one on the Plan tab first")
    if plan.get("free"):
        # Free: the own price stays as the price after it.
        price_sek = int(billing["priceSek"]) if billing.get("priceSek") is not None else None
    elif price_sek is not None and int(price_sek) == int(plan.get("priceSek") or -1):
        price_sek = None
    elif price_sek is None and billing.get("priceSek") is not None:
        price_sek = int(billing["priceSek"])
    terms = terms or billing.get("terms") or "subscription"
    customer_id = ensure_customer(tenant_id, profile, actor)
    if method == "charge_automatically":
        customer = stripe_request("GET", f"/customers/{customer_id}")
        if not ((customer.get("invoice_settings") or {}).get("default_payment_method")):
            raise ApiError(409, "no_card", "No card on file yet - create a card link, let the restaurant add a card, "
                                           "then start with charge automatically (or invoice by email instead)")
    starts = first_day.isoformat()
    _write_billing(tenant_id, {
        "status": "active", "startsAt": starts, "endsAt": None, "terms": terms, "termsSince": f"{starts}T00:00:00Z",
        "priceSek": price_sek, "collectionMethod": method, "startedAt": now_iso(), "startedBy": actor,
        "lastInvoicedPeriodEnd": done.isoformat() if done else None, "previous": previous or None,
        "offboardAtEnd": None, "autoSuspended": None, "endedAt": None,
        "cancelRequestedAt": None, "cancelRequestedBy": None,
    })
    # From the start, or today for a later start: a price changed before a
    # scheduled start is the one it starts with.
    record_price(tenant_id, get_profile(tenant_id), plan, on=min(first_day, today))
    write_audit(tenant_id, "subscription_started", actor,
                {"startsAt": starts, "planId": plan.get("planId"), "collectionMethod": method, "terms": terms,
                 "priceSek": price_sek, "inArrears": True, "previous": previous or None})
    return _view(get_profile(tenant_id))


def end_date_for(billing: dict, today: date) -> date:
    """When a cancellation takes effect: a try-out with the current period
    (the 24th), a subscription BILLING_NOTICE_MONTHS periods later."""
    start, end = period_of(today)
    if (billing.get("terms") or "subscription") == "trial":
        return end
    for _ in range(int(_env_num("BILLING_NOTICE_MONTHS", "3"))):
        start, end = next_period(end)
    return end


def update_subscription(req) -> tuple[int, dict]:
    """action: cancel (ends with the terms: a try-out with the current
    period, a subscription after the notice period; `offboardAtEnd`
    default true), cancel_now (ends today, the days used are invoiced on
    the next 25th), keep (undo a cancellation), convert (try-out ->
    subscription), use_card (charge the card the restaurant added)."""
    tenant_id = req.path["tenantId"]
    f = v.Fields(req.body)
    action = f.text("action", required=True, max_len=20)
    offboard_at_end = f.boolean("offboardAtEnd")
    f.done()
    profile = get_profile(tenant_id)
    billing = _billing(profile)
    customer_id = billing.get("customerId")
    today = datetime.now(timezone.utc).date()
    if not agreement_running(billing, today):
        raise ApiError(409, "not_subscribed", "The customer has no running agreement")
    details: dict = {}
    if action == "cancel":
        ends = end_date_for(billing, today)
        _write_billing(tenant_id, {"endsAt": ends.isoformat(), "offboardAtEnd": offboard_at_end is not False,
                                   "cancelRequestedAt": now_iso(), "cancelRequestedBy": req.actor})
        details = {"endsAt": ends.isoformat(), "terms": billing.get("terms") or "subscription",
                   "offboardAtEnd": offboard_at_end is not False}
    elif action == "cancel_now":
        _write_billing(tenant_id, {"endsAt": today.isoformat(), "offboardAtEnd": offboard_at_end is True,
                                   "cancelRequestedAt": now_iso(), "cancelRequestedBy": req.actor})
        details = {"endsAt": today.isoformat(), "offboardAtEnd": offboard_at_end is True}
    elif action == "keep":
        _write_billing(tenant_id, {"endsAt": None, "offboardAtEnd": None, "cancelRequestedAt": None, "cancelRequestedBy": None})
    elif action == "convert":
        if (billing.get("terms") or "subscription") != "trial":
            raise ApiError(409, "not_trial", "The customer is already on a subscription")
        _write_billing(tenant_id, {"terms": "subscription", "termsSince": now_iso(), "convertedBy": req.actor})
        details = {"from": "trial", "to": "subscription"}
    elif action == "use_card":
        if not customer_id:
            raise ApiError(409, "no_card", "The restaurant has not added a card yet - send them the card link")
        methods = stripe_request("GET", "/payment_methods", {"customer": customer_id, "type": "card", "limit": 1})
        cards = methods.get("data") or []
        if not cards:
            raise ApiError(409, "no_card", "The restaurant has not added a card yet - send them the card link")
        card = cards[0]["id"]
        stripe_request("POST", f"/customers/{customer_id}", {"invoice_settings[default_payment_method]": card})
        _write_billing(tenant_id, {"collectionMethod": "charge_automatically", "defaultPaymentMethod": card})
        details = {"paymentMethod": card}
    else:
        raise ApiError(400, "validation_failed", "Unknown action",
                       fields={"action": "cancel, cancel_now, keep, convert or use_card"})
    write_audit(tenant_id, f"subscription_{action}", req.actor, details)
    return 200, {"billing": _view(get_profile(tenant_id))}


def card_link(req) -> tuple[int, dict]:
    """A Stripe Checkout page (setup mode) where the restaurant adds a card;
    afterwards "use_card" switches the agreement to charge it."""
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    customer_id = ensure_customer(tenant_id, profile, req.actor)
    base = env("PLATFORM_ADMIN_APP_URL").rstrip("/")
    session = stripe_request("POST", "/checkout/sessions", {
        "mode": "setup", "customer": customer_id, "currency": "sek", "payment_method_types[0]": "card",
        "locale": "sv", "success_url": f"{base}/tenants/{tenant_id}?tab=billing&card=added",
        "cancel_url": f"{base}/tenants/{tenant_id}?tab=billing", "metadata[tenantId]": tenant_id})
    write_audit(tenant_id, "card_link_created", req.actor, {"customerId": customer_id})
    return 200, {"url": session["url"], "expiresAt": _iso(session.get("expires_at"))}


# ------------------------------------------------------------- hooks from tenants
def after_plan_change(tenant_id: str, profile: dict, plan: dict, actor: str, *, exact: bool = False,
                      on: date | None = None, before: dict | None = None) -> dict | None:
    """A changed plan or price applies from the next period: the one
    running is invoiced at the prices it began with (priceHistory). Onto or
    off Free (`exact`) applies from `on` (today), pro rata. An agreement
    from before price history first gets the price it ran at (`before`,
    the profile before the change) from its start, so its days before the
    change keep that price."""
    billing = _billing(profile)
    if not agreement_running(billing):
        return None
    today = on or datetime.now(timezone.utc).date()
    if exact and before is not None and not billing.get("priceHistory"):
        started = _date(billing.get("startsAt")) or today
        if started < today:
            record_price(tenant_id, before, plan_of(before), on=started)
            profile = get_profile(tenant_id)
    record_price(tenant_id, profile, plan, on=today, exact=exact)
    _start, end = period_of(today)
    return {"monthlySek": monthly_price(profile, plan), "priceSek": int(billing["priceSek"]) if billing.get("priceSek") is not None else None,
            "from": today.isoformat() if exact else (end + timedelta(days=1)).isoformat()}


def cancel_for_offboarding(tenant_id: str, profile: dict, actor: str) -> dict | None:
    """Offboarded today: the agreement ends today and the days used are
    invoiced on the next 25th. A legacy Stripe subscription is cancelled."""
    billing = _billing(profile)
    legacy = None
    if billing.get("subscriptionId"):
        try:
            legacy = migrate_legacy(tenant_id, profile, actor)
            billing = _billing(get_profile(tenant_id))
        except ApiError as e:
            log.warning("legacy subscription of %s not cancelled: %s", tenant_id, e.message)
            legacy = {"error": e.message}
    if not agreement_running(billing):
        return legacy
    today = datetime.now(timezone.utc).date().isoformat()
    _write_billing(tenant_id, {"endsAt": today if not billing.get("endsAt") or billing["endsAt"] > today else billing["endsAt"],
                               "offboardAtEnd": None, "cancelRequestedAt": now_iso(), "cancelRequestedBy": actor})
    write_audit(tenant_id, "subscription_cancelled", actor, {"endsAt": today, "reason": "offboarding"})
    return {"endsAt": today, "legacy": legacy}


# ------------------------------------------------------------- invoicing in arrears
def _all_profiles() -> list[dict]:
    return query_all(TableName=tenant_table(), IndexName="GSI1", KeyConditionExpression="GSI1PK = :t",
                     ExpressionAttributeValues={":t": {"S": "TENANT"}})


def _already_invoiced(tenant_id: str, end: date) -> bool:
    rows = query_all(TableName=finance_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :i)",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":i": {"S": "INVOICE#"}})
    return any((r.get("periodEnd") or "")[:10] == end.isoformat() and r.get("status") != "void" for r in rows)


def _invoiced_to(billing: dict, end: date) -> dict:
    """The fields after the period to `end` is invoiced: earlier
    agreements that ended in it (or before) are done."""
    left = [s for s in billing.get("previous") or [] if (_date(s.get("endsAt")) or end) > end]
    out = {"lastInvoicedPeriodEnd": end.isoformat(), "previous": left or None}
    history = sorted(billing.get("priceHistory") or [], key=lambda h: h.get("from") or "")
    if history:
        nxt = (end + timedelta(days=1)).isoformat()
        keep = max((i for i, h in enumerate(history) if (h.get("from") or "") <= nxt), default=0)
        out["priceHistory"] = history[keep:]
    return out


def _stripe_period_invoice(customer_id: str, tenant_id: str, end: date) -> dict | None:
    """The period's invoice if Stripe already has it (a run that stopped
    after creating it, or a retry after Stripe keeps idempotency keys for
    24 hours): the ledger may not know it yet."""
    since = int(datetime.combine(end, datetime.min.time(), tzinfo=timezone.utc).timestamp())
    page = stripe_request("GET", "/invoices", {"customer": customer_id, "created[gte]": since, "limit": 100})
    for invoice in page.get("data") or []:
        md = invoice.get("metadata") or {}
        if (md.get("kind") == "period" and md.get("tenantId") == tenant_id and md.get("periodEnd") == end.isoformat()
                and invoice.get("status") != "void"):
            return invoice
    return None


def _stripe_pending_kinds(customer_id: str, end: date) -> set:
    """The period's invoice items already on the customer, not on an invoice yet."""
    page = stripe_request("GET", "/invoiceitems", {"customer": customer_id, "pending": "true", "limit": 100})
    return {(i.get("metadata") or {}).get("kind") for i in page.get("data") or []
            if (i.get("metadata") or {}).get("periodEnd") == end.isoformat()}


def build_invoice(tenant_id: str, profile: dict, start: date, end: date, plan: dict, actor: str) -> dict:
    """One Stripe invoice for the period: the fee line and any pending late
    fee or interest items, emailed or charged by Stripe."""
    billing = _billing(profile)
    plan_ = invoice_plan(profile, start, end, plan)
    result = {"tenantId": tenant_id, "name": profile.get("name"), **plan_}
    if plan_["nothingToInvoice"]:
        _write_billing(tenant_id, {**_invoiced_to(billing, end),
                                   **({"status": "ended", "endedAt": now_iso()} if plan_["final"] else {})})
        result["invoiceId"] = None
        return result
    customer_id = billing.get("customerId") or ensure_customer(tenant_id, profile, actor)
    if _already_invoiced(tenant_id, end):
        _write_billing(tenant_id, _invoiced_to(billing, end))
        result["invoiceId"] = "exists"
        return result
    tax = env("BILLING_TAX_RATE_ID", "")
    if not tax:
        raise ApiError(500, "no_vat_rate", "BILLING_TAX_RATE_ID is not set: no invoice is sent without VAT")
    common = {"customer": customer_id, "currency": "sek",
              "period[start]": int(datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc).timestamp()),
              "period[end]": int(datetime.combine(end, datetime.max.time().replace(microsecond=0), tzinfo=timezone.utc).timestamp()),
              "metadata[tenantId]": tenant_id, "metadata[periodEnd]": end.isoformat(), "tax_rates[0]": tax}
    method = billing.get("collectionMethod") or "send_invoice"
    invoice = _stripe_period_invoice(customer_id, tenant_id, end)
    if invoice is None:
        pending = _stripe_pending_kinds(customer_id, end)
        if plan_["feeSek"] > 0 and "fee" not in pending:
            stripe_request("POST", "/invoiceitems", {**common, "amount": int((plan_["feeSek"] * 100).to_integral_value(rounding=ROUND_HALF_UP)),
                                                     "description": plan_["feeText"], "metadata[kind]": "fee"},
                           idempotency_key=f"fee-{tenant_id}-{end.isoformat()}")
        invoice = _new_period_invoice(customer_id, tenant_id, start, end, method, plan_["period"])
    if invoice.get("status") == "draft":
        invoice = stripe_request("POST", f"/invoices/{invoice['id']}/finalize", {})
    delivery = "paid" if invoice.get("status") == "paid" else "sent"
    if invoice.get("status") == "open":
        try:
            if method == "send_invoice":
                stripe_request("POST", f"/invoices/{invoice['id']}/send", {})
            else:
                invoice = stripe_request("POST", f"/invoices/{invoice['id']}/pay", {})
                delivery = "charged"
        except ApiError as e:
            delivery = f"not {'sent' if method == 'send_invoice' else 'charged'}: {e.message}"
    record_invoice(tenant_id, invoice)
    row = _invoice_row(tenant_id, invoice)
    _mark(row, periodStart=start.isoformat(), periodEnd=end.isoformat(), feeSek=plan_["feeSek"],
          billedDays=plan_["billedDays"], collectionMethod=method)
    _write_billing(tenant_id, {**_invoiced_to(billing, end),
                               **({"status": "ended", "endedAt": now_iso()} if plan_["final"] else {})})
    write_audit(tenant_id, "invoice_created", actor, {"invoiceId": invoice["id"], "number": invoice.get("number"),
                                                      "period": plan_["period"], "feeSek": plan_["feeSek"],
                                                      "totalSek": plan_["totalSek"], "delivery": delivery})
    result.update({"invoiceId": invoice["id"], "number": invoice.get("number"), "delivery": delivery,
                   "hostedInvoiceUrl": invoice.get("hosted_invoice_url")})
    return result


def _new_period_invoice(customer_id: str, tenant_id: str, start: date, end: date, method: str, period: str) -> dict:
    """The period's invoice, with the customer's pending items on it."""
    params = {"customer": customer_id, "collection_method": method, "auto_advance": "true",
              "pending_invoice_items_behavior": "include", "description": f"Booqy, {period}",
              "metadata[tenantId]": tenant_id, "metadata[periodStart]": start.isoformat(),
              "metadata[periodEnd]": end.isoformat(), "metadata[kind]": "period"}
    if method == "send_invoice":
        params["days_until_due"] = int(env("BILLING_DAYS_UNTIL_DUE", "30"))
    return stripe_request("POST", "/invoices", params, idempotency_key=f"inv-{tenant_id}-{end.isoformat()}")


def run_invoicing(actor: str, *, dry_run: bool = False, only: str | None = None, today: date | None = None,
                  deadline: float | None = None) -> dict:
    """Every complete, uninvoiced period of every agreement (or one
    customer's). dry_run = the preview. Past `deadline` (time.monotonic())
    no new customer is started: they are listed as unfinished and the next
    daily run invoices them."""
    today = today or datetime.now(timezone.utc).date()
    summary = {"dryRun": dry_run, "today": today.isoformat(), "invoices": [], "skipped": [], "errors": [], "migrated": [],
               "unfinished": []}
    for profile in _all_profiles():
        tenant_id = profile["tenantId"]
        if only and tenant_id != only:
            continue
        try:
            if _billing(profile).get("subscriptionId") and not dry_run:
                migrated = migrate_legacy(tenant_id, profile, actor)
                if migrated:
                    summary["migrated"].append({"tenantId": tenant_id, "name": profile.get("name"), **migrated})
                    profile = get_profile(tenant_id)
            billing = _billing(profile)
            periods = pending_periods(billing, today)
            if not periods:
                continue
            if deadline is not None and time.monotonic() > deadline:
                summary["unfinished"].append({"tenantId": tenant_id, "name": profile.get("name"), "periods": len(periods)})
                continue
            plan = plan_of(profile)
            for start, end in periods:
                if dry_run:
                    plan_ = invoice_plan(profile, start, end, plan)
                    target = summary["skipped"] if plan_["nothingToInvoice"] else summary["invoices"]
                    target.append({"tenantId": tenant_id, "name": profile.get("name"), "invoiceId": None, **plan_})
                    continue
                result = build_invoice(tenant_id, profile, start, end, plan, actor)
                (summary["skipped"] if result.get("invoiceId") in (None, "exists") else summary["invoices"]).append(result)
                profile = get_profile(tenant_id)
        except (ApiError, ClientError, BotoCoreError) as e:
            summary["errors"].append({"tenantId": tenant_id, "name": profile.get("name"),
                                      "error": (getattr(e, "message", None) or str(e))[:300]})
    summary["totalSek"] = sum((Decimal(i.get("totalSek") or 0) for i in summary["invoices"]), Decimal(0))
    if not dry_run and (summary["invoices"] or summary["errors"] or summary["migrated"] or summary["unfinished"]):
        lines = [f"Invoicing ({env('ENVIRONMENT', 'dev')}) on {today.isoformat()}: {len(summary['invoices'])} invoice(s), "
                 f"{summary['totalSek']} kr ex VAT.", ""]
        lines += [f"{i['name']}: {i['period']}, {i['feeSek']} kr, {i.get('delivery')}" for i in summary["invoices"]]
        lines += [f"FAILED {e['name']}: {e['error']}" for e in summary["errors"]]
        lines += [f"Moved to arrears: {m['name']}" for m in summary["migrated"]]
        lines += [f"NOT REACHED (out of time, the next daily run continues): {u['name']}" for u in summary["unfinished"]]
        topic = env("ALERT_TOPIC_ARN", "")
        if topic:
            try:
                client("sns").publish(TopicArn=topic, Subject=f"[{env('ENVIRONMENT', 'dev')}] Booqy invoicing: "
                                      f"{len(summary['invoices'])} invoices, {len(summary['errors'])} failed"
                                      + (f", {len(summary['unfinished'])} not reached" if summary["unfinished"] else ""),
                                      Message="\n".join(lines))
            except (ClientError, BotoCoreError):
                log.warning("invoicing summary not published", exc_info=True)
    log.info(json.dumps({"invoicing": {k: v for k, v in summary.items() if k != "invoices"},
                         "count": len(summary["invoices"])}, default=str))
    return summary


def invoicing(req) -> tuple[int, dict]:
    """POST /platform/finance/invoicing {dryRun}: the preview, or the run."""
    f = v.Fields(req.body)
    dry_run = f.boolean("dryRun")
    f.done()
    return 200, run_invoicing(req.actor, dry_run=dry_run is not False)


def invoice_now(req) -> tuple[int, dict]:
    """POST .../billing/invoice: every pending period of one customer."""
    tenant_id = req.path["tenantId"]
    get_profile(tenant_id)
    return 200, run_invoicing(req.actor, dry_run=False, only=tenant_id)


# ------------------------------------------------------------- the Free plan
SV_MONTHS_LONG = ("januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober",
                  "november", "december")


def sv_day(day: date) -> str:
    return f"{day.day} {SV_MONTHS_LONG[day.month - 1]} {day.year}"


def _then_price(billing: dict, then: dict) -> int:
    """The monthly price after Free: the customer's own price (kept while on
    Free), else the next plan's."""
    if billing.get("priceSek") is not None:
        return int(billing["priceSek"])
    return int(then.get("priceSek") or 0)


def free_view(profile: dict) -> dict | None:
    """The free period of a customer on Free: until = the last free day
    (None = no end date), then the plan it moves to the day after, at the
    customer's own price if one is kept."""
    if profile.get("planId") != FREE_PLAN_ID:
        return None
    billing = _billing(profile)
    until = _date(billing.get("freeUntil"))
    then = get_plan(billing.get("freeThenPlanId") or "starter") or {}
    return {"until": until.isoformat() if until else None, "since": billing.get("freeSince"),
            "switchOn": (until + timedelta(days=1)).isoformat() if until else None,
            "thenPlanId": billing.get("freeThenPlanId") or "starter", "thenPlanName": then.get("name"),
            "thenPriceSek": _then_price(billing, then) if then else None,
            "thenOwnPrice": billing.get("priceSek") is not None, "noticeSentFor": billing.get("freeNoticeFor")}


def _claim_notice(tenant_id: str, until: str, new_until: str) -> bool:
    """Marks the notice as sent, once (a re-run, or two runs at the same
    time, never send it twice). A notice later than 14 days before the
    first paid day moves the last free day to `new_until` with it."""
    try:
        client("dynamodb").update_item(
            TableName=tenant_table(), Key=tkey(tenant_id),
            UpdateExpression="SET billing.freeNoticeFor = :nu, billing.freeUntil = :nu, billing.freeNoticeAt = :n",
            ConditionExpression="planId = :free AND billing.freeUntil = :u AND "
                                "(attribute_not_exists(billing.freeNoticeFor) OR billing.freeNoticeFor <> :u)",
            ExpressionAttributeValues={":u": {"S": until}, ":nu": {"S": new_until}, ":free": {"S": FREE_PLAN_ID},
                                       ":n": {"S": now_iso()}})
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def _unclaim_notice(tenant_id: str, until: str, new_until: str) -> None:
    """The notice was not sent: back to the end date it had, so the next run
    tries again (unless someone changed the period meanwhile)."""
    try:
        client("dynamodb").update_item(
            TableName=tenant_table(), Key=tkey(tenant_id),
            UpdateExpression="SET billing.freeUntil = :u REMOVE billing.freeNoticeFor, billing.freeNoticeAt",
            ConditionExpression="billing.freeNoticeFor = :nu AND billing.freeUntil = :nu",
            ExpressionAttributeValues={":u": {"S": until}, ":nu": {"S": new_until}})
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def _free_notice_mail(profile: dict, until: date, then: dict, price: int) -> tuple[str, str]:
    first = ((profile.get("ownerName") or "").split() or [""])[0]
    amount = f"{price:,}".replace(",", " ")
    card = (_billing(profile).get("collectionMethod") or "send_invoice") == "charge_automatically"
    paying = ("Kortet på filen dras i efterhand, den 25:e varje månad." if card
              else "Fakturan kommer i efterhand, den 25:e varje månad.")
    subject = f"Er gratisperiod hos Booqy slutar {sv_day(until)}"
    body = (f"Hej{' ' + first if first else ''}!\n\n"
            f"Gratisperioden för {profile.get('name')} gäller till och med {sv_day(until)}. "
            f"Från {sv_day(until + timedelta(days=1))} har ni Booqy {then.get('name') or ''}, {amount} kr per månad "
            f"exklusive moms. SMS ingår.\n\n"
            f"{paying} Vill ni ändra något, svara på det här mejlet.")
    return subject, body


def _start_after_free(tenant_id: str, profile: dict, actor: str, start_day: str) -> str | None:
    """Starts the agreement after a switch off Free, from `start_day`, the
    way it is collected (invoice or card). None when started, else why not
    (billing.freeSwitchAgreementPending stays, so the next run tries again)."""
    billing = _billing(profile)
    if agreement_running(billing):
        _write_billing(tenant_id, {"freeSwitchAgreementPending": None})
        return None
    try:
        start_for(tenant_id, profile, actor=actor, start_day=start_day,
                  method=billing.get("collectionMethod") or "send_invoice",
                  terms=billing.get("terms") or "subscription")
    except (ApiError, ClientError, BotoCoreError) as e:
        return str(getattr(e, "message", None) or e)
    _write_billing(tenant_id, {"freeSwitchAgreementPending": None})
    return None


def free_step(profile: dict, today: date, actor: str) -> dict:
    """The daily look at one customer on Free with an end date. The owner is
    emailed and the operators get a line in the summary 14 days before the
    first paid day (once per end date); a notice that goes out later (set
    late, the email failed, the job was down) moves the first paid day to
    14 days after it, so nobody is charged without notice. From the day
    after the last free day, once told, the customer is on the plan chosen
    for afterwards and an agreement runs so the 25th invoices it; an
    agreement that did not start is tried again every day. Idempotent."""
    out = {"notice": None, "switched": None, "failed": None}
    billing = _billing(profile)
    tenant_id, name = profile["tenantId"], profile.get("name") or profile["tenantId"]
    pending = billing.get("freeSwitchAgreementPending")
    if pending and profile.get("planId") != FREE_PLAN_ID:
        why = _start_after_free(tenant_id, profile, actor, pending)
        if why:
            out["failed"] = f"{name}: switched off Free, NO AGREEMENT yet from {pending}: {why} (tried again tomorrow)"[:300]
        else:
            out["switched"] = f"{name}: agreement after Free started from {pending}"
        return out
    until = _date(billing.get("freeUntil"))
    if profile.get("planId") != FREE_PLAN_ID or until is None:
        return out
    if profile.get("status") not in ("provisioning", "active", "suspended"):
        return out
    switch_on = until + timedelta(days=1)
    then_id = billing.get("freeThenPlanId") or "starter"
    then = get_plan(then_id)
    if then is None or then.get("free"):
        out["failed"] = f"{name}: the plan after Free ({then_id}) does not exist"
        return out
    price = _then_price(billing, then)
    told = billing.get("freeNoticeFor") == until.isoformat()
    if today >= switch_on and told:
        own = int(billing["priceSek"]) if billing.get("priceSek") is not None else None
        try:
            apply_plan(tenant_id, profile, then, actor, force=True, price_sek=own, expect_free_until=until.isoformat(),
                       price_from=switch_on, agreement_pending=switch_on.isoformat())
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return out                          # someone else switched it, or changed the period
            raise
        write_audit(tenant_id, "free_period_ended", actor, {"freeUntil": until.isoformat(), "planId": then_id,
                                                            "priceSek": price})
        line = f"{name}: Free ended {until.isoformat()}, now {then.get('name')} ({price} kr per month)"
        fresh = get_profile(tenant_id)
        if agreement_running(_billing(fresh), today):
            _write_billing(tenant_id, {"freeSwitchAgreementPending": None})
        else:
            why = _start_after_free(tenant_id, fresh, actor, switch_on.isoformat())
            line += (f", NO AGREEMENT: {why} (tried again tomorrow)" if why
                     else f", agreement started from {switch_on.isoformat()}")
        count = int(fresh.get("locationCount") or 0)
        limit = int(((fresh.get("entitlements") or {}).get("maxLocations")) or 0)
        if count > limit:
            line += f"; {count} locations, the plan allows {limit}"
        out["switched"] = line
        return out
    if today >= switch_on - timedelta(days=FREE_NOTICE_DAYS) and not told:
        # Told today: at least 14 days before the first paid day.
        new_until = max(until, today + timedelta(days=FREE_NOTICE_DAYS - 1))
        if not _claim_notice(tenant_id, until.isoformat(), new_until.isoformat()):
            return out
        to = profile.get("billingEmail") or profile.get("ownerEmail")
        try:
            if not to:
                raise ApiError(409, "no_email", "no owner or billing email")
            from . import mail                       # mail imports nothing from billing
            subject, body = _free_notice_mail(profile, new_until, then, price)
            mail._send_one(to, subject, body, mail._load_template())
        except (ApiError, ClientError, BotoCoreError) as e:
            _unclaim_notice(tenant_id, until.isoformat(), new_until.isoformat())
            held = f", still on Free until the owner is told (was to end {until.isoformat()})" if today >= switch_on else ""
            out["failed"] = f"{name}: Free ending notice not sent{held}: {getattr(e, 'message', None) or e}"[:300]
            return out
        write_audit(tenant_id, "free_period_notice_sent", actor, {"freeUntil": new_until.isoformat(), "to": to,
                                                                   "thenPlanId": then_id, "priceSek": price,
                                                                   **({"movedFrom": until.isoformat()} if new_until != until else {})})
        moved = f" (moved from {switch_on.isoformat()}: told late)" if new_until != until else ""
        out["notice"] = (f"{name}: Free ends {new_until.isoformat()}, {then.get('name')} ({price} kr per month) from "
                         f"{(new_until + timedelta(days=1)).isoformat()}{moved}; owner told ({to})")
    return out


# ------------------------------------------------------------- reminders, fees, interest
def _env_num(name: str, default: str) -> Decimal:
    try:
        return Decimal(env(name, default) or default)
    except ArithmeticError:
        return Decimal(default)


def _parse(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None


def days_late(invoice: dict, now: datetime | None = None) -> int:
    """Days between the due date and now (or the payment), 0 when not late."""
    due = _parse(invoice.get("dueDate"))
    if due is None:
        return 0
    end = _parse(invoice.get("paidAt")) if invoice.get("status") == "paid" else None
    end = end or now or datetime.now(timezone.utc)
    return max(0, (end.date() - due.date()).days)


def interest_sek(amount: Decimal, days: int, *, reference_pct: Decimal, margin_pct: Decimal) -> Decimal:
    """Simple interest: amount x (reference + margin) % per year x days / 365."""
    if days <= 0 or amount <= 0:
        return Decimal("0.00")
    rate = (reference_pct + margin_pct) / Decimal(100)
    return (amount * rate * Decimal(days) / Decimal(365)).quantize(CENTS, rounding=ROUND_HALF_UP)


def _mark(row: dict, **fields) -> None:
    names = {f"#f{i}": k for i, k in enumerate(fields)}
    values = {f":v{i}": to_ddb_value(v) for i, v in enumerate(fields.values())}
    client("dynamodb").update_item(TableName=finance_table(), Key={"PK": {"S": row["PK"]}, "SK": {"S": row["SK"]}},
                                   UpdateExpression="SET " + ", ".join(f"{n} = :v{i}" for i, n in enumerate(names)),
                                   ConditionExpression="attribute_exists(PK)",
                                   ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def open_invoices(tenant_id: str) -> list[dict]:
    return [r for r in query_all(TableName=finance_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :i)",
                                 ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":i": {"S": "INVOICE#"}})
            if r.get("status") in ("open", "paid")]


def send_reminder(tenant_id: str, row: dict, actor: str) -> dict:
    """Stripe re-sends the invoice email (emailed invoices only)."""
    if row.get("status") != "open":
        raise ApiError(409, "not_open", "Only an open invoice can be reminded about")
    invoice = stripe_request("POST", f"/invoices/{row['invoiceId']}/send", {})
    if invoice.get("collection_method") == "charge_automatically":
        raise ApiError(409, "charged_automatically", "This invoice is charged to a card; Stripe retries it by itself")
    n = int(row.get("remindersSent") or 0) + 1
    _mark(row, remindersSent=n, lastReminderAt=now_iso(), lastReminderBy=actor)
    write_audit(tenant_id, "invoice_reminder_sent", actor, {"invoiceId": row["invoiceId"], "number": row.get("number"),
                                                            "reminder": n})
    return {"remindersSent": n}


def _add_item(customer_id: str, amount: Decimal, description: str, metadata: dict, key: str) -> str:
    """A VAT-free invoice item on the customer; Stripe puts it on the next
    invoice (or _bill_pending_items makes one)."""
    item = stripe_request("POST", "/invoiceitems", {
        "customer": customer_id, "amount": int((amount * 100).to_integral_value(rounding=ROUND_HALF_UP)),
        "currency": "sek", "description": description, "tax_rates": "",
        **{f"metadata[{k}]": v for k, v in metadata.items()},
    }, idempotency_key=key)
    return item["id"]


def _bill_pending_items(customer_id: str, tenant_id: str) -> str | None:
    """A customer without a running subscription has no next invoice: bill
    the pending items now on a one-off invoice that Stripe emails."""
    invoice = stripe_request("POST", "/invoices", {
        "customer": customer_id, "collection_method": "send_invoice",
        "days_until_due": int(env("BILLING_DAYS_UNTIL_DUE", "30")), "auto_advance": "true",
        "pending_invoice_items_behavior": "include", "metadata[tenantId]": tenant_id, "metadata[kind]": "late_fees",
    })
    stripe_request("POST", f"/invoices/{invoice['id']}/finalize", {})
    stripe_request("POST", f"/invoices/{invoice['id']}/send", {})
    return invoice["id"]


def work_invoices(profile: dict, now: datetime, actor: str) -> dict:
    """Reminders, the late fee and the interest for one customer's invoices.
    Every step is recorded on the ledger row, so a re-run never repeats it."""
    tenant_id, name = profile["tenantId"], profile.get("name") or profile["tenantId"]
    billing = _billing(profile)
    customer_id = billing.get("customerId")
    out = {"reminded": [], "fees": [], "interest": [], "oneOff": None}
    if not customer_id:
        return out
    interval = int(_env_num("BILLING_REMINDER_INTERVAL_DAYS", "7"))
    fee = _env_num("BILLING_LATE_FEE_SEK", "450")
    fee_after = int(_env_num("BILLING_LATE_FEE_AFTER_DAYS", "7"))
    reference, margin = _env_num("BILLING_REFERENCE_RATE_PCT", "2"), _env_num("BILLING_INTEREST_MARGIN_PCT", "8")
    added_items = False
    for row in open_invoices(tenant_id):
        late = days_late(row, now)
        number = row.get("number") or row["invoiceId"]
        if row.get("status") == "open" and late >= 1:
            # Never remind or charge a fee on an invoice paid (or voided)
            # whose webhook was missed: ask Stripe first.
            try:
                fresh = stripe_request("GET", f"/invoices/{row['invoiceId']}")
            except ApiError:
                fresh = None
            if fresh and fresh.get("status") and fresh["status"] != "open":
                record_invoice(tenant_id, fresh)
                row = {**row, **{k: val for k, val in _invoice_row(tenant_id, fresh).items() if val is not None}}
                late = days_late(row, now)
        if row.get("status") == "open" and late >= 1 and interval > 0 and row.get("collectionMethod") != "charge_automatically":
            last = _parse(row.get("lastReminderAt"))
            if last is None or (now - last).days >= interval:
                try:
                    stripe_request("POST", f"/invoices/{row['invoiceId']}/send", {})
                    n = int(row.get("remindersSent") or 0) + 1
                    _mark(row, remindersSent=n, lastReminderAt=now_iso(), lastReminderBy=actor)
                    out["reminded"].append(f"{name} {number} (reminder {n}, {late} days late)")
                except ApiError as e:
                    out["reminded"].append(f"{name} {number}: FAILED {e.message}")
        if row.get("status") == "open" and fee > 0 and late >= fee_after and not row.get("lateFeeAdded"):
            item_id = _add_item(customer_id, fee, f"Förseningsavgift, faktura {number}",
                                {"tenantId": tenant_id, "invoiceId": row["invoiceId"], "kind": "late_fee"},
                                f"late-fee-{row['invoiceId']}")
            _mark(row, lateFeeAdded=now_iso(), lateFeeSek=fee, lateFeeItemId=item_id)
            write_audit(tenant_id, "late_fee_added", actor, {"invoiceId": row["invoiceId"], "number": number, "feeSek": fee})
            out["fees"].append(f"{name} {number} ({fee} kr, {late} days late)")
            added_items = True
        if row.get("status") == "paid" and late >= 1 and not row.get("interestAdded"):
            amount = interest_sek(Decimal(row.get("totalSek") or 0), late, reference_pct=reference, margin_pct=margin)
            if amount >= 1:
                item_id = _add_item(customer_id, amount,
                                    f"Dröjsmålsränta {reference + margin} % i {late} dagar, faktura {number}",
                                    {"tenantId": tenant_id, "invoiceId": row["invoiceId"], "kind": "interest", "days": str(late)},
                                    f"interest-{row['invoiceId']}")
                added_items = True
            else:
                item_id = None
            _mark(row, interestAdded=now_iso(), interestSek=amount, interestDays=late, interestItemId=item_id or "-")
            write_audit(tenant_id, "interest_added", actor, {"invoiceId": row["invoiceId"], "number": number,
                                                             "interestSek": amount, "days": late})
            out["interest"].append(f"{name} {number} ({amount} kr for {late} days)")
    if added_items and not agreement_running(billing):
        out["oneOff"] = _bill_pending_items(customer_id, tenant_id)
        write_audit(tenant_id, "late_fees_invoiced", actor, {"invoiceId": out["oneOff"]})
    return out


def overdue_days(tenant_id: str, now: datetime | None = None) -> int | None:
    """Days the oldest open invoice is past its due date (None: none is).
    An emailed invoice never fails a payment, so this is what makes it
    past due."""
    late = [days_late(r, now) for r in open_invoices(tenant_id) if r.get("status") == "open"]
    late = [d for d in late if d > 0]
    return max(late) if late else None


def remind_invoice(req) -> tuple[int, dict]:
    """Send a reminder now (the Payments view and the Billing tab)."""
    tenant_id, invoice_id = req.path["tenantId"], req.path["invoiceId"]
    get_profile(tenant_id)
    rows = [r for r in query_all(TableName=finance_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :i)",
                                 ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":i": {"S": "INVOICE#"}})
            if r.get("invoiceId") == invoice_id]
    if not rows:
        raise ApiError(404, "not_found", "No such invoice")
    return 200, send_reminder(tenant_id, rows[0], req.actor)


# ------------------------------------------------------------- dunning
def _days_since(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - then).days


def dunning_task(event: dict, context) -> dict:
    """Suspends customers past due longer than BILLING_SUSPEND_AFTER_DAYS
    (0 = off) and resumes the ones it suspended that have paid. Emails the
    operators when it did something."""
    actor = "dunning"
    limit = int(env("BILLING_SUSPEND_AFTER_DAYS", "14"))
    now = datetime.now(timezone.utc)
    trial_months = int(_env_num("BILLING_TRIAL_MONTHS", "6"))
    suspended, resumed, failed, reminded, fees, interest, converted, offboarded = [], [], [], [], [], [], [], []
    free_notices, free_switched = [], []
    from .website import stockholm_today           # website imports nothing from here
    today = stockholm_today(now)
    for profile in _all_profiles():
        billing = _billing(profile)
        tenant_id, name = profile["tenantId"], profile.get("name") or profile["tenantId"]
        days = _days_since(billing.get("pastDueSince"))
        try:
            worked = work_invoices(profile, now, actor)
            reminded += worked["reminded"]
            fees += worked["fees"]
            interest += worked["interest"]
            # Past due: a failed card payment (webhook) or an emailed invoice
            # past its due date (ledger), whichever is older.
            overdue = overdue_days(tenant_id, now)
            days = max(d for d in (days, overdue) if d is not None) if days is not None or overdue is not None else None
        except (ApiError, ClientError, BotoCoreError) as e:
            failed.append(f"{name} invoices: {getattr(e, 'message', None) or e}"[:300])
        try:
            # Free: the notice 14 days before the first paid day, then the switch.
            stepped = free_step(profile, today, actor)
            if stepped["notice"]:
                free_notices.append(stepped["notice"])
            if stepped["switched"]:
                free_switched.append(stepped["switched"])
                profile = get_profile(tenant_id)
                billing = _billing(profile)
            if stepped["failed"]:
                failed.append(stepped["failed"])
        except (ApiError, ClientError, BotoCoreError) as e:
            failed.append(f"{name} free plan: {getattr(e, 'message', None) or e}"[:300])
        try:
            # Prices changed outside the console (the plan catalog in
            # tfvars) are recorded too, so they also apply from the next
            # period; agreements from before price history get theirs from
            # their start.
            if agreement_running(billing) and price_drift(profile):
                history = billing.get("priceHistory")
                record_price(tenant_id, profile, on=None if history else
                             min(_date(billing.get("startsAt")) or now.date(), now.date()))
        except (ApiError, ClientError, BotoCoreError) as e:
            failed.append(f"{name} prices: {getattr(e, 'message', None) or e}"[:300])
        try:
            # A try-out that has run its course becomes a subscription.
            if billing.get("subscriptionId"):
                migrate_legacy(tenant_id, profile, actor)
                profile = get_profile(tenant_id)
                billing = _billing(profile)
            since = _parse(billing.get("termsSince"))
            if (billing.get("terms") == "trial" and trial_months > 0 and since and agreement_running(billing)
                    and not billing.get("endsAt") and now >= _add_months(since, trial_months)):
                _write_billing(tenant_id, {"terms": "subscription", "termsSince": now_iso(), "convertedBy": actor})
                write_audit(tenant_id, "subscription_converted", actor, {"from": "trial", "after_months": trial_months})
                converted.append(f"{name} (try-out since {since.date().isoformat()})")
            # An agreement that has ended and had its final invoice: the customer is offboarded.
            if (billing.get("offboardAtEnd") and billing.get("status") == "ended"
                    and profile.get("status") in ("active", "suspended")):
                offboard_tenant(tenant_id, profile, actor, reason="agreement ended")
                _write_billing(tenant_id, {"offboardAtEnd": None})
                offboarded.append(name)
        except (ApiError, ClientError, BotoCoreError) as e:
            failed.append(f"{name} terms: {getattr(e, 'message', None) or e}"[:300])
        try:
            if limit > 0 and profile.get("status") == "active" and days is not None and days >= limit:
                suspend_tenant(tenant_id, actor, f"Subscription past due for {days} days")
                client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id),
                                               UpdateExpression="SET billing.autoSuspended = :t",
                                               ExpressionAttributeValues={":t": {"BOOL": True}})
                suspended.append(f"{name} ({days} days past due)")
            elif profile.get("status") == "suspended" and billing.get("autoSuspended") and days is None \
                    and agreement_running(billing):
                resume_tenant(tenant_id, actor)
                client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id),
                                               UpdateExpression="REMOVE billing.autoSuspended")
                resumed.append(name)
        except (ApiError, ClientError, BotoCoreError) as e:
            failed.append(f"{name}: {getattr(e, 'message', None) or e}"[:300])
    summary = {"status": "done", "limitDays": limit, "suspended": suspended, "resumed": resumed, "failed": failed,
               "reminded": reminded, "fees": fees, "interest": interest, "converted": converted, "offboarded": offboarded,
               "freeNotices": free_notices, "freeSwitched": free_switched}
    if suspended or resumed or failed or reminded or fees or interest or converted or offboarded or free_notices or free_switched:
        lines = [f"Dunning ({env('ENVIRONMENT', 'dev')}): past due limit {limit} days.", ""]
        lines += [f"Reminder sent: {r}" for r in reminded] + [f"Late fee added: {f}" for f in fees]
        lines += [f"Interest added: {i}" for i in interest]
        lines += [f"Try-out became a subscription: {c}" for c in converted] + [f"Offboarded (subscription ended): {o}" for o in offboarded]
        lines += [f"Free ends in {FREE_NOTICE_DAYS} days: {n}" for n in free_notices]
        lines += [f"Free ended, switched: {w}" for w in free_switched]
        lines += [f"Suspended: {s}" for s in suspended] + [f"Resumed: {r}" for r in resumed] + [f"FAILED: {x}" for x in failed]
        topic = env("ALERT_TOPIC_ARN", "")
        if topic:
            try:
                client("sns").publish(TopicArn=topic, Subject=f"[{env('ENVIRONMENT', 'dev')}] Booqy dunning: "
                                      f"{len(reminded)} reminded, {len(fees)} fees, {len(suspended)} suspended, "
                                      f"{len(resumed)} resumed"
                                      + (f", {len(free_notices) + len(free_switched)} free plan" if free_notices or free_switched else ""),
                                      Message="\n".join(lines))
            except (ClientError, BotoCoreError):
                log.warning("dunning summary not published", exc_info=True)
    log.info(json.dumps(summary, default=str))
    return summary


def finance_task(event: dict, context) -> dict:
    if event.get("financeTask") == "dunning":
        return dunning_task(event, context)
    if event.get("financeTask") == "invoice":
        # Stop starting customers 30 s before the Lambda timeout, so the
        # summary is still sent; the next daily run takes the rest.
        # {"dryRun": true}: the preview only (reads DynamoDB, writes nothing,
        # calls no Stripe), for an operator's `aws lambda invoke`.
        remaining = getattr(context, "get_remaining_time_in_millis", None)
        deadline = time.monotonic() + remaining() / 1000 - 30 if remaining else None
        return {"status": "done", **run_invoicing("invoicing", dry_run=event.get("dryRun") is True, deadline=deadline)}
    return {"status": "unknown_task"}
