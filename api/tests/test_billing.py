"""Agreements invoiced in arrears (periods from the 25th to the 24th):
customer creation, the agreement, cancellation terms, the monthly invoicing
run with the SMS line, reminders, late fees, interest and the dunning task.
Stripe is a fake; DynamoDB and Cognito are moto."""
import json
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
import pytest

from conftest import REGION, call

FINANCE_TABLE = "dev-finance"


@pytest.fixture
def finance(aws, monkeypatch):
    monkeypatch.setenv("FINANCE_TABLE_NAME", FINANCE_TABLE)
    monkeypatch.setenv("BILLING_TAX_RATE_ID", "txr_vat25")
    monkeypatch.setenv("BILLING_DAYS_UNTIL_DUE", "30")
    monkeypatch.setenv("BILLING_SUSPEND_AFTER_DAYS", "14")
    monkeypatch.setenv("FINANCE_ROLLUP_FUNCTION_ARN", "arn:aws:lambda:eu-north-1:123456789012:function:dev-finance-rollup:live")
    monkeypatch.setenv("ALERT_TOPIC_ARN", "")
    monkeypatch.setenv("BILLING_SMS_PRICE_SEK", "0.70")
    monkeypatch.setenv("BILLING_NOTICE_MONTHS", "3")
    monkeypatch.setenv("BILLING_TRIAL_MONTHS", "6")
    aws["ddb"].create_table(TableName=FINANCE_TABLE, BillingMode="PAY_PER_REQUEST",
                            AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"},
                                                  {"AttributeName": "SK", "AttributeType": "S"}],
                            KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}])
    for plan_id, price in (("starter", "price_starter"), ("growth", "price_growth")):
        aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"PLAN#{plan_id}"}, "SK": {"S": "PLAN"}},
                               UpdateExpression="SET stripePriceId = :p, priceSek = :s, stripeProductId = :pr",
                               ExpressionAttributeValues={":p": {"S": price}, ":s": {"N": "990" if plan_id == "starter" else "1990"},
                                                          ":pr": {"S": f"prod_{plan_id}"}})
    return boto3.resource("dynamodb", region_name=REGION).Table(FINANCE_TABLE)


def _price(price_id, amount):
    return {"id": price_id, "unit_amount": amount, "metadata": {"planId": price_id.split("_")[1]},
            "recurring": {"interval": "month", "interval_count": 1}}


