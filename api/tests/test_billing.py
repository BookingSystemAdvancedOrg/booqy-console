"""Subscriptions (Stripe Billing on the platform account): customer and
subscription creation, plan changes, pause/cancel, the ledger import and the
dunning task. Stripe is a fake; DynamoDB and Cognito are moto."""
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
    aws["ddb"].create_table(TableName=FINANCE_TABLE, BillingMode="PAY_PER_REQUEST",
                            AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"},
                                                  {"AttributeName": "SK", "AttributeType": "S"}],
                            KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}])
    for plan_id, price in (("starter", "price_starter"), ("growth", "price_growth")):
        aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"PLAN#{plan_id}"}, "SK": {"S": "PLAN"}},
                               UpdateExpression="SET stripePriceId = :p, priceSek = :s",
                               ExpressionAttributeValues={":p": {"S": price}, ":s": {"N": "990" if plan_id == "starter" else "1990"}})
    return boto3.resource("dynamodb", region_name=REGION).Table(FINANCE_TABLE)


def _price(price_id, amount):
    return {"id": price_id, "unit_amount": amount, "metadata": {"planId": price_id.split("_")[1]},
            "recurring": {"interval": "month", "interval_count": 1}}


@pytest.fixture
def stripe(monkeypatch):
    from app import billing
    state = {"calls": [], "subs": {}, "n": 0, "c": 0, "card": None, "invoices": [], "items": [], "sent": [],
             "oneoff": []}

    def sub_obj(sub_id):
        return state["subs"][sub_id]

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
            price = _price(params["items[0][price]"], 99000 if "starter" in params["items[0][price]"] else 199000)
            sub = {"id": sub_id, "status": "trialing" if params.get("trial_end") else "active",
                   "customer": params["customer"], "collection_method": params["collection_method"],
                   "trial_end": params.get("trial_end"), "pause_collection": None, "cancel_at": None,
                   "items": {"data": [{"id": f"si_{state['n']}", "quantity": 1, "price": price,
                                       "current_period_start": 1_790_000_000, "current_period_end": 1_792_600_000}]}}
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
            if "items[0][price]" in params:
                sub["items"]["data"][0]["price"] = _price(params["items[0][price]"],
                                                         99000 if "starter" in params["items[0][price]"] else 199000)
            if "collection_method" in params:
                sub["collection_method"] = params["collection_method"]
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
            return {"id": path.split("/")[2], "status": "open"}
        if method == "POST" and path == "/invoiceitems":
            state["items"].append({**params, "idempotency_key": idempotency_key})
            return {"id": f"ii_{len(state['items'])}"}
        if method == "POST" and path == "/invoices":
            state["oneoff"].append(params)
            return {"id": f"in_oneoff_{len(state['oneoff'])}"}
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


def test_billing_tab_before_any_subscription(finance, stripe, tenant):
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    assert status == 200
    assert body["billing"]["subscribed"] is False and body["billing"]["plan"]["priceSek"] == 990
    assert body["invoices"] == []


def test_start_needs_an_active_customer(finance, stripe, tenant):
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    assert status == 409 and body["error"] == "invalid_status"


def test_start_subscription_creates_customer_claims_it_and_subscribes(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"collectionMethod": "send_invoice"}, actor="ops@booqy.se")
    assert status == 201, body
    b = body["billing"]
    assert b["customerId"] == "cus_test1" and b["subscriptionId"] == "sub_1" and b["status"] == "active"
    assert b["subscribed"] is True and b["mrrSek"] == 990 and b["planId"] == "starter"
    assert b["collectionMethod"] == "send_invoice" and b["startedBy"] == "ops@booqy.se" and b["priceDiffers"] is False
    # the customer carries the company details, the VAT rate and the due days went on the subscription
    customer_call = next(c for c in stripe["calls"] if c[1] == "/customers")
    assert customer_call[2]["name"] == "Roma Restaurang AB" and customer_call[2]["metadata[tenantId]"] == tenant
    assert customer_call[2]["email"] == "owner@roma.se" and customer_call[3] == f"customer-{tenant}"
    sub_call = next(c for c in stripe["calls"] if c[1] == "/subscriptions")
    assert sub_call[2]["items[0][price]"] == "price_starter" and sub_call[2]["default_tax_rates[0]"] == "txr_vat25"
    assert sub_call[2]["days_until_due"] == 30 and sub_call[2]["metadata[tenantId]"] == tenant
    claim = aws["ddb"].get_item(TableName="dev-tenant", Key={"PK": {"S": "STRIPE_CUSTOMER#cus_test1"}, "SK": {"S": "TENANT"}})
    assert claim["Item"]["tenantId"]["S"] == tenant
    # twice is refused
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    assert status == 409 and body["error"] == "already_subscribed"
    # audit trail
    status, body = call("GET /platform/tenants/{tenantId}", {"tenantId": tenant})
    actions = [a["action"] for a in body["audit"]]
    assert "subscription_started" in actions and "stripe_customer_created" in actions


