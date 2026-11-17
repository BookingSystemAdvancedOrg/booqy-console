"""Agreements invoiced in advance per calendar month: customer creation and
sync, the agreement, cancellation terms, the invoicing run (the monthly
price only: SMS are included), the switch from the old arrears cycle,
collection (card or emailed invoice), the compliance fields, reminders to
the restaurant and the operators, fees, interest and the dunning task.
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
    monkeypatch.setenv("BILLING_SUSPEND_AFTER_DAYS", "0")
    monkeypatch.setenv("BILLING_DAYS_UNTIL_DUE_NO_CARD", "10")
    monkeypatch.setenv("BILLING_REMINDER_STEPS", "3,7,14")
    monkeypatch.setenv("BILLING_FINAL_NOTICE_DAYS", "30")
    monkeypatch.setenv("BILLING_REMINDER_FEE_SEK", "60")
    monkeypatch.setenv("BILLING_LATE_FEE_SEK", "450")
    monkeypatch.setenv("BILLING_LATE_FEE_AFTER_DAYS", "7")
    monkeypatch.setenv("BILLING_REFERENCE_RATE_PCT", "2")
    monkeypatch.setenv("BILLING_SELLER_JSON", json.dumps({
        "name": "Booqy AB", "address": "Exempelgatan 1, 111 11 Stockholm", "org_number": "559999-0001",
        "vat_number": "SE559999000101", "seat": "Stockholm", "f_skatt": True}))
    monkeypatch.setenv("FINANCE_ROLLUP_FUNCTION_ARN", "arn:aws:lambda:eu-north-1:123456789012:function:dev-finance-rollup:live")
    monkeypatch.setenv("ALERT_TOPIC_ARN", "")
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
    """A fake Stripe: customers, invoices (drafts with their own items, or
    the old include-pending behaviour), finalize/send/pay/void, Checkout,
    tax ids, connected accounts. A repeated idempotency key returns the
    first answer, like Stripe."""
    from app import billing
    state = {"calls": [], "subs": {}, "n": 0, "c": 0, "card": None, "invoices": [], "items": [], "sent": [],
             "oneoff": [], "paid": [], "voided": [], "made": {}, "keys": {}, "account": None, "customers": {},
             "pay_fails": False}

    def sub_obj(sub_id):
        return state["subs"][sub_id]

    def totals(inv):
        lines = [i for i in state["items"] if i.get("invoice") == inv["id"] or i.get("_on") == inv["id"]]
        total = sum(int(i["amount"]) for i in lines)
        tax = sum(round(int(i["amount"]) * 0.25) for i in lines if i.get("tax_rates[0]"))
        inv.update({"total": total + tax, "tax": tax, "total_excluding_tax": total, "amount_due": total + tax,
                    "amount_remaining": total + tax if inv["status"] != "paid" else 0,
                    "lines": {"data": [{"description": i.get("description"), "amount": int(i["amount"]),
                                        "metadata": {k[9:-1]: v for k, v in i.items() if k.startswith("metadata[")}}
                                       for i in lines]}})

    def fake(method, path, params=None, *, account=None, idempotency_key=None):
        params = params or {}
        state["calls"].append((method, path, params, idempotency_key))
        if idempotency_key and method == "POST":
            seen = state["keys"].get((path, idempotency_key))
            if seen is not None:
                return dict(state["made"].get(seen.get("id"), seen)) if seen.get("object") == "invoice" else seen
            out = handle(method, path, params, idempotency_key)
            state["keys"][(path, idempotency_key)] = out
            return out
        return handle(method, path, params, idempotency_key)

    def handle(method, path, params, idempotency_key):
        if method == "POST" and path == "/customers":
            state["c"] += 1
            cid = f"cus_test{state['c']}"
            state["customers"][cid] = dict(params)
            return {"id": cid, "name": params.get("name")}
        if method == "GET" and path.startswith("/customers/"):
            return {"id": path.split("/")[-1], "invoice_settings": {"default_payment_method": state["card"]}}
        if method == "POST" and path.startswith("/customers/") and path.endswith("/tax_ids"):
            return {"id": f"txi_{params['value']}"}
        if method == "DELETE" and "/tax_ids/" in path:
            return {"id": path.split("/")[-1], "deleted": True}
        if method == "POST" and path == "/tax_ids":
            return {"id": "txi_booqy"}
        if method == "GET" and path.startswith("/accounts/"):
            return state["account"] or {"id": path.split("/")[-1]}
        if method == "POST" and path.startswith("/customers/"):
            state["customers"].setdefault(path.split("/")[-1], {}).update(params)
            return {"id": path.split("/")[-1]}
        if path.startswith("/subscriptions/"):
            sub = sub_obj(path.split("/")[-1])
            if method == "DELETE":
                sub["status"] = "canceled"
            return sub
        if method == "GET" and path == "/payment_methods":
            return {"data": [{"id": state["card"], "card": {"brand": "visa", "last4": "4242"}}] if state["card"] else []}
        if method == "POST" and path == "/checkout/sessions":
            return {"id": "cs_1", "url": "https://checkout.stripe.com/c/cs_1", "expires_at": 1_800_000_000}
        if method == "GET" and path == "/invoices":
            made = [i for i in state["made"].values() if i["customer"] == params.get("customer")
                    and ("created[gte]" not in params or i["created"] >= params["created[gte]"])]
            if "created[gte]" in params:
                return {"data": state["invoices"] + made, "has_more": False}
            return {"data": state["invoices"], "has_more": False}
        if method == "GET" and path.startswith("/invoices/") and path.endswith("/lines"):
            return {"data": [{"metadata": {k[9:-1]: v for k, v in i.items() if k.startswith("metadata[")}}
                             for i in state["items"] if i.get("invoice") == path.split("/")[2]]}
        if method == "GET" and path.startswith("/invoices/"):
            invoice_id = path.split("/")[2]
            return state["made"].get(invoice_id) or state.get("remote", {}).get(invoice_id) or {"id": invoice_id, "status": "open"}
        if method == "POST" and path.startswith("/invoices/") and path.endswith("/send"):
            invoice_id = path.split("/")[2]
            state["sent"].append(invoice_id)
            return {"id": invoice_id, "collection_method": "send_invoice"}
        if method == "POST" and path.startswith("/invoices/") and path.endswith("/finalize"):
            invoice_id = path.split("/")[2]
            inv = state["made"].get(invoice_id)
            if inv is None:
                return {"id": invoice_id, "status": "open"}
            if inv["status"] == "draft":
                inv["status"] = "open"
                inv["number"] = f"F-{sum(1 for i in state['made'].values() if i.get('number')) + 1:04d}"
                inv["status_transitions"] = {"finalized_at": int(time.time())}
                totals(inv)
            return dict(inv)
        if method == "POST" and path.startswith("/invoices/") and path.endswith("/pay"):
            invoice_id = path.split("/")[2]
            if state["pay_fails"]:
                from app.core import ApiError
                raise ApiError(402, "card_declined", "Your card was declined.")
            state["paid"].append(invoice_id)
            inv = state["made"].get(invoice_id) or {"id": invoice_id}
            inv.update({"status": "paid", "amount_paid": inv.get("total", 0), "amount_remaining": 0,
                        "status_transitions": {**inv.get("status_transitions", {}), "paid_at": int(time.time())}})
            return dict(inv)
        if method == "POST" and path.startswith("/invoices/") and path.endswith("/void"):
            state["voided"].append(path.split("/")[2])
            return {"id": path.split("/")[2], "status": "void"}
        if method == "POST" and path == "/invoiceitems":
            state["items"].append({**params, "idempotency_key": idempotency_key})
            return {"id": f"ii_{len(state['items'])}"}
        if method == "POST" and path == "/invoices":
            state["oneoff"].append(params)
            invoice_id = f"in_made_{len(state['oneoff'])}"
            now = int(time.time())
            draft = params.get("pending_invoice_items_behavior") == "exclude"
            inv = {"id": invoice_id, "object": "invoice", "customer": params["customer"], "number": None,
                   "status": "draft" if draft else "open", "currency": "sek", "created": now, "amount_paid": 0,
                   "due_date": now + int(params.get("days_until_due") or 30) * 86400
                   if params.get("collection_method") == "send_invoice" else None,
                   "collection_method": params.get("collection_method"),
                   "metadata": {k[9:-1]: v for k, v in params.items() if k.startswith("metadata[")},
                   "status_transitions": {}, "hosted_invoice_url": f"https://invoice.stripe.com/{invoice_id}"}
            if not draft:   # the old behaviour: the customer's pending items go on it
                for i in state["items"]:
                    if i.get("customer") == params["customer"] and not i.get("invoice") and not i.get("_on"):
                        i["_on"] = invoice_id
                inv["number"] = f"F-{len(state['oneoff']):04d}"
                inv["status_transitions"] = {"finalized_at": now}
            state["made"][invoice_id] = inv
            totals(inv)
            return dict(inv)
        raise AssertionError(f"unexpected Stripe call {method} {path}")

    monkeypatch.setattr(billing, "stripe_request", fake)
    return state


@pytest.fixture
def mails(monkeypatch):
    from app import mail
    sent = []
    monkeypatch.setattr(mail, "_send_one", lambda to, subject, body, template: sent.append((to, subject, body)))
    return sent


@pytest.fixture
def ops(monkeypatch):
    """The operators' emails (the alerts topic)."""
    from app import billing
    sent = []
    monkeypatch.setenv("ALERT_TOPIC_ARN", "arn:aws:sns:eu-north-1:123456789012:dev-platform-alerts")

    def publish(subject, message):
        if sent and sent[-1] == "FAIL":
            sent.pop()
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "Throttling", "Message": "slow down"}}, "Publish")
        sent.append((subject, message))
        return True
    monkeypatch.setattr(billing, "_ops_publish", publish)
    return sent


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