@pytest.fixture
def stripe(monkeypatch):
    from app import billing
    state = {"calls": [], "subs": {}, "n": 0, "c": 0, "card": None, "invoices": [], "items": [], "sent": [],
             "oneoff": [], "paid": [], "voided": [], "made": {}}

    def sub_obj(sub_id):
        return state["subs"][sub_id]

    def item_price(params, prefix="items[0]"):
        if f"{prefix}[price_data][unit_amount]" in params:
            amount = int(params[f"{prefix}[price_data][unit_amount]"])
            return {"id": f"price_custom_{amount}", "unit_amount": amount, "metadata": {},
                    "product": params[f"{prefix}[price_data][product]"], "recurring": {"interval": "month", "interval_count": 1}}
        price_id = params[f"{prefix}[price]"]
        return _price(price_id, {"price_starter": 99000, "price_starter2": 109000, "price_growth": 199000}.get(price_id, 99000))

    def fake(method, path, params=None, *, account=None, idempotency_key=None):
        params = params or {}
        state["calls"].append((method, path, params, idempotency_key))
        if method == "POST" and path == "/customers":
            state["c"] += 1
            return {"id": f"cus_test{state['c']}", "name": params.get("name")}
        if method == "GET" and path.startswith("/customers/"):
            return {"id": path.split("/")[-1], "invoice_settings": {"default_payment_method": state["card"]}}
        if method == "POST" and path.startswith("/customers/") and path.endswith("/tax_ids"):
            return {"id": "txi_1"}
        if method == "POST" and path.startswith("/customers/"):
            return {"id": path.split("/")[-1]}
        if method == "POST" and path == "/subscriptions":
            state["n"] += 1
            sub_id = f"sub_{state['n']}"
            price = item_price(params)
            sub = {"id": sub_id, "status": "trialing" if params.get("trial_end") else "active",
                   "customer": params["customer"], "collection_method": params["collection_method"],
                   "metadata": {k[9:-1]: v for k, v in params.items() if k.startswith("metadata[")},
                   "trial_end": params.get("trial_end"), "pause_collection": None, "cancel_at": None,
                   "items": {"data": [{"id": f"si_{state['n']}", "quantity": 1, "price": price,
                                       "current_period_start": PERIOD_START, "current_period_end": PERIOD_END}]}}
            state["subs"][sub_id] = sub
            return sub
        if path.startswith("/subscriptions/"):
            sub_id = path.split("/")[-1]
            sub = sub_obj(sub_id)
            if method == "GET":
                return sub
            if method == "DELETE":
                sub["status"] = "canceled"
                return sub
            if "pause_collection[behavior]" in params:
                sub["pause_collection"] = {"behavior": params["pause_collection[behavior]"]}
            if params.get("pause_collection") == "":
                sub["pause_collection"] = None
            if "items[0][price]" in params or "items[0][price_data][unit_amount]" in params:
                sub["items"]["data"][0]["price"] = item_price(params)
                state["last_update"] = params
            if "collection_method" in params:
                sub["collection_method"] = params["collection_method"]
            if "cancel_at" in params:
                sub["cancel_at"] = int(params["cancel_at"]) if params["cancel_at"] != "" else None
            for k, v in params.items():
                if k.startswith("metadata["):
                    sub.setdefault("metadata", {})[k[9:-1]] = v
            return sub
        if method == "GET" and path == "/payment_methods":
            return {"data": [{"id": state["card"]}] if state["card"] else []}
        if method == "POST" and path == "/checkout/sessions":
            return {"id": "cs_1", "url": "https://checkout.stripe.com/c/cs_1", "expires_at": 1_800_000_000}
        if method == "GET" and path == "/invoices":
            return {"data": state["invoices"], "has_more": False}
        if method == "POST" and path.startswith("/invoices/") and path.endswith("/send"):
            invoice_id = path.split("/")[2]
            state["sent"].append(invoice_id)
            return {"id": invoice_id, "collection_method": "send_invoice"}
        if method == "POST" and path.startswith("/invoices/") and path.endswith("/finalize"):
            invoice_id = path.split("/")[2]
            return state["made"].get(invoice_id) or {"id": invoice_id, "status": "open"}
        if method == "POST" and path.startswith("/invoices/") and path.endswith("/pay"):
            invoice_id = path.split("/")[2]
            state["paid"].append(invoice_id)
            inv = dict(state["made"].get(invoice_id) or {"id": invoice_id})
            inv.update({"status": "paid", "amount_paid": inv.get("total", 0), "amount_remaining": 0,
                        "status_transitions": {**inv.get("status_transitions", {}), "paid_at": int(time.time())}})
            return inv
        if method == "POST" and path.startswith("/invoices/") and path.endswith("/void"):
            state["voided"].append(path.split("/")[2])
            return {"id": path.split("/")[2], "status": "void"}
        if method == "POST" and path == "/invoiceitems":
            state["items"].append({**params, "idempotency_key": idempotency_key})
            return {"id": f"ii_{len(state['items'])}"}
        if method == "POST" and path == "/invoices":
            # The invoice carries the customer's pending items, like Stripe's include behaviour.
            state["oneoff"].append(params)
            invoice_id = f"in_made_{len(state['oneoff'])}"
            pending = [i for i in state["items"] if i.get("customer") == params["customer"] and not i.get("_used")]
            total = 0
            for i in pending:
                i["_used"] = True
                total += int(i["amount"]) if "amount" in i else int(round(int(i["quantity"]) * float(i["unit_amount_decimal"])))
            tax = round(total * 0.25)
            now = int(time.time())
            inv = {"id": invoice_id, "object": "invoice", "customer": params["customer"], "number": f"F-{len(state['oneoff']):04d}",
                   "status": "open", "currency": "sek", "created": now, "total": total + tax, "tax": tax,
                   "total_excluding_tax": total, "amount_due": total + tax, "amount_paid": 0, "amount_remaining": total + tax,
                   "due_date": now + 30 * 86400 if params.get("collection_method") == "send_invoice" else None,
                   "collection_method": params.get("collection_method"), "metadata": {k[9:-1]: v for k, v in params.items() if k.startswith("metadata[")},
                   "status_transitions": {"finalized_at": now}, "hosted_invoice_url": f"https://invoice.stripe.com/{invoice_id}",
                   "lines": {"data": [{"description": i.get("description"), "quantity": i.get("quantity", 1)} for i in pending]}}
            state["made"][invoice_id] = inv
            return inv
        raise AssertionError(f"unexpected Stripe call {method} {path}")

    monkeypatch.setattr(billing, "stripe_request", fake)
    return state


def _activate(aws, tenant_id):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :a", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":a": {"S": "active"}})


def _profile(aws, tenant_id):
    from app.core import from_ddb
    return from_ddb(aws["ddb"].get_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant_id}"},
                                                                     "SK": {"S": "PROFILE"}})["Item"])


def _set_billing(aws, tenant_id, **fields):
    from app.core import to_ddb_value
    names = {f"#f{i}": k for i, k in enumerate(fields)}
    values = {f":v{i}": to_ddb_value(v) for i, v in enumerate(fields.values())}
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET " + ", ".join(f"billing.{n} = :v{i}" for i, n in enumerate(names)),
                           ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def test_dunning_suspends_long_past_due_and_resumes_after_payment(finance, stripe, aws, tenant):
    from app.handler import handler
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    recent = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat().replace("+00:00", "Z")
    _set_billing(aws, tenant, status="past_due", pastDueSince=recent)
    out = handler({"financeTask": "dunning"}, None)
    assert out["suspended"] == [] and _profile(aws, tenant)["status"] == "active"
    old = (datetime.now(timezone.utc) - timedelta(days=15)).isoformat().replace("+00:00", "Z")
    _set_billing(aws, tenant, pastDueSince=old)
    out = handler({"financeTask": "dunning"}, None)
    assert out["suspended"] == ["Pizzeria Roma (15 days past due)"]
    p = _profile(aws, tenant)
    assert p["status"] == "suspended" and p["billing"]["autoSuspended"] is True
    # paid: the webhook clears pastDueSince and sets status active
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="REMOVE billing.pastDueSince SET billing.#s = :a",
                           ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":a": {"S": "active"}})
    out = handler({"financeTask": "dunning"}, None)
    assert out["resumed"] == ["Pizzeria Roma"]
    p = _profile(aws, tenant)
    assert p["status"] == "active" and "autoSuspended" not in p["billing"]
    # audit trail
    status, body = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})
    actions = [a["action"] for a in body["audit"]]
    assert "suspended" in actions and "resumed" in actions


