"""The customers' agreements and their monthly invoices, in advance.

One Stripe Customer per restaurant company on the PLATFORM account (never
the restaurant's own connected account); no Stripe subscriptions. The
agreement lives on PROFILE.billing: status (active, ended), startsAt,
endsAt, terms (trial = try-out period: leaves at the end of the current
month and becomes a subscription after BILLING_TRIAL_MONTHS; subscription
= BILLING_NOTICE_MONTHS notice), priceSek (own monthly price, else the
plan's; kept while on Free as the price after it), collectionPreference
(card = the saved card is charged automatically, the default; invoice =
emailed, pay within BILLING_DAYS_UNTIL_DUE days), cycle ("advance"),
paidThrough (the last day invoiced), lastInvoicedPeriodEnd (the old
arrears cycle, read once by the switch), offboardAtEnd, priceHistory
([{from, monthlySek, planName, exact?}]: a change applies from the next
month; an `exact` one, a move onto or off the Free plan, from its own day,
pro rata), freeUntil / freeThenPlanId / freeSince / freeNoticeFor (the
Free plan), freeSwitchAgreementPending, previous (earlier agreements).

Billing is per calendar month (Europe/Stockholm), in advance: on the 1st
(financeTask "invoice", daily) every running agreement gets one Stripe
invoice for that month; the first month is invoiced on the agreement's
first day, pro rata by days of the month; an end date inside the month is
pro rata too. 25 % VAT on every line. SMS are included in the price. With a
card on file (and the card preference) Stripe charges it at once (Smart
Retries on failure); without one the invoice is emailed, due in
BILLING_DAYS_UNTIL_DUE_NO_CARD days (BILLING_DAYS_UNTIL_DUE with the
invoice preference). An agreement from the old cycle (25th to 24th in
arrears) gets one closing invoice from the day after its last invoiced
period to the end of the current month, then continues in advance.

Late payment (dunning_task): reminders by email at BILLING_REMINDER_STEPS
days after the due date and a final notice at BILLING_FINAL_NOTICE_DAYS,
to the restaurant and to the operators (once per invoice and step); a
reminder fee at the first step and the statutory förseningsersättning at
the second (offset by the reminder fee), interest (reference rate + 8 %)
once paid, all on separate fee invoices; a daily overdue summary to the
operators. Nothing is suspended automatically (BILLING_SUSPEND_AFTER_DAYS
0). The ledger rows mirror those platform-stripe-webhook writes
(application shared/billing.py), with the same booking flags.
"""

import json
import time
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

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
STOCKHOLM = ZoneInfo("Europe/Stockholm")


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
def _today() -> date:
    """Billing days are Stockholm days."""
    from .website import stockholm_today           # website imports nothing from here
    return stockholm_today()


def vat_number_of(profile: dict) -> str | None:
    """The buyer's Swedish VAT number: the one given, else SE + the
    organisation number + 01."""
    given = (profile.get("vatNumber") or "").replace(" ", "").upper()
    if given:
        return given
    digits = "".join(ch for ch in str(profile.get("orgNumber") or "") if ch.isdigit())
    return f"SE{digits}01" if len(digits) == 10 else None


def billing_email_of(profile: dict, account: dict | None = None) -> str | None:
    """Where invoices go: the operator's billing email, else the owner's,
    the contact address or the connected Stripe account's email."""
    return (profile.get("billingEmail") or profile.get("ownerEmail") or profile.get("contactEmail")
            or (account or {}).get("email") or None)


def _connected_account(profile: dict) -> dict | None:
    """The restaurant's connected Stripe account as the platform sees it
    (read only: it is never charged), once its details are submitted."""
    stripe = profile.get("stripe") if isinstance(profile.get("stripe"), dict) else {}
    account_id = stripe.get("accountId")
    if not account_id or not stripe.get("detailsSubmitted"):
        return None
    try:
        return stripe_request("GET", f"/accounts/{account_id}")
    except ApiError as e:
        log.warning("connected account %s not read: %s", account_id, e.message)
        return None


def _customer_params(tenant_id: str, profile: dict, account: dict | None = None) -> dict:
    """The billing customer's details: the tenant record first, gaps filled
    from the connected account (company name and address, email)."""
    account = account or {}
    company = account.get("company") or {}
    business = account.get("business_profile") or {}
    address = profile.get("address") or {}
    acc_address = company.get("address") or {}
    params = {
        "name": profile.get("legalName") or company.get("name") or business.get("name") or profile.get("name"),
        "email": billing_email_of(profile, account),
        "description": f"{profile.get('name')} ({profile.get('slug')})",
        "preferred_locales[0]": "sv",
        "metadata[tenantId]": tenant_id,
        "metadata[slug]": profile.get("slug") or "",
        "metadata[environment]": env("ENVIRONMENT", "dev"),
    }
    if profile.get("orgNumber"):
        params["metadata[orgNumber]"] = profile["orgNumber"]
    if address.get("street"):
        params.update({"address[line1]": address.get("street"), "address[postal_code]": address.get("postalCode") or "",
                       "address[city]": address.get("city") or "", "address[country]": address.get("country") or "SE"})
    elif acc_address.get("line1"):
        params.update({"address[line1]": acc_address.get("line1"), "address[line2]": acc_address.get("line2") or "",
                       "address[postal_code]": acc_address.get("postal_code") or "",
                       "address[city]": acc_address.get("city") or "", "address[country]": acc_address.get("country") or "SE"})
    return {k: val for k, val in params.items() if val}


def sync_customer(tenant_id: str, profile: dict, *, actor: str = "billing") -> bool:
    """Keeps the billing customer's name, address, email and VAT number in
    step with the tenant record (and the connected account), so invoices
    reach the right address with the right company details. Writes to
    Stripe only when something changed (a hash on PROFILE.billing).
    True when it wrote."""
    import hashlib
    billing = _billing(profile)
    customer_id = billing.get("customerId")
    if not customer_id:
        return False
    params = _customer_params(tenant_id, profile, _connected_account(profile))
    vat = vat_number_of(profile)

    def hash_of(vat_part):
        return hashlib.sha256(json.dumps({**params, "vat": vat_part}, sort_keys=True).encode()).hexdigest()[:20]
    digest = hash_of(vat)
    if billing.get("customerSyncHash") == digest:
        return False
    stripe_request("POST", f"/customers/{customer_id}", params, idempotency_key=f"customer-sync-{tenant_id}-{digest}")
    fields: dict = {"customerSyncHash": digest, "customerSyncedAt": now_iso()}
    if vat and vat != billing.get("customerVat"):
        try:
            tax = stripe_request("POST", f"/customers/{customer_id}/tax_ids", {"type": "eu_vat", "value": vat},
                                 idempotency_key=f"customer-vat-{tenant_id}-{vat}")
            old = billing.get("customerTaxId")
            if old and old != tax.get("id"):
                try:
                    stripe_request("DELETE", f"/customers/{customer_id}/tax_ids/{old}", {},
                                   idempotency_key=f"customer-vat-del-{tenant_id}-{old}")
                except ApiError as e:
                    log.warning("old VAT number %s not removed: %s", old, e.message)
            fields.update({"customerVat": vat, "customerTaxId": tax.get("id")})
        except ApiError as e:
            # Not in the hash: the next run tries the VAT number again.
            fields["customerSyncHash"] = hash_of(billing.get("customerVat"))
            log.warning("VAT number not registered on %s: %s", customer_id, e.message)
    _write_billing(tenant_id, fields)
    write_audit(tenant_id, "billing_customer_synced", actor, {"customerId": customer_id, "email": params.get("email"),
                                                              "name": params.get("name"), "vat": vat})
    return True


# ------------------------------------------------------------- the seller (mervärdesskattelagen 17 kap 24 §)
def seller() -> dict:
    """Booqy's own details for every invoice (BILLING_SELLER_JSON, not
    secret): name, address, org_number, vat_number, seat, f_skatt."""
    try:
        raw = json.loads(env("BILLING_SELLER_JSON", "") or "{}")
    except ValueError:
        raw = {}
    return raw if isinstance(raw, dict) else {}


SELLER_REQUIRED = ("name", "address", "org_number", "vat_number")


def seller_missing() -> list[str]:
    s = seller()
    return [k for k in SELLER_REQUIRED if not str(s.get(k) or "").strip()]


def _account_tax_id() -> str | None:
    """Booqy's VAT number as a Stripe account tax id, created once (keyed)
    and remembered on PLATFORM#BILLING / TAX_ID."""
    vat = str(seller().get("vat_number") or "").replace(" ", "").upper()
    if not vat:
        return None
    key = {"PK": {"S": "PLATFORM#BILLING"}, "SK": {"S": "TAX_ID"}}
    row = client("dynamodb").get_item(TableName=tenant_table(), Key=key).get("Item") or {}
    if row.get("vat", {}).get("S") == vat and row.get("taxId", {}).get("S"):
        return row["taxId"]["S"]
    tax = stripe_request("POST", "/tax_ids", {"type": "eu_vat", "value": vat, "owner[type]": "self"},
                         idempotency_key=f"account-tax-id-{vat}")
    client("dynamodb").put_item(TableName=tenant_table(), Item={**key, "vat": {"S": vat}, "taxId": {"S": tax["id"]},
                                                               "updatedAt": {"S": now_iso()}})
    return tax["id"]


def compliance_params() -> dict:
    """What every invoice carries besides Stripe's own number, dates and
    amounts: Booqy's organisation number, registered office and F-skatt as
    custom fields, name, address and VAT number in the footer, the VAT
    number as an account tax id."""
    s = seller()
    params: dict = {}
    fields = [("Org.nr", s.get("org_number")), ("Säte", s.get("seat")),
              ("F-skatt", "Godkänd för F-skatt" if s.get("f_skatt") else None)]
    i = 0
    for name, value in fields:
        if value:
            params[f"custom_fields[{i}][name]"] = name
            params[f"custom_fields[{i}][value]"] = str(value)[:140]
            i += 1
    footer = ", ".join(str(x) for x in (s.get("name"), s.get("address"),
                                        f"Momsreg.nr {s['vat_number']}" if s.get("vat_number") else None) if x)
    if footer:
        params["footer"] = footer[:5000]
    try:
        tax_id = _account_tax_id()
    except ApiError as e:
        log.warning("account tax id not created: %s", e.message)
        tax_id = None
    if tax_id:
        params["account_tax_ids[0]"] = tax_id
    return params


def ensure_customer(tenant_id: str, profile: dict, actor: str) -> str:
    """The tenant's Stripe customer, created on first use and claimed in the
    same transaction as the first PROFILE.billing write."""
    existing = _billing(profile).get("customerId")
    if existing:
        return existing
    customer = stripe_request("POST", "/customers", _customer_params(tenant_id, profile, _connected_account(profile)),
                              idempotency_key=f"customer-{tenant_id}")
    customer_id = customer["id"]
    vat, tax_id = vat_number_of(profile), None
    if vat:
        try:
            tax_id = stripe_request("POST", f"/customers/{customer_id}/tax_ids", {"type": "eu_vat", "value": vat},
                                    idempotency_key=f"customer-vat-{tenant_id}-{vat}").get("id")
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
    if tax_id:
        _write_billing(tenant_id, {"customerVat": vat, "customerTaxId": tax_id})
    write_audit(tenant_id, "stripe_customer_created", actor, {"customerId": customer_id})
    return customer_id


# ------------------------------------------------------------- the ledger
# Still owed: open, or uncollectible (Stripe's last card retry gave up; the
# restaurant can still pay it and is still reminded).
OWED = ("open", "uncollectible")