def _start(tenant_id, **body):
    status, out = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant_id}, body=body)
    assert status == 201, out
    return out["billing"]


def _ledger(finance, tenant_id, invoice_id, **fields):
    finance.put_item(Item={"PK": f"TENANT#{tenant_id}", "SK": f"INVOICE#2026-10-01#{invoice_id}", "invoiceId": invoice_id,
                           "number": f"F-{invoice_id[-1]}", "currency": "sek", "subtotalSek": Decimal("990"),
                           "taxSek": Decimal("247.5"), "totalSek": Decimal("1237.50"), "amountRemainingSek": Decimal("1237.50"),
                           "amountPaidSek": Decimal(0), "createdAt": "2026-10-01T00:00:00Z",
                           "periodStart": "2026-10-01", "periodEnd": "2026-10-31", "kind": "advance",
                           "hostedInvoiceUrl": f"https://invoice.stripe.com/{invoice_id}",
                           "collectionMethod": "send_invoice", **fields})


def _accept_terms(aws, tenant_id, version="2026-11-v1", at="2026-09-01T10:00:00Z"):
    """The owner accepted Allmänna villkor för restauranger (the reminder
    fee is agreed) before the ledger rows' invoices (1 Oct)."""
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET terms = :t",
                           ExpressionAttributeValues={":t": {"M": {"version": {"S": version}, "acceptedAt": {"S": at},
                                                                   "acceptedBySub": {"S": "sub-owner"}}}})


def _ago(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds").replace("+00:00", "Z")


def _row(finance, tenant_id, invoice_id):
    return finance.get_item(Key={"PK": f"TENANT#{tenant_id}", "SK": f"INVOICE#2026-10-01#{invoice_id}"})["Item"]


def _fee_invoices(stripe):
    return [p for p in stripe["oneoff"] if p.get("metadata[kind]") == "fees"]


def _items_of(stripe, invoice_id):
    return [i for i in stripe["items"] if i.get("invoice") == invoice_id]


# ------------------------------------------------------------ calendar months and pro rata
def test_periods_are_calendar_months():
    from datetime import date
    from app.billing import active_days, fee_for, month_end, month_segments, next_period, period_days, period_of, period_text
    assert period_of(date(2026, 9, 10)) == (date(2026, 9, 1), date(2026, 9, 30))
    assert period_of(date(2026, 2, 1)) == (date(2026, 2, 1), date(2026, 2, 28))
    assert period_of(date(2028, 2, 29)) == (date(2028, 2, 1), date(2028, 2, 29))      # leap year
    assert next_period(date(2026, 12, 31)) == (date(2027, 1, 1), date(2027, 1, 31))
    assert month_end(date(2026, 11, 25)) == date(2026, 11, 30)
    assert period_days(date(2026, 11, 1), date(2026, 11, 30)) == 30
    assert period_text(date(2026, 11, 25), date(2026, 11, 30)) == "25 nov till 30 nov 2026"
    assert month_segments(date(2026, 10, 25), date(2026, 11, 30)) == [(date(2026, 10, 25), date(2026, 10, 31)),
                                                                      (date(2026, 11, 1), date(2026, 11, 30))]
    # the first month pro rata by the days of the month: 25 to 30 Nov = 6 of 30 days
    assert active_days(date(2026, 11, 25), None, date(2026, 11, 25), date(2026, 11, 30)) == 6
    assert fee_for(990, date(2026, 11, 25), None, date(2026, 11, 25), date(2026, 11, 30)) == Decimal("198.00")
    assert fee_for(990, date(2026, 8, 1), None, date(2026, 9, 1), date(2026, 9, 30)) == Decimal("990.00")
    assert fee_for(990, date(2026, 8, 1), date(2026, 9, 3), date(2026, 9, 1), date(2026, 9, 30)) == Decimal("99.00")


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
    assert b["free"] is None and b["nextInvoice"] is None and body["invoices"] == []
    assert b["collectionPreference"] == "card" and b["collectionMethod"] == "send_invoice" and b["hasCard"] is False
    assert b["reminderSteps"] == [3, 7, 14] and b["finalNoticeDays"] == 30 and b["suspendAfterDays"] == 0
    assert b["sellerMissing"] == [] and b["billingEmail"] == "owner@roma.se"


def test_start_creates_the_customer_and_an_agreement_in_advance(finance, stripe, aws, tenant):
    from app.billing import _today, month_end
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"terms": "trial", "priceSek": 790}, actor="ops@booqy.se")
    assert status == 201, body
    b = body["billing"]
    assert b["customerId"] == "cus_test1" and b["status"] == "active" and b["subscribed"] is True
    assert b["terms"] == "trial" and b["priceSek"] == 790 and b["monthlySek"] == 790 and b["trialEndsAt"]
    assert b["startsAt"] == _today().isoformat() and b["cycle"] == "advance" and b["paidThrough"] is None
    nxt = b["nextInvoice"]
    # the first invoice is today, for the rest of this month; no card yet: emailed, 10 days
    assert nxt["date"] == _today().isoformat() and nxt["periodEnd"] == month_end(_today()).isoformat()
    assert nxt["kind"] == "advance" and b["daysUntilDue"] == 10 and b["collectionMethod"] == "send_invoice"
    customer = stripe["customers"]["cus_test1"]
    assert customer["name"] == "Roma Restaurang AB" and customer["preferred_locales[0]"] == "sv"
    assert customer["email"] == "owner@roma.se" and customer["address[city]"] == "Stockholm"
    tax = [c for c in stripe["calls"] if c[1] == "/customers/cus_test1/tax_ids"]
    assert tax[0][2] == {"type": "eu_vat", "value": "SE556677889901"}                 # from the org number
    claim = aws["ddb"].get_item(TableName="dev-tenant", Key={"PK": {"S": "STRIPE_CUSTOMER#cus_test1"}, "SK": {"S": "TENANT"}})
    assert claim["Item"]["tenantId"]["S"] == tenant
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    assert status == 409 and body["error"] == "already_subscribed"


def test_start_needs_a_customer_that_is_not_suspended_or_gone(finance, stripe, aws, tenant):
    _set_status(aws, tenant, "suspended")
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    assert status == 409 and body["error"] == "invalid_status"


def test_start_validation_and_no_card_needed(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"collectionPreference": "cash", "startDate": "soon", "terms": "weekly"})
    assert status == 400 and set(body["fields"]) == {"collectionPreference", "startDate", "terms"}
    # card preference without a card: no longer refused, emailed until a card is added
    b = _start(tenant, collectionMethod="charge_automatically")
    assert b["collectionPreference"] == "card" and b["collectionMethod"] == "send_invoice"


def test_create_customer_with_billing_starts_the_agreement_while_provisioning(finance, stripe, aws):
    from conftest import NEW_TENANT
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "billing": {
        "terms": "trial", "priceSek": 790, "startInvoicing": True}}, actor="ops@booqy.se")
    assert status == 202, body
    b = body["billing"]
    assert b["terms"] == "trial" and b["priceSek"] == 790 and b["status"] == "active" and b["cycle"] == "advance"
    profile = _profile(aws, body["tenantId"])
    assert profile["status"] == "provisioning" and profile["billing"]["priceSek"] == 790