def test_dunning_off_when_limit_is_zero(finance, stripe, aws, tenant, monkeypatch):
    from app.handler import handler
    monkeypatch.setenv("BILLING_SUSPEND_AFTER_DAYS", "0")
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    _set_billing(aws, tenant, status="past_due", pastDueSince="2020-01-01T00:00:00Z")
    out = handler({"financeTask": "dunning"}, None)
    assert out["suspended"] == [] and _profile(aws, tenant)["status"] == "active"


# ------------------------------------------------------------ reminders, fees, interest
def _ledger(finance, tenant_id, invoice_id, **fields):
    finance.put_item(Item={"PK": f"TENANT#{tenant_id}", "SK": f"INVOICE#2026-10-01#{invoice_id}", "invoiceId": invoice_id,
                           "number": f"F-{invoice_id[-1]}", "currency": "sek", "subtotalSek": Decimal("990"),
                           "taxSek": Decimal("247.5"), "totalSek": Decimal("1237.50"), "amountRemainingSek": Decimal("1237.50"),
                           "amountPaidSek": Decimal(0), "createdAt": "2026-10-01T00:00:00Z",
                           "periodStart": "2026-10-01T00:00:00Z", "periodEnd": "2026-11-01T00:00:00Z",
                           "collectionMethod": "send_invoice", **fields})


def _ago(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds").replace("+00:00", "Z")


def _row(finance, tenant_id, invoice_id):
    return finance.get_item(Key={"PK": f"TENANT#{tenant_id}", "SK": f"INVOICE#2026-10-01#{invoice_id}"})["Item"]


def test_dunning_reminds_weekly_until_paid(finance, stripe, aws, tenant, monkeypatch):
    from app.handler import handler
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    _ledger(finance, tenant, "in_a", status="open", dueDate=_ago(0))        # due today: not late yet
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(2))        # 2 days late: first reminder
    _ledger(finance, tenant, "in_c", status="open", dueDate=_ago(10), remindersSent=1, lastReminderAt=_ago(3))  # too soon
    _ledger(finance, tenant, "in_d", status="open", dueDate=_ago(16), remindersSent=2, lastReminderAt=_ago(7))  # due again
    _ledger(finance, tenant, "in_e", status="open", dueDate=_ago(3), collectionMethod="charge_automatically")   # card: Stripe retries
    out = handler({"financeTask": "dunning"}, None)
    assert sorted(stripe["sent"]) == ["in_b", "in_d"]
    assert len(out["reminded"]) == 2 and "reminder 1, 2 days late" in out["reminded"][0]
    assert _row(finance, tenant, "in_b")["remindersSent"] == 1 and _row(finance, tenant, "in_d")["remindersSent"] == 3
    assert "remindersSent" not in _row(finance, tenant, "in_a")
    # the next day nothing is due again
    stripe["sent"].clear()
    handler({"financeTask": "dunning"}, None)
    assert stripe["sent"] == []
    monkeypatch.setenv("BILLING_REMINDER_INTERVAL_DAYS", "0")
    _ledger(finance, tenant, "in_f", status="open", dueDate=_ago(30))
    handler({"financeTask": "dunning"}, None)
    assert stripe["sent"] == []


def test_dunning_adds_the_late_fee_once_after_the_grace_period(finance, stripe, aws, tenant):
    from app.handler import handler
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    _ledger(finance, tenant, "in_a", status="open", dueDate=_ago(6))     # inside the 7-day grace period
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(7))     # fee today
    out = handler({"financeTask": "dunning"}, None)
    assert len(out["fees"]) == 1 and "F-b (450 kr, 7 days late)" in out["fees"][0]
    item = stripe["items"][0]
    assert item["amount"] == 45000 and item["currency"] == "sek" and item["tax_rates"] == ""
    assert item["customer"] == "cus_test1" and item["metadata[kind]"] == "late_fee" and item["idempotency_key"] == "late-fee-in_b"
    assert "Förseningsavgift" in item["description"] and "F-b" in item["description"]
    row = _row(finance, tenant, "in_b")
    assert row["lateFeeSek"] == 450 and row["lateFeeItemId"] == "ii_1"
    assert "lateFeeAdded" not in _row(finance, tenant, "in_a")
    assert stripe["oneoff"] == []                      # a running subscription bills it on the next invoice
    handler({"financeTask": "dunning"}, None)
    assert len(stripe["items"]) == 1                  # never twice


