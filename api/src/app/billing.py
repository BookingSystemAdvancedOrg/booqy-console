"""The customers' subscriptions: Stripe Billing on the PLATFORM account.

One Stripe Customer per restaurant company, one Subscription on the plan's
monthly price (the PLAN# row's stripePriceId, created by Terraform from
var.plans) with Swedish VAT (BILLING_TAX_RATE_ID). Invoices are emailed by
Stripe; payment is by card on the hosted invoice page, automatically with
a card on file, or by bankgiro to your own account with the invoice marked
paid in Stripe. The restaurant's Connect account (guest payments) is a
different thing and untouched here.

What this module writes:
    tenant table   TENANT#<id> PROFILE.billing   customerId, subscriptionId,
                   status, priceId, planId, mrrSek, collectionMethod,
                   currentPeriodStart/End, pauseCollection, startedAt/By,
                   pastDueSince, autoSuspended
                   STRIPE_CUSTOMER#<cus> TENANT   tenantId (one transaction
                   with the first billing write)
    finance table  TENANT#<id> INVOICE#<day>#<in_...>  mirror of the rows
                   platform-stripe-webhook writes (application repo,
                   shared/billing.py) - the Stripe import here uses the same
                   layout and booking flags, so both can write safely.

From the first write on, platform-stripe-webhook keeps PROFILE.billing and
the ledger current. The daily dunning task (financeTask, EventBridge
Scheduler) then works the unpaid invoices, all through Stripe:
  * reminders: from the day after the due date and every
    BILLING_REMINDER_INTERVAL_DAYS days, Stripe re-sends the invoice email
    (POST /invoices/{id}/send; remindersSent / lastReminderAt on the row);
  * late fee: BILLING_LATE_FEE_AFTER_DAYS days after the due date, one
    VAT-free invoice item of BILLING_LATE_FEE_SEK on the customer
    (förseningsavgift), billed on their next invoice;
  * interest: when a late invoice is paid, one VAT-free invoice item for
    the overdue amount at BILLING_REFERENCE_RATE_PCT +
    BILLING_INTEREST_MARGIN_PCT per year for the days late
    (dröjsmålsränta); a customer without a running subscription gets a
    one-off invoice for the items instead;
  * suspension: customers past due longer than BILLING_SUSPEND_AFTER_DAYS
    are suspended and resumed once they paid.
"""

import json
import time
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal

from botocore.exceptions import BotoCoreError, ClientError

from . import validation as v
from .core import (ApiError, client, env, log, now_iso, query_all, tenant_table, to_ddb, to_ddb_value,
                   write_audit)
from .stripe_connect import stripe_request
from .tenants import ensure_billing_map, get_plan, get_profile, offboard_tenant, resume_tenant, suspend_tenant, tkey

COLLECTION_METHODS = ("send_invoice", "charge_automatically")
TERMS = ("trial", "subscription")
OPEN_STATUSES = ("active", "trialing", "past_due", "unpaid", "incomplete")
PAST_DUE_STATUSES = ("past_due", "unpaid")
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


# ------------------------------------------------------------- Stripe -> rows
def monthly_sek(subscription: dict) -> Decimal:
    total = Decimal(0)
    for item in ((subscription.get("items") or {}).get("data") or []):
        price = item.get("price") or {}
        recurring = price.get("recurring") or {}
        amount = sek(price.get("unit_amount")) * Decimal(int(item.get("quantity") or 1))
        interval, count = recurring.get("interval"), int(recurring.get("interval_count") or 1)
        if interval == "year":
            amount = amount / Decimal(12 * count)
        elif interval == "month":
            amount = amount / Decimal(count)
        total += amount
    return total.quantize(CENTS, rounding=ROUND_HALF_UP)