def due_date_of(invoice: dict) -> str | None:
    """The due date: Stripe's own for an emailed invoice; a card invoice has
    none (it is due when charged), so the day it was finalized."""
    due = _iso(invoice.get("due_date"))
    if due or invoice.get("collection_method") != "charge_automatically":
        return due
    return _iso((invoice.get("status_transitions") or {}).get("finalized_at"))


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
        # The billed period (a calendar month or part of one) is in the
        # metadata, like the webhook reads it; Stripe's own period of a
        # one-off invoice is its creation.
        "dueDate": due_date_of(invoice),
        "kind": metadata.get("kind"), "feesFor": metadata.get("invoiceId") if metadata.get("kind") == "fees" else None,
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
    credits = credits_by_invoice(tenant_id) if rows else {}
    out = []
    for r in rows[:limit]:
        total = r.get("totalSek") or Decimal(0)
        cn = credits.get(r.get("invoiceId")) or {}
        remaining = r.get("amountRemainingSek") or Decimal(0)
        out.append({
            "invoiceId": r.get("invoiceId"), "number": r.get("number"), "status": r.get("status"),
            "month": ((r.get("periodStart") if r.get("kind") in ("advance", "closing") else r.get("periodEnd"))
                      or r.get("createdAt") or "")[:7] or None, "kind": r.get("kind"),
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
            # credit notes on it, incl VAT: back to the card, and the rest
            "refundedSek": cn.get("refundedSek", Decimal("0.00")), "creditedSek": cn.get("creditedSek", Decimal("0.00")),
            "creditableSek": creditable_sek(r, cn),
            "refundable": r.get("status") == "paid" and not r.get("paidOutOfBand")
            and Decimal(r.get("amountPaidSek") or 0) > 0,
            "reminderStep": max([st for st in reminder_steps() if r.get(f"customerReminder{st}At")], default=None),
        })
    return out


# ------------------------------------------------------------- periods: calendar months
SV_MONTHS = ("jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec")


def month_end(day: date) -> date:
    return (day.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


def period_of(day: date) -> tuple[date, date]:
    """The billing month a day falls in: from the 1st to its last day."""
    return day.replace(day=1), month_end(day)


def next_period(end: date) -> tuple[date, date]:
    return period_of(end + timedelta(days=1))


def legacy_period_of(day: date) -> tuple[date, date]:
    """The old arrears period (25th to 24th), read only by the switch."""
    start = day.replace(day=25) if day.day >= 25 else (day.replace(day=1) - timedelta(days=1)).replace(day=25)
    end = (start + timedelta(days=31)).replace(day=24)
    return start, end


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
    """The monthly price for the days of [start, end] (inside one month),
    pro rata by the days of that month."""
    return prorate(price_sek, active_days(starts_at, ends_at, start, end), period_days(*period_of(start)))


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
    day = (on or _today()).isoformat()
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
    today = today or _today()
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


def _sub_period(sub: dict, billing: dict, field: str) -> date | None:
    """A legacy subscription's current period start or end as a Stockholm
    date: from the subscription (or its first item, newer API versions), else
    what PROFILE.billing recorded."""
    items = ((sub.get("items") or {}).get("data") or [{}]) if isinstance(sub, dict) else [{}]
    ts = (sub or {}).get(f"current_{field}") or (items[0] or {}).get(f"current_{field}")
    if isinstance(ts, (int, float)) and ts > 0:
        return datetime.fromtimestamp(int(ts), STOCKHOLM).date()
    iso = billing.get("currentPeriodStart" if field == "period_start" else "currentPeriodEnd")
    parsed = _parse(iso) if isinstance(iso, str) else None
    if parsed is not None:
        return parsed.astimezone(STOCKHOLM).date()
    return None


def migrate_legacy(tenant_id: str, profile: dict, actor: str) -> dict | None:
    """A Stripe subscription from the first version (billed in advance):
    cancelled without a final invoice, its open advance invoice voided, and
    the agreement continues in advance per calendar month from the day after
    the last period the subscription collected (paidThrough), so no day is
    invoiced twice: the period end less a day when it was paid, the day
    before the period when its open invoice was voided."""
    billing = _billing(profile)
    sub_id = billing.get("subscriptionId")
    if not sub_id:
        return None
    customer_id = billing.get("customerId")
    voided = []
    sub: dict = {}
    if billing.get("status") not in ("canceled", "incomplete_expired"):
        sub = stripe_request("DELETE", f"/subscriptions/{sub_id}", {"invoice_now": "false", "prorate": "false"}) or {}
        if customer_id:
            page = stripe_request("GET", "/invoices", {"customer": customer_id, "subscription": sub_id, "status": "open", "limit": 100})
            for invoice in page.get("data") or []:
                stripe_request("POST", f"/invoices/{invoice['id']}/void", {})
                voided.append(invoice["id"])
    started = _date(billing.get("startedAt")) or _date(billing.get("termsSince")) or _today()
    ended = billing.get("status") in ("canceled", "incomplete_expired")
    ends_at = (_date(billing.get("canceledAt")) or started) if ended else None
    if ended:
        paid = ends_at
    elif voided:
        period_start = _sub_period(sub, billing, "period_start")
        paid = period_start - timedelta(days=1) if period_start else None
    else:
        period_end = _sub_period(sub, billing, "period_end")
        # Unknown (never seen): the days so far count as collected, never
        # charged again.
        paid = period_end - timedelta(days=1) if period_end else _today() - timedelta(days=1)
    if paid is not None and paid < started:
        paid = None
    fields = {
        "status": "ended" if ended else "active", "startsAt": started.isoformat(),
        "endsAt": ends_at.isoformat() if ends_at else None,
        "cycle": "advance", "paidThrough": paid.isoformat() if paid else None,
        "legacySubscriptionId": sub_id, "subscriptionId": None, "priceId": None, "mrrSek": None,
        "currentPeriodStart": None, "currentPeriodEnd": None, "cancelAt": None, "canceledAt": None,
        "pauseCollection": None, "trialEnd": None, "eventCreated": None,
    }
    _write_billing(tenant_id, fields)
    write_audit(tenant_id, "billing_migrated_to_advance", actor, {"subscriptionId": sub_id, "voidedInvoices": voided,
                                                                  "paidThrough": fields["paidThrough"]})
    return {"subscriptionId": sub_id, "voided": voided, "paidThrough": fields["paidThrough"]}


# ------------------------------------------------------------- what a period costs
def invoice_plan(profile: dict, start: date, end: date, plan: dict | None = None) -> dict:
    """What one month's invoice (or [start, end], a part of one month)
    carries: the monthly price for the days the agreement runs, at the
    price of each day, pro rata by the days of the month."""
    billing = _billing(profile)
    plan = plan if plan is not None else plan_of(profile)
    ends_at = _date(billing.get("endsAt"))
    days = period_days(*period_of(start))
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
    paid_set: list[date] = []
    for day in sorted(active_set):
        entry = price_on(billing, first_day, day) or fallback
        key = (int(entry.get("monthlySek") or 0), entry.get("planName") or "")
        by_entry[key] = by_entry.get(key, 0) + 1
        if key[0] > 0:
            paid_set.append(day)
    fee = sum((prorate(price, n, days) for (price, _name), n in by_entry.items()), Decimal("0.00"))
    paid = [(name, n) for (price, name), n in by_entry.items() if price > 0]
    paid_days = sum(n for _name, n in paid)
    last_entry = price_on(billing, first_day, max(active_set)) if active_set else prices_for(billing, start)
    price = int((last_entry or fallback).get("monthlySek") or 0)
    names = list(dict.fromkeys(name for name, _n in paid)) or [(last_entry or fallback).get("planName") or ""]
    shown = paid_set or sorted(active_set)
    shown_start = shown[0] if shown else start
    shown_end = shown[-1] if shown else end
    period = period_text(shown_start, shown_end)
    fee_text = f"Booqy {' och '.join(names)}, {period}".strip()
    if 0 < paid_days < days:
        fee_text += f" ({paid_days} av {days} dagar)"
    return {
        "periodStart": start.isoformat(), "periodEnd": end.isoformat(), "period": period,
        "days": days, "activeDays": active, "billedDays": paid_days, "monthlySek": price, "feeSek": fee.quantize(CENTS),
        "feeText": fee_text, "totalSek": fee.quantize(CENTS), "final": bool(ends_at and ends_at <= end),
        "nothingToInvoice": fee == 0,
    }


def paid_through(billing: dict) -> date | None:
    """The last day invoiced: paidThrough in advance, the end of the last
    invoiced period on the old cycle."""
    if billing.get("cycle") == "advance":
        return _date(billing.get("paidThrough"))
    return _date(billing.get("lastInvoicedPeriodEnd"))


def _next_active_day(billing: dict, day: date) -> date | None:
    """The first day on or after `day` that an agreement covers."""
    best = None
    for a, b in stints(billing):
        if b is not None and b < day:
            continue
        candidate = max(a, day)
        best = candidate if best is None or candidate < best else best
    return best


def pending_advance(billing: dict, today: date) -> list[tuple[date, date]]:
    """The months (or parts of months) to invoice now, in advance: from the
    first uninvoiced active day to its month's end (or the agreement's end),
    once that day has come. On the 1st the whole month; on an agreement's
    first day (a start, or the first paid day after Free) the rest of that
    month at once."""
    if not _date(billing.get("startsAt")) or billing.get("status") not in ("active", "ended"):
        return []
    done = paid_through(billing)
    first = _next_active_day(billing, done + timedelta(days=1) if done else date.min)
    out = []
    while first is not None and first <= today:
        end = month_end(first)
        covering = [b for a, b in stints(billing) if a <= first and (b is None or b >= first)]
        stop = None if not covering or any(b is None for b in covering) else max(covering)
        if stop is not None and stop < end:
            end = stop
        out.append((first, end))
        first = _next_active_day(billing, end + timedelta(days=1))
    return out


def pending_periods(billing: dict, today: date) -> list[tuple[date, date]]:
    """What the next run invoices: the closing stretch of an agreement on
    the old cycle (one invoice), else the advance months."""
    if billing.get("cycle") != "advance":
        closing = closing_range(billing, today)
        return [closing] if closing else []
    return pending_advance(billing, today)


def closing_range(billing: dict, today: date) -> tuple[date, date] | None:
    """An agreement still on the old cycle (25th to 24th in arrears) that
    has invoiced days: from the day after its last invoiced period to the
    end of the current month (or its end date), on one closing invoice, so
    advance billing starts on the next 1st with no gap and no overlap."""
    if billing.get("cycle") == "advance" or billing.get("status") not in ("active", "ended"):
        return None
    done = _date(billing.get("lastInvoicedPeriodEnd"))
    if done is None:
        return None
    first = _next_active_day(billing, done + timedelta(days=1))
    if first is None or first > month_end(today):
        return None
    last = month_end(today)
    ends = [b for _a, b in stints(billing)]
    if ends and all(b is not None for b in ends):
        last = min(last, max(ends))
    return (first, last) if first <= last else None


def month_segments(start: date, end: date) -> list[tuple[date, date]]:
    out = []
    while start <= end:
        out.append((start, min(end, month_end(start))))
        start = month_end(start) + timedelta(days=1)
    return out


# ------------------------------------------------------------- the Billing tab
def _view(profile: dict, today: date | None = None) -> dict:
    today = today or _today()
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
        "collectionPreference": collection_preference(billing),
        "collectionMethod": "charge_automatically" if collection_preference(billing) == "card"
        and billing.get("defaultPaymentMethod") else "send_invoice",
        "cardBrand": billing.get("cardBrand"), "cardLast4": billing.get("cardLast4"),
        "cardAddedAt": billing.get("cardAddedAt"), "cycle": billing.get("cycle") or "arrears",
        "paidThrough": (paid_through(billing).isoformat() if paid_through(billing) else None),
        "billingEmail": billing_email_of(profile),
        "hasCard": bool(billing.get("defaultPaymentMethod")),
        "pastDueSince": billing.get("pastDueSince"), "autoSuspended": bool(billing.get("autoSuspended")),
        "lastPaidAt": billing.get("lastPaidAt"), "lastPaymentFailedAt": billing.get("lastPaymentFailedAt"),
        "startedAt": billing.get("startedAt"), "startedBy": billing.get("startedBy"),
        "lastInvoicedPeriodEnd": billing.get("lastInvoicedPeriodEnd"), "offboardAtEnd": bool(billing.get("offboardAtEnd")),
        "noticeMonths": int(_env_num("BILLING_NOTICE_MONTHS", "3")), "trialMonths": trial_months,
        "daysUntilDue": days_until_due(billing), "suspendAfterDays": int(env("BILLING_SUSPEND_AFTER_DAYS", "0")),
        "reminderSteps": reminder_steps(), "finalNoticeDays": final_notice_days(),
        "sellerMissing": seller_missing(),
        "plan": {"planId": plan.get("planId"), "name": plan.get("name"), "priceSek": plan.get("priceSek"),
                 "free": bool(plan.get("free"))},
        "legacySubscriptionId": billing.get("legacySubscriptionId"), "pendingSubscriptionId": billing.get("subscriptionId"),
        "nextInvoice": None, "pendingPeriods": len(pending_periods(billing, today)),
        "previous": [{"startsAt": s.get("startsAt"), "endsAt": s.get("endsAt")} for s in billing.get("previous") or []],
    }
    upcoming = next_invoice_range(billing, today)
    if upcoming and ph in ("scheduled", "active", "ending"):
        start, end, on = upcoming
        if billing.get("cycle") != "advance" and closing_range(billing, today):
            parts = [invoice_plan(profile, a, b, plan) for a, b in month_segments(start, end)]
            current = {**parts[-1], "periodStart": start.isoformat(), "periodEnd": end.isoformat(),
                       "period": period_text(start, end), "kind": "closing",
                       "feeSek": sum((p["feeSek"] for p in parts), Decimal("0.00")),
                       "totalSek": sum((p["totalSek"] for p in parts), Decimal("0.00"))}
        else:
            current = {**invoice_plan(profile, start, end, plan), "kind": "advance"}
        view["nextInvoice"] = {**current, "date": on.isoformat(),
                               "dueDate": (on + timedelta(days=view["daysUntilDue"])).isoformat()
                               if view["collectionMethod"] == "send_invoice" else on.isoformat()}
    return view