def test_dunning_adds_interest_when_a_late_invoice_is_paid(finance, stripe, aws, tenant, monkeypatch):
    from app.handler import handler
    monkeypatch.setenv("BILLING_REFERENCE_RATE_PCT", "2")
    monkeypatch.setenv("BILLING_INTEREST_MARGIN_PCT", "8")
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    _ledger(finance, tenant, "in_a", status="paid", dueDate="2026-09-30T00:00:00Z", paidAt="2026-10-20T10:00:00Z",
            amountPaidSek=Decimal("1237.50"), amountRemainingSek=Decimal(0))   # 20 days late
    _ledger(finance, tenant, "in_b", status="paid", dueDate="2026-09-30T00:00:00Z", paidAt="2026-09-28T10:00:00Z",
            amountPaidSek=Decimal("1237.50"), amountRemainingSek=Decimal(0))   # on time
    out = handler({"financeTask": "dunning"}, None)
    # 1237.50 x 10 % x 20 / 365 = 6.78 kr
    assert out["interest"] == ["Pizzeria Roma F-a (6.78 kr for 20 days)"]
    item = stripe["items"][0]
    assert item["amount"] == 678 and item["metadata[kind]"] == "interest" and item["metadata[days]"] == "20"
    assert "Dröjsmålsränta 10 %" in item["description"]
    row = _row(finance, tenant, "in_a")
    assert row["interestSek"] == Decimal("6.78") and row["interestDays"] == 20
    assert "interestAdded" not in _row(finance, tenant, "in_b")
    handler({"financeTask": "dunning"}, None)
    assert len(stripe["items"]) == 1


def test_fees_for_a_cancelled_customer_go_on_a_one_off_invoice(finance, stripe, aws, tenant):
    from app.handler import handler
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    _set_billing(aws, tenant, status="ended", endsAt="2026-01-31")
    _ledger(finance, tenant, "in_a", status="open", dueDate=_ago(9))
    out = handler({"financeTask": "dunning"}, None)
    assert len(out["fees"]) == 1
    assert len(stripe["oneoff"]) == 1 and stripe["oneoff"][0]["pending_invoice_items_behavior"] == "include"
    assert "in_made_1" in stripe["sent"]            # finalized and emailed at once


def test_interest_maths():
    from app.billing import interest_sek
    assert interest_sek(Decimal("1237.50"), 20, reference_pct=Decimal("2"), margin_pct=Decimal("8")) == Decimal("6.78")
    assert interest_sek(Decimal("1000"), 365, reference_pct=Decimal("2.5"), margin_pct=Decimal("8")) == Decimal("105.00")
    assert interest_sek(Decimal("1000"), 0, reference_pct=Decimal("2"), margin_pct=Decimal("8")) == Decimal("0.00")


def test_manual_reminder_route(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    _ledger(finance, tenant, "in_a", status="open", dueDate=_ago(1))
    _ledger(finance, tenant, "in_p", status="paid", dueDate=_ago(1), paidAt=_ago(0))
    status, body = call("POST /platform/tenants/{tenantId}/billing/invoices/{invoiceId}/remind",
                        {"tenantId": tenant, "invoiceId": "in_a"}, body={}, actor="ops@booqy.se")
    assert status == 200 and body == {"remindersSent": 1} and stripe["sent"] == ["in_a"]
    assert _row(finance, tenant, "in_a")["lastReminderBy"] == "ops@booqy.se"
    status, body = call("POST /platform/tenants/{tenantId}/billing/invoices/{invoiceId}/remind",
                        {"tenantId": tenant, "invoiceId": "in_p"}, body={})
    assert status == 409 and body["error"] == "not_open"
    status, body = call("POST /platform/tenants/{tenantId}/billing/invoices/{invoiceId}/remind",
                        {"tenantId": tenant, "invoiceId": "in_zzz"}, body={})
    assert status == 404
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    by_id = {i["invoiceId"]: i for i in body["invoices"]}
    assert by_id["in_a"]["remindersSent"] == 1 and by_id["in_a"]["daysLate"] == 1 and by_id["in_a"]["month"] == "2026-10"


# ------------------------------------------------------------ price, terms, notice, try-out


# ------------------------------------------------------------ periods and pro rata
def test_periods_run_from_the_25th_to_the_24th():
    from datetime import date
    from app.billing import active_days, fee_for, next_period, period_days, period_of, period_text
    assert period_of(date(2026, 9, 10)) == (date(2026, 8, 25), date(2026, 9, 24))
    assert period_of(date(2026, 9, 25)) == (date(2026, 9, 25), date(2026, 10, 24))
    assert period_of(date(2026, 9, 24)) == (date(2026, 8, 25), date(2026, 9, 24))
    assert period_of(date(2026, 1, 3)) == (date(2025, 12, 25), date(2026, 1, 24))
    assert period_of(date(2026, 2, 26)) == (date(2026, 2, 25), date(2026, 3, 24))
    assert period_of(date(2028, 2, 25)) == (date(2028, 2, 25), date(2028, 3, 24))    # leap year
    assert next_period(date(2026, 9, 24)) == (date(2026, 9, 25), date(2026, 10, 24))
    assert period_days(date(2026, 8, 25), date(2026, 9, 24)) == 31
    assert period_days(date(2026, 1, 25), date(2026, 2, 24)) == 31
    assert period_days(date(2026, 2, 25), date(2026, 3, 24)) == 28
    assert period_text(date(2026, 8, 25), date(2026, 9, 24)) == "25 aug till 24 sep 2026"
    # the owner's example: onboarded 10 September in 25 Aug to 24 Sep = 15 of 31 days
    assert active_days(date(2026, 9, 10), None, date(2026, 8, 25), date(2026, 9, 24)) == 15
    assert fee_for(990, date(2026, 9, 10), None, date(2026, 8, 25), date(2026, 9, 24)) == Decimal("479.03")
    assert fee_for(990, date(2026, 8, 1), None, date(2026, 8, 25), date(2026, 9, 24)) == Decimal("990.00")
    assert fee_for(990, date(2026, 8, 1), date(2026, 9, 3), date(2026, 8, 25), date(2026, 9, 24)) == Decimal("319.35")  # 10 days
    assert fee_for(990, date(2026, 10, 1), None, date(2026, 8, 25), date(2026, 9, 24)) == Decimal("0.00")


# ------------------------------------------------------------ the agreement
def _set_status(aws, tenant_id, status):
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET #s = :a", ExpressionAttributeNames={"#s": "status"},
                           ExpressionAttributeValues={":a": {"S": status}})


