"""Refunds and credits of Booqy's own invoices (Billing tab): ownership,
the cap at what is left, idempotency (a repeated request never refunds
twice), one invoice failing without hiding the others, and the ledger
agreeing with platform-stripe-webhook (credit_note.created) so nothing
counts twice. Stripe is a fake; DynamoDB is moto."""
from decimal import Decimal

import boto3
import pytest

from conftest import NEW_TENANT, REGION, call
from test_billing import FINANCE_TABLE, finance  # noqa: F401 - the fixture

CUS = "cus_roma"
ROUTE = "POST /platform/tenants/{tenantId}/billing/credit-notes"


def _invoice(inv_id, *, status="paid", lines=(80_000, 20_000), paid_out_of_band=False, customer=CUS):
    ex = sum(lines)
    total = ex + sum(round(a * 0.25) for a in lines)
    return {"id": inv_id, "object": "invoice", "customer": customer, "status": status, "number": f"B-{inv_id[-3:]}",
            "created": 1_800_000_000, "total": total, "total_excluding_tax": ex, "tax": total - ex,
            "amount_paid": total if status == "paid" else 0, "amount_due": total,
            "amount_remaining": 0 if status == "paid" else total, "paid_out_of_band": paid_out_of_band,
            "post_payment_credit_notes_amount": 0, "pre_payment_credit_notes_amount": 0,
            "collection_method": "charge_automatically", "metadata": {"kind": "advance"},
            "status_transitions": {"finalized_at": 1_800_000_000,
                                   "paid_at": 1_800_000_100 if status == "paid" else None},
            "lines": {"data": [{"id": f"il_{inv_id}_{n}", "amount": a} for n, a in enumerate(lines)], "has_more": False}}


@pytest.fixture
def stripe(monkeypatch):
    """Invoices and credit notes: the preview rounds VAT per line like
    Stripe; a repeated idempotency key returns the first answer; Stripe
    refuses a note above what is left."""
    from app import billing
    state = {"invoices": {}, "notes": [], "keys": {}, "posts": 0, "fail": set()}

    def note_of(params):
        inv = state["invoices"][params["invoice"]]
        ex = tax = 0
        n = 0
        while f"lines[{n}][amount]" in params:
            amount = int(params[f"lines[{n}][amount]"])
            assert params[f"lines[{n}][type]"] == "invoice_line_item"
            assert params[f"lines[{n}][invoice_line_item]"].startswith(f"il_{inv['id']}_")
            ex, tax = ex + amount, tax + round(amount * 0.25)
            n += 1
        return {"object": "credit_note", "invoice": inv["id"], "customer": inv["customer"], "total": ex + tax,
                "subtotal": ex, "total_excluding_tax": ex, "created": 1_800_300_000}

    def fake(method, path, params=None, *, account=None, idempotency_key=None):
        params = dict(params or {})
        if method == "GET" and path.startswith("/invoices/"):
            inv_id = path.split("/")[2]
            if inv_id not in state["invoices"]:
                raise billing.ApiError(502, "stripe_error", "Stripe: No such invoice")
            return dict(state["invoices"][inv_id])
        if method == "GET" and path == "/credit_notes/preview":
            return note_of(params)
        if method == "GET" and path == "/credit_notes":
            return {"data": [n for n in state["notes"] if n["invoice"] == params["invoice"]]}
        if method == "POST" and path == "/credit_notes":
            if idempotency_key in state["keys"]:
                stored = state["keys"][idempotency_key]
                if isinstance(stored, Exception):   # Stripe keeps a failed answer under its key too
                    raise stored
                return stored
            if params["invoice"] in state["fail"]:
                state["keys"][idempotency_key] = billing.ApiError(502, "stripe_error", "Stripe: card_declined")
                raise state["keys"][idempotency_key]
            inv = state["invoices"][params["invoice"]]
            note = note_of(params)
            state["posts"] += 1
            left = (inv["amount_paid"] - inv["post_payment_credit_notes_amount"] if inv["status"] == "paid"
                    else inv["amount_remaining"])
            assert note["total"] <= left, "Stripe would refuse: more than left"
            refund = int(params.get("refund_amount") or 0)
            credit = int(params.get("credit_amount") or 0)
            if inv["status"] == "paid":
                assert refund + credit == note["total"]
                inv["post_payment_credit_notes_amount"] += note["total"]
            else:
                assert not refund and not credit
                inv["amount_remaining"] -= note["total"]
                inv["pre_payment_credit_notes_amount"] += note["total"]
            note.update({"id": f"cn_{len(state['notes']) + 1}", "number": f"B-CN-{len(state['notes']) + 1}",
                         "type": "post_payment" if inv["status"] == "paid" else "pre_payment",
                         "post_payment_amount": note["total"] if inv["status"] == "paid" else 0,
                         "refunds": [{"refund": "re_1", "amount_refunded": refund}] if refund else [],
                         "memo": params.get("memo"), "reason": params.get("reason"),
                         "metadata": {k[9:-1]: val for k, val in params.items() if k.startswith("metadata[")}})
            state["notes"].append(note)
            state["keys"][idempotency_key] = note
            return note
        raise AssertionError(f"unexpected Stripe call {method} {path}")

    monkeypatch.setattr(billing, "stripe_request", fake)
    return state