def next_invoice_range(billing: dict, today: date) -> tuple[date, date, date] | None:
    """The next invoice: (first day, last day, the day it is made)."""
    closing = closing_range(billing, today)
    if billing.get("cycle") != "advance" and closing:
        return closing[0], closing[1], today
    pending = pending_advance(billing, today)
    if pending:
        return pending[0][0], pending[0][1], today
    done = paid_through(billing) if billing.get("cycle") == "advance" else None
    first = _next_active_day(billing, done + timedelta(days=1) if done else date.min) if _date(billing.get("startsAt")) else None
    if first is None:
        return None
    covering = [b for a, b in stints(billing) if a <= first and (b is None or b >= first)]
    stop = None if not covering or any(b is None for b in covering) else max(covering)
    end = min(month_end(first), stop) if stop else month_end(first)
    return first, end, first


# ------------------------------------------------------------- collection
COLLECTION_PREFERENCES = ("card", "invoice")


def collection_preference(billing: dict) -> str:
    """card (default: the saved card is charged automatically) or invoice
    (emailed, pay within BILLING_DAYS_UNTIL_DUE days). The old
    collectionMethod send_invoice chosen by an operator counts as invoice."""
    pref = billing.get("collectionPreference")
    if pref in COLLECTION_PREFERENCES:
        return pref
    if billing.get("collectionMethod") == "send_invoice" and billing.get("collectionMethodChosen"):
        return "invoice"
    return "card"


def days_until_due(billing: dict) -> int:
    if collection_preference(billing) == "invoice":
        return int(env("BILLING_DAYS_UNTIL_DUE", "30"))
    return int(env("BILLING_DAYS_UNTIL_DUE_NO_CARD", "10"))


def collection_for(customer_id: str, billing: dict) -> tuple[str, int | None, str | None]:
    """How one invoice is collected: (collection_method, days until due,
    the card). With the card preference and a default payment method on the
    Stripe customer it is charged automatically; otherwise emailed, due in
    10 days (no card yet) or 30 (the invoice preference)."""
    if collection_preference(billing) == "card":
        customer = stripe_request("GET", f"/customers/{customer_id}")
        card = _id((customer.get("invoice_settings") or {}).get("default_payment_method"))
        if card:
            return "charge_automatically", None, card
    return "send_invoice", days_until_due(billing), None


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
    if day > _today() + timedelta(days=365):
        f.fail(field, "At most a year ahead")
    return day


def _preference_input(f: v.Fields) -> str | None:
    """collectionPreference (card | invoice), or the older collectionMethod
    (charge_automatically = card, send_invoice = invoice)."""
    pref = f.text("collectionPreference", max_len=20)
    method = f.text("collectionMethod", max_len=30)
    if pref is not None and pref not in COLLECTION_PREFERENCES:
        f.fail("collectionPreference", "card (charged automatically) or invoice (pay within 30 days)")
    if method is not None and method not in COLLECTION_METHODS:
        f.fail("collectionMethod", "send_invoice (emailed invoice) or charge_automatically (card on file)")
    if pref is None and method is not None:
        pref = "card" if method == "charge_automatically" else "invoice"
    return pref


def start_subscription(req) -> tuple[int, dict]:
    """Starts the agreement (Billing tab): from `startDate` (today by
    default; a past date backdates the first invoice, a future one
    schedules it), on `terms` (trial or subscription), at `priceSek` (the
    customer's own monthly price), collected per `collectionPreference`."""
    tenant_id = req.path["tenantId"]
    f = v.Fields(req.body)
    pref = _preference_input(f)
    start_day = _start_day(f)
    terms = f.text("terms", max_len=20)
    if terms is not None and terms not in TERMS:
        f.fail("terms", "trial (try-out period) or subscription")
    price_sek = f.integer("priceSek", minimum=0, maximum=1_000_000)
    f.done()
    profile = get_profile(tenant_id)
    view = start_for(tenant_id, profile, actor=req.actor, preference=pref,
                     start_day=start_day.isoformat() if start_day else None, price_sek=price_sek, terms=terms)
    return 201, {"billing": view}


def start_for(tenant_id: str, profile: dict, *, actor: str, method: str | None = None, preference: str | None = None,
              start_day: str | None = None, price_sek: int | None = None, terms: str | None = None) -> dict:
    """Creates the Stripe customer (if needed) and the agreement, in
    advance: the first invoice (the rest of the first month, pro rata) is
    made on the start day by the daily run, then one on every 1st. Without a
    card the invoice is emailed (10 days) until the restaurant adds one in
    Booqy Admin. Days already invoiced (a restart inside a paid month) are
    never invoiced again."""
    if profile.get("status") not in ("provisioning", "active"):
        raise ApiError(409, "invalid_status", f"Not possible while the customer is {profile.get('status')}",
                       currentStatus=profile.get("status"))
    billing = _billing(profile)
    today = _today()
    first_day = date.fromisoformat(start_day) if start_day else today
    advance = billing.get("cycle") == "advance" or not billing.get("lastInvoicedPeriodEnd")
    done = paid_through({**billing, "cycle": "advance" if advance else billing.get("cycle")})
    previous = list(billing.get("previous") or [])
    old_start, old_end = _date(billing.get("startsAt")), _date(billing.get("endsAt"))
    if agreement_running(billing, today):
        if not (old_end and old_end < today and old_end < first_day):
            hint = (f" until {old_end.isoformat()}: undo the cancellation with Keep the agreement, or start a new one "
                    f"once it has ended" if old_end else "")
            raise ApiError(409, "already_subscribed", f"The customer already has a running agreement{hint}")
    if old_start and old_end and (not done or old_end > done) and billing.get("status") in ("active", "ended"):
        previous.append({"startsAt": max(old_start, done + timedelta(days=1)).isoformat() if done else old_start.isoformat(),
                         "endsAt": old_end.isoformat()})
    if not advance and done and first_day <= done:
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
    if preference is None and method is not None:
        preference = "card" if method == "charge_automatically" else "invoice"
    preference = preference or collection_preference(billing)
    customer_id = ensure_customer(tenant_id, profile, actor)
    starts = first_day.isoformat()
    fields = {
        "status": "active", "startsAt": starts, "endsAt": None, "terms": terms, "termsSince": f"{starts}T00:00:00Z",
        "priceSek": price_sek, "collectionPreference": preference, "collectionMethod": None,
        "startedAt": now_iso(), "startedBy": actor,
        "previous": [p for p in previous if not done or (_date(p.get("endsAt")) or first_day) > done] or None,
        "offboardAtEnd": None, "autoSuspended": None, "endedAt": None,
        "cancelRequestedAt": None, "cancelRequestedBy": None,
    }
    if advance:
        fields.update({"cycle": "advance", "paidThrough": done.isoformat() if done else None})
    _write_billing(tenant_id, fields)
    # From the start, or today for a later start: a price changed before a
    # scheduled start is the one it starts with.
    record_price(tenant_id, get_profile(tenant_id), plan, on=min(first_day, today))
    try:
        sync_customer(tenant_id, get_profile(tenant_id), actor=actor)
    except ApiError as e:
        log.warning("billing customer of %s not synced: %s", tenant_id, e.message)
    write_audit(tenant_id, "subscription_started", actor,
                {"startsAt": starts, "planId": plan.get("planId"), "collectionPreference": preference, "terms": terms,
                 "priceSek": price_sek, "inAdvance": advance, "previous": fields["previous"]})
    return _view(get_profile(tenant_id))


def end_date_for(billing: dict, today: date) -> date:
    """When a cancellation takes effect: a try-out at the end of the current
    month, a subscription BILLING_NOTICE_MONTHS months after that."""
    _start, end = period_of(today)
    if (billing.get("terms") or "subscription") == "trial":
        return end
    for _ in range(int(_env_num("BILLING_NOTICE_MONTHS", "3"))):
        _start, end = next_period(end)
    return end


def update_subscription(req) -> tuple[int, dict]:
    """action: cancel (ends with the terms: a try-out at the end of the
    current month, a subscription after the notice period; `offboardAtEnd`
    default true), cancel_now (ends today; the month is invoiced in advance,
    so the days left are not refunded), keep (undo a cancellation), convert
    (try-out -> subscription), use_card (charge the card the restaurant
    added), collection (`collectionPreference` card or invoice; also
    without a running agreement)."""
    tenant_id = req.path["tenantId"]
    f = v.Fields(req.body)
    action = f.text("action", required=True, max_len=20)
    offboard_at_end = f.boolean("offboardAtEnd")
    pref = f.text("collectionPreference", max_len=20) if action == "collection" else None
    if action == "collection" and pref not in COLLECTION_PREFERENCES:
        f.fail("collectionPreference", "card (charged automatically) or invoice (pay within 30 days)")
    f.done()
    profile = get_profile(tenant_id)
    billing = _billing(profile)
    customer_id = billing.get("customerId")
    today = _today()
    if action == "collection":
        _write_billing(tenant_id, {"collectionPreference": pref, "collectionMethod": None})
        write_audit(tenant_id, "billing_collection_changed", req.actor,
                    {"from": collection_preference(billing), "to": pref})
        return 200, {"billing": _view(get_profile(tenant_id))}
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
        stripe_request("POST", f"/customers/{customer_id}", {"invoice_settings[default_payment_method]": card},
                       idempotency_key=f"default-pm-{card}")
        details_card = (cards[0].get("card") or {})
        _write_billing(tenant_id, {"collectionPreference": "card", "collectionMethod": None, "defaultPaymentMethod": card,
                                   "cardBrand": details_card.get("brand"), "cardLast4": details_card.get("last4"),
                                   "cardAddedAt": billing.get("cardAddedAt") or now_iso()})
        details = {"paymentMethod": card}
    else:
        raise ApiError(400, "validation_failed", "Unknown action",
                       fields={"action": "cancel, cancel_now, keep, convert, use_card or collection"})
    write_audit(tenant_id, f"subscription_{action}", req.actor, details)
    return 200, {"billing": _view(get_profile(tenant_id))}