def subscription_state(subscription: dict, *, deleted: bool = False) -> dict:
    items = ((subscription.get("items") or {}).get("data") or [])
    first = items[0] if items else {}
    price = first.get("price") or {}
    metadata = price.get("metadata") or {}
    return {
        "subscriptionId": _id(subscription.get("id")),
        "status": "canceled" if deleted else (subscription.get("status") or "unknown"),
        "priceId": _id(price.get("id")),
        "planId": metadata.get("planId") or (subscription.get("metadata") or {}).get("planId") or price.get("lookup_key") or None,
        "mrrSek": Decimal(0) if deleted else monthly_sek(subscription),
        "collectionMethod": subscription.get("collection_method") or None,
        "currentPeriodStart": _iso(first.get("current_period_start") or subscription.get("current_period_start")),
        "currentPeriodEnd": _iso(first.get("current_period_end") or subscription.get("current_period_end")),
        "cancelAt": _iso(subscription.get("cancel_at")),
        "canceledAt": _iso(subscription.get("canceled_at")),
        "pauseCollection": bool(subscription.get("pause_collection")) and not deleted,
        "trialEnd": _iso(subscription.get("trial_end")),
    }


def store_subscription(tenant_id: str, customer_id: str, state: dict, *, extra: dict | None = None) -> bool:
    """Writes the state on PROFILE.billing (the console's own writes carry no
    Stripe event time, so they never block a later webhook)."""
    names = {"#b": "billing", "#c": "customerId", "#u": "updatedAt"}
    values = {":cus": {"S": customer_id}, ":now": {"S": now_iso()}}
    sets, removes = ["#b.#u = :now"], []
    fields = {**state, **(extra or {})}
    for i, (key, value) in enumerate(fields.items()):
        names[f"#f{i}"] = key
        if value is None:
            removes.append(f"#b.#f{i}")
        else:
            values[f":v{i}"] = to_ddb_value(value)
            sets.append(f"#b.#f{i} = :v{i}")
    if state.get("status") in PAST_DUE_STATUSES:
        names["#p"] = "pastDueSince"
        sets.append("#b.#p = if_not_exists(#b.#p, :now)")
    elif state.get("status") in ("active", "trialing", "canceled"):
        names["#p"] = "pastDueSince"
        removes.append("#b.#p")
    expression = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
    try:
        client("dynamodb").update_item(
            TableName=tenant_table(), Key=tkey(tenant_id), UpdateExpression=expression,
            ConditionExpression="#b.#c = :cus", ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    except client("dynamodb").exceptions.ConditionalCheckFailedException:
        return False
    return True


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
        "dueDate": _iso(invoice.get("due_date")), "periodStart": _iso(invoice.get("period_start")),
        "periodEnd": _iso(invoice.get("period_end")), "hostedInvoiceUrl": invoice.get("hosted_invoice_url"),
        "invoicePdf": invoice.get("invoice_pdf"), "paidOutOfBand": bool(invoice.get("paid_out_of_band")),
        "collectionMethod": invoice.get("collection_method"),
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
            "month": (r.get("periodStart") or r.get("createdAt") or "")[:7] or None,
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


# ------------------------------------------------------------- the routes
def _plan_price(profile: dict) -> tuple[dict, str]:
    plan = get_plan(profile.get("planId") or "")
    if not plan:
        raise ApiError(409, "no_plan", "The customer has no plan - set one on the Plan tab first")
    price_id = plan.get("stripePriceId")
    if not price_id:
        raise ApiError(409, "plan_without_price",
                       f"The plan {plan.get('name')} has no Stripe price yet - set price_sek in the infrastructure "
                       "tfvars and apply")
    return plan, price_id


def effective_price(profile: dict, plan: dict) -> int | None:
    """The customer's own monthly price (ex VAT) when one is set, else None
    (= the plan's price)."""
    price = _billing(profile).get("priceSek")
    if price is None or int(price) == int(plan.get("priceSek") or -1):
        return None
    return int(price)


def _item_params(plan: dict, price_id: str, price_sek: int | None, prefix: str = "items[0]") -> dict:
    """Stripe subscription item: the plan's price, or the customer's own
    amount as a price on the plan's product."""
    if price_sek is None:
        return {f"{prefix}[price]": price_id}
    product = plan.get("stripeProductId")
    if not product:
        raise ApiError(409, "plan_without_price", f"The plan {plan.get('name')} has no Stripe product yet - apply the infrastructure")
    return {f"{prefix}[price_data][currency]": "sek", f"{prefix}[price_data][product]": product,
            f"{prefix}[price_data][unit_amount]": int(price_sek) * 100, f"{prefix}[price_data][tax_behavior]": "exclusive",
            f"{prefix}[price_data][recurring][interval]": "month"}


def _add_months(when: datetime, months: int) -> datetime:
    month = when.month - 1 + months
    year = when.year + month // 12
    month = month % 12 + 1
    last = [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    return when.replace(year=year, month=month, day=min(when.day, last))


def end_date(billing: dict, now: datetime) -> datetime:
    """When a cancellation takes effect: a try-out ends with the paid month,
    a subscription BILLING_NOTICE_MONTHS after the current month ends."""
    period_end = _parse(billing.get("currentPeriodEnd")) or _add_months(now, 1)
    if period_end < now:
        period_end = _add_months(now, 1)
    if billing.get("terms") == "trial":
        return period_end
    return _add_months(period_end, int(_env_num("BILLING_NOTICE_MONTHS", "3")))


def _view(profile: dict) -> dict:
    billing = _billing(profile)
    plan = get_plan(profile.get("planId") or "") or {}
    status = billing.get("status")
    return {
        "customerId": billing.get("customerId"), "subscriptionId": billing.get("subscriptionId"),
        "status": status, "planId": billing.get("planId"), "priceId": billing.get("priceId"),
        "mrrSek": billing.get("mrrSek"), "collectionMethod": billing.get("collectionMethod"),
        "currentPeriodStart": billing.get("currentPeriodStart"), "currentPeriodEnd": billing.get("currentPeriodEnd"),
        "cancelAt": billing.get("cancelAt"), "canceledAt": billing.get("canceledAt"), "trialEnd": billing.get("trialEnd"),
        "pauseCollection": bool(billing.get("pauseCollection")),
        "pastDueSince": billing.get("pastDueSince"), "autoSuspended": bool(billing.get("autoSuspended")),
        "lastPaidAt": billing.get("lastPaidAt"), "lastPaymentFailedAt": billing.get("lastPaymentFailedAt"),
        "startedAt": billing.get("startedAt"), "startedBy": billing.get("startedBy"),
        "hasCard": bool(billing.get("defaultPaymentMethod")),
        "terms": billing.get("terms") or "subscription",
        "termsSince": billing.get("termsSince"),
        "trialEndsAt": (_add_months(_parse(billing["termsSince"]), int(_env_num("BILLING_TRIAL_MONTHS", "6"))).isoformat()
                        if billing.get("terms") == "trial" and _parse(billing.get("termsSince")) and _env_num("BILLING_TRIAL_MONTHS", "6") > 0
                        else None),
        "priceSek": int(billing["priceSek"]) if billing.get("priceSek") is not None else None,
        "monthlySek": int(billing["priceSek"]) if billing.get("priceSek") is not None else plan.get("priceSek"),
        "noticeMonths": int(_env_num("BILLING_NOTICE_MONTHS", "3")),
        "trialMonths": int(_env_num("BILLING_TRIAL_MONTHS", "6")),
        "offboardAtEnd": bool(billing.get("offboardAtEnd")),
        "endsAt": billing.get("cancelAt"),
        "subscribed": bool(billing.get("subscriptionId")) and status in OPEN_STATUSES,
        "plan": {"planId": plan.get("planId"), "name": plan.get("name"), "priceSek": plan.get("priceSek"),
                 "stripePriceId": plan.get("stripePriceId")},
        "priceDiffers": bool(billing.get("subscriptionId")) and status in OPEN_STATUSES and bool(plan.get("stripePriceId"))
        and int(billing.get("mrrSek") or 0) != int(billing["priceSek"] if billing.get("priceSek") is not None else plan.get("priceSek") or 0),
        "daysUntilDue": int(env("BILLING_DAYS_UNTIL_DUE", "30")),
        "suspendAfterDays": int(env("BILLING_SUSPEND_AFTER_DAYS", "14")),
    }


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
    if day <= datetime.now(timezone.utc).date():
        return None                     # today or earlier = start now
    if day > datetime.now(timezone.utc).date() + timedelta(days=365):
        f.fail(field, "At most a year ahead")
    return day


def start_subscription(req) -> tuple[int, dict]:
    """Starts the customer's subscription (Billing tab). Invoices by email by
    default; `startDate` (yyyy-mm-dd, in the future) delays the first
    invoice until then (a Stripe trial, nothing is charged before);
    `priceSek` is the customer's own monthly price, `terms` trial or
    subscription."""
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
    """Creates the Stripe customer (if needed) and the subscription on the
    plan's product: the plan's price, or the customer's own amount."""
    if profile.get("status") not in ("provisioning", "active"):
        raise ApiError(409, "invalid_status", f"Not possible while the customer is {profile.get('status')}",
                       currentStatus=profile.get("status"))
    billing = _billing(profile)
    if billing.get("subscriptionId") and billing.get("status") in OPEN_STATUSES:
        raise ApiError(409, "already_subscribed", "The customer already has a subscription")
    plan, price_id = _plan_price(profile)
    if price_sek is None:
        price_sek = effective_price(profile, plan)
    elif int(price_sek) == int(plan.get("priceSek") or -1):
        price_sek = None
    terms = terms or billing.get("terms") or "subscription"
    customer_id = ensure_customer(tenant_id, profile, actor)
    if method == "charge_automatically":
        customer = stripe_request("GET", f"/customers/{customer_id}")
        if not ((customer.get("invoice_settings") or {}).get("default_payment_method")):
            raise ApiError(409, "no_card", "No card on file yet - create a card link, let the restaurant add a card, "
                                           "then start with charge automatically (or invoice by email instead)")
    params = {
        "customer": customer_id, "collection_method": method,
        "metadata[tenantId]": tenant_id, "metadata[planId]": plan.get("planId") or "", "metadata[terms]": terms,
        "proration_behavior": "none", **_item_params(plan, price_id, price_sek),
    }
    if method == "send_invoice":
        params["days_until_due"] = int(env("BILLING_DAYS_UNTIL_DUE", "30"))
    tax_rate = env("BILLING_TAX_RATE_ID", "")
    if tax_rate:
        params["default_tax_rates[0]"] = tax_rate
    if start_day:
        params["trial_end"] = int(datetime.combine(date.fromisoformat(start_day), datetime.min.time(), tzinfo=timezone.utc).timestamp())
    sub = stripe_request("POST", "/subscriptions", params,
                         idempotency_key=f"subscription-{tenant_id}-{int(time.time() // 3600)}")
    state = subscription_state(sub)
    store_subscription(tenant_id, customer_id, state,
                       extra={"startedAt": now_iso(), "startedBy": actor, "autoSuspended": None, "terms": terms,
                              "termsSince": now_iso(), "priceSek": price_sek, "offboardAtEnd": None})
    write_audit(tenant_id, "subscription_started", actor,
                {"subscriptionId": state["subscriptionId"], "planId": plan.get("planId"), "collectionMethod": method,
                 "terms": terms, "priceSek": price_sek, "startDate": start_day})
    return _view(get_profile(tenant_id))


def _subscription_item(subscription_id: str) -> str:
    sub = stripe_request("GET", f"/subscriptions/{subscription_id}")
    items = ((sub.get("items") or {}).get("data") or [])
    if not items:
        raise ApiError(502, "stripe_error", "Stripe: the subscription has no items")
    return items[0]["id"]


def update_subscription(req) -> tuple[int, dict]:
    """action: pause (stop invoicing, keep the subscription), resume,
    cancel (ends with the terms: a try-out at the end of the paid month, a
    subscription after the notice period; `offboardAtEnd` default true),
    cancel_now (final prorated invoice today), keep (undo a cancellation),
    convert (try-out -> subscription), sync_price (the plan's current
    price, or the customer's own, from the next invoice), use_card (charge
    the card the restaurant added)."""
    tenant_id = req.path["tenantId"]
    f = v.Fields(req.body)
    action = f.text("action", required=True, max_len=20)
    offboard_at_end = f.boolean("offboardAtEnd")
    f.done()
    profile = get_profile(tenant_id)
    billing = _billing(profile)
    sub_id, customer_id = billing.get("subscriptionId"), billing.get("customerId")
    if not sub_id or billing.get("status") not in OPEN_STATUSES:
        raise ApiError(409, "not_subscribed", "The customer has no running subscription")
    details: dict = {}
    extra: dict | None = None
    if action == "pause":
        sub = stripe_request("POST", f"/subscriptions/{sub_id}", {"pause_collection[behavior]": "void"})
    elif action == "resume":
        sub = stripe_request("POST", f"/subscriptions/{sub_id}", {"pause_collection": ""})
    elif action == "cancel":
        ends = end_date(billing, datetime.now(timezone.utc))
        sub = stripe_request("POST", f"/subscriptions/{sub_id}", {"cancel_at": int(ends.timestamp())})
        extra = {"offboardAtEnd": offboard_at_end is not False, "cancelRequestedAt": now_iso(), "cancelRequestedBy": req.actor}
        details = {"endsAt": ends.isoformat(), "terms": billing.get("terms") or "subscription",
                   "offboardAtEnd": extra["offboardAtEnd"]}
    elif action == "cancel_now":
        sub = stripe_request("DELETE", f"/subscriptions/{sub_id}", {"invoice_now": "true", "prorate": "true"})
        extra = {"offboardAtEnd": offboard_at_end is True}
    elif action == "keep":
        sub = stripe_request("POST", f"/subscriptions/{sub_id}", {"cancel_at": ""})
        extra = {"offboardAtEnd": None, "cancelRequestedAt": None, "cancelRequestedBy": None}
    elif action == "convert":
        if (billing.get("terms") or "subscription") != "trial":
            raise ApiError(409, "not_trial", "The customer is already on a subscription")
        sub = stripe_request("POST", f"/subscriptions/{sub_id}", {"metadata[terms]": "subscription"})
        extra = {"terms": "subscription", "termsSince": now_iso(), "convertedBy": req.actor}
        details = {"from": "trial", "to": "subscription"}
    elif action == "sync_price":
        plan, price_id = _plan_price(profile)
        price_sek = effective_price(profile, plan)
        item_id = _subscription_item(sub_id)
        sub = stripe_request("POST", f"/subscriptions/{sub_id}", {
            "items[0][id]": item_id, **_item_params(plan, price_id, price_sek), "proration_behavior": "none",
            "metadata[planId]": plan.get("planId") or ""})
        details = {"planId": plan.get("planId"), "priceId": price_id, "priceSek": price_sek}
    elif action == "use_card":
        methods = stripe_request("GET", "/payment_methods", {"customer": customer_id, "type": "card", "limit": 1})
        cards = methods.get("data") or []
        if not cards:
            raise ApiError(409, "no_card", "The restaurant has not added a card yet - send them the card link")
        card = cards[0]["id"]
        stripe_request("POST", f"/customers/{customer_id}", {"invoice_settings[default_payment_method]": card})
        sub = stripe_request("POST", f"/subscriptions/{sub_id}", {
            "collection_method": "charge_automatically", "default_payment_method": card})
        details = {"paymentMethod": card}
    else:
        raise ApiError(400, "validation_failed", "Unknown action",
                       fields={"action": "pause, resume, cancel, cancel_now, keep, convert, sync_price or use_card"})
    state = subscription_state(sub, deleted=action == "cancel_now" or sub.get("status") == "canceled")
    if action == "use_card":
        extra = {"defaultPaymentMethod": details.get("paymentMethod")}
    store_subscription(tenant_id, customer_id, state, extra=extra)
    write_audit(tenant_id, f"subscription_{action}", req.actor, {"subscriptionId": sub_id, **details})
    return 200, {"billing": _view(get_profile(tenant_id))}


def card_link(req) -> tuple[int, dict]:
    """A Stripe Checkout page (setup mode) where the restaurant adds a card;
    afterwards "use_card" switches the subscription to charge it."""
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
def after_plan_change(tenant_id: str, profile: dict, plan: dict, actor: str) -> dict | None:
    """Moves a running subscription to the new plan's price, or the
    customer's own amount, from the next invoice (no proration: the paid
    month stays as it is). Best effort: a Stripe hiccup is reported, the
    plan change stands."""
    billing = _billing(profile)
    sub_id = billing.get("subscriptionId")
    price_id = plan.get("stripePriceId")
    if not sub_id or billing.get("status") not in OPEN_STATUSES or not price_id:
        return None
    price_sek = effective_price(profile, plan)
    current = int(billing.get("mrrSek") or 0)
    wanted = price_sek if price_sek is not None else int(plan.get("priceSek") or 0)
    if billing.get("priceId") == price_id and price_sek is None:
        return None
    if price_sek is not None and current == wanted and billing.get("priceId") != price_id and billing.get("planId") == plan.get("planId"):
        return None
    try:
        item_id = _subscription_item(sub_id)
        sub = stripe_request("POST", f"/subscriptions/{sub_id}", {
            "items[0][id]": item_id, **_item_params(plan, price_id, price_sek), "proration_behavior": "none",
            "metadata[planId]": plan.get("planId") or ""})
    except ApiError as e:
        log.warning("subscription %s not moved to %s: %s", sub_id, price_id, e.message)
        return {"error": e.message}
    store_subscription(tenant_id, billing["customerId"], subscription_state(sub))
    write_audit(tenant_id, "subscription_price_synced", actor,
                {"subscriptionId": sub_id, "priceId": price_id, "priceSek": price_sek, "from": "next invoice"})
    return {"priceId": price_id, "priceSek": price_sek, "monthlySek": wanted, "from": "next invoice"}


def cancel_for_offboarding(tenant_id: str, profile: dict, actor: str) -> dict | None:
    """Ends the subscription with a final prorated invoice. The Stripe
    customer and the invoices stay (bookkeeping)."""
    billing = _billing(profile)
    sub_id = billing.get("subscriptionId")
    if not sub_id or billing.get("status") not in OPEN_STATUSES:
        return None
    try:
        sub = stripe_request("DELETE", f"/subscriptions/{sub_id}", {"invoice_now": "true", "prorate": "true"})
    except ApiError as e:
        log.warning("subscription %s not cancelled at offboarding: %s", sub_id, e.message)
        write_audit(tenant_id, "subscription_cancel_failed", actor, {"subscriptionId": sub_id, "error": e.message})
        return {"error": e.message}
    store_subscription(tenant_id, billing["customerId"], subscription_state(sub, deleted=True))
    write_audit(tenant_id, "subscription_cancelled", actor, {"subscriptionId": sub_id, "reason": "offboarding"})
    return {"cancelled": sub_id}


# ------------------------------------------------------------- Stripe import
def _all_profiles() -> list[dict]:
    return query_all(TableName=tenant_table(), IndexName="GSI1", KeyConditionExpression="GSI1PK = :t",
                     ExpressionAttributeValues={":t": {"S": "TENANT"}})


def sync_from_stripe(actor: str) -> dict:
    """Re-reads every customer's subscription and invoices from Stripe: for
    webhook deliveries that were missed, or figures to check by hand."""
    summary = {"tenants": 0, "subscriptions": 0, "invoices": 0, "booked": 0, "errors": []}
    for profile in _all_profiles():
        billing = _billing(profile)
        customer_id, tenant_id = billing.get("customerId"), profile["tenantId"]
        if not customer_id:
            continue
        summary["tenants"] += 1
        try:
            if billing.get("subscriptionId"):
                sub = stripe_request("GET", f"/subscriptions/{billing['subscriptionId']}")
                store_subscription(tenant_id, customer_id, subscription_state(sub))
                summary["subscriptions"] += 1
            after = None
            while True:
                params = {"customer": customer_id, "limit": 100}
                if after:
                    params["starting_after"] = after
                page = stripe_request("GET", "/invoices", params)
                for invoice in page.get("data") or []:
                    if invoice.get("status") == "draft":
                        continue
                    summary["invoices"] += 1
                    summary["booked"] += len(record_invoice(tenant_id, invoice))
                    after = invoice["id"]
                if not page.get("has_more") or not after:
                    break
        except (ApiError, ClientError, BotoCoreError) as e:
            summary["errors"].append(f"{profile.get('name')}: {getattr(e, 'message', None) or e}"[:300])
    log.info(json.dumps({"stripeSync": summary, "actor": actor}, default=str))
    return summary


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
    if added_items and billing.get("status") not in OPEN_STATUSES:
        out["oneOff"] = _bill_pending_items(customer_id, tenant_id)
        write_audit(tenant_id, "late_fees_invoiced", actor, {"invoiceId": out["oneOff"]})
    return out


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
    for profile in _all_profiles():
        billing = _billing(profile)
        tenant_id, name = profile["tenantId"], profile.get("name") or profile["tenantId"]
        days = _days_since(billing.get("pastDueSince"))
        try:
            worked = work_invoices(profile, now, actor)
            reminded += worked["reminded"]
            fees += worked["fees"]
            interest += worked["interest"]
        except (ApiError, ClientError, BotoCoreError) as e:
            failed.append(f"{name} invoices: {getattr(e, 'message', None) or e}"[:300])
        try:
            # A try-out that has run its course becomes a subscription.
            since = _parse(billing.get("termsSince"))
            if (billing.get("terms") == "trial" and trial_months > 0 and since and billing.get("subscriptionId")
                    and billing.get("status") in OPEN_STATUSES and not billing.get("cancelAt")
                    and now >= _add_months(since, trial_months)):
                stripe_request("POST", f"/subscriptions/{billing['subscriptionId']}", {"metadata[terms]": "subscription"})
                store_subscription(tenant_id, billing["customerId"], {},
                                   extra={"terms": "subscription", "termsSince": now_iso(), "convertedBy": actor})
                write_audit(tenant_id, "subscription_converted", actor, {"from": "trial", "after_months": trial_months})
                converted.append(f"{name} (try-out since {since.date().isoformat()})")
            # A cancelled subscription that has ended: the customer is offboarded.
            if (billing.get("offboardAtEnd") and billing.get("status") == "canceled"
                    and profile.get("status") in ("active", "suspended")):
                offboard_tenant(tenant_id, profile, actor, reason="subscription ended")
                client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id),
                                               UpdateExpression="REMOVE billing.offboardAtEnd")
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
                    and billing.get("status") in ("active", "trialing"):
                resume_tenant(tenant_id, actor)
                client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id),
                                               UpdateExpression="REMOVE billing.autoSuspended")
                resumed.append(name)
        except (ApiError, ClientError, BotoCoreError) as e:
            failed.append(f"{name}: {getattr(e, 'message', None) or e}"[:300])
    summary = {"status": "done", "limitDays": limit, "suspended": suspended, "resumed": resumed, "failed": failed,
               "reminded": reminded, "fees": fees, "interest": interest, "converted": converted, "offboarded": offboarded}
    if suspended or resumed or failed or reminded or fees or interest or converted or offboarded:
        lines = [f"Dunning ({env('ENVIRONMENT', 'dev')}): past due limit {limit} days.", ""]
        lines += [f"Reminder sent: {r}" for r in reminded] + [f"Late fee added: {f}" for f in fees]
        lines += [f"Interest added: {i}" for i in interest]
        lines += [f"Try-out became a subscription: {c}" for c in converted] + [f"Offboarded (subscription ended): {o}" for o in offboarded]
        lines += [f"Suspended: {s}" for s in suspended] + [f"Resumed: {r}" for r in resumed] + [f"FAILED: {x}" for x in failed]
        topic = env("ALERT_TOPIC_ARN", "")
        if topic:
            try:
                client("sns").publish(TopicArn=topic, Subject=f"[{env('ENVIRONMENT', 'dev')}] Booqy dunning: "
                                      f"{len(reminded)} reminded, {len(fees)} fees, {len(suspended)} suspended, "
                                      f"{len(resumed)} resumed", Message="\n".join(lines))
            except (ClientError, BotoCoreError):
                log.warning("dunning summary not published", exc_info=True)
    log.info(json.dumps(summary, default=str))
    return summary


def finance_task(event: dict, context) -> dict:
    if event.get("financeTask") == "dunning":
        return dunning_task(event, context)
    return {"status": "unknown_task"}