@pytest.fixture
def billed(finance, stripe, aws, tenant):  # noqa: F811 - the fixture
    """A customer with a paid card invoice (1 250 kr incl VAT), a second
    paid one, an open one and one paid outside Stripe, all in the ledger."""
    from app import billing
    aws["ddb"].update_item(TableName="dev-tenant", Key={"PK": {"S": f"TENANT#{tenant}"}, "SK": {"S": "PROFILE"}},
                           UpdateExpression="SET billing = :b",
                           ExpressionAttributeValues={":b": {"M": {"customerId": {"S": CUS}}}})
    for inv in (_invoice("in_paid1"), _invoice("in_paid2", lines=(10_000,)), _invoice("in_open1", status="open"),
                _invoice("in_oob1", paid_out_of_band=True), _invoice("in_other", customer="cus_someone_else")):
        stripe["invoices"][inv["id"]] = inv
        billing.record_invoice(tenant, inv)
    return tenant


def _post(tenant, body, **kw):
    return call(ROUTE, path={"tenantId": tenant}, body={"requestId": "req-1", "reason": "other", **body}, **kw)


def _invoices(tenant):
    status, body = call("GET /platform/tenants/{tenantId}/billing", path={"tenantId": tenant})
    assert status == 200
    return {i["invoiceId"]: i for i in body["invoices"]}


def _fin(pk, sk):
    return boto3.resource("dynamodb", region_name=REGION).Table(FINANCE_TABLE).get_item(
        Key={"PK": pk, "SK": sk}).get("Item") or {}


def _day_total(tenant, field):
    rows = boto3.resource("dynamodb", region_name=REGION).Table(FINANCE_TABLE).query(
        KeyConditionExpression="PK = :p AND begins_with(SK, :d)",
        ExpressionAttributeValues={":p": f"TENANT#{tenant}", ":d": "DAY#"})["Items"]
    return sum((Decimal(r.get(field) or 0) for r in rows), Decimal(0))


def test_operators_only(billed):
    status, _ = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 1}]}, groups="[support]")
    assert status == 403


def test_partial_refund_splits_vat_and_books_once(billed, stripe):
    status, body = _post(billed, {"method": "refund", "memo": "Two days closed",
                                  "items": [{"invoiceId": "in_paid1", "amountSek": "12.50"}]})
    assert status == 200, body
    [res] = body["results"]
    assert res["ok"] and res["totalSek"] == 12.5 and res["refundedSek"] == 12.5 and res["creditedSek"] == 0
    note = stripe["notes"][0]
    assert note["subtotal"] == 1_000 and note["total"] == 1_250       # 10 kr + 25 % VAT
    assert note["metadata"]["booqyMethod"] == "refund" and note["memo"] == "Two days closed"
    inv = _invoices(billed)["in_paid1"]
    assert inv["refundedSek"] == 12.5 and inv["creditableSek"] == 1237.5
    assert _day_total(billed, "refundedSek") == Decimal("10.00")       # collected falls by the ex-VAT part
    assert _day_total(billed, "creditedSek") == Decimal("10.00")