def card_link(req) -> tuple[int, dict]:
    """A Stripe Checkout page (setup mode) where the restaurant adds a card;
    the webhook makes it the default (checkout.session.completed), and
    "use_card" does the same by hand."""
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    customer_id = ensure_customer(tenant_id, profile, req.actor)
    # Back to the restaurant's Booqy Admin (Inställningar, Abonnemang), the same
    # page and flags as its own card session; the console only while
    # ADMIN_APP_URL is not set.
    admin = (env("ADMIN_APP_URL", "") or "").rstrip("/")
    if admin:
        success_url, cancel_url = f"{admin}/installningar?kort=klart", f"{admin}/installningar?kort=avbrutet"
    else:
        base = env("PLATFORM_ADMIN_APP_URL").rstrip("/")
        success_url, cancel_url = f"{base}/tenants/{tenant_id}?tab=billing&card=added", f"{base}/tenants/{tenant_id}?tab=billing"
    session = stripe_request("POST", "/checkout/sessions", {
        "mode": "setup", "customer": customer_id, "currency": "sek", "payment_method_types[0]": "card",
        "locale": "sv", "success_url": success_url,
        "cancel_url": cancel_url, "metadata[tenantId]": tenant_id,
        "setup_intent_data[metadata][tenantId]": tenant_id},
        idempotency_key=f"card-link-{tenant_id}-{int(time.time() // 60)}")
    write_audit(tenant_id, "card_link_created", req.actor, {"customerId": customer_id})
    return 200, {"url": session["url"], "expiresAt": _iso(session.get("expires_at"))}


# ------------------------------------------------------------- hooks from tenants
def after_plan_change(tenant_id: str, profile: dict, plan: dict, actor: str, *, exact: bool = False,
                      on: date | None = None, before: dict | None = None) -> dict | None:
    """A changed plan or price applies from the next month: the one running
    is already invoiced in advance (priceHistory). Onto or off Free
    (`exact`) applies from `on` (today), pro rata: days of the current
    month invoiced at 0 kr (Free) are invoiced again from `on` (paidThrough
    moves back), days already invoiced at a price never are. An agreement
    from before price history first gets the price it ran at (`before`,
    the profile before the change) from its start, so its days before the
    change keep that price."""
    billing = _billing(profile)
    if not agreement_running(billing):
        return None
    today = on or _today()
    if exact and before is not None and not billing.get("priceHistory"):
        started = _date(billing.get("startsAt")) or today
        if started < today:
            record_price(tenant_id, before, plan_of(before), on=started)
            profile = get_profile(tenant_id)
    record_price(tenant_id, profile, plan, on=today, exact=exact)
    done = _date(billing.get("paidThrough")) if billing.get("cycle") == "advance" else None
    if exact and done and done >= today:
        priced = _date(billing.get("pricedThrough"))
        back = max(today - timedelta(days=1), priced) if priced else today - timedelta(days=1)
        if back < done:
            _write_billing(tenant_id, {"paidThrough": back.isoformat()})
            write_audit(tenant_id, "billing_rewound", actor, {"paidThrough": back.isoformat(), "from": done.isoformat()})
    _start, end = period_of(today)
    return {"monthlySek": monthly_price(profile, plan), "priceSek": int(billing["priceSek"]) if billing.get("priceSek") is not None else None,
            "from": today.isoformat() if exact else (end + timedelta(days=1)).isoformat()}


def cancel_for_offboarding(tenant_id: str, profile: dict, actor: str) -> dict | None:
    """Offboarded today: the agreement ends today (the month is already
    invoiced in advance). A legacy Stripe subscription is cancelled."""
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
    today = _today().isoformat()
    _write_billing(tenant_id, {"endsAt": today if not billing.get("endsAt") or billing["endsAt"] > today else billing["endsAt"],
                               "offboardAtEnd": None, "cancelRequestedAt": now_iso(), "cancelRequestedBy": actor})
    write_audit(tenant_id, "subscription_cancelled", actor, {"endsAt": today, "reason": "offboarding"})
    return {"endsAt": today, "legacy": legacy}


# ------------------------------------------------------------- invoicing in advance
def _all_profiles() -> list[dict]:
    return query_all(TableName=tenant_table(), IndexName="GSI1", KeyConditionExpression="GSI1PK = :t",
                     ExpressionAttributeValues={":t": {"S": "TENANT"}})


def _ledger(tenant_id: str) -> list[dict]:
    return query_all(TableName=finance_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :i)",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":i": {"S": "INVOICE#"}})


def _already_invoiced(tenant_id: str, kind: str, start: date) -> bool:
    return any(r.get("kind") == kind and (r.get("periodStart") or "")[:10] == start.isoformat()
               and r.get("status") != "void" for r in _ledger(tenant_id))


def _invoiced_through(billing: dict, end: date, *, priced: bool) -> dict:
    """The fields once everything to `end` is invoiced: earlier agreements
    that ended by then are done; prices before the next day are trimmed."""
    left = [s for s in billing.get("previous") or [] if (_date(s.get("endsAt")) or end) > end]
    out = {"cycle": "advance", "paidThrough": end.isoformat(), "previous": left or None}
    if priced:
        out["pricedThrough"] = end.isoformat()
    history = sorted(billing.get("priceHistory") or [], key=lambda h: h.get("from") or "")
    if history:
        nxt = (end + timedelta(days=1)).isoformat()
        keep = max((i for i, h in enumerate(history) if (h.get("from") or "") <= nxt), default=0)
        out["priceHistory"] = history[keep:]
    return out


def _stripe_invoice_for(customer_id: str, tenant_id: str, kind: str, start: date) -> dict | None:
    """The stretch's invoice if Stripe already has it (a run that stopped
    after creating it, or a retry after Stripe forgot the idempotency key,
    24 hours): the ledger may not know it yet."""
    # Newest first; a year back covers any rerun (the stretch is recent).
    since = int(time.time()) - 400 * 86400
    page = stripe_request("GET", "/invoices", {"customer": customer_id, "created[gte]": since, "limit": 100})
    for invoice in page.get("data") or []:
        md = invoice.get("metadata") or {}
        if (md.get("kind") == kind and md.get("tenantId") == tenant_id and md.get("periodStart") == start.isoformat()
                and invoice.get("status") != "void"):
            return invoice
    return None


def plan_for_range(profile: dict, start: date, end: date, plan: dict | None = None, kind: str = "advance") -> dict:
    """What the invoice for [start, end] carries: one fee line per calendar
    month in it (a closing invoice can span two)."""
    parts = [invoice_plan(profile, a, b, plan) for a, b in month_segments(start, end)]
    fee = sum((p["feeSek"] for p in parts), Decimal("0.00"))
    last = parts[-1]
    return {**last, "kind": kind, "parts": parts, "periodStart": start.isoformat(), "periodEnd": end.isoformat(),
            "period": period_text(start, end) if len(parts) > 1 else last["period"],
            "feeSek": fee, "totalSek": fee, "nothingToInvoice": fee == 0,
            "billedDays": sum(p["billedDays"] for p in parts), "activeDays": sum(p["activeDays"] for p in parts)}


def _cents(amount: Decimal) -> int:
    return int((amount * 100).to_integral_value(rounding=ROUND_HALF_UP))


def _ts(day: date, end: bool = False) -> int:
    """A line's period bound in Stockholm time (00:00 or 23:59:59), so the
    invoice shows the billed days themselves, also when Stripe renders the
    period in the account's timezone."""
    t = datetime.max.time().replace(microsecond=0) if end else datetime.min.time()
    return int(datetime.combine(day, t, tzinfo=STOCKHOLM).timestamp())


def build_invoice(tenant_id: str, profile: dict, start: date, end: date, plan: dict, actor: str,
                  kind: str = "advance") -> dict:
    """One Stripe invoice for [start, end] (kind advance: a month or the
    rest of one; closing: the switch from the old cycle), with only its own
    fee lines (never other pending items), charged to the card or emailed."""
    billing = _billing(profile)
    plan_ = plan_for_range(profile, start, end, plan, kind)
    result = {"tenantId": tenant_id, "name": profile.get("name"), **{k: val for k, val in plan_.items() if k != "parts"}}
    if plan_["nothingToInvoice"]:
        _write_billing(tenant_id, _invoiced_through(billing, end, priced=False))
        result["invoiceId"] = None
        return result
    customer_id = billing.get("customerId") or ensure_customer(tenant_id, profile, actor)
    if _already_invoiced(tenant_id, kind, start):
        _write_billing(tenant_id, _invoiced_through(billing, end, priced=True))
        result["invoiceId"] = "exists"
        return result
    tax = env("BILLING_TAX_RATE_ID", "")
    if not tax:
        raise ApiError(500, "no_vat_rate", "BILLING_TAX_RATE_ID is not set: no invoice is sent without VAT")
    if env("ENVIRONMENT", "dev") == "prod" and seller_missing():
        raise ApiError(500, "no_seller_details", "BILLING_SELLER_JSON lacks " + ", ".join(seller_missing())
                       + ": no invoice is sent without Booqy's details (mervärdesskattelagen 17 kap 24 §)")
    method, due, _card = collection_for(customer_id, billing)
    key = f"{kind}-{tenant_id}-{start.isoformat()}"
    invoice = _stripe_invoice_for(customer_id, tenant_id, kind, start)
    found = invoice
    if invoice is None:
        params = {"customer": customer_id, "currency": "sek", "collection_method": method, "auto_advance": "false",
                  "pending_invoice_items_behavior": "exclude",
                  "description": f"Booqy, {plan_['period']}" + (" (avslutande faktura vid byte till betalning i förskott)"
                                                                 if kind == "closing" else ", betalas i förskott"),
                  "metadata[tenantId]": tenant_id, "metadata[kind]": kind, "metadata[periodStart]": start.isoformat(),
                  "metadata[periodEnd]": end.isoformat(), **compliance_params()}
        if due is not None:
            params["days_until_due"] = due
        invoice = stripe_request("POST", "/invoices", params, idempotency_key=f"inv-{key}")
    method = invoice.get("collection_method") or method
    lines = (invoice.get("lines") or {}).get("data") or []
    if found is not None and invoice.get("status") == "draft":
        # A draft a stopped run left: its lines as Stripe has them now.
        lines = stripe_request("GET", f"/invoices/{invoice['id']}/lines", {"limit": 100}).get("data") or []
    have = {(ln.get("metadata") or {}).get("segment") for ln in lines}
    if invoice.get("status") == "draft":
        for part in plan_["parts"]:
            if part["feeSek"] <= 0 or part["periodStart"] in have:
                continue
            a, b = _date(part["periodStart"]), _date(part["periodEnd"])
            stripe_request("POST", "/invoiceitems", {
                "customer": customer_id, "invoice": invoice["id"], "currency": "sek", "amount": _cents(part["feeSek"]),
                "description": part["feeText"], "tax_rates[0]": tax, "period[start]": _ts(a), "period[end]": _ts(b, True),
                "metadata[tenantId]": tenant_id, "metadata[kind]": "fee", "metadata[segment]": part["periodStart"],
                "metadata[periodEnd]": part["periodEnd"]}, idempotency_key=f"fee-{key}-{part['periodStart']}")
        # auto_advance: Stripe's Smart Retries take over a failed card payment.
        invoice = stripe_request("POST", f"/invoices/{invoice['id']}/finalize", {"auto_advance": "true"},
                                 idempotency_key=f"finalize-{invoice['id']}")
    delivery = "paid" if invoice.get("status") == "paid" else "sent"
    if invoice.get("status") == "open":
        try:
            if method == "send_invoice":
                stripe_request("POST", f"/invoices/{invoice['id']}/send", {}, idempotency_key=f"send-{invoice['id']}")
            else:
                invoice = stripe_request("POST", f"/invoices/{invoice['id']}/pay", {}, idempotency_key=f"pay-{invoice['id']}")
                delivery = "charged"
        except ApiError as e:
            delivery = f"not {'sent' if method == 'send_invoice' else 'charged'} (Stripe retries): {e.message}"
    record_invoice(tenant_id, invoice)
    row = _invoice_row(tenant_id, invoice)
    _mark(row, periodStart=start.isoformat(), periodEnd=end.isoformat(), feeSek=plan_["feeSek"], kind=kind,
          billedDays=plan_["billedDays"], collectionMethod=method)
    _write_billing(tenant_id, _invoiced_through(billing, end, priced=True))
    write_audit(tenant_id, "invoice_created", actor, {"invoiceId": invoice["id"], "number": invoice.get("number"),
                                                      "kind": kind, "period": plan_["period"], "feeSek": plan_["feeSek"],
                                                      "totalSek": plan_["totalSek"], "delivery": delivery,
                                                      "collectionMethod": method})
    result.update({"invoiceId": invoice["id"], "number": invoice.get("number"), "delivery": delivery,
                   "collectionMethod": method, "hostedInvoiceUrl": invoice.get("hosted_invoice_url")})
    return result