def test_plan_or_price_change_applies_from_the_next_month(finance, stripe, aws, tenant):
    from app.billing import _billing, _today, invoice_plan, next_period, period_of
    _activate(aws, tenant)
    start, end = period_of(_today())
    _start(tenant, startDate=(start - timedelta(days=40)).isoformat())
    nxt = (end + timedelta(days=1)).isoformat()
    status, body = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "starter", "priceSek": 1490})
    assert status == 200 and body["subscription"] == {"monthlySek": 1490, "priceSek": 1490, "from": nxt}
    status, body = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "growth"})
    assert status == 200 and body["subscription"] == {"monthlySek": 1990, "priceSek": None, "from": nxt}
    profile = _profile(aws, tenant)
    assert invoice_plan(profile, start, end)["monthlySek"] == 990
    after = invoice_plan(profile, *next_period(end))
    assert after["monthlySek"] == 1990 and after["feeText"].startswith("Booqy Growth,")
    assert [h["monthlySek"] for h in _billing(profile)["priceHistory"]] == [990, 1990]


def test_cancel_terms_end_with_a_month(finance, stripe, aws, tenant):
    from app.billing import _today, next_period, period_of
    _activate(aws, tenant)
    _start(tenant, terms="subscription")
    patch = "PATCH /platform/tenants/{tenantId}/billing/subscription"
    today = _today()
    _s, end = period_of(today)
    status, body = call(patch, {"tenantId": tenant}, body={"action": "cancel"}, actor="ops@booqy.se")
    expected = end
    for _ in range(3):
        _s, expected = next_period(expected)
    assert status == 200 and body["billing"]["endsAt"] == expected.isoformat() and body["billing"]["status"] == "ending"
    status, body = call(patch, {"tenantId": tenant}, body={"action": "keep"})
    assert body["billing"]["endsAt"] is None
    _set_billing(aws, tenant, terms="trial")
    status, body = call(patch, {"tenantId": tenant}, body={"action": "cancel", "offboardAtEnd": False})
    assert body["billing"]["endsAt"] == end.isoformat() and body["billing"]["offboardAtEnd"] is False
    call(patch, {"tenantId": tenant}, body={"action": "keep"})
    status, body = call(patch, {"tenantId": tenant}, body={"action": "convert"})
    assert status == 200 and body["billing"]["terms"] == "subscription"
    status, body = call(patch, {"tenantId": tenant}, body={"action": "cancel_now"})
    assert status == 200 and body["billing"]["endsAt"] == today.isoformat()