def test_everything_left_and_never_more(billed, stripe):
    _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 250}]})
    status, body = _post(billed, {"requestId": "req-2", "method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 1000}]})
    assert body["results"][0]["ok"] and body["results"][0]["totalSek"] == 1000
    assert _invoices(billed)["in_paid1"]["creditableSek"] == 0
    status, body = _post(billed, {"requestId": "req-3", "method": "refund",
                                  "items": [{"invoiceId": "in_paid1", "amountSek": 1}]})
    assert body["results"][0] == {"invoiceId": "in_paid1", "ok": False, "error": "nothing_left",
                                  "message": "Nothing is left to refund or credit on this invoice."}


def test_more_than_left_is_refused_before_stripe(billed, stripe):
    status, body = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": "1250.01"}]})
    assert body["results"][0]["error"] == "more_than_left" and body["results"][0]["leftSek"] == 1250
    assert stripe["posts"] == 0


def test_repeated_request_refunds_once(billed, stripe):
    body = {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 100}]}
    _, first = _post(billed, body)
    _, again = _post(billed, body)          # double click, or a retry after a timeout
    assert first["results"][0]["creditNoteId"] == again["results"][0]["creditNoteId"]
    assert stripe["posts"] == 1 and len(stripe["notes"]) == 1
    assert _invoices(billed)["in_paid1"]["refundedSek"] == 100
    assert _day_total(billed, "refundedSek") == Decimal("80.00")
    audits = boto3.resource("dynamodb", region_name=REGION).Table("dev-tenant").query(
        KeyConditionExpression="PK = :p", ExpressionAttributeValues={":p": f"TENANT#{billed}"})["Items"]
    assert sum(1 for a in audits if a.get("action") == "invoice_refunded") == 1


def test_idempotency_key_carries_tenant_invoice_amount_and_request(billed, stripe):
    _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 100}]})
    _post(billed, {"requestId": "req-2", "method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 50}]})
    keys = sorted(stripe["keys"])
    assert keys == [f"cn-{billed}-in_paid1-10000-refund-req-1", f"cn-{billed}-in_paid1-5000-refund-req-2"]
    assert _invoices(billed)["in_paid1"]["refundedSek"] == 150


def test_concurrent_request_on_the_same_invoice_is_refused(billed, stripe):
    import time
    from app import billing
    billing.client("dynamodb").put_item(TableName=FINANCE_TABLE, Item={
        "PK": {"S": f"TENANT#{billed}"}, "SK": {"S": "CNLOCK#in_paid1"}, "requestId": {"S": "req-other"},
        "expiresAt": {"N": str(int(time.time()) + 60)}})
    _, body = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 1}]})
    assert body["results"][0]["error"] == "credit_in_progress" and stripe["posts"] == 0
    assert _fin(f"TENANT#{billed}", "CNLOCK#in_paid1")["requestId"] == "req-other"   # not ours to release


def test_ownership(billed, stripe, aws):
    _, body = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_other", "amountSek": 1},
                                                           {"invoiceId": "in_nope", "amountSek": 1}]})
    assert [r["error"] for r in body["results"]] == ["not_found", "not_found"]
    status, other = call("POST /platform/tenants", body={**NEW_TENANT, "name": "Annan", "slug": "annan-krog"})
    assert status == 202, other
    _, body = _post(other["tenantId"], {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 1}]})
    assert body["results"][0]["error"] == "not_found" and stripe["posts"] == 0