def _settle_end(tenant_id: str, billing: dict, today: date) -> dict:
    """An agreement whose end date has passed and is invoiced to it: ended
    (the daily task then offboards it if asked)."""
    ends_at, done = _date(billing.get("endsAt")), paid_through(billing)
    if (billing.get("status") == "active" and billing.get("cycle") == "advance" and ends_at and ends_at < today
            and done and done >= ends_at):
        _write_billing(tenant_id, {"status": "ended", "endedAt": now_iso()})
        return {**billing, "status": "ended"}
    return billing


def run_invoicing(actor: str, *, dry_run: bool = False, only: str | None = None, today: date | None = None,
                  deadline: float | None = None, closing_only: bool = False) -> dict:
    """Every running agreement (or one customer's): the switch from the old
    cycle (one closing invoice), then each month in advance once its first
    day has come. dry_run = the preview. Safe to rerun: the ledger, Stripe's
    own records and idempotency keys keep every stretch on one invoice.
    Past `deadline` (time.monotonic()) no new customer is started: they are
    listed as unfinished and the next daily run invoices them.
    closing_only: the one-shot switch (financeTask migrate_to_advance)."""
    today = today or _today()
    summary = {"dryRun": dry_run, "today": today.isoformat(), "invoices": [], "skipped": [], "errors": [], "migrated": [],
               "unfinished": [], "switched": []}
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
            if billing.get("cycle") != "advance" and billing.get("status") in ("active", "ended") \
                    and closing_range(billing, today) is None:
                # On the old cycle with nothing invoiced in arrears: straight to advance.
                if billing.get("status") == "active" and not dry_run:
                    done = _date(billing.get("lastInvoicedPeriodEnd"))
                    _write_billing(tenant_id, {"cycle": "advance", "paidThrough": done.isoformat() if done else None})
                    billing = _billing(get_profile(tenant_id))
                summary["switched"].append({"tenantId": tenant_id, "name": profile.get("name"), "closing": None})
                if dry_run:
                    billing = {**billing, "cycle": "advance", "paidThrough": billing.get("lastInvoicedPeriodEnd")}
            if not dry_run:
                billing = _settle_end(tenant_id, billing, today)
            closing = closing_range(billing, today) if billing.get("cycle") != "advance" else None
            periods = [closing] if closing else ([] if closing_only else pending_advance(billing, today))
            if not periods:
                continue
            if deadline is not None and time.monotonic() > deadline:
                summary["unfinished"].append({"tenantId": tenant_id, "name": profile.get("name"), "periods": len(periods)})
                continue
            plan = plan_of(profile)
            kind = "closing" if closing else "advance"
            if not dry_run:
                try:
                    sync_customer(tenant_id, profile, actor=actor)
                except ApiError as e:
                    log.warning("billing customer of %s not synced: %s", tenant_id, e.message)
            for start, end in periods:
                if dry_run:
                    plan_ = plan_for_range({**profile, "billing": billing}, start, end, plan, kind)
                    plan_.pop("parts", None)
                    target = summary["skipped"] if plan_["nothingToInvoice"] else summary["invoices"]
                    target.append({"tenantId": tenant_id, "name": profile.get("name"), "invoiceId": None, **plan_})
                    continue
                result = build_invoice(tenant_id, profile, start, end, plan, actor, kind)
                (summary["skipped"] if result.get("invoiceId") in (None, "exists") else summary["invoices"]).append(result)
                if kind == "closing":
                    summary["switched"].append({"tenantId": tenant_id, "name": profile.get("name"),
                                                "closing": result.get("invoiceId"), "period": result.get("period")})
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
        lines += [f"Legacy subscription moved: {m['name']}" for m in summary["migrated"]]
        lines += [f"Switched to billing in advance: {w['name']}" + (f" (closing invoice {w['period']})" if w.get("closing") else "")
                  for w in summary["switched"]]
        lines += [f"NOT REACHED (out of time, the next daily run continues): {u['name']}" for u in summary["unfinished"]]
        if seller_missing():
            lines += ["", "Booqy's seller details are incomplete (BILLING_SELLER_JSON): " + ", ".join(seller_missing())]
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
            "thenOwnPrice": billing.get("priceSek") is not None, "noticeSentFor": billing.get("freeNoticeFor"),
            "preset": billing.get("freePreset")}


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
    billing = _billing(profile)
    card = collection_preference(billing) == "card" and billing.get("defaultPaymentMethod")
    opener = "Första fakturan kommer samma dag och gäller resten av månaden, därefter"
    paying = (f"{opener} dras månadsavgiften från ert kort i förskott den 1:a varje månad." if card
              else f"{opener} kommer fakturan i förskott den 1:a varje månad. Lägg till ett kort i Booqy Admin "
                   "(Inställningar, Abonnemang) så dras avgiften automatiskt.")
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
        start_for(tenant_id, profile, actor=actor, start_day=start_day, preference=collection_preference(billing),
                  terms=billing.get("terms") or "subscription")
    except (ApiError, ClientError, BotoCoreError) as e:
        return str(getattr(e, "message", None) or e)
    _write_billing(tenant_id, {"freeSwitchAgreementPending": None})
    return None


def _kept_locations(profile: dict, then: dict) -> dict | None:
    """The number of locations the operator chose on Free stays on the plan
    after it, never below that plan's own (Free 1 then Growth = 3).
    billing.freeLocationsChosen says whether it was chosen, so the Free
    plan's own number chosen on purpose stays too. Saved before the flag:
    a number equal to the Free plan's own counts as not chosen."""
    chosen = (profile.get("entitlements") or {}).get("maxLocations")
    if chosen is None:
        return None
    flag = _billing(profile).get("freeLocationsChosen")
    if flag is None:
        free_default = (get_plan(FREE_PLAN_ID) or {}).get("maxLocations")
        if free_default is not None and int(chosen) == int(free_default):
            return None
    elif not flag:
        return None
    return {"maxLocations": max(int(chosen), int(then.get("maxLocations", 1)))}


def free_step(profile: dict, today: date, actor: str) -> dict:
    """The daily look at one customer on Free with an end date. The owner is
    emailed and the operators get a line in the summary 14 days before the
    first paid day (once per end date); a notice that goes out later (set
    late, the email failed, the job was down) moves the first paid day to
    14 days after it, so nobody is charged without notice. From the day
    after the last free day, once told, the customer is on the plan chosen
    for afterwards and an agreement runs and the first paid day is invoiced at once (the rest of
    that month, pro rata), then every 1st; an
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
            apply_plan(tenant_id, profile, then, actor, overrides=_kept_locations(profile, then), force=True,
                       price_sek=own, expect_free_until=until.isoformat(),
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
    """Days between the due date and now (or the payment), 0 when not late.
    A card invoice has no due date of its own: due when it was finalized
    (rows written before that rule have only finalizedAt or createdAt)."""
    due = _parse(invoice.get("dueDate"))
    if due is None and invoice.get("collectionMethod") == "charge_automatically":
        due = _parse(invoice.get("finalizedAt") or invoice.get("createdAt"))
    if due is None:
        return 0
    end = _parse(invoice.get("paidAt")) if invoice.get("status") == "paid" else None
    end = end or now or datetime.now(timezone.utc)
    return max(0, (end.date() - due.date()).days)


def due_iso(row: dict) -> str | None:
    """The ledger row's due date (a card invoice: the day it was finalized)."""
    if row.get("dueDate"):
        return row["dueDate"]
    if row.get("collectionMethod") == "charge_automatically":
        return row.get("finalizedAt") or row.get("createdAt")
    return None


def is_overdue(row: dict, now: datetime | None = None) -> bool:
    return row.get("status") in OWED and days_late(row, now) > 0


def _pct(value: Decimal) -> str:
    """A percentage in Swedish: 10, 10,25 (decimal comma, no trailing zeros)."""
    text = format(Decimal(value).normalize(), "f")
    return text.replace(".", ",")


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
            if r.get("status") in (*OWED, "paid")]


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


def reminder_steps() -> list[int]:
    """Days after the due date when a reminder goes out (3, 7, 14)."""
    raw = env("BILLING_REMINDER_STEPS", "3,7,14") or ""
    out = sorted({int(x) for x in raw.replace(" ", "").split(",") if x.isdigit() and int(x) > 0})
    return out


def final_notice_days() -> int:
    return int(_env_num("BILLING_FINAL_NOTICE_DAYS", "30"))


def all_steps() -> list[int]:
    final = final_notice_days()
    return sorted(set(reminder_steps() + ([final] if final > 0 else [])))


def _claim(row: dict, field: str) -> bool:
    """Marks one step done on the ledger row, once: a rerun (or two runs at
    the same time) never does it twice."""
    try:
        client("dynamodb").update_item(
            TableName=finance_table(), Key={"PK": {"S": row["PK"]}, "SK": {"S": row["SK"]}},
            UpdateExpression="SET #f = :n", ConditionExpression="attribute_exists(PK) AND attribute_not_exists(#f)",
            ExpressionAttributeNames={"#f": field}, ExpressionAttributeValues={":n": {"S": now_iso()}})
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    return True


def _unclaim(row: dict, field: str) -> None:
    client("dynamodb").update_item(TableName=finance_table(), Key={"PK": {"S": row["PK"]}, "SK": {"S": row["SK"]}},
                                   UpdateExpression="REMOVE #f", ExpressionAttributeNames={"#f": field})


def _kr(amount) -> str:
    q = Decimal(amount or 0).quantize(CENTS)
    whole = f"{int(q):,}".replace(",", " ")
    cents = int((q - int(q)) * 100)
    return f"{whole},{cents:02d} kr" if cents else f"{whole} kr"


def console_link(tenant_id: str) -> str:
    base = (env("PLATFORM_ADMIN_APP_URL", "") or "").rstrip("/")
    return f"{base}/tenants/{tenant_id}?tab=billing"


# The first version of Allmänna villkor för restauranger that agrees the
# reminder fee (application shared/terms.py CURRENT_VERSION).
FEE_TERMS_VERSION = "2026-11-v1"


def _terms_key(version: str) -> tuple:
    """2026-11-v1 -> (2026, 11, 1): versions compare by date, then number."""
    try:
        year, month, rest = version.split("-", 2)
        return int(year), int(month), int(rest.lstrip("v"))
    except (AttributeError, ValueError):
        return (0, 0, 0)


def reminder_fee_agreed(profile: dict, row: dict) -> bool:
    """The restaurant accepted terms with the reminder fee (FEE_TERMS_VERSION
    or later) on or before the invoice was created: 2 § lagen (1981:739)
    allows a reminder fee only when agreed when the debt arose."""
    terms = profile.get("terms") if isinstance(profile.get("terms"), dict) else {}
    version, accepted = terms.get("version"), _parse(terms.get("acceptedAt"))
    created = _parse(row.get("createdAt"))
    if not isinstance(version, str) or accepted is None or created is None:
        return False
    return _terms_key(version) >= _terms_key(FEE_TERMS_VERSION) and accepted <= created


def _reminder_mail(profile: dict, row: dict, step: int, late: int, fee_note: str | None) -> tuple[str, str]:
    """The restaurant's reminder, in Swedish; the last one is the final notice."""
    number = row.get("number") or row.get("invoiceId")
    due = _date(due_iso(row))
    final = step == final_notice_days()
    card = row.get("collectionMethod") == "charge_automatically"
    subject = (f"Sista påminnelse: faktura {number} från Booqy" if final else f"Påminnelse: faktura {number} från Booqy")
    lines = [f"Hej{' ' + (profile.get('ownerName') or '').split()[0] if (profile.get('ownerName') or '').split() else ''}!", "",
             f"Vi har ännu inte fått betalt för faktura {number} till {profile.get('name')} på "
             f"{_kr(row.get('amountRemainingSek') or row.get('totalSek'))} som förföll {sv_day(due) if due else ''}, "
             f"{late} dagar sedan."]
    if card:
        lines.append("Vi har försökt dra beloppet från ert kort utan att lyckas. Uppdatera kortet i Booqy Admin "
                     "(Inställningar, Abonnemang) eller betala fakturan via länken nedan.")
    if row.get("hostedInvoiceUrl"):
        lines += ["", f"Betala här: {row['hostedInvoiceUrl']}"]
    if fee_note:
        lines += ["", fee_note]
    if final:
        lines += ["", "Detta är vår sista påminnelse. Betala inom 10 dagar, annars kan ärendet gå vidare till inkasso."]
    lines += ["", "Har ni redan betalat kan ni bortse från det här meddelandet. Frågor? Svara på det här mejlet."]
    return subject, "\n".join(lines)