def test_collection_preference_and_card(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    patch = "PATCH /platform/tenants/{tenantId}/billing/subscription"
    # before any agreement: the operator picks Invoice (pay within 30 days)
    status, body = call(patch, {"tenantId": tenant}, body={"action": "collection", "collectionPreference": "invoice"})
    assert status == 200 and body["billing"]["collectionPreference"] == "invoice" and body["billing"]["daysUntilDue"] == 30
    status, body = call(patch, {"tenantId": tenant}, body={"action": "collection", "collectionPreference": "cash"})
    assert status == 400
    status, body = call("POST /platform/tenants/{tenantId}/billing/card-link", {"tenantId": tenant}, body={})
    assert status == 200 and body["url"].startswith("https://checkout.stripe.com/")
    session = next(c for c in stripe["calls"] if c[1] == "/checkout/sessions")
    assert session[2]["mode"] == "setup" and session[3].startswith(f"card-link-{tenant}-")
    # The restaurant opens the link: back to Booqy Admin's Abonnemang, not the console (audit 168).
    assert session[2]["success_url"] == "https://app.example.se/installningar?kort=klart"
    assert session[2]["cancel_url"] == "https://app.example.se/installningar?kort=avbrutet"
    _start(tenant)
    status, body = call(patch, {"tenantId": tenant}, body={"action": "use_card"})
    assert status == 409 and body["error"] == "no_card"
    stripe["card"] = "pm_card1"
    status, body = call(patch, {"tenantId": tenant}, body={"action": "use_card"})
    b = body["billing"]
    assert status == 200 and b["collectionPreference"] == "card" and b["collectionMethod"] == "charge_automatically"
    assert b["hasCard"] and b["cardLast4"] == "4242"


def test_offboarding_ends_the_agreement_today(finance, stripe, aws, tenant):
    from app.billing import _today
    _activate(aws, tenant)
    _start(tenant)
    status, body = call("POST /platform/tenants/{tenantId}/offboard", {"tenantId": tenant}, body={"confirmSlug": "pizzeria-roma"})
    assert status == 202 and body["subscription"]["endsAt"] == _today().isoformat()


# ------------------------------------------------------------ invoicing in advance
def test_first_month_pro_rata_on_the_start_day_then_every_first(finance, stripe, aws, tenant):
    """test-pizza's case: an agreement from 25 Nov, no card: 25 to 30 Nov
    (6/30) on 25 Nov, emailed with 10 days; December in full on 1 Dec."""
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-11-25", terms="trial")
    assert run_invoicing("invoicing", today=date(2026, 11, 24))["invoices"] == []
    preview = run_invoicing("invoicing", dry_run=True, today=date(2026, 11, 25))
    assert preview["invoices"][0]["feeSek"] == Decimal("198.00") and stripe["oneoff"] == []
    out = run_invoicing("invoicing", today=date(2026, 11, 25))
    (made,) = out["invoices"]
    assert made["feeSek"] == Decimal("198.00") and made["kind"] == "advance" and made["delivery"] == "sent"
    assert made["period"] == "25 nov till 30 nov 2026" and made["collectionMethod"] == "send_invoice"
    params = stripe["oneoff"][0]
    assert params["collection_method"] == "send_invoice" and params["days_until_due"] == 10
    assert params["pending_invoice_items_behavior"] == "exclude" and params["metadata[periodStart]"] == "2026-11-25"
    assert params["metadata[kind]"] == "advance" and stripe["calls"][-0]
    (item,) = _items_of(stripe, "in_made_1")
    assert item["amount"] == 19800 and item["tax_rates[0]"] == "txr_vat25"
    assert item["description"] == "Booqy Starter, 25 nov till 30 nov 2026 (6 av 30 dagar)"
    assert stripe["sent"] == ["in_made_1"]
    b = _profile(aws, tenant)["billing"]
    assert b["paidThrough"] == "2026-11-30" and b["cycle"] == "advance"
    # the same day again, and the rest of the month: nothing new
    assert run_invoicing("invoicing", today=date(2026, 11, 25))["invoices"] == []
    assert run_invoicing("invoicing", today=date(2026, 11, 30))["invoices"] == []
    dec = run_invoicing("invoicing", today=date(2026, 12, 1))["invoices"]
    assert [(i["periodStart"], i["feeSek"]) for i in dec] == [("2026-12-01", Decimal("990.00"))]
    assert run_invoicing("invoicing", today=date(2026, 12, 2))["invoices"] == []
    assert len(stripe["oneoff"]) == 2
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    assert [i["month"] for i in body["invoices"]] == ["2026-12", "2026-11"] or len(body["invoices"]) == 2


def test_compliance_fields_on_every_invoice(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-12-01")
    run_invoicing("invoicing", today=date(2026, 12, 1))
    params = stripe["oneoff"][0]
    assert params["custom_fields[0][name]"] == "Org.nr" and params["custom_fields[0][value]"] == "559999-0001"
    assert params["custom_fields[1][name]"] == "Säte" and params["custom_fields[2][value]"] == "Godkänd för F-skatt"
    assert params["footer"] == "Booqy AB, Exempelgatan 1, 111 11 Stockholm, Momsreg.nr SE559999000101"
    assert params["account_tax_ids[0]"] == "txi_booqy"
    created = [c for c in stripe["calls"] if c[1] == "/tax_ids"]
    assert len(created) == 1 and created[0][2]["owner[type]"] == "self"
    run_invoicing("invoicing", today=date(2027, 1, 1))
    assert len([c for c in stripe["calls"] if c[1] == "/tax_ids"]) == 1               # created once
    assert stripe["customers"]["cus_test1"]["preferred_locales[0]"] == "sv"


def test_prod_refuses_to_invoice_without_the_seller_details(finance, stripe, aws, tenant, monkeypatch):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-12-01")
    monkeypatch.setenv("BILLING_SELLER_JSON", "{}")
    monkeypatch.setenv("ENVIRONMENT", "prod")
    try:
        out = run_invoicing("invoicing", today=date(2026, 12, 1))
    finally:
        monkeypatch.setenv("ENVIRONMENT", "dev")
    assert out["invoices"] == [] and "company details are missing" in out["errors"][0]["error"]
    assert _profile(aws, tenant)["billing"].get("paidThrough") is None                # tried again tomorrow


def test_card_on_file_is_charged_automatically_else_an_emailed_invoice(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-12-01")
    stripe["card"] = "pm_card1"
    out = run_invoicing("invoicing", today=date(2026, 12, 1))
    assert out["invoices"][0]["delivery"] == "charged" and stripe["paid"] == ["in_made_1"] and stripe["sent"] == []
    params = stripe["oneoff"][0]
    assert params["collection_method"] == "charge_automatically" and "days_until_due" not in params
    finalize = next(c for c in stripe["calls"] if c[1].endswith("/finalize"))
    assert finalize[2] == {"auto_advance": "true"} and finalize[3] == "finalize-in_made_1"   # Smart Retries
    # a declined card: the invoice stays open, Stripe retries; nothing is emailed by us
    stripe["pay_fails"] = True
    out = run_invoicing("invoicing", today=date(2027, 1, 1))
    assert out["invoices"][0]["delivery"].startswith("not charged (Stripe retries)")
    # the operator chooses Invoice (pay within 30 days)
    call("PATCH /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
         body={"action": "collection", "collectionPreference": "invoice"})
    run_invoicing("invoicing", today=date(2027, 2, 1))
    assert stripe["oneoff"][2]["collection_method"] == "send_invoice" and stripe["oneoff"][2]["days_until_due"] == 30


def test_an_end_date_inside_the_month_is_pro_rata_and_ends_the_agreement(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant, startDate="2026-12-01", terms="trial")
    _set_billing(aws, tenant, endsAt="2027-01-10", offboardAtEnd=True)
    run_invoicing("invoicing", today=date(2026, 12, 1))
    jan = run_invoicing("invoicing", today=date(2027, 1, 1))["invoices"]
    assert [(i["periodEnd"], i["feeSek"], i["final"]) for i in jan] == [("2027-01-10", Decimal("319.35"), True)]
    assert _profile(aws, tenant)["billing"]["status"] == "active"                     # still running to the 10th
    run_invoicing("invoicing", today=date(2027, 1, 11))
    assert _profile(aws, tenant)["billing"]["status"] == "ended"
    out = handler({"financeTask": "dunning"}, None)
    assert out["offboarded"] == ["Pizzeria Roma"]
    assert run_invoicing("invoicing", today=date(2027, 3, 1))["invoices"] == []


def test_a_month_with_nothing_to_pay_makes_no_invoice(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-12-01", priceSek=0)
    _set_billing(aws, tenant, priceHistory=[{"from": "2026-12-01", "monthlySek": 0, "planName": "Starter"}])
    out = run_invoicing("invoicing", today=date(2026, 12, 1))
    assert out["invoices"] == [] and len(out["skipped"]) == 1 and stripe["oneoff"] == []
    assert _profile(aws, tenant)["billing"]["paidThrough"] == "2026-12-31"


def test_a_rerun_after_a_stopped_run_never_bills_twice(finance, stripe, aws, tenant):
    """Stripe has the invoice but the ledger and the profile were never
    written (the run stopped): a rerun, even after Stripe's 24 h idempotency
    window, finds it instead of making another."""
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-12-01")
    first = run_invoicing("invoicing", today=date(2026, 12, 1))
    assert len(first["invoices"]) == 1 and len(stripe["oneoff"]) == 1 and len(stripe["items"]) == 1
    _set_billing(aws, tenant, paidThrough=None)
    for row in finance.scan()["Items"]:
        if row["SK"].startswith("INVOICE#"):
            finance.delete_item(Key={"PK": row["PK"], "SK": row["SK"]})
    stripe["keys"].clear()                                                            # 24 hours later
    stripe["sent"].clear()
    again = run_invoicing("invoicing", today=date(2026, 12, 2))
    assert len(again["invoices"]) == 1 and again["invoices"][0]["invoiceId"] == "in_made_1"
    assert len(stripe["oneoff"]) == 1 and len(stripe["items"]) == 1
    assert _profile(aws, tenant)["billing"]["paidThrough"] == "2026-12-31"


def test_a_draft_left_by_a_stopped_run_gets_its_lines_once(finance, stripe, aws, tenant, monkeypatch):
    from datetime import date
    from app import billing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-12-01")
    real = billing.stripe_request

    def stop_at_finalize(method, path, params=None, **kw):
        if path.endswith("/finalize"):
            raise billing.ApiError(503, "stripe_unavailable", "network")
        return real(method, path, params, **kw)
    monkeypatch.setattr(billing, "stripe_request", stop_at_finalize)
    assert billing.run_invoicing("invoicing", today=date(2026, 12, 1))["errors"]
    monkeypatch.setattr(billing, "stripe_request", real)
    stripe["keys"].clear()
    out = billing.run_invoicing("invoicing", today=date(2026, 12, 2))
    assert len(out["invoices"]) == 1 and len(stripe["oneoff"]) == 1 and len(stripe["items"]) == 1
    assert out["invoices"][0]["feeSek"] == Decimal("990.00")


def test_no_invoice_without_the_vat_rate(finance, stripe, aws, tenant, monkeypatch):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-12-01")
    monkeypatch.setenv("BILLING_TAX_RATE_ID", "")
    out = run_invoicing("invoicing", today=date(2026, 12, 1))
    assert out["invoices"] == [] and "VAT rate isn't set up" in out["errors"][0]["error"] and stripe["oneoff"] == []


def test_a_run_out_of_time_leaves_the_rest_to_the_next_daily_run(finance, stripe, aws, tenant):
    import time as clock
    from datetime import date
    from app.billing import run_invoicing
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant, startDate="2026-09-01")
    out = run_invoicing("invoicing", today=date(2026, 12, 1), deadline=clock.monotonic() - 1)
    assert out["invoices"] == [] and out["unfinished"][0]["name"] == "Pizzeria Roma" and stripe["oneoff"] == []

    class Ctx:
        def get_remaining_time_in_millis(self):
            return 10_000
    out = handler({"financeTask": "invoice"}, Ctx())
    assert out["invoices"] == [] and len(out["unfinished"]) == 1
    out = handler({"financeTask": "invoice", "dryRun": True}, None)
    assert out["dryRun"] is True and out["invoices"][0]["periodStart"] == "2026-09-01" and stripe["oneoff"] == []


def test_a_catch_up_bills_each_missed_month_once(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-09-10")
    out = run_invoicing("invoicing", today=date(2026, 11, 5))
    assert [(i["periodStart"], i["feeSek"]) for i in out["invoices"]] == [
        ("2026-09-10", Decimal("693.00")), ("2026-10-01", Decimal("990.00")), ("2026-11-01", Decimal("990.00"))]
    assert run_invoicing("invoicing", today=date(2026, 11, 6))["invoices"] == []


def test_a_free_period_ending_mid_month_is_invoiced_from_the_first_paid_day(finance, stripe, aws, tenant, mails):
    """Free with an agreement running: the months are 0 kr; the switch on
    20 Dec moves paidThrough back and the stub 20 to 31 Dec is invoiced at
    once, at the price after Free set by the operator."""
    from datetime import date
    from app import billing
    _activate(aws, tenant)
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant},
         body={"planId": "free", "free": {"until": None, "thenPlanId": "starter"}, "priceSek": 1240})
    _start(tenant, startDate="2026-12-01")
    _set_billing(aws, tenant, priceHistory=[{"from": "2026-12-01", "monthlySek": 0, "planName": "Free", "exact": True}],
                 freeUntil="2026-12-19", freeNoticeFor="2026-12-19")
    assert billing.run_invoicing("invoicing", today=date(2026, 12, 1))["invoices"] == []
    assert _profile(aws, tenant)["billing"]["paidThrough"] == "2026-12-31"
    out = billing.free_step(_profile(aws, tenant), date(2026, 12, 20), "dunning")
    assert out["switched"] and _profile(aws, tenant)["planId"] == "starter"
    assert _profile(aws, tenant)["billing"]["paidThrough"] == "2026-12-19"
    run = billing.run_invoicing("invoicing", today=date(2026, 12, 20))
    # 12 of 31 days at 1240 kr
    assert [(i["periodStart"], i["feeSek"]) for i in run["invoices"]] == [("2026-12-20", Decimal("480.00"))]
    jan = billing.run_invoicing("invoicing", today=date(2027, 1, 1))["invoices"]
    assert jan[0]["feeSek"] == Decimal("1240.00")


def test_days_paid_at_a_price_are_never_invoiced_again(finance, stripe, aws, tenant):
    """Paid for December, then onto Free and off again in December: the
    days already paid are not charged twice."""
    from datetime import date
    from app import billing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-12-01")
    billing.run_invoicing("invoicing", today=date(2026, 12, 1))
    profile = _profile(aws, tenant)
    billing.after_plan_change(tenant, profile, billing.plan_of(profile), "op", exact=True, on=date(2026, 12, 21))
    assert _profile(aws, tenant)["billing"]["paidThrough"] == "2026-12-31"
    assert billing.run_invoicing("invoicing", today=date(2026, 12, 21))["invoices"] == []


# ------------------------------------------------------------ the switch from the old cycle
def _legacy(aws, tenant_id, **fields):
    _set_billing(aws, tenant_id, cycle=None, paidThrough=None, **fields)
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant_id}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="REMOVE billing.#c, billing.paidThrough", ExpressionAttributeNames={"#c": "cycle"})