def test_partial_failure_is_visible(billed, stripe):
    stripe["fail"].add("in_paid2")
    _, body = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 10},
                                                           {"invoiceId": "in_paid2", "amountSek": 125},
                                                           {"invoiceId": "in_open1", "amountSek": 1}]})
    assert [r["ok"] for r in body["results"]] == [True, False, False]
    assert body["results"][1]["error"] == "stripe_error"
    assert body["results"][2]["error"] == "not_paid"
    assert body["ok"] == 1 and body["failed"] == 2 and body["refundedSek"] == 10
    assert _fin(f"TENANT#{billed}", "CNLOCK#in_paid2")["expiresAt"] == 0     # released after the failure
    stripe["fail"].clear()
    # the dialog retries a definite failure as a new attempt: Stripe would answer the same key with the stored error
    _, body = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid2", "amountSek": 125}]})
    assert body["results"][0]["error"] == "stripe_error"
    _, body = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid2", "amountSek": 125, "attempt": 1}]})
    assert body["results"][0]["ok"] and len(stripe["notes"]) == 2
    assert stripe["notes"][1]["metadata"]["booqyKey"] == f"cn-{billed}-in_paid2-12500-refund-req-1-a1"


def test_credit_paid_goes_to_balance_and_open_lowers_what_is_owed(billed, stripe):
    _, body = _post(billed, {"method": "credit", "reason": "order_change",
                             "items": [{"invoiceId": "in_paid2", "amountSek": 125}, {"invoiceId": "in_open1", "amountSek": 250}]})
    assert all(r["ok"] for r in body["results"]), body
    assert body["creditedSek"] == 375 and body["refundedSek"] == 0
    paid_note, open_note = stripe["notes"]
    assert paid_note["reason"] == "order_change"
    invs = _invoices(billed)
    assert invs["in_paid2"]["creditedSek"] == 125 and invs["in_paid2"]["refundedSek"] == 0
    assert invs["in_open1"]["creditedSek"] == 250 and invs["in_open1"]["amountRemainingSek"] == 1000
    assert invs["in_open1"]["creditableSek"] == 1000
    assert _day_total(billed, "refundedSek") == Decimal(0)


def test_paid_outside_stripe_can_only_be_credited(billed, stripe):
    _, body = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_oob1", "amountSek": 1}]})
    assert body["results"][0]["error"] == "paid_out_of_band"
    assert _invoices(billed)["in_oob1"]["refundable"] is False


def test_validation(billed):
    status, body = _post(billed, {"method": "cash", "reason": "because", "items": [
        {"invoiceId": "in_paid1", "amountSek": "1.234"}, {"invoiceId": "in_paid1"}, {"invoiceId": "x"},
        {"invoiceId": "in_paid2", "amountSek": 1, "attempt": -1}]})
    assert status == 400
    assert set(body["fields"]) == {"method", "reason", "items.0.amountSek", "items.1.invoiceId", "items.2.invoiceId",
                                   "items.3.attempt"}
    status, body = _post(billed, {"requestId": None, "method": "refund", "items": []})
    assert status == 400 and set(body["fields"]) == {"requestId", "items"}


def test_webhook_after_the_console_counts_nothing_twice(billed, stripe):
    """credit_note.created arrives after the console recorded the note: the
    same CREDIT# row and flags, so the day rows stay put."""
    from app import billing
    _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 125}]})
    before = (_day_total(billed, "creditedSek"), _day_total(billed, "refundedSek"))
    assert billing.record_credit_note(billed, stripe["notes"][0]) == []
    assert (_day_total(billed, "creditedSek"), _day_total(billed, "refundedSek")) == before == (
        Decimal("100.00"), Decimal("100.00"))


def test_finance_collected_is_net_of_refunds(billed, stripe):
    _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 250}]})
    status, body = call("GET /platform/finance/overview", query={"from": "2027-01-01", "to": "2027-01-31",
                                                                 "tenantId": billed})
    assert status == 200, body
    k = body["kpis"]
    # paid 1 000 + 100 + 1 000 (out of band) + 1 000 (in_other) ex VAT, 200 of it refunded
    assert k["collectedSek"] == 2900 and k["refundedSek"] == 200
    status, body = call("GET /platform/finance/invoices", query={"from": "2027-01-01", "to": "2027-01-31"})
    assert status == 200, body
    assert body["summary"]["collectedSek"] == 2900 and body["summary"]["refundedSek"] == 200