def _fee_invoice(customer_id: str, tenant_id: str, row: dict, step: str, lines: list[tuple[Decimal, str, str]],
                 actor: str) -> dict:
    """A separate, VAT-free fee invoice for one late invoice and step (the
    reminder fee, the förseningsersättning or the interest), emailed with 10
    days to pay. Never charged to the card, never with other pending items."""
    key = f"fees-{row['invoiceId']}-{step}"
    invoice = stripe_request("POST", "/invoices", {
        "customer": customer_id, "currency": "sek", "collection_method": "send_invoice",
        "days_until_due": int(env("BILLING_DAYS_UNTIL_DUE_NO_CARD", "10")), "auto_advance": "false",
        "pending_invoice_items_behavior": "exclude",
        "description": f"Avgifter för sen betalning av faktura {row.get('number') or row['invoiceId']}",
        "metadata[tenantId]": tenant_id, "metadata[kind]": "fees", "metadata[invoiceId]": row["invoiceId"],
        "metadata[step]": step, **compliance_params()}, idempotency_key=f"inv-{key}")
    if invoice.get("status") == "draft":
        for i, (amount, text, kind) in enumerate(lines):
            stripe_request("POST", "/invoiceitems", {
                "customer": customer_id, "invoice": invoice["id"], "currency": "sek", "amount": _cents(amount),
                "description": text, "metadata[tenantId]": tenant_id, "metadata[invoiceId]": row["invoiceId"],
                "metadata[kind]": kind}, idempotency_key=f"item-{key}-{i}")
        invoice = stripe_request("POST", f"/invoices/{invoice['id']}/finalize", {"auto_advance": "true"},
                                 idempotency_key=f"finalize-{invoice['id']}")
    if invoice.get("status") == "open":
        try:
            stripe_request("POST", f"/invoices/{invoice['id']}/send", {}, idempotency_key=f"send-{invoice['id']}")
        except ApiError as e:
            log.warning("fee invoice %s not sent: %s", invoice["id"], e.message)
    record_invoice(tenant_id, invoice)
    _mark(_invoice_row(tenant_id, invoice), kind="fees", feesFor=row["invoiceId"])
    write_audit(tenant_id, "late_fees_invoiced", actor, {"invoiceId": invoice["id"], "for": row["invoiceId"], "step": step,
                                                         "totalSek": sum((a for a, _t, _k in lines), Decimal(0))})
    return invoice


def _ops_publish(subject: str, message: str) -> bool:
    topic = env("ALERT_TOPIC_ARN", "")
    if not topic:
        return False
    client("sns").publish(TopicArn=topic, Subject=subject[:100], Message=message)
    return True


def ops_reminder(profile: dict, row: dict, step: int, late: int) -> bool:
    """The operators' copy of a reminder step (3, 7, 14 and 30 days): once
    per invoice and step (claimed on the ledger row before it is sent,
    released when sending fails)."""
    if not env("ALERT_TOPIC_ARN", ""):
        return False
    field = f"opsReminder{step}At"
    if not _claim(row, field):
        return False
    tenant_id, name = profile["tenantId"], profile.get("name") or profile["tenantId"]
    number = row.get("number") or row["invoiceId"]
    due = (due_iso(row) or "")[:10]
    final = " FINAL NOTICE" if step == final_notice_days() else ""
    subject = f"[{env('ENVIRONMENT', 'dev')}] Booqy: {name} invoice {number} {late} days overdue{final}"
    message = "\n".join([
        f"{name} has not paid invoice {number}.{final}", "",
        f"Restaurant: {name} ({profile.get('slug') or tenant_id})",
        f"Invoice: {number}", f"Amount due: {_kr(row.get('amountRemainingSek') or row.get('totalSek'))} incl. VAT",
        f"Due date: {due}", f"Days overdue: {late} (reminder step {step})",
        f"Collected by: {'card (Stripe retries)' if row.get('collectionMethod') == 'charge_automatically' else 'emailed invoice'}",
        "", f"Customer in Booqy Console: {console_link(tenant_id)}",
        *( [f"Invoice: {row['hostedInvoiceUrl']}"] if row.get("hostedInvoiceUrl") else []),
        "", "The restaurant got its reminder too. Nothing is paused automatically."])
    try:
        _ops_publish(subject, message)
    except (ClientError, BotoCoreError):
        _unclaim(row, field)
        log.warning("operator reminder for %s not published", row["invoiceId"], exc_info=True)
        return False
    return True


def work_invoices(profile: dict, now: datetime, actor: str) -> dict:
    """One customer's late and late-paid invoices: reminders to the
    restaurant and to the operators at each step, the reminder fee and the
    förseningsersättning on separate fee invoices, interest once paid.
    Every step is claimed on the ledger row first, so a rerun never repeats
    it (the operators never get the same step twice)."""
    tenant_id, name = profile["tenantId"], profile.get("name") or profile["tenantId"]
    billing = _billing(profile)
    customer_id = billing.get("customerId")
    out = {"reminded": [], "fees": [], "interest": [], "ops": [], "overdue": [], "oneOff": None}
    if not customer_id:
        return out
    steps = all_steps()
    first_step = (reminder_steps() or [0])[0]
    fee_step = int(_env_num("BILLING_LATE_FEE_AFTER_DAYS", "7"))
    late_fee = _env_num("BILLING_LATE_FEE_SEK", "450")
    reminder_fee = _env_num("BILLING_REMINDER_FEE_SEK", "60")
    reference, margin = _env_num("BILLING_REFERENCE_RATE_PCT", "2"), _env_num("BILLING_INTEREST_MARGIN_PCT", "8")
    to = billing_email_of(profile)
    for row in open_invoices(tenant_id):
        late = days_late(row, now)
        number = row.get("number") or row["invoiceId"]
        is_fee_invoice = row.get("kind") in ("fees", "late_fees")
        if row.get("status") in OWED and late >= 1:
            # Never remind or charge a fee on an invoice paid (or voided)
            # whose webhook was missed: ask Stripe first.
            try:
                fresh = stripe_request("GET", f"/invoices/{row['invoiceId']}")
            except ApiError:
                fresh = None
            if fresh and fresh.get("status") and fresh["status"] != row.get("status"):
                record_invoice(tenant_id, fresh)
                row = {**row, **{k: val for k, val in _invoice_row(tenant_id, fresh).items() if val is not None}}
                late = days_late(row, now)
        if row.get("status") in OWED and late >= 1:
            out["overdue"].append({"tenantId": tenant_id, "name": name, "number": number, "late": late,
                                   "amountSek": row.get("amountRemainingSek") or row.get("totalSek"),
                                   "dueDate": (due_iso(row) or "")[:10]})
        reached = [st for st in steps if row.get("status") in OWED and late >= st]
        if reached:
            top = max(reached)
            # The reminder fee only when agreed before the debt arose
            # (2 § lagen (1981:739)), and never after the
            # förseningsersättning: 4 a § caps both together at 450 kr.
            want_reminder_fee = (not is_fee_invoice and to and reminder_fee > 0 and late >= first_step
                                 and not row.get("reminderFeeAt") and not row.get("lateFeeAdded")
                                 and reminder_fee_agreed(profile, row))
            want_late_fee = not is_fee_invoice and late_fee > 0 and late >= fee_step and not row.get("lateFeeAdded")
            offset = reminder_fee if (want_reminder_fee or row.get("reminderFeeSek")) else Decimal(0)
            late_amount = max(Decimal(0), late_fee - Decimal(offset))
            notes = []
            if want_reminder_fee:
                notes.append(f"En påminnelseavgift på {_kr(reminder_fee)} enligt avtalet kommer på en separat faktura.")
            if want_late_fee and late_amount > 0:
                less = f" ({_kr(late_fee)} minus påminnelseavgiften)" if offset else ""
                notes.append(f"Enligt lagen (1981:739) om ersättning för inkassokostnader m.m. tar vi ut en "
                             f"förseningsersättning på {_kr(late_amount)}{less} på en "
                             f"separat faktura. Dröjsmålsränta enligt räntelagen (referensräntan plus "
                             f"{_pct(margin)} procentenheter) räknas från förfallodagen.")
            # The restaurant: the newest step only (a job that was down
            # catches up with one email, not three).
            new = [st for st in reached if not row.get(f"customerReminder{st}At")]
            mailed = False
            if new and to and _claim(row, f"customerReminder{top}At"):
                for st in new:
                    if st != top:
                        _claim(row, f"customerReminder{st}At")
                try:
                    from . import mail                   # mail imports nothing from billing
                    subject, body = _reminder_mail(profile, row, top, late, " ".join(notes) or None)
                    mail._send_one(to, subject, body, mail._load_template())
                    mailed = True
                    n = int(row.get("remindersSent") or 0) + 1
                    _mark(row, remindersSent=n, lastReminderAt=now_iso(), lastReminderBy=actor, lastReminderStep=top)
                    write_audit(tenant_id, "invoice_reminder_sent", actor, {"invoiceId": row["invoiceId"], "number": number,
                                                                            "step": top, "to": to})
                    out["reminded"].append(f"{name} {number} (step {top}, {late} days late)")
                except (ApiError, ClientError, BotoCoreError) as e:
                    for st in new:
                        _unclaim(row, f"customerReminder{st}At")
                    out["reminded"].append(f"{name} {number}: FAILED {getattr(e, 'message', None) or e}")
            reminded_before = any(row.get(f"customerReminder{st}At") for st in reached)
            reminder_fee_failed = False
            # The reminder fee only with a reminder sent (now or earlier).
            if want_reminder_fee and (mailed or reminded_before) and _claim(row, "reminderFeeAt"):
                try:
                    inv = _fee_invoice(customer_id, tenant_id, row, "reminder",
                                       [(reminder_fee, f"Påminnelseavgift enligt avtal, faktura {number}", "reminder_fee")], actor)
                    _mark(row, reminderFeeSek=reminder_fee, reminderFeeInvoiceId=inv["id"])
                    out["fees"].append(f"{name} {number} (reminder fee {reminder_fee} kr, {late} days late)")
                    row = {**row, "reminderFeeSek": reminder_fee}
                except ApiError as e:
                    _unclaim(row, "reminderFeeAt")
                    reminder_fee_failed = True
                    out["fees"].append(f"{name} {number}: reminder fee FAILED {e.message}")
            # A reminder fee that failed just now is retried first (the next
            # run), so the förseningsersättning is then 450 kr less it, never
            # 450 kr with the 60 kr on top.
            if want_late_fee and not reminder_fee_failed and _claim(row, "lateFeeAdded"):
                # 4 a § lagen (1981:739): a reminder fee already charged is
                # covered by the förseningsersättning, never both in full.
                amount = max(Decimal(0), late_fee - Decimal(row.get("reminderFeeSek") or 0))
                try:
                    if amount > 0:
                        inv = _fee_invoice(customer_id, tenant_id, row, "late_fee", [(
                            amount, f"Förseningsersättning enligt 4 a § lagen (1981:739) om ersättning för "
                                    f"inkassokostnader m.m., faktura {number}", "late_fee")], actor)
                        _mark(row, lateFeeSek=amount, lateFeeInvoiceId=inv["id"])
                    write_audit(tenant_id, "late_fee_added", actor, {"invoiceId": row["invoiceId"], "number": number,
                                                                     "feeSek": amount})
                    out["fees"].append(f"{name} {number} (förseningsersättning {amount} kr, {late} days late)")
                except ApiError as e:
                    _unclaim(row, "lateFeeAdded")
                    out["fees"].append(f"{name} {number}: förseningsersättning FAILED {e.message}")
            # The operators: the same steps, by email through the alerts topic.
            new_ops = [st for st in reached if not row.get(f"opsReminder{st}At")]
            if new_ops and ops_reminder(profile, row, max(new_ops), late):
                for st in new_ops:
                    if st != max(new_ops):
                        _claim(row, f"opsReminder{st}At")
                out["ops"].append(f"{name} {number} (step {max(new_ops)})")
        if row.get("status") == "paid" and late >= 1 and not is_fee_invoice and _claim(row, "interestAdded"):
            amount = interest_sek(Decimal(row.get("totalSek") or 0), late, reference_pct=reference, margin_pct=margin)
            try:
                inv_id = None
                if amount >= 1:
                    inv_id = _fee_invoice(customer_id, tenant_id, row, "interest", [(
                        amount, f"Dröjsmålsränta {_pct(reference + margin)} % per år (räntelagen 6 §) i {late} dagar, "
                                f"faktura {number}", "interest")], actor)["id"]
                _mark(row, interestSek=amount, interestDays=late, interestInvoiceId=inv_id or "-")
                write_audit(tenant_id, "interest_added", actor, {"invoiceId": row["invoiceId"], "number": number,
                                                                 "interestSek": amount, "days": late})
                out["interest"].append(f"{name} {number} ({amount} kr for {late} days)")
            except ApiError as e:
                _unclaim(row, "interestAdded")
                out["interest"].append(f"{name} {number}: FAILED {e.message}")
    return out