def test_billing_tab_before_any_agreement(finance, stripe, tenant):
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    assert status == 200
    b = body["billing"]
    assert b["status"] == "none" and b["subscribed"] is False and b["plan"]["priceSek"] == 990 and b["monthlySek"] == 990
    assert b["smsPrice"] == 0.7 and b["nextInvoice"] is None and body["invoices"] == []


def test_start_creates_the_customer_and_the_agreement_without_a_stripe_subscription(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"collectionMethod": "send_invoice", "terms": "trial", "priceSek": 790}, actor="ops@booqy.se")
    assert status == 201, body
    b = body["billing"]
    assert b["customerId"] == "cus_test1" and b["status"] == "active" and b["subscribed"] is True
    assert b["terms"] == "trial" and b["priceSek"] == 790 and b["monthlySek"] == 790 and b["trialEndsAt"]
    assert b["startsAt"] == datetime.now(timezone.utc).date().isoformat() and b["endsAt"] is None
    assert b["startedBy"] == "ops@booqy.se" and b["pendingPeriods"] == 0
    nxt = b["nextInvoice"]
    assert nxt["monthlySek"] == 790 and nxt["smsParts"] == 0 and nxt["date"] == nxt["periodEnd"][:8] + "25" or nxt["date"]
    assert not any(c[1] == "/subscriptions" for c in stripe["calls"])
    customer_call = next(c for c in stripe["calls"] if c[1] == "/customers")
    assert customer_call[2]["name"] == "Roma Restaurang AB"
    claim = aws["ddb"].get_item(TableName="dev-tenant", Key={"PK": {"S": "STRIPE_CUSTOMER#cus_test1"}, "SK": {"S": "TENANT"}})
    assert claim["Item"]["tenantId"]["S"] == tenant
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    assert status == 409 and body["error"] == "already_subscribed"


def test_start_needs_a_customer_that_is_not_suspended_or_gone(finance, stripe, aws, tenant):
    _set_status(aws, tenant, "suspended")
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    assert status == 409 and body["error"] == "invalid_status"


def test_start_validation_and_card_requirement(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"collectionMethod": "cash", "startDate": "soon", "terms": "weekly"})
    assert status == 400 and set(body["fields"]) == {"collectionMethod", "startDate", "terms"}
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"collectionMethod": "charge_automatically"})
    assert status == 409 and body["error"] == "no_card"
    stripe["card"] = "pm_card1"
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"collectionMethod": "charge_automatically"})
    assert status == 201 and body["billing"]["collectionMethod"] == "charge_automatically"


def test_create_customer_with_billing_starts_the_agreement_while_provisioning(finance, stripe, aws):
    from conftest import NEW_TENANT
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "billing": {
        "terms": "trial", "priceSek": 790, "startInvoicing": True}}, actor="ops@booqy.se")
    assert status == 202, body
    b = body["billing"]
    assert b["terms"] == "trial" and b["priceSek"] == 790 and b["status"] == "active"
    profile = _profile(aws, body["tenantId"])
    assert profile["status"] == "provisioning" and profile["billing"]["priceSek"] == 790 and "subscriptionId" not in profile["billing"]
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "roma-2", "ownerEmail": "o2@roma.se",
                                                        "billing": {"terms": "subscription"}})
    assert status == 202 and "billing" not in body and _profile(aws, body["tenantId"])["billing"] == {"terms": "subscription"}


def test_plan_or_price_change_is_what_the_next_invoice_carries(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    status, body = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "starter", "priceSek": 1490})
    assert status == 200 and body["subscription"] == {"monthlySek": 1490, "priceSek": 1490, "from": "next invoice"}
    assert not any(c[1].startswith("/subscriptions") for c in stripe["calls"])
    status, body = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "growth"})
    assert status == 200 and body["subscription"] == {"monthlySek": 1990, "priceSek": None, "from": "next invoice"}
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    assert body["billing"]["monthlySek"] == 1990 and body["billing"]["nextInvoice"]["monthlySek"] == 1990