def test_start_later_is_a_trial_until_the_date(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    start = (datetime.now(timezone.utc).date() + timedelta(days=10)).isoformat()
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"startDate": start})
    assert status == 201, body
    sub_call = next(c for c in stripe["calls"] if c[1] == "/subscriptions")
    assert datetime.fromtimestamp(sub_call[2]["trial_end"], timezone.utc).date().isoformat() == start
    assert body["billing"]["status"] == "trialing" and body["billing"]["trialEnd"].startswith(start)


def test_start_validation(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"collectionMethod": "cash", "startDate": "soon"})
    assert status == 400 and set(body["fields"]) == {"collectionMethod", "startDate"}


def test_charge_automatically_needs_a_card(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"collectionMethod": "charge_automatically"})
    assert status == 409 and body["error"] == "no_card"
    stripe["card"] = "pm_card1"
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"collectionMethod": "charge_automatically"})
    assert status == 201 and body["billing"]["collectionMethod"] == "charge_automatically"


def test_plan_without_a_price_is_refused(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": "PLAN#starter"}, "SK": {"S": "PLAN"}},
                           UpdateExpression="REMOVE stripePriceId")
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    assert status == 409 and body["error"] == "plan_without_price"


def test_plan_change_moves_the_subscription_to_the_new_price(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    status, body = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "growth"})
    assert status == 200, body
    assert body["subscription"] == {"priceId": "price_growth"}
    assert body["tenant"]["billing"]["priceId"] == "price_growth" and body["tenant"]["billing"]["mrrSek"] == 1990
    move = next(c for c in stripe["calls"] if c[0] == "POST" and c[1] == "/subscriptions/sub_1")
    assert move[2]["items[0][id]"] == "si_1" and move[2]["proration_behavior"] == "create_prorations"


def test_pause_resume_cancel_and_sync_price(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    patch = "PATCH /platform/tenants/{tenantId}/billing/subscription"
    status, body = call(patch, {"tenantId": tenant}, body={"action": "pause"})
    assert status == 200 and body["billing"]["pauseCollection"] is True
    status, body = call(patch, {"tenantId": tenant}, body={"action": "resume"})
    assert status == 200 and body["billing"]["pauseCollection"] is False
    # the plan got a new price in Terraform: the tab says so, sync moves to it
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": "PLAN#starter"}, "SK": {"S": "PLAN"}},
                           UpdateExpression="SET stripePriceId = :p", ExpressionAttributeValues={":p": {"S": "price_starter2"}})
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    assert body["billing"]["priceDiffers"] is True
    status, body = call(patch, {"tenantId": tenant}, body={"action": "sync_price"})
    assert status == 200 and body["billing"]["priceId"] == "price_starter2" and body["billing"]["priceDiffers"] is False
    status, body = call(patch, {"tenantId": tenant}, body={"action": "cancel"})
    assert status == 200 and body["billing"]["status"] == "canceled" and body["billing"]["subscribed"] is False
    assert body["billing"]["mrrSek"] == 0
    cancel = next(c for c in stripe["calls"] if c[0] == "DELETE")
    assert cancel[2] == {"invoice_now": "true", "prorate": "true"}
    status, body = call(patch, {"tenantId": tenant}, body={"action": "pause"})
    assert status == 409 and body["error"] == "not_subscribed"
    status, body = call(patch, {"tenantId": tenant}, body={"action": "fly"})
    assert status == 409  # no subscription any more comes first