def test_amount_is_always_the_confirmed_one(billed, stripe):
    """No "everything left" without a figure: a ledger that understates
    what is left (a webhook row without postPaymentSek) must never let the
    api refund Stripe's larger figure."""
    status, body = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1"}]})
    assert status == 400 and set(body["fields"]) == {"items.0.amountSek"} and stripe["posts"] == 0


def test_webhook_row_without_post_payment_then_paid_refunds_only_what_was_confirmed(billed, stripe):
    from app import billing
    _post(billed, {"method": "credit", "items": [{"invoiceId": "in_open1", "amountSek": 250}]})
    tbl = boto3.resource("dynamodb", region_name=REGION).Table(FINANCE_TABLE)
    for r in tbl.query(KeyConditionExpression="PK = :p AND begins_with(SK, :c)",
                       ExpressionAttributeValues={":p": f"TENANT#{billed}", ":c": "CREDIT#"})["Items"]:
        tbl.update_item(Key={"PK": r["PK"], "SK": r["SK"]}, UpdateExpression="REMOVE postPaymentSek")
    inv = stripe["invoices"]["in_open1"]
    inv.update({"status": "paid", "amount_paid": inv["amount_remaining"], "amount_remaining": 0,
                "status_transitions": {**inv["status_transitions"], "paid_at": 1_800_400_000}})
    billing.record_invoice(billed, inv)
    shown = _invoices(billed)["in_open1"]["creditableSek"]
    assert shown == 750                      # an old row: the conservative figure
    _, body = _post(billed, {"requestId": "req-2", "method": "refund",
                             "items": [{"invoiceId": "in_open1", "amountSek": shown}]})
    assert body["results"][0]["ok"] and body["results"][0]["refundedSek"] == 750
    # the console met the row again and filled in what the note took from the payment
    assert billing.record_credit_note(billed, stripe["notes"][0]) == []
    assert _invoices(billed)["in_open1"]["creditableSek"] == 250


def _audits(tenant):
    rows = boto3.resource("dynamodb", region_name=REGION).Table("dev-tenant").query(
        KeyConditionExpression="PK = :p", ExpressionAttributeValues={":p": f"TENANT#{tenant}"})["Items"]
    return [a for a in rows if a.get("action") in ("invoice_refunded", "invoice_credited")]


def test_retry_after_a_failure_past_stripe_finds_the_note_and_audits_it(billed, stripe, monkeypatch):
    from app import billing
    real = billing.record_credit_note

    def boom(*a, **k):
        raise RuntimeError("ddb throttled")
    monkeypatch.setattr(billing, "record_credit_note", boom)
    _, first = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 1250}]})
    assert first["results"][0]["error"] == "internal_error" and stripe["posts"] == 1
    monkeypatch.setattr(billing, "record_credit_note", real)
    # the dialog retries a failed invoice with a new attempt (and the operator may even change the amount)
    _, again = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 1250, "attempt": 1}]})
    assert again["results"][0]["ok"] and again["results"][0]["creditNoteId"] == stripe["notes"][0]["id"]
    _, third = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 5, "attempt": 2}]})
    assert third["results"][0]["creditNoteId"] == stripe["notes"][0]["id"]
    assert stripe["posts"] == 1 and len(_audits(billed)) == 1
    assert _invoices(billed)["in_paid1"]["refundedSek"] == 1250


def test_audit_written_by_a_retry_when_the_first_audit_failed(billed, stripe, monkeypatch):
    from app import billing
    real = billing.write_audit
    monkeypatch.setattr(billing, "write_audit", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    _, first = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 100}]})
    assert first["results"][0]["error"] == "internal_error"
    monkeypatch.setattr(billing, "write_audit", real)
    _, again = _post(billed, {"method": "refund", "items": [{"invoiceId": "in_paid1", "amountSek": 100, "attempt": 1}]})
    assert again["results"][0]["ok"] and stripe["posts"] == 1 and len(_audits(billed)) == 1