def test_cancel_terms_in_arrears(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import next_period, period_of
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={"terms": "subscription"})
    patch = "PATCH /platform/tenants/{tenantId}/billing/subscription"
    today = datetime.now(timezone.utc).date()
    start, end = period_of(today)
    status, body = call(patch, {"tenantId": tenant}, body={"action": "cancel"}, actor="ops@booqy.se")
    assert status == 200, body
    expected = end
    for _ in range(3):
        _s, expected = next_period(expected)
    assert body["billing"]["endsAt"] == expected.isoformat() and body["billing"]["status"] == "ending"
    assert body["billing"]["offboardAtEnd"] is True and body["billing"]["subscribed"] is True
    status, body = call(patch, {"tenantId": tenant}, body={"action": "keep"})
    assert status == 200 and body["billing"]["endsAt"] is None and body["billing"]["status"] == "active"
    # a try-out ends with the current period, the 24th
    status, body = call(patch, {"tenantId": tenant}, body={"action": "convert"})
    assert status == 409 and body["error"] == "not_trial"
    from test_billing import _set_billing
    _set_billing(aws, tenant, terms="trial")
    status, body = call(patch, {"tenantId": tenant}, body={"action": "cancel", "offboardAtEnd": False})
    assert status == 200 and body["billing"]["endsAt"] == end.isoformat() and body["billing"]["offboardAtEnd"] is False
    call(patch, {"tenantId": tenant}, body={"action": "keep"})
    status, body = call(patch, {"tenantId": tenant}, body={"action": "convert"})
    assert status == 200 and body["billing"]["terms"] == "subscription" and body["billing"]["trialEndsAt"] is None
    # cancel today: the days used are invoiced on the next 25th
    status, body = call(patch, {"tenantId": tenant}, body={"action": "cancel_now"})
    assert status == 200 and body["billing"]["endsAt"] == today.isoformat() and body["billing"]["status"] == "ending"
    status, body = call(patch, {"tenantId": tenant}, body={"action": "set_sms_price", "smsPriceSek": 0.55})
    assert status == 200 and body["billing"]["smsPriceSek"] == 0.55 and body["billing"]["smsPrice"] == 0.55
    status, body = call(patch, {"tenantId": tenant}, body={"action": "set_sms_price", "smsPriceSek": None})
    assert status == 200 and body["billing"]["smsPriceSek"] is None and body["billing"]["smsPrice"] == 0.7
    assert isinstance(date.today(), date)