def overdue_summary(overdue: list[dict], today: date) -> bool:
    """The operators' morning list of every overdue invoice, once a day and
    only when there is one (claimed on PLATFORM#BILLING / OPS_OVERDUE#day)."""
    if not overdue or not env("ALERT_TOPIC_ARN", ""):
        return False
    key = {"PK": {"S": "PLATFORM#BILLING"}, "SK": {"S": f"OPS_OVERDUE#{today.isoformat()}"}}
    try:
        client("dynamodb").put_item(TableName=tenant_table(), Item={**key, "count": {"N": str(len(overdue))},
                                                                   "at": {"S": now_iso()},
                                                                   "ttl": {"N": str(int(time.time()) + 90 * 86400)}},
                                    ConditionExpression="attribute_not_exists(PK)")
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    rows = sorted(overdue, key=lambda o: -o["late"])
    total = sum((Decimal(o.get("amountSek") or 0) for o in rows), Decimal(0))
    lines = [f"{len(rows)} overdue invoice(s), {_kr(total)} incl. VAT, on {today.isoformat()}:", ""]
    lines += [f"{o['name']}: {o['number']}, {_kr(o.get('amountSek'))}, due {o['dueDate']}, {o['late']} days overdue, "
              f"{console_link(o['tenantId'])}" for o in rows]
    try:
        _ops_publish(f"[{env('ENVIRONMENT', 'dev')}] Booqy: {len(rows)} overdue invoice(s)", "\n".join(lines))
    except (ClientError, BotoCoreError):
        client("dynamodb").delete_item(TableName=tenant_table(), Key=key)
        log.warning("overdue summary not published", exc_info=True)
        return False
    return True


def overdue_days(tenant_id: str, now: datetime | None = None) -> int | None:
    """Days the oldest open invoice is past its due date (None: none is).
    An emailed invoice never fails a payment, so this is what makes it
    past due."""
    late = [days_late(r, now) for r in open_invoices(tenant_id) if r.get("status") in OWED]
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


# ------------------------------------------------------------- credit notes: refunds and credits
# An operator refunds (back to the card) or credits (to the customer's
# Stripe balance, which reduces the next invoice) part or all of an invoice
# with a Stripe credit note on the platform account. The CREDIT# ledger row
# is the one platform-stripe-webhook writes on credit_note.created
# (application shared/billing.py, record_credit_note): same key, same
# booking flags, so whichever of the two comes first books and the other
# finds it booked.
CREDIT_METHODS = ("refund", "credit")
CREDIT_REASONS = ("duplicate", "fraudulent", "order_change", "product_unsatisfactory", "other")
CREDIT_LOCK_SECONDS = 120
MAX_CREDIT_ITEMS = 24
REQUEST_ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


def refunded_minor(note: dict) -> int:
    """The part of a credit note paid back to the card (öre, incl VAT); the
    rest was credited. Read like the webhook reads it."""
    total = int(note.get("total") or 0)
    refunds = note.get("refunds")
    if isinstance(refunds, list) and refunds:
        amount = sum(int(r.get("amount_refunded") or 0) for r in refunds if isinstance(r, dict))
    elif note.get("refund"):
        amount = total - int(note.get("out_of_band_amount") or 0)
    else:
        amount = 0
    return max(0, min(amount, total))


def _post_payment_minor(note: dict) -> int:
    """What the note took back from money already paid (the rest only
    lowered what was still owed)."""
    if isinstance(note.get("post_payment_amount"), int):
        return note["post_payment_amount"]
    if note.get("type") == "pre_payment":
        return 0
    return int(note.get("total") or 0)


def credit_note_row(tenant_id: str, note: dict) -> dict:
    day = (_iso(note.get("created")) or now_iso())[:10]
    ex = note.get("total_excluding_tax")
    if ex is None:
        ex = note.get("subtotal")
    total = int(note.get("total") or 0)
    refunded = refunded_minor(note)
    refunded_ex = (Decimal(refunded) * Decimal(int(ex or 0)) / Decimal(total) / Decimal(100)).quantize(
        CENTS, rounding=ROUND_HALF_UP) if total > 0 else Decimal("0.00")
    metadata = note.get("metadata") or {}
    return {"PK": f"TENANT#{tenant_id}", "SK": f"CREDIT#{day}#{note['id']}", "day": day,
            "creditNoteId": note["id"], "invoiceId": _id(note.get("invoice")), "number": note.get("number"),
            "reason": note.get("reason"), "amountSek": sek(ex or 0), "totalSek": sek(total),
            "refundedSek": sek(refunded), "refundedExSek": refunded_ex,
            "postPaymentSek": sek(_post_payment_minor(note)),
            "method": metadata.get("booqyMethod"), "memo": note.get("memo"),
            "createdAt": _iso(note.get("created")), "eventCreated": int(time.time()), "updatedAt": now_iso()}


def record_credit_note(tenant_id: str, note: dict) -> list[str]:
    """Writes the CREDIT# row once and books it: the ex-VAT total reduces
    revenue (creditedSek), the part refunded to the card reduces what was
    collected (refundedSek). Returns what was booked."""
    row = credit_note_row(tenant_id, note)
    day = row.pop("day")
    try:
        client("dynamodb").put_item(TableName=finance_table(), Item=to_ddb(row),
                                    ConditionExpression="attribute_not_exists(PK)")
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    key = {"PK": row["PK"], "SK": row["SK"]}
    booked = []
    if _book(key, "bookedCredited", tenant_id, day, "creditedSek", row["amountSek"]):
        booked.append("credited")
    if _book(key, "bookedRefunded", tenant_id, day, "refundedSek", row["refundedExSek"]):
        booked.append("refunded")
    return booked


def credits_by_invoice(tenant_id: str) -> dict[str, dict]:
    """Per invoice: refundedSek (back to the card) and creditedSek (the rest
    of its credit notes), incl VAT, and postPaymentSek (taken back from
    what was paid). One CREDIT# row per credit note, so nothing counts
    twice."""
    rows = query_all(TableName=finance_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :c)",
                     ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":c": {"S": "CREDIT#"}})
    out: dict[str, dict] = {}
    for r in rows:
        if not r.get("invoiceId"):
            continue
        total, refunded = Decimal(r.get("totalSek") or 0), Decimal(r.get("refundedSek") or 0)
        post = r.get("postPaymentSek")
        sums = out.setdefault(r["invoiceId"], {"refundedSek": Decimal("0.00"), "creditedSek": Decimal("0.00"),
                                               "postPaymentSek": Decimal("0.00")})
        sums["refundedSek"] += refunded
        sums["creditedSek"] += total - refunded
        sums["postPaymentSek"] += Decimal(post) if post is not None else total
    return out


def creditable_sek(row: dict, credits: dict | None) -> Decimal:
    """What can still be refunded or credited on an invoice (incl VAT):
    a paid invoice, what was paid less the notes on it; an open one, what is
    still owed (a credit note lowers it)."""
    status = row.get("status")
    if status == "paid":
        left = Decimal(row.get("amountPaidSek") or 0) - Decimal((credits or {}).get("postPaymentSek") or 0)
    elif status in OWED:
        left = Decimal(row.get("amountRemainingSek") or 0)
    else:
        left = Decimal(0)
    return max(left, Decimal(0)).quantize(CENTS)


def _amount_minor(value, field: str, f: v.Fields) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal, str)):
        f.fail(field, "Must be an amount")
        return None
    try:
        amount = Decimal(str(value))
    except Exception:  # noqa: BLE001 - any unparsable value
        f.fail(field, "Must be an amount")
        return None
    if not amount.is_finite() or amount <= 0:
        f.fail(field, "More than 0")
        return None
    if amount != amount.quantize(CENTS):
        f.fail(field, "At most 2 decimals")
        return None
    return int(amount * 100)


def _parse_credit_request(body: dict) -> dict:
    f = v.Fields(body)
    method = f.text("method", required=True, max_len=10)
    if method and method not in CREDIT_METHODS:
        f.fail("method", "refund or credit")
    reason = f.text("reason", max_len=40) or "other"
    if reason not in CREDIT_REASONS:
        f.fail("reason", "Unknown reason")
    memo = f.text("memo", max_len=500)
    request_id = f.text("requestId", required=True, max_len=64)
    if request_id and not set(request_id) <= REQUEST_ID_CHARS:
        f.fail("requestId", "Letters, digits and hyphens")
    items = (body or {}).get("items")
    parsed, seen = [], set()
    if not isinstance(items, list) or not items:
        f.fail("items", "Pick at least one invoice")
    elif len(items) > MAX_CREDIT_ITEMS:
        f.fail("items", f"At most {MAX_CREDIT_ITEMS} invoices at a time")
    else:
        for n, item in enumerate(items):
            invoice_id = item.get("invoiceId") if isinstance(item, dict) else None
            if not isinstance(invoice_id, str) or not invoice_id.startswith("in_") or len(invoice_id) > 80:
                f.fail(f"items.{n}.invoiceId", "Not an invoice")
                continue
            if invoice_id in seen:
                f.fail(f"items.{n}.invoiceId", "Listed twice")
                continue
            seen.add(invoice_id)
            parsed.append({"invoiceId": invoice_id,
                           "amount": _amount_minor(item.get("amountSek"), f"items.{n}.amountSek", f)})
    f.done()
    return {"method": method, "reason": reason, "memo": memo, "requestId": request_id, "items": parsed}


def _lock_invoice(tenant_id: str, invoice_id: str, request_id: str) -> None:
    """One credit note at a time per invoice: a second operator (or a second
    tab) gets 409 instead of racing the first one to Stripe."""
    now = int(time.time())
    try:
        client("dynamodb").put_item(
            TableName=finance_table(),
            Item=to_ddb({"PK": f"TENANT#{tenant_id}", "SK": f"CNLOCK#{invoice_id}", "requestId": request_id,
                         "expiresAt": now + CREDIT_LOCK_SECONDS, "lockedAt": now_iso()}),
            ConditionExpression="attribute_not_exists(PK) OR expiresAt < :now",
            ExpressionAttributeValues={":now": {"N": str(now)}})
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ApiError(409, "credit_in_progress", "Another refund of this invoice is running; reload in a minute") from e
        raise


def _unlock_invoice(tenant_id: str, invoice_id: str, request_id: str) -> None:
    """Expires our own lock (an update, not a delete: the role has no
    DeleteItem on the finance table, and one small row per invoice ever
    credited is nothing)."""
    try:
        client("dynamodb").update_item(TableName=finance_table(),
                                       Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": f"CNLOCK#{invoice_id}"}},
                                       UpdateExpression="SET expiresAt = :z",
                                       ConditionExpression="requestId = :r",
                                       ExpressionAttributeValues={":r": {"S": request_id}, ":z": {"N": "0"}})
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            log.warning("credit note lock not released: %s", e)