def test_switch_closing_invoice_has_no_gap_and_no_overlap(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant, startDate="2026-08-01")
    _legacy(aws, tenant, lastInvoicedPeriodEnd="2026-10-24",
            priceHistory=[{"from": "2026-08-01", "monthlySek": 990, "planName": "Starter"}])
    # the one-shot task: dry run first (the default), nothing written
    out = handler({"financeTask": "migrate_to_advance"}, None)
    assert out["dryRun"] is True and out["invoices"][0]["period"] == "25 okt till 30 nov 2026" and stripe["oneoff"] == []
    out = handler({"financeTask": "migrate_to_advance", "dryRun": False}, None) if False else \
        run_invoicing("migrate_to_advance", today=date(2026, 11, 14), closing_only=True)
    (closing,) = out["invoices"]
    # 25 to 31 Oct (7 of 31 days) plus November in full
    assert closing["kind"] == "closing" and closing["feeSek"] == Decimal("1213.55")
    lines = _items_of(stripe, "in_made_1")
    assert [(i["amount"], i["metadata[segment]"]) for i in lines] == [(22355, "2026-10-25"), (99000, "2026-11-01")]
    assert stripe["oneoff"][0]["metadata[kind]"] == "closing" and "avslutande" in stripe["oneoff"][0]["description"]
    b = _profile(aws, tenant)["billing"]
    assert b["cycle"] == "advance" and b["paidThrough"] == "2026-11-30" and b["lastInvoicedPeriodEnd"] == "2026-10-24"
    # rerun: nothing; the rest of November: nothing; 1 Dec: December
    assert run_invoicing("migrate_to_advance", today=date(2026, 11, 14), closing_only=True)["invoices"] == []
    assert run_invoicing("invoicing", today=date(2026, 11, 30))["invoices"] == []
    dec = run_invoicing("invoicing", today=date(2026, 12, 1))["invoices"]
    assert [(i["periodStart"], i["feeSek"]) for i in dec] == [("2026-12-01", Decimal("990.00"))]
    assert len(stripe["oneoff"]) == 2


def test_switch_of_an_agreement_never_invoiced_goes_straight_to_advance(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-11-25")
    _legacy(aws, tenant)
    out = run_invoicing("migrate_to_advance", today=date(2026, 11, 14), closing_only=True)
    assert out["invoices"] == [] and out["switched"][0]["closing"] is None
    assert _profile(aws, tenant)["billing"]["cycle"] == "advance"
    assert run_invoicing("invoicing", today=date(2026, 11, 25))["invoices"][0]["feeSek"] == Decimal("198.00")


def test_a_paying_customer_pays_the_same_per_month_after_the_switch(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant, startDate="2026-01-01", priceSek=1490)
    _legacy(aws, tenant, lastInvoicedPeriodEnd="2026-11-24",
            priceHistory=[{"from": "2026-01-01", "monthlySek": 1490, "planName": "Starter"}])
    closing = run_invoicing("invoicing", today=date(2026, 11, 25))["invoices"][0]
    assert closing["feeSek"] == Decimal("298.00")                                    # 25 to 30 Nov: 6/30 x 1490
    months = [run_invoicing("invoicing", today=date(2026 + (m > 12), (m - 1) % 12 + 1, 1))["invoices"][0]["feeSek"]
              for m in (12, 13, 14)]
    assert months == [Decimal("1490.00")] * 3


def test_a_paid_legacy_subscription_continues_from_its_paid_period(finance, stripe, aws, tenant):
    """A legacy subscription that collected its current period (10 Nov to
    10 Dec): advance billing starts the day after, never from its start."""
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant)
    _set_billing(aws, tenant, subscriptionId="sub_paid", status="active", startedAt="2026-06-10T10:00:00Z", mrrSek=990,
                 startsAt="2026-06-10")
    start, end = (int(datetime(2026, 11, 10, 10, tzinfo=timezone.utc).timestamp()),
                  int(datetime(2026, 12, 10, 10, tzinfo=timezone.utc).timestamp()))
    stripe["subs"]["sub_paid"] = {"id": "sub_paid", "status": "active", "items": {"data": [
        {"current_period_start": start, "current_period_end": end}]}}
    out = run_invoicing("invoicing", today=date(2026, 11, 14))
    assert out["migrated"][0]["paidThrough"] == "2026-12-09" and out["invoices"] == []
    b = _profile(aws, tenant)["billing"]
    assert b["cycle"] == "advance" and b["paidThrough"] == "2026-12-09" and b["startsAt"] == "2026-06-10"
    assert run_invoicing("invoicing", today=date(2026, 12, 1))["invoices"] == []
    (dec,) = run_invoicing("invoicing", today=date(2026, 12, 10))["invoices"]
    assert (dec["periodStart"], dec["periodEnd"]) == ("2026-12-10", "2026-12-31")


def test_legacy_stripe_subscription_is_moved(finance, stripe, aws, tenant):
    from datetime import date
    from app.billing import run_invoicing
    _activate(aws, tenant)
    _start(tenant)
    _set_billing(aws, tenant, subscriptionId="sub_legacy", status="active", startedAt="2026-11-10T10:00:00Z", mrrSek=990)
    stripe["subs"]["sub_legacy"] = {"id": "sub_legacy", "status": "active", "items": {"data": []}}
    stripe["invoices"] = [{"id": "in_adv", "status": "open", "customer": "cus_test1", "subscription": "sub_legacy"}]
    out = run_invoicing("invoicing", today=date(2026, 11, 14))
    assert out["migrated"][0]["voided"] == ["in_adv"] and stripe["subs"]["sub_legacy"]["status"] == "canceled"
    # its open invoice was voided: the period it was for is invoiced again, once
    assert out["invoices"][0]["periodStart"] == "2026-11-10"
    assert _profile(aws, tenant)["billing"]["cycle"] == "advance"


# ------------------------------------------------------------ the billing customer
def test_prefill_from_the_connected_account_and_sync_on_change(finance, stripe, aws, tenant):
    from app.billing import sync_customer
    _activate(aws, tenant)
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="REMOVE legalName, address, ownerEmail, contactEmail SET stripe = :s",
                           ExpressionAttributeValues={":s": {"M": {"accountId": {"S": "acct_1"},
                                                                   "detailsSubmitted": {"BOOL": True}}}})
    stripe["account"] = {"id": "acct_1", "email": "ekonomi@roma.se",
                         "company": {"name": "Roma Krog AB", "address": {"line1": "Krogvägen 2", "postal_code": "222 33",
                                                                         "city": "Malmö", "country": "SE"}}}
    _start(tenant)
    customer = stripe["customers"]["cus_test1"]
    assert customer["name"] == "Roma Krog AB" and customer["email"] == "ekonomi@roma.se"
    assert customer["address[city]"] == "Malmö" and customer["address[line1]"] == "Krogvägen 2"
    assert not sync_customer(tenant, _profile(aws, tenant))                           # nothing changed
    # the operator sets the billing email; the VAT number changes
    status, _b = call("PATCH /platform/tenants/{tenantId}", {"tenantId": tenant},
                      body={"billingEmail": "faktura@roma.se", "vatNumber": "SE556677889901"})
    assert status == 200
    assert sync_customer(tenant, _profile(aws, tenant))
    assert stripe["customers"]["cus_test1"]["email"] == "faktura@roma.se"
    sync = [c for c in stripe["calls"] if c[1] == "/customers/cus_test1" and c[0] == "POST"]
    assert all(c[3].startswith(f"customer-sync-{tenant}-") for c in sync)