def test_card_link_and_use_card(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/billing/card-link", {"tenantId": tenant}, body={})
    assert status == 200 and body["url"].startswith("https://checkout.stripe.com/")
    session = next(c for c in stripe["calls"] if c[1] == "/checkout/sessions")
    assert session[2]["mode"] == "setup" and session[2]["customer"] == "cus_test1"
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    status, body = call("PATCH /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"action": "use_card"})
    assert status == 409 and body["error"] == "no_card"
    stripe["card"] = "pm_card1"
    status, body = call("PATCH /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"action": "use_card"})
    assert status == 200 and body["billing"]["collectionMethod"] == "charge_automatically" and body["billing"]["hasCard"]


def test_offboarding_cancels_the_subscription(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    status, body = call("POST /platform/tenants/{tenantId}/offboard", {"tenantId": tenant}, body={"confirmSlug": "pizzeria-roma"})
    assert status == 202 and body["subscription"] == {"cancelled": "sub_1"}
    assert _profile(aws, tenant)["billing"]["status"] == "canceled"


def test_offboarding_goes_on_when_stripe_fails(finance, stripe, aws, tenant, monkeypatch):
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    from app import billing
    from app.core import ApiError

    def broken(method, path, params=None, **kw):
        raise ApiError(502, "stripe_unreachable", "Stripe: down")
    monkeypatch.setattr(billing, "stripe_request", broken)
    status, body = call("POST /platform/tenants/{tenantId}/offboard", {"tenantId": tenant}, body={"confirmSlug": "pizzeria-roma"})
    assert status == 202 and body["subscription"] == {"error": "Stripe: down"}
    assert _profile(aws, tenant)["status"] == "offboarding"


def test_stripe_sync_imports_invoices_into_the_ledger(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    stripe["invoices"] = [
        {"id": "in_1", "customer": "cus_test1", "subscription": "sub_1", "number": "F-1", "status": "paid",
         "currency": "sek", "created": 1_799_900_000, "total": 123_750, "tax": 24_750, "total_excluding_tax": 99_000,
         "amount_paid": 123_750, "amount_due": 123_750, "amount_remaining": 0, "due_date": 1_802_500_000,
         "status_transitions": {"finalized_at": 1_800_000_000, "paid_at": 1_800_100_000},
         "hosted_invoice_url": "https://invoice.stripe.com/i/1", "period_start": 1_790_000_000, "period_end": 1_792_600_000},
        {"id": "in_2", "customer": "cus_test1", "subscription": "sub_1", "number": "F-2", "status": "open",
         "currency": "sek", "created": 1_802_000_000, "total": 123_750, "tax": 24_750, "total_excluding_tax": 99_000,
         "amount_paid": 0, "amount_due": 123_750, "amount_remaining": 123_750, "due_date": 1_805_000_000,
         "status_transitions": {"finalized_at": 1_802_000_000}},
        {"id": "in_3", "customer": "cus_test1", "status": "draft", "created": 1_803_000_000, "total": 0},
    ]
    status, body = call("POST /platform/finance/stripe-sync", body={})
    assert status == 200, body
    assert body["sync"] == {"tenants": 1, "subscriptions": 1, "invoices": 2, "booked": 3, "errors": []}
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    numbers = [i["number"] for i in body["invoices"]]
    assert numbers == ["F-2", "F-1"]
    open_inv = body["invoices"][0]
    assert open_inv["outstandingSek"] == 990 and open_inv["status"] == "open"
    day = finance.get_item(Key={"PK": f"TENANT#{tenant}", "SK": "DAY#2027-01-15"})["Item"]
    assert day["invoicedSek"] == Decimal("990.00")
    assert finance.get_item(Key={"PK": f"TENANT#{tenant}", "SK": "DAY#2027-01-16"})["Item"]["paidSek"] == Decimal("990.00")
    # a second sync books nothing twice
    status, body = call("POST /platform/finance/stripe-sync", body={})
    assert body["sync"]["booked"] == 0
    assert finance.get_item(Key={"PK": f"TENANT#{tenant}", "SK": "DAY#2027-01-15"})["Item"]["invoicedSek"] == Decimal("990.00")


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
    call("PATCH /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={"action": "cancel"})
    _ledger(finance, tenant, "in_a", status="open", dueDate=_ago(9))
    out = handler({"financeTask": "dunning"}, None)
    assert len(out["fees"]) == 1
    assert len(stripe["oneoff"]) == 1 and stripe["oneoff"][0]["pending_invoice_items_behavior"] == "include"
    assert "in_oneoff_1" in stripe["sent"]            # finalized and emailed at once


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