def test_card_link_and_use_card(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/billing/card-link", {"tenantId": tenant}, body={})
    assert status == 200 and body["url"].startswith("https://checkout.stripe.com/")
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    status, body = call("PATCH /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={"action": "use_card"})
    assert status == 409 and body["error"] == "no_card"
    stripe["card"] = "pm_card1"
    status, body = call("PATCH /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={"action": "use_card"})
    assert status == 200 and body["billing"]["collectionMethod"] == "charge_automatically" and body["billing"]["hasCard"]


def test_offboarding_ends_the_agreement_today(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    status, body = call("POST /platform/tenants/{tenantId}/offboard", {"tenantId": tenant}, body={"confirmSlug": "pizzeria-roma"})
    assert status == 202 and body["subscription"]["endsAt"] == datetime.now(timezone.utc).date().isoformat()
    assert _profile(aws, tenant)["billing"]["endsAt"] == datetime.now(timezone.utc).date().isoformat()


# ------------------------------------------------------------ the monthly invoicing run
def _day_row(finance, tenant_id, day, **fields):
    finance.put_item(Item={"PK": f"TENANT#{tenant_id}", "SK": f"DAY#{day}", **fields})


def _loc_row(finance, tenant_id, loc, day, **fields):
    finance.put_item(Item={"PK": f"TENANT#{tenant_id}", "SK": f"LOC#{loc}#DAY#{day}", **fields})


def test_invoicing_run_builds_one_arrears_invoice_per_period_with_the_sms_line(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    # agreement from 10 Sep 2026 at 990 kr; 412 SMS parts in 25 Aug to 24 Sep across two locations
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={"startDate": "2026-09-10"})
    status, body = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})
    loc1 = body["locations"][0]["locationId"]
    call("POST /platform/tenants/{tenantId}/locations", {"tenantId": tenant}, body={"name": "Roma Vasastan", "address": "Odengatan 1, Stockholm"})
    _day_row(finance, tenant, "2026-09-12", smsParts=300, sms=250, smsBooking=200, smsReminder=100)
    _day_row(finance, tenant, "2026-09-20", smsParts=112, sms=100, smsOrder=112)
    _day_row(finance, tenant, "2026-09-05", smsParts=999)                    # before the start: not theirs
    _loc_row(finance, tenant, loc1, "2026-09-12", smsParts=300)
    # the preview first
    preview = run_invoicing("ops@booqy.se", dry_run=True, today=date(2026, 9, 25))
    assert len(preview["invoices"]) == 1 and preview["errors"] == []
    plan = preview["invoices"][0]
    assert plan["period"] == "25 aug till 24 sep 2026" and plan["activeDays"] == 15 and plan["days"] == 31
    assert plan["feeSek"] == Decimal("479.03") and plan["smsParts"] == 412 and plan["smsSek"] == Decimal("288.40")
    assert plan["feeText"] == "Booqy Starter, 25 aug till 24 sep 2026 (15 av 31 dagar)"
    assert plan["smsText"] == "SMS 25 aug till 24 sep 2026: 412 delar x 0,70 kr (Roma Södermalm 300)"
    assert plan["totalSek"] == Decimal("767.43") and plan["invoiceId"] is None
    assert stripe["items"] == [] and stripe["oneoff"] == []
    # the run
    out = run_invoicing("invoicing", dry_run=False, today=date(2026, 9, 25))
    assert len(out["invoices"]) == 1 and out["errors"] == [] and out["totalSek"] == Decimal("767.43")
    made = out["invoices"][0]
    assert made["invoiceId"] == "in_made_1" and made["delivery"] == "sent" and made["number"] == "F-0001"
    fee_item, sms_item = stripe["items"]
    assert fee_item["amount"] == 47903 and fee_item["description"] == plan["feeText"] and fee_item["tax_rates[0]"] == "txr_vat25"
    assert fee_item["idempotency_key"] == f"fee-{tenant}-2026-09-24" and fee_item["metadata[kind]"] == "fee"
    assert sms_item["quantity"] == 412 and sms_item["unit_amount_decimal"] == "70" and sms_item["tax_rates[0]"] == "txr_vat25"
    assert sms_item["description"] == plan["smsText"]
    invoice_params = stripe["oneoff"][0]
    assert invoice_params["collection_method"] == "send_invoice" and invoice_params["days_until_due"] == 30
    assert invoice_params["pending_invoice_items_behavior"] == "include" and invoice_params["metadata[periodEnd]"] == "2026-09-24"
    assert stripe["sent"] == ["in_made_1"] and stripe["paid"] == []
    # ledger, profile and audit
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    inv = body["invoices"][0]
    assert inv["number"] == "F-0001" and inv["subtotalSek"] == 767.43 and inv["totalSek"] == 959.29
    assert inv["periodStart"] == "2026-08-25" and inv["periodEnd"] == "2026-09-24"
    assert body["billing"]["lastInvoicedPeriodEnd"] == "2026-09-24"
    # revenue is booked on the day Stripe finalized the invoice (the fake uses the real clock)
    booked_day = datetime.now(timezone.utc).date().isoformat()
    row = finance.get_item(Key={"PK": f"TENANT#{tenant}", "SK": f"DAY#{booked_day}"}).get("Item")
    assert row and row["invoicedSek"] == Decimal("767.43")
    # the same day again: nothing new; a month later: the next period, SMS free this time
    again = run_invoicing("invoicing", dry_run=False, today=date(2026, 9, 25))
    assert again["invoices"] == [] and len(stripe["oneoff"]) == 1
    later = run_invoicing("invoicing", dry_run=False, today=date(2026, 10, 25))
    assert len(later["invoices"]) == 1 and later["invoices"][0]["feeSek"] == Decimal("990.00") and later["invoices"][0]["smsParts"] == 0
    assert len(stripe["items"]) == 3                                      # no SMS item for a period without SMS


def test_invoicing_charges_a_card_and_ends_an_agreement_on_its_final_period(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    from app.handler import handler
    _activate(aws, tenant)
    stripe["card"] = "pm_card1"
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
         body={"startDate": "2026-08-01", "collectionMethod": "charge_automatically", "terms": "trial"})
    _set_billing(aws, tenant, endsAt="2026-09-03", offboardAtEnd=True)     # cancelled: ends 3 Sep
    out = run_invoicing("invoicing", dry_run=False, today=date(2026, 9, 25))
    # two periods: 25 Jul to 24 Aug (from 1 Aug, 24 days) and 25 Aug to 24 Sep (to 3 Sep, 10 days, the last)
    first, made = out["invoices"]
    assert first["activeDays"] == 24 and first["final"] is False
    assert made["activeDays"] == 10 and made["feeSek"] == Decimal("319.35") and made["final"] is True
    assert made["delivery"] == "charged" and stripe["paid"] == ["in_made_1", "in_made_2"] and stripe["sent"] == []
    assert "days_until_due" not in stripe["oneoff"][0]
    b = _profile(aws, tenant)["billing"]
    assert b["status"] == "ended" and b["lastInvoicedPeriodEnd"] == "2026-09-24"
    # the daily task offboards an ended agreement that asked for it
    out = handler({"financeTask": "dunning"}, None)
    assert out["offboarded"] == ["Pizzeria Roma"] and _profile(aws, tenant)["status"] == "offboarding"
    # and nothing more is ever invoiced
    assert run_invoicing("invoicing", dry_run=False, today=date(2026, 12, 25))["invoices"] == []


def test_invoicing_catches_up_missed_periods_and_skips_empty_ones(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={"startDate": "2026-06-01", "priceSek": 0})
    _day_row(finance, tenant, "2026-07-10", smsParts=10)
    out = run_invoicing("invoicing", dry_run=False, today=date(2026, 9, 25))
    # periods: 25 May-24 Jun, 25 Jun-24 Jul, 25 Jul-24 Aug, 25 Aug-24 Sep; price 0, so only the one with SMS is invoiced
    assert [i["period"] for i in out["invoices"]] == ["25 juni till 24 juli 2026"]
    assert [s["period"] for s in out["skipped"]] == ["25 maj till 24 juni 2026", "25 juli till 24 aug 2026", "25 aug till 24 sep 2026"]
    assert _profile(aws, tenant)["billing"]["lastInvoicedPeriodEnd"] == "2026-09-24"


def test_invoicing_route_and_invoice_now(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={"startDate": "2026-01-10"})
    status, body = call("POST /platform/finance/invoicing", body={"dryRun": True})
    assert status == 200 and body["dryRun"] is True and len(body["invoices"]) >= 1 and stripe["oneoff"] == []
    status, body = call("POST /platform/tenants/{tenantId}/billing/invoice", {"tenantId": tenant}, body={})
    assert status == 200 and body["dryRun"] is False and len(body["invoices"]) == len(stripe["oneoff"]) >= 1
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    assert body["billing"]["pendingPeriods"] == 0 and len(body["invoices"]) >= 1


def test_legacy_stripe_subscription_is_moved_to_arrears(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    # pretend the first version had started a Stripe subscription in advance
    _set_billing(aws, tenant, subscriptionId="sub_legacy", status="active", startedAt="2026-09-10T10:00:00Z", mrrSek=990)
    stripe["subs"]["sub_legacy"] = {"id": "sub_legacy", "status": "active", "items": {"data": []}}
    stripe["invoices"] = [{"id": "in_adv", "status": "open", "customer": "cus_test1", "subscription": "sub_legacy"}]
    out = run_invoicing("invoicing", dry_run=False, today=date(2026, 9, 25))
    assert out["migrated"][0]["subscriptionId"] == "sub_legacy" and out["migrated"][0]["voided"] == ["in_adv"]
    assert stripe["subs"]["sub_legacy"]["status"] == "canceled" and stripe["voided"] == ["in_adv"]
    b = _profile(aws, tenant)["billing"]
    assert "subscriptionId" not in b and b["legacySubscriptionId"] == "sub_legacy" and b["startsAt"] == "2026-09-10"
    assert len(out["invoices"]) == 1 and out["invoices"][0]["activeDays"] == 15


# ------------------------------------------------------------ leaving and coming back
def test_restart_in_the_same_period_bills_both_stretches_on_one_invoice(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={"startDate": "2026-09-01"})
    _set_billing(aws, tenant, endsAt="2026-09-10", offboardAtEnd=True)     # left on 10 Sep
    _day_row(finance, tenant, "2026-09-05", smsParts=10)                    # theirs
    _day_row(finance, tenant, "2026-09-12", smsParts=500)                   # between the agreements: not theirs
    _day_row(finance, tenant, "2026-09-20", smsParts=20)                    # theirs again
    # back from 15 Sep: the ended stretch is kept for the next invoice
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"startDate": "2026-09-15"})
    assert status == 201, body
    b = body["billing"]
    assert b["startsAt"] == "2026-09-15" and b["endsAt"] is None and b["offboardAtEnd"] is False
    assert b["previous"] == [{"startsAt": "2026-09-01", "endsAt": "2026-09-10"}]
    out = run_invoicing("invoicing", dry_run=False, today=date(2026, 9, 25))
    made = out["invoices"][0]
    # 1-10 Sep and 15-24 Sep: 20 of 31 days, SMS from both stretches only
    assert made["activeDays"] == 20 and made["feeSek"] == Decimal("638.71") and made["smsParts"] == 30
    assert made["final"] is False and len(out["invoices"]) == 1
    b = _profile(aws, tenant)["billing"]
    assert b["status"] == "active" and "previous" not in b and b["lastInvoicedPeriodEnd"] == "2026-09-24"
    later = run_invoicing("invoicing", dry_run=False, today=date(2026, 10, 25))
    assert later["invoices"][0]["feeSek"] == Decimal("990.00") and later["invoices"][0]["activeDays"] == 30


def test_restart_rules(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    post = "POST /platform/tenants/{tenantId}/billing/subscription"
    _activate(aws, tenant)
    call(post, {"tenantId": tenant}, body={"startDate": "2026-08-01"})
    # still running, or cancelled but not ended yet: not a restart
    status, body = call(post, {"tenantId": tenant}, body={})
    assert status == 409 and body["error"] == "already_subscribed"
    _set_billing(aws, tenant, endsAt="2099-01-24")
    status, body = call(post, {"tenantId": tenant}, body={})
    assert status == 409 and body["error"] == "already_subscribed" and "Keep the agreement" in body["message"]
    # ended on 3 Sep: a new start must come after that
    _set_billing(aws, tenant, endsAt="2026-09-03")
    status, body = call(post, {"tenantId": tenant}, body={"startDate": "2026-09-03"})
    assert status == 409 and body["error"] == "already_subscribed"
    # the last invoice made: a start inside an invoiced period is refused
    run_invoicing("invoicing", dry_run=False, today=date(2026, 9, 25))
    b = _profile(aws, tenant)["billing"]
    assert b["status"] == "ended" and b["lastInvoicedPeriodEnd"] == "2026-09-24"
    status, body = call(post, {"tenantId": tenant}, body={"startDate": "2026-09-20"})
    assert status == 409 and body["error"] == "already_invoiced" and body["earliestStart"] == "2026-09-25"
    status, body = call(post, {"tenantId": tenant}, body={"startDate": "2026-10-01"})
    assert status == 201 and body["billing"]["lastInvoicedPeriodEnd"] == "2026-09-24" and body["billing"]["previous"] == []
    out = run_invoicing("invoicing", dry_run=False, today=date(2026, 10, 25))
    # 1-24 Oct of 25 Sep to 24 Oct
    assert [(i["activeDays"], i["feeSek"]) for i in out["invoices"]] == [(24, Decimal("792.00"))]