def _invoice_lines(invoice: dict) -> list[dict]:
    lines = invoice.get("lines") or {}
    data = list(lines.get("data") or [])
    if lines.get("has_more"):
        data = stripe_request("GET", f"/invoices/{invoice['id']}/lines", {"limit": 100}).get("data") or data
    return [ln for ln in data if isinstance(ln.get("id"), str) and int(ln.get("amount") or 0) > 0]


def _split_lines(lines: list[dict], ex_minor: int) -> dict:
    """Credit note lines: `ex_minor` (excl VAT) spread over the invoice's
    lines in proportion to their amounts, so each line's own tax rate (25 %
    VAT) applies to its share. Never more than a line's amount."""
    whole = sum(int(ln["amount"]) for ln in lines)
    ex_minor = max(0, min(ex_minor, whole))
    shares = [(ln, ex_minor * int(ln["amount"]) // whole, ex_minor * int(ln["amount"]) % whole) for ln in lines]
    rest = ex_minor - sum(s for _, s, _ in shares)
    order = sorted(range(len(shares)), key=lambda i: -shares[i][2])
    amounts = [s for _, s, _ in shares]
    for i in order:
        if rest <= 0:
            break
        if amounts[i] < int(shares[i][0]["amount"]):
            amounts[i] += 1
            rest -= 1
    params, n = {}, 0
    for (ln, _, _), amount in zip(shares, amounts):
        if amount <= 0:
            continue
        params.update({f"lines[{n}][type]": "invoice_line_item", f"lines[{n}][invoice_line_item]": ln["id"],
                       f"lines[{n}][amount]": amount})
        n += 1
    return params


def _note_params(invoice: dict, lines: list[dict], wanted: int, left: int) -> tuple[dict, int]:
    """The lines whose total incl VAT is `wanted` öre (or the nearest below,
    never above what is left), checked with Stripe's preview: the VAT is
    rounded per line by Stripe, so the preview is the truth."""
    total, ex = int(invoice.get("total") or 0), invoice.get("total_excluding_tax")
    if ex is None:
        ex = total - int(invoice.get("tax") or 0)
    ratio = Decimal(int(ex)) / Decimal(total) if total > 0 else Decimal(1)
    cap = min(wanted, left)
    guess = int((Decimal(wanted) * ratio).to_integral_value(rounding=ROUND_HALF_UP))
    best, tried = None, set()
    for _ in range(4):
        if guess in tried or guess <= 0:
            break
        tried.add(guess)
        params = {"invoice": invoice["id"], **_split_lines(lines, guess)}
        preview = stripe_request("GET", "/credit_notes/preview", params)
        got = int(preview.get("total") or 0)
        if got <= cap and (best is None or got > best[1]):
            best = (params, got)
        if got == wanted:
            break
        step = int((Decimal(wanted - got) * ratio).to_integral_value(rounding=ROUND_HALF_UP)) or (1 if got < wanted else -1)
        guess += step
    if best is None:
        raise ApiError(409, "amount_not_possible", "Stripe cannot credit that amount on this invoice; try a slightly smaller one")
    return best


def _existing_note(invoice_id: str, key: str) -> dict | None:
    """A credit note this very request already created (a retry after a
    timeout, or a repeated click): found by its key in the metadata."""
    notes = stripe_request("GET", "/credit_notes", {"invoice": invoice_id, "limit": 100}).get("data") or []
    return next((n for n in notes if (n.get("metadata") or {}).get("booqyKey") == key), None)


def _credit_one(tenant_id: str, customer_id: str | None, rows: dict, item: dict, req: dict, actor: str) -> dict:
    invoice_id, method = item["invoiceId"], req["method"]
    row = rows.get(invoice_id)
    if not row:
        raise ApiError(404, "not_found", "No such invoice for this customer")
    invoice = stripe_request("GET", f"/invoices/{invoice_id}", {})
    if not customer_id or _id(invoice.get("customer")) != customer_id:
        raise ApiError(404, "not_found", "No such invoice for this customer")
    status = invoice.get("status")
    if method == "refund" and status != "paid":
        raise ApiError(409, "not_paid", "Only a paid invoice can be refunded; credit it instead")
    if method == "credit" and status not in ("paid", *OWED):
        raise ApiError(409, "not_creditable", "Only a paid or open invoice can be credited")
    if method == "refund" and (invoice.get("paid_out_of_band") or row.get("paidOutOfBand")):
        raise ApiError(409, "paid_out_of_band", "Paid outside Stripe, so there is no card payment to refund; credit it instead")
    if status == "paid":
        left = int(invoice.get("amount_paid") or 0) - int(invoice.get("post_payment_credit_notes_amount") or 0)
    else:
        left = int(invoice.get("amount_remaining") or 0)
    wanted = item["amount"] if item["amount"] is not None else left
    key = f"cn-{tenant_id}-{invoice_id}-{wanted}-{method}-{req['requestId']}"
    note = _existing_note(invoice_id, key)
    created = note is None
    if created:
        if left <= 0:
            raise ApiError(409, "nothing_left", "Nothing left to refund or credit on this invoice")
        if wanted > left:
            raise ApiError(409, "more_than_left", f"At most {sek(left)} kr is left on this invoice", leftSek=sek(left))
        lines = _invoice_lines(invoice)
        if not lines:
            raise ApiError(409, "no_lines", "This invoice has no lines to credit")
        params, amount = _note_params(invoice, lines, wanted, left)
        if status == "paid":
            params["refund_amount" if method == "refund" else "credit_amount"] = amount
        if req["reason"] != "other":
            params["reason"] = req["reason"]
        if req["memo"]:
            params["memo"] = req["memo"]
        params.update({"metadata[booqyKey]": key, "metadata[booqyMethod]": method,
                       "metadata[booqyActor]": actor[:100], "metadata[tenantId]": tenant_id})
        note = stripe_request("POST", "/credit_notes", params, idempotency_key=key)
    record_credit_note(tenant_id, note)
    try:   # the row's amounts as Stripe has them now (a credit lowers what is owed)
        record_invoice(tenant_id, stripe_request("GET", f"/invoices/{invoice_id}", {}))
    except ApiError as e:
        log.warning("invoice %s not refreshed after credit note: %s", invoice_id, e.message)
    refunded = sek(refunded_minor(note))
    total = sek(note.get("total") or 0)
    if created:   # one audit row per note, by the request that made it
        write_audit(tenant_id, "invoice_refunded" if refunded else "invoice_credited", actor, {
            "invoiceId": invoice_id, "number": row.get("number"), "creditNoteId": note.get("id"),
            "creditNoteNumber": note.get("number"), "method": method, "totalSek": str(total),
            "refundedSek": str(refunded), "reason": req["reason"], "memo": req["memo"]})
    return {"invoiceId": invoice_id, "ok": True, "creditNoteId": note.get("id"), "number": note.get("number"),
            "totalSek": total, "refundedSek": refunded, "creditedSek": total - refunded,
            "pdf": note.get("pdf")}


def create_credit_notes(req) -> tuple[int, dict]:
    """POST .../billing/credit-notes {items: [{invoiceId, amountSek?}], method:
    refund|credit, reason, memo, requestId}: one credit note per invoice;
    amountSek incl VAT, left out = everything left. Each invoice succeeds or
    fails on its own; the results say which. requestId is the client's, one
    per confirm dialog: a repeat of the same request never refunds twice."""
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    parsed = _parse_credit_request(req.body)
    customer_id = (profile.get("billing") or {}).get("customerId") if isinstance(profile.get("billing"), dict) else None
    rows = {r.get("invoiceId"): r for r in _ledger(tenant_id)}
    results = []
    for item in parsed["items"]:
        try:
            _lock_invoice(tenant_id, item["invoiceId"], parsed["requestId"])
        except ApiError as e:
            results.append({"invoiceId": item["invoiceId"], "ok": False, "error": e.code, "message": e.message})
            continue
        try:
            results.append(_credit_one(tenant_id, customer_id, rows, item, parsed, req.actor))
        except ApiError as e:
            results.append({"invoiceId": item["invoiceId"], "ok": False, "error": e.code, "message": e.message,
                            **{k: val for k, val in e.extra.items() if k in ("leftSek", "stripeStatus")}})
        except Exception:  # noqa: BLE001 - one invoice's fault must not hide the others' results
            log.exception("credit note for %s failed", item["invoiceId"])
            results.append({"invoiceId": item["invoiceId"], "ok": False, "error": "internal_error",
                            "message": "Booqy's fault: the refund of this invoice did not finish"})
        finally:
            _unlock_invoice(tenant_id, item["invoiceId"], parsed["requestId"])
    ok = [r for r in results if r["ok"]]
    return 200, {"results": results, "ok": len(ok), "failed": len(results) - len(ok),
                 "refundedSek": sum((r["refundedSek"] for r in ok), Decimal("0.00")),
                 "creditedSek": sum((r["creditedSek"] for r in ok), Decimal("0.00"))}


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
    """The daily look at every customer: reminders, fees and interest on
    late invoices (to the restaurant and the operators), the operators'
    morning list of overdue invoices, the Free plan, try-outs that become
    subscriptions, ended agreements, the billing customer's details.
    Suspends customers past due longer than BILLING_SUSPEND_AFTER_DAYS only
    when set (0 = off, the default: the owner chose reminders and fees) and
    resumes the ones it suspended that have paid. Emails the operators a
    summary when it did something."""
    actor = "dunning"
    limit = int(env("BILLING_SUSPEND_AFTER_DAYS", "0"))
    now = datetime.now(timezone.utc)
    trial_months = int(_env_num("BILLING_TRIAL_MONTHS", "6"))
    suspended, resumed, failed, reminded, fees, interest, converted, offboarded = [], [], [], [], [], [], [], []
    free_notices, free_switched, ops, overdue_all = [], [], [], []
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
            ops += worked["ops"]
            overdue_all += worked["overdue"]
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
            # The billing customer follows the tenant record (and the
            # connected Stripe account): name, address, email, VAT number.
            if billing.get("customerId") and profile.get("status") in ("provisioning", "active", "suspended"):
                sync_customer(tenant_id, get_profile(tenant_id), actor=actor)
        except (ApiError, ClientError, BotoCoreError) as e:
            failed.append(f"{name} billing details: {getattr(e, 'message', None) or e}"[:300])
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
    try:
        overdue_sent = overdue_summary(overdue_all, today)
    except (ClientError, BotoCoreError) as e:
        overdue_sent = False
        failed.append(f"overdue summary: {e}"[:300])
    summary = {"status": "done", "limitDays": limit, "suspended": suspended, "resumed": resumed, "failed": failed,
               "reminded": reminded, "fees": fees, "interest": interest, "converted": converted, "offboarded": offboarded,
               "freeNotices": free_notices, "freeSwitched": free_switched, "opsReminders": ops,
               "overdue": len(overdue_all), "overdueSummarySent": overdue_sent}
    if suspended or resumed or failed or reminded or fees or interest or converted or offboarded or free_notices or free_switched:
        lines = [f"Dunning ({env('ENVIRONMENT', 'dev')})" + (f": suspends after {limit} days past due." if limit > 0
                 else ": nothing is suspended automatically."), ""]
        lines += [f"Reminder sent: {r}" for r in reminded] + [f"Fee invoiced: {f}" for f in fees]
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
    if event.get("financeTask") == "migrate_to_advance":
        # The one-shot switch from the 25th-in-arrears cycle: {"dryRun": true}
        # first (the default), then {"dryRun": false}. Every agreement on the
        # old cycle gets its closing invoice (the days since its last
        # invoiced period to the end of this month) and continues in
        # advance. Rerunnable: keys and the ledger's kind=closing check.
        return {"status": "done", **run_invoicing("migrate_to_advance", dry_run=event.get("dryRun") is not False,
                                                  closing_only=True)}
    return {"status": "unknown_task"}