def test_a_vat_number_that_failed_to_register_is_tried_again(finance, stripe, aws, tenant, monkeypatch):
    from app import billing
    from app.billing import sync_customer
    from app.core import ApiError
    _activate(aws, tenant)
    _start(tenant)
    real, fails = billing.stripe_request, {"n": 1}

    def flaky(method, path, params=None, **kw):
        if path.endswith("/tax_ids") and method == "POST" and fails["n"]:
            fails["n"] -= 1
            raise ApiError(502, "stripe_unavailable", "Stripe is down")
        return real(method, path, params, **kw)
    monkeypatch.setattr(billing, "stripe_request", flaky)
    status, _b = call("PATCH /platform/tenants/{tenantId}", {"tenantId": tenant}, body={"vatNumber": "SE559988776601"})
    assert status == 200
    assert sync_customer(tenant, _profile(aws, tenant))
    assert _profile(aws, tenant)["billing"].get("customerVat") != "SE559988776601"
    # the next run: the VAT number again (the rest is unchanged)
    assert sync_customer(tenant, _profile(aws, tenant))
    b = _profile(aws, tenant)["billing"]
    assert b["customerVat"] == "SE559988776601" and b["customerTaxId"] == "txi_SE559988776601"
    assert not sync_customer(tenant, _profile(aws, tenant))


def test_line_periods_are_stockholm_days():
    from datetime import date
    from app.billing import _ts
    from zoneinfo import ZoneInfo
    sthlm = ZoneInfo("Europe/Stockholm")
    start, end = datetime.fromtimestamp(_ts(date(2026, 12, 1)), sthlm), datetime.fromtimestamp(_ts(date(2026, 12, 31), True), sthlm)
    assert (start.date(), start.hour, start.minute) == (date(2026, 12, 1), 0, 0)
    assert (end.date(), end.hour, end.minute, end.second) == (date(2026, 12, 31), 23, 59, 59)
    summer = datetime.fromtimestamp(_ts(date(2026, 7, 31), True), sthlm)            # CEST
    assert (summer.date(), summer.hour) == (date(2026, 7, 31), 23)


# ------------------------------------------------------------ late payment
def test_reminders_at_3_7_14_and_a_final_notice_at_30(finance, stripe, aws, tenant, mails, ops):
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _accept_terms(aws, tenant)
    _ledger(finance, tenant, "in_a", status="open", dueDate=_ago(2))       # not yet
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(3))       # step 3
    _ledger(finance, tenant, "in_c", status="open", dueDate=_ago(16))      # job was down: one email, step 14
    _ledger(finance, tenant, "in_d", status="open", dueDate=_ago(31), collectionMethod="charge_automatically")
    out = handler({"financeTask": "dunning"}, None)
    subjects = sorted(m[1] for m in mails)
    assert subjects == ["Påminnelse: faktura F-b från Booqy", "Påminnelse: faktura F-c från Booqy",
                        "Sista påminnelse: faktura F-d från Booqy"]
    by = {m[1].split("faktura ")[1].split(" ")[0]: m for m in mails}
    assert by["F-b"][0] == "owner@roma.se" and "https://invoice.stripe.com/in_b" in by["F-b"][2]
    assert "påminnelseavgift på 60 kr" in by["F-b"][2] and "förseningsersättning" not in by["F-b"][2]
    assert "förseningsersättning på 390 kr" in by["F-c"][2]
    assert "försökt dra beloppet från ert kort" in by["F-d"][2] and "sista påminnelse" in by["F-d"][2]
    assert "\u2013" not in "".join(m[2] for m in mails) and "\u2014" not in "".join(m[2] for m in mails)
    assert _row(finance, tenant, "in_b")["customerReminder3At"]
    c = _row(finance, tenant, "in_c")
    assert c["customerReminder3At"] and c["customerReminder7At"] and c["customerReminder14At"] and c["remindersSent"] == 1
    assert "customerReminder3At" not in _row(finance, tenant, "in_a")
    assert len(out["reminded"]) == 3
    # the next day: nothing again
    mails.clear()
    handler({"financeTask": "dunning"}, None)
    assert mails == []


def test_operators_get_each_step_once_and_the_daily_summary(finance, stripe, aws, tenant, mails, ops):
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(3))
    _ledger(finance, tenant, "in_c", status="open", dueDate=_ago(30))
    out = handler({"financeTask": "dunning"}, None)
    steps = [s for s, _m in ops if "overdue invoice(s)" not in s]
    assert sorted(steps) == sorted([f"[dev] Booqy: Pizzeria Roma invoice F-b 3 days overdue",
                                    f"[dev] Booqy: Pizzeria Roma invoice F-c 30 days overdue FINAL NOTICE"])
    message = dict(ops)[next(s for s in steps if "F-b" in s)]
    assert "Amount due: 1 237,50 kr incl. VAT" in message and "Due date: " + _ago(3)[:10] in message
    assert f"https://ops.example.se/tenants/{tenant}?tab=billing" in message and "Days overdue: 3" in message
    summary = [m for s, m in ops if "2 overdue invoice(s)" in s]
    assert len(summary) == 1 and "F-c" in summary[0] and "F-b" in summary[0]
    assert out["overdue"] == 2 and out["overdueSummarySent"] is True
    # a rerun the same day: no step twice, no second summary
    ops.clear()
    handler({"financeTask": "dunning"}, None)
    assert ops == []
    # a later step goes out once
    _ledger(finance, tenant, "in_e", status="open", dueDate=_ago(7), opsReminder3At=_ago(4), customerReminder3At=_ago(4),
            reminderFeeAt=_ago(4), reminderFeeSek=Decimal(60))
    handler({"financeTask": "dunning"}, None)
    assert [s for s, _m in ops] == ["[dev] Booqy: Pizzeria Roma invoice F-e 7 days overdue"]


def test_no_summary_without_an_overdue_invoice_and_a_failed_send_is_retried(finance, stripe, aws, tenant, mails, ops):
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    handler({"financeTask": "dunning"}, None)
    assert ops == []
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(3))
    ops.append("FAIL")                                                               # SNS throttles the first one
    handler({"financeTask": "dunning"}, None)
    assert "opsReminder3At" not in _row(finance, tenant, "in_b")
    ops.clear()
    from app import billing
    from datetime import date
    billing.ops_reminder(_profile(aws, tenant), _row(finance, tenant, "in_b"), 3, 3)
    assert len(ops) == 1 and _row(finance, tenant, "in_b")["opsReminder3At"]
    assert billing.ops_reminder(_profile(aws, tenant), _row(finance, tenant, "in_b"), 3, 3) is False
    assert isinstance(date.today(), date)


def test_reminder_fee_60_then_forseningsersattning_390_on_separate_fee_invoices(finance, stripe, aws, tenant, mails, ops):
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _accept_terms(aws, tenant)
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(3))
    handler({"financeTask": "dunning"}, None)
    (fee,) = _fee_invoices(stripe)
    assert fee["collection_method"] == "send_invoice" and fee["pending_invoice_items_behavior"] == "exclude"
    assert fee["metadata[invoiceId]"] == "in_b" and fee["metadata[step]"] == "reminder" and fee["footer"]
    (item,) = _items_of(stripe, next(i for i, p in stripe["made"].items() if p["metadata"].get("step") == "reminder"))
    assert item["amount"] == 6000 and "tax_rates[0]" not in item and "Påminnelseavgift" in item["description"]
    # four days later: step 7, the förseningsersättning less the reminder fee
    finance.update_item(Key={"PK": f"TENANT#{tenant}", "SK": "INVOICE#2026-10-01#in_b"},
                        UpdateExpression="SET dueDate = :d", ExpressionAttributeValues={":d": _ago(7)})
    handler({"financeTask": "dunning"}, None)
    fees = _fee_invoices(stripe)
    assert [f["metadata[step]"] for f in fees] == ["reminder", "late_fee"]
    late_id = next(i for i, p in stripe["made"].items() if p["metadata"].get("step") == "late_fee")
    (late,) = _items_of(stripe, late_id)
    assert late["amount"] == 39000 and "4 a § lagen (1981:739)" in late["description"] and "tax_rates[0]" not in late
    row = _row(finance, tenant, "in_b")
    assert row["reminderFeeSek"] == 60 and row["lateFeeSek"] == 390
    # never again for this invoice, however late
    finance.update_item(Key={"PK": f"TENANT#{tenant}", "SK": "INVOICE#2026-10-01#in_b"},
                        UpdateExpression="SET dueDate = :d", ExpressionAttributeValues={":d": _ago(40)})
    handler({"financeTask": "dunning"}, None)
    handler({"financeTask": "dunning"}, None)
    assert [f["metadata[step]"] for f in _fee_invoices(stripe)] == ["reminder", "late_fee"]
    # the fee invoices themselves get no fees
    assert not any(f.get("metadata[invoiceId]", "").startswith("in_made") for f in _fee_invoices(stripe))


def test_no_reminder_fee_unless_agreed_before_the_invoice(finance, stripe, aws, tenant, mails, ops):
    """2 § lagen (1981:739): a reminder fee only when agreed when the debt
    arose; the förseningsersättning (the law itself) is then 450 kr."""
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(3))
    handler({"financeTask": "dunning"}, None)
    (mail,) = mails
    assert "påminnelseavgift" not in mail[2].lower() and _fee_invoices(stripe) == []
    assert "reminderFeeAt" not in _row(finance, tenant, "in_b")
    # accepted after the invoice was created: still no reminder fee for it
    _accept_terms(aws, tenant, at="2026-10-15T10:00:00Z")
    finance.update_item(Key={"PK": f"TENANT#{tenant}", "SK": "INVOICE#2026-10-01#in_b"},
                        UpdateExpression="SET dueDate = :d", ExpressionAttributeValues={":d": _ago(7)})
    mails.clear()
    handler({"financeTask": "dunning"}, None)
    (fee,) = _fee_invoices(stripe)
    assert fee["metadata[step]"] == "late_fee"
    (item,) = _items_of(stripe, next(i for i, p in stripe["made"].items() if p["metadata"].get("step") == "late_fee"))
    assert item["amount"] == 45000
    (mail,) = mails
    assert "förseningsersättning på 450 kr på en separat faktura" in mail[2] and "minus" not in mail[2]
    assert "påminnelseavgift" not in mail[2].lower()
    # an older terms version (before the fee) does not count either
    from app.billing import reminder_fee_agreed
    row = {"createdAt": "2026-12-01T00:00:00Z"}
    assert not reminder_fee_agreed({"terms": {"version": "2026-10-v3", "acceptedAt": "2026-10-01T00:00:00Z"}}, row)
    assert reminder_fee_agreed({"terms": {"version": "2026-11-v1", "acceptedAt": "2026-11-20T00:00:00Z"}}, row)
    assert reminder_fee_agreed({"terms": {"version": "2027-01-v2", "acceptedAt": "2026-12-01T00:00:00Z"}}, row)
    assert not reminder_fee_agreed({}, row)


def test_fees_never_exceed_450_kr_when_the_reminder_fee_fails(finance, stripe, aws, tenant, mails, ops, monkeypatch):
    """4 a §: the reminder fee and the förseningsersättning together at most
    450 kr, also when the 60 kr invoice fails on the run the 450 kr is due."""
    from app import billing
    from app.core import ApiError
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _accept_terms(aws, tenant)
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(7))
    real = billing._fee_invoice
    failing = {"reminder": 1}

    def flaky(customer_id, tenant_id, row, step, lines, actor):
        if failing.get(step):
            failing[step] -= 1
            raise ApiError(502, "stripe_unavailable", "Stripe is down")
        return real(customer_id, tenant_id, row, step, lines, actor)
    monkeypatch.setattr(billing, "_fee_invoice", flaky)
    out = handler({"financeTask": "dunning"}, None)
    assert any("reminder fee FAILED" in f for f in out["fees"])
    assert _fee_invoices(stripe) == []                                               # no 450 kr on its own
    row = _row(finance, tenant, "in_b")
    assert "lateFeeAdded" not in row and "reminderFeeAt" not in row and row["customerReminder7At"]
    handler({"financeTask": "dunning"}, None)
    amounts = sorted(i["amount"] for f in stripe["made"].values() if f["metadata"].get("kind") == "fees"
                     for i in _items_of(stripe, f["id"]))
    assert amounts == [6000, 39000]                                                  # 60 + 390 = 450
    handler({"financeTask": "dunning"}, None)
    assert len(_fee_invoices(stripe)) == 2


def test_no_reminder_fee_after_the_forseningsersattning(finance, stripe, aws, tenant, mails, ops):
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _accept_terms(aws, tenant)
    # the 450 kr went out (an older run), the reminder fee never did
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(8), customerReminder3At=_ago(5),
            customerReminder7At=_ago(1), lateFeeAdded=_ago(1), lateFeeSek=Decimal(450))
    handler({"financeTask": "dunning"}, None)
    assert _fee_invoices(stripe) == [] and "reminderFeeAt" not in _row(finance, tenant, "in_b")


def test_a_card_invoice_has_no_due_date_and_is_late_from_its_charge(finance, stripe, aws, tenant, mails, ops):
    """Stripe leaves due_date empty on charge_automatically invoices: the
    day it was finalized (charged) is the due date, for the restaurant's
    reminders, the operators' steps, the summary and the console."""
    from app import billing
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _accept_terms(aws, tenant)
    _ledger(finance, tenant, "in_c", status="open", collectionMethod="charge_automatically", finalizedAt=_ago(7))
    out = handler({"financeTask": "dunning"}, None)
    (mail,) = mails
    assert mail[1] == "Påminnelse: faktura F-c från Booqy" and "försökt dra beloppet från ert kort" in mail[2]
    assert "förseningsersättning på 390 kr" in mail[2]
    steps = [s for s, _m in ops if "overdue invoice(s)" not in s]
    assert steps == ["[dev] Booqy: Pizzeria Roma invoice F-c 7 days overdue"]
    message = dict(ops)[steps[0]]
    assert "Due date: " + _ago(7)[:10] in message and "card (Stripe retries)" in message
    assert out["overdue"] == 1 and out["overdueSummarySent"] is True
    assert sorted(f["metadata[step]"] for f in _fee_invoices(stripe)) == ["late_fee", "reminder"]
    # the console: days late, the past-due status and the Payments list
    (inv,) = [i for i in billing.list_invoices(tenant) if i["invoiceId"] == "in_c"]
    assert inv["daysLate"] == 7
    status, body = call("GET /platform/finance/invoices", query={"from": "2026-01-01", "to": "2026-12-31", "status": "overdue"})
    assert status == 200 and [r["invoiceId"] for r in body["invoices"]] == ["in_c"] and body["summary"]["overdue"] == 1
    # a new card invoice from Stripe: its row gets the finalized day as the due date
    now = int(time.time())
    row = billing._invoice_row(tenant, {"id": "in_x", "status": "open", "collection_method": "charge_automatically",
                                        "due_date": None, "created": now, "status_transitions": {"finalized_at": now}})
    assert row["dueDate"] == billing._iso(now)
    emailed = billing._invoice_row(tenant, {"id": "in_y", "status": "open", "collection_method": "send_invoice",
                                            "due_date": now + 86400, "created": now, "status_transitions": {"finalized_at": now}})
    assert emailed["dueDate"] == billing._iso(now + 86400)


def test_an_uncollectible_invoice_is_still_reminded_and_listed(finance, stripe, aws, tenant, mails, ops):
    """Stripe marks a card invoice uncollectible after its last retry; it is
    still owed (and payable), so it stays in the reminders and the lists."""
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _ledger(finance, tenant, "in_u", status="uncollectible", collectionMethod="charge_automatically",
            finalizedAt=_ago(14), dueDate=_ago(14))
    stripe["remote"] = {"in_u": {"id": "in_u", "status": "uncollectible"}}
    out = handler({"financeTask": "dunning"}, None)
    assert [m[1] for m in mails] == ["Påminnelse: faktura F-u från Booqy"]
    assert [s for s, _m in ops if "overdue invoice(s)" not in s] == ["[dev] Booqy: Pizzeria Roma invoice F-u 14 days overdue"]
    assert out["overdue"] == 1
    status, body = call("GET /platform/finance/invoices", query={"from": "2026-01-01", "to": "2026-12-31", "status": "overdue"})
    assert [r["invoiceId"] for r in body["invoices"]] == ["in_u"]


def test_450_kr_once_when_there_is_no_reminder_fee(finance, stripe, aws, tenant, mails, monkeypatch):
    from app.handler import handler
    monkeypatch.setenv("BILLING_REMINDER_FEE_SEK", "0")
    _activate(aws, tenant)
    _start(tenant)
    _ledger(finance, tenant, "in_b", status="open", dueDate=_ago(9))
    handler({"financeTask": "dunning"}, None)
    handler({"financeTask": "dunning"}, None)
    (fee,) = _fee_invoices(stripe)
    late_id = next(i for i, p in stripe["made"].items() if p["metadata"].get("kind") == "fees")
    assert [i["amount"] for i in _items_of(stripe, late_id)] == [45000] and fee["metadata[step]"] == "late_fee"


def test_interest_days_times_rate_once_a_late_invoice_is_paid(finance, stripe, aws, tenant, mails):
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _ledger(finance, tenant, "in_a", status="paid", dueDate="2026-09-30T00:00:00Z", paidAt="2026-10-20T10:00:00Z",
            amountPaidSek=Decimal("1237.50"), amountRemainingSek=Decimal(0))     # 20 days late
    _ledger(finance, tenant, "in_b", status="paid", dueDate="2026-09-30T00:00:00Z", paidAt="2026-09-28T10:00:00Z",
            amountPaidSek=Decimal("1237.50"), amountRemainingSek=Decimal(0))     # on time
    out = handler({"financeTask": "dunning"}, None)
    # 1237.50 x 10 % x 20 / 365 = 6.78 kr
    assert out["interest"] == ["Pizzeria Roma F-a (6.78 kr for 20 days)"]
    (fee,) = _fee_invoices(stripe)
    assert fee["metadata[step]"] == "interest"
    (item,) = _items_of(stripe, next(iter(stripe["made"])))
    assert item["amount"] == 678 and "Dröjsmålsränta 10 % per år (räntelagen 6 §) i 20 dagar" in item["description"]
    assert _row(finance, tenant, "in_a")["interestSek"] == Decimal("6.78")
    assert "interestAdded" not in _row(finance, tenant, "in_b")
    handler({"financeTask": "dunning"}, None)
    assert len(_fee_invoices(stripe)) == 1


def test_interest_maths():
    from app.billing import interest_sek
    assert interest_sek(Decimal("1237.50"), 20, reference_pct=Decimal("2"), margin_pct=Decimal("8")) == Decimal("6.78")
    assert interest_sek(Decimal("1000"), 365, reference_pct=Decimal("2.5"), margin_pct=Decimal("8")) == Decimal("105.00")
    assert interest_sek(Decimal("1000"), 0, reference_pct=Decimal("2"), margin_pct=Decimal("8")) == Decimal("0.00")


def test_nothing_is_suspended_automatically(finance, stripe, aws, tenant, mails):
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _set_billing(aws, tenant, pastDueSince="2020-01-01T00:00:00Z")
    _ledger(finance, tenant, "in_a", status="open", dueDate=_ago(45))
    out = handler({"financeTask": "dunning"}, None)
    assert out["suspended"] == [] and out["limitDays"] == 0 and _profile(aws, tenant)["status"] == "active"


def test_suspension_still_works_when_an_operator_turns_it_on(finance, stripe, aws, tenant, mails, monkeypatch):
    from app.handler import handler
    monkeypatch.setenv("BILLING_SUSPEND_AFTER_DAYS", "14")
    _activate(aws, tenant)
    _start(tenant)
    _set_billing(aws, tenant, pastDueSince=_ago(15))
    out = handler({"financeTask": "dunning"}, None)
    assert out["suspended"] == ["Pizzeria Roma (15 days past due)"]
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="REMOVE billing.pastDueSince")
    assert handler({"financeTask": "dunning"}, None)["resumed"] == ["Pizzeria Roma"]


def test_a_paid_invoice_whose_webhook_was_missed_gets_no_reminder(finance, stripe, aws, tenant, mails, ops):
    from app.handler import handler
    _activate(aws, tenant)
    _start(tenant)
    _ledger(finance, tenant, "in_a", status="open", dueDate=_ago(15))
    stripe["remote"] = {"in_a": {"id": "in_a", "object": "invoice", "status": "paid", "customer": "cus_test1",
                                 "created": int(datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp()), "total": 123750,
                                 "total_excluding_tax": 99000, "tax": 24750, "amount_paid": 123750, "amount_remaining": 0,
                                 "currency": "sek", "status_transitions": {"paid_at": int(time.time())}}}
    handler({"financeTask": "dunning"}, None)
    assert mails == [] and [s for s, _m in ops if "overdue" in s] == [] and _row(finance, tenant, "in_a")["status"] == "paid"


def test_manual_reminder_route(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    _start(tenant)
    _ledger(finance, tenant, "in_a", status="open", dueDate=_ago(1))
    _ledger(finance, tenant, "in_p", status="paid", dueDate=_ago(1), paidAt=_ago(0))
    status, body = call("POST /platform/tenants/{tenantId}/billing/invoices/{invoiceId}/remind",
                        {"tenantId": tenant, "invoiceId": "in_a"}, body={}, actor="ops@booqy.se")
    assert status == 200 and body == {"remindersSent": 1} and stripe["sent"] == ["in_a"]
    status, body = call("POST /platform/tenants/{tenantId}/billing/invoices/{invoiceId}/remind",
                        {"tenantId": tenant, "invoiceId": "in_p"}, body={})
    assert status == 409 and body["error"] == "not_open"
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    by_id = {i["invoiceId"]: i for i in body["invoices"]}
    assert by_id["in_a"]["daysLate"] == 1 and by_id["in_a"]["month"] == "2026-10" and by_id["in_a"]["kind"] == "advance"


def test_a_try_out_runs_from_the_agreements_start(finance, stripe, aws, tenant):
    from app.billing import _today
    _activate(aws, tenant)
    later = (_today() + timedelta(days=40)).isoformat()
    b = _start(tenant, startDate=later, terms="trial")
    assert b["termsSince"] == f"{later}T00:00:00Z" and b["status"] == "scheduled" and b["nextInvoice"]["date"] == later


def test_a_catalog_price_change_also_applies_from_the_next_month(finance, stripe, aws, tenant, mails):
    from app.billing import _billing, _today, invoice_plan, next_period, period_of
    from app.handler import handler
    _activate(aws, tenant)
    start, end = period_of(_today())
    _start(tenant, startDate=(start - timedelta(days=40)).isoformat())
    handler({"financeTask": "dunning"}, None)
    assert len(_billing(_profile(aws, tenant))["priceHistory"]) == 1
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": "PLAN#starter"}, "SK": {"S": "PLAN"}},
                           UpdateExpression="SET priceSek = :s", ExpressionAttributeValues={":s": {"N": "1290"}})
    handler({"financeTask": "dunning"}, None)
    profile = _profile(aws, tenant)
    assert [h["monthlySek"] for h in _billing(profile)["priceHistory"]] == [990, 1290]
    assert invoice_plan(profile, start, end)["monthlySek"] == 990
    assert invoice_plan(profile, *next_period(end))["monthlySek"] == 1290


def test_card_link_falls_back_to_the_console_without_admin_app_url(finance, stripe, aws, tenant, monkeypatch):
    """Until infrastructure sets ADMIN_APP_URL the card link keeps its old return pages (audit 168)."""
    monkeypatch.delenv("ADMIN_APP_URL", raising=False)
    status, body = call("POST /platform/tenants/{tenantId}/billing/card-link", {"tenantId": tenant}, body={})
    assert status == 200, body
    session = next(c for c in stripe["calls"] if c[1] == "/checkout/sessions")
    assert session[2]["success_url"] == f"https://ops.example.se/tenants/{tenant}?tab=billing&card=added"
    assert session[2]["cancel_url"] == f"https://ops.example.se/tenants/{tenant}?tab=billing"
