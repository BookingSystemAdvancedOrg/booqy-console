"""The Free plan: no monthly charge, Growth's features, a default three
months from the start (or no end date), a notice to the owner and the
operators 14 days before the first paid day, then the plan chosen for
afterwards. Stripe is a fake; DynamoDB and Cognito are moto."""
from datetime import date, timedelta
from decimal import Decimal

import pytest

from conftest import NEW_TENANT, call
from test_billing import _activate, _profile, _set_billing, finance, stripe  # noqa: F401 (fixtures)


@pytest.fixture
def mails(monkeypatch):
    from app import mail
    sent = []
    monkeypatch.setattr(mail, "_send_one", lambda to, subject, body, template: sent.append((to, subject, body)))
    return sent


def _today():
    from app.website import stockholm_today
    return stockholm_today()


def _add_months(day, months):
    from app.tenants import add_months
    return add_months(day, months)


def test_plans_list_free_with_growths_features_and_no_price(aws):
    status, body = call("GET /platform/plans")
    assert status == 200
    by_id = {p["planId"]: p for p in body["plans"]}
    assert set(by_id) == {"starter", "growth", "free"} and list(by_id)[-1] == "free"
    free, growth = by_id["free"], by_id["growth"]
    assert free["name"] == "Free" and free["priceSek"] == 0 and free["free"] is True and growth["free"] is False
    assert free["features"] == growth["features"] and free["maxLocations"] == growth["maxLocations"]
    assert free["limits"] == growth["limits"]
    assert body["freeDefaultUntil"] == _add_months(_today(), 3).isoformat()


def test_setting_free_defaults_to_three_months_then_starter(finance, stripe, aws, tenant):
    _activate(aws, tenant)
    status, body = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "free"})
    assert status == 200, body
    t = body["tenant"]
    growth = _profile(aws, tenant)
    assert t["planId"] == "free" and t["entitlements"]["maxLocations"] == 3
    assert t["entitlements"]["features"]["catering"] is True                      # Growth's features
    until = _add_months(_today(), 3).isoformat()
    assert growth["billing"]["freeUntil"] == until and growth["billing"]["freeThenPlanId"] == "starter"
    status, body = call("GET /platform/tenants/{tenantId}/billing", {"tenantId": tenant})
    free = body["billing"]["free"]
    assert free["until"] == until and free["thenPlanId"] == "starter" and free["thenPlanName"] == "Starter"
    assert free["switchOn"] == (date.fromisoformat(until) + timedelta(days=1)).isoformat()
    assert body["billing"]["monthlySek"] == 0 and body["billing"]["plan"]["free"] is True
    status, body = call("GET /platform/tenants")
    assert next(r for r in body["tenants"] if r["tenantId"] == tenant)["freeUntil"] == until


def test_free_entitlements_equal_growth(aws, tenant):
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "growth"})
    growth = _profile(aws, tenant)["entitlements"]
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "free", "free": {"until": None}})
    free = _profile(aws, tenant)["entitlements"]
    assert {k: free[k] for k in ("maxLocations", "features", "limits")} == {k: growth[k] for k in ("maxLocations", "features", "limits")}


def test_no_end_date_stays_free(finance, stripe, aws, tenant, mails):
    from app.billing import free_step
    _activate(aws, tenant)
    status, body = call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant},
                        body={"planId": "free", "free": {"until": None, "thenPlanId": "growth"}})
    assert status == 200, body
    profile = _profile(aws, tenant)
    assert "freeUntil" not in profile["billing"] and profile["billing"]["freeThenPlanId"] == "growth"
    out = free_step(profile, _today() + timedelta(days=3650), "dunning")
    assert out == {"notice": None, "switched": None, "failed": None} and mails == []
    assert _profile(aws, tenant)["planId"] == "free"
    status, body = call("GET /platform/tenants")
    assert next(r for r in body["tenants"] if r["tenantId"] == tenant)["freeUntil"] is None


def test_free_validation(aws, tenant):
    path = {"tenantId": tenant}
    status, body = call("PUT /platform/tenants/{tenantId}/plan", path,
                        body={"planId": "free", "free": {"until": "2020-01-01", "thenPlanId": "free"}})
    assert status == 400 and set(body["fields"]) == {"free.until", "free.thenPlanId"}
    status, body = call("PUT /platform/tenants/{tenantId}/plan", path, body={"planId": "free", "free": {"until": "soon"}})
    assert status == 400 and "free.until" in body["fields"]


def test_create_customer_on_free(finance, stripe, aws):
    until = (_today() + timedelta(days=30)).isoformat()
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "planId": "free",
                                                        "free": {"until": until, "thenPlanId": "growth"},
                                                        "billing": {"terms": "subscription", "priceSek": 500}})
    assert status == 202, body
    profile = _profile(aws, body["tenantId"])
    assert profile["planId"] == "free" and profile["entitlements"]["maxLocations"] == 3
    assert profile["billing"]["freeUntil"] == until and profile["billing"]["freeThenPlanId"] == "growth"
    assert "priceSek" not in profile["billing"]                                   # Free has no price of its own
    # left out: three months, then Starter
    status, body = call("POST /platform/tenants", body={**NEW_TENANT, "slug": "roma-2", "ownerEmail": "o2@roma.se",
                                                        "planId": "free"})
    assert status == 202
    b = _profile(aws, body["tenantId"])["billing"]
    assert b["freeUntil"] == _add_months(_today(), 3).isoformat() and b["freeThenPlanId"] == "starter"


def test_free_has_no_charge(finance, stripe, aws, tenant):
    from app.billing import run_invoicing
    _activate(aws, tenant)
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "free", "free": {"until": None}})
    status, body = call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant},
                        body={"startDate": "2026-08-01", "priceSek": 700})
    assert status == 201, body
    assert body["billing"]["monthlySek"] == 0 and body["billing"]["priceSek"] is None
    out = run_invoicing("invoicing", dry_run=False, today=date(2026, 10, 25))
    assert out["invoices"] == [] and len(out["skipped"]) == 3
    assert stripe["items"] == [] and stripe["oneoff"] == [] and stripe["paid"] == []
    assert _profile(aws, tenant)["billing"]["lastInvoicedPeriodEnd"] == "2026-10-24"


def test_the_period_free_ends_in_is_charged_pro_rata_from_the_first_paid_day(finance, stripe, aws, tenant):
    from app.billing import invoice_plan
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={"startDate": "2026-08-01"})
    _set_billing(aws, tenant, priceHistory=[{"from": "2026-08-01", "monthlySek": 0, "planName": "Free"},
                                            {"from": "2026-09-10", "monthlySek": 990, "planName": "Starter", "exact": True},
                                            {"from": "2026-09-15", "monthlySek": 1990, "planName": "Growth"}])
    plan = invoice_plan(_profile(aws, tenant), date(2026, 8, 25), date(2026, 9, 24))
    # 10 to 24 Sep at Starter's price; the later (not exact) change waits for the next period
    assert plan["feeSek"] == Decimal("479.03") and plan["billedDays"] == 15 and plan["activeDays"] == 31
    assert plan["feeText"] == "Booqy Starter, 25 aug till 24 sep 2026 (15 av 31 dagar)"
    after = invoice_plan(_profile(aws, tenant), date(2026, 9, 25), date(2026, 10, 24))
    assert after["feeSek"] == Decimal("1990.00") and after["feeText"].startswith("Booqy Growth,")


def test_notice_once_fourteen_days_before_the_first_paid_day(finance, stripe, aws, tenant, mails):
    from app.handler import handler
    _activate(aws, tenant)
    until = _today() + timedelta(days=13)                                         # first paid day in 14 days
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant},
         body={"planId": "free", "free": {"until": until.isoformat(), "thenPlanId": "starter"}})
    out = handler({"financeTask": "dunning"}, None)
    assert len(out["freeNotices"]) == 1 and out["freeSwitched"] == [] and out["failed"] == []
    assert len(mails) == 1
    to, subject, body = mails[0]
    assert to == "owner@roma.se" and subject.startswith("Er gratisperiod hos Booqy slutar ")
    assert "Booqy Starter, 990 kr per månad exklusive moms" in body and "SMS ingår" in body
    assert "–" not in body + subject and "—" not in body + subject
    assert _profile(aws, tenant)["billing"]["freeNoticeFor"] == until.isoformat()
    # the next days: no second email, no switch yet
    out = handler({"financeTask": "dunning"}, None)
    assert out["freeNotices"] == [] and len(mails) == 1 and _profile(aws, tenant)["planId"] == "free"
    # extended: a new end date gets its own notice when its time comes
    later = _today() + timedelta(days=40)
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant},
         body={"planId": "free", "free": {"until": later.isoformat(), "thenPlanId": "starter"}})
    assert "freeNoticeFor" not in _profile(aws, tenant)["billing"]
    out = handler({"financeTask": "dunning"}, None)
    assert out["freeNotices"] == [] and len(mails) == 1


def test_no_notice_before_the_window(finance, stripe, aws, tenant, mails):
    from app.billing import free_step
    _activate(aws, tenant)
    until = _today() + timedelta(days=20)
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "free", "free": {"until": until.isoformat()}})
    assert free_step(_profile(aws, tenant), _today(), "dunning")["notice"] is None and mails == []


def test_a_failed_notice_is_tried_again_the_next_day(finance, stripe, aws, tenant, monkeypatch):
    from app import mail
    from app.billing import free_step
    from app.core import ApiError
    _activate(aws, tenant)
    until = _today() + timedelta(days=5)
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "free", "free": {"until": until.isoformat()}})

    def broken(*_a, **_k):
        raise ApiError(500, "ses", "SES said no")
    monkeypatch.setattr(mail, "_send_one", broken)
    out = free_step(_profile(aws, tenant), _today(), "dunning")
    assert out["notice"] is None and "SES said no" in out["failed"]
    assert "freeNoticeFor" not in _profile(aws, tenant)["billing"]


def test_switch_to_the_chosen_plan_once(finance, stripe, aws, tenant, mails):
    from app.billing import free_step
    from app.handler import handler
    _activate(aws, tenant)
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant},
         body={"planId": "free", "free": {"until": _today().isoformat(), "thenPlanId": "growth"}})
    _set_billing(aws, tenant, freeUntil=(_today() - timedelta(days=1)).isoformat(), freeNoticeFor="x")
    stale = _profile(aws, tenant)
    out = handler({"financeTask": "dunning"}, None)
    assert len(out["freeSwitched"]) == 1 and out["failed"] == [], out
    assert "now Growth" in out["freeSwitched"][0] and "agreement started" in out["freeSwitched"][0]
    profile = _profile(aws, tenant)
    assert profile["planId"] == "growth" and profile["entitlements"]["maxLocations"] == 3
    assert not any(k.startswith("free") for k in profile["billing"])
    b = profile["billing"]
    assert b["status"] == "active" and b["startsAt"] == _today().isoformat()
    assert [(h["monthlySek"], h["planName"]) for h in b["priceHistory"]] == [(1990, "Growth")]
    # a re-run, even with the old profile in hand, never switches again
    assert free_step(stale, _today(), "dunning")["switched"] is None
    assert handler({"financeTask": "dunning"}, None)["freeSwitched"] == []
    assert _profile(aws, tenant)["planId"] == "growth"


def test_switch_to_starter_by_default_with_a_running_agreement(finance, stripe, aws, tenant):
    from app.billing import free_step
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "free"})
    _set_billing(aws, tenant, freeUntil=(_today() - timedelta(days=1)).isoformat())
    out = free_step(_profile(aws, tenant), _today(), "dunning")
    assert "now Starter" in out["switched"] and "agreement started" not in out["switched"]
    profile = _profile(aws, tenant)
    assert profile["planId"] == "starter" and profile["entitlements"]["maxLocations"] == 1
    last = profile["billing"]["priceHistory"][-1]
    assert last["monthlySek"] == 990 and last["exact"] is True and last["from"] == _today().isoformat()


def test_paid_customers_are_untouched_by_the_free_step(finance, stripe, aws, tenant, mails):
    from app.handler import handler
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    before = _profile(aws, tenant)
    out = handler({"financeTask": "dunning"}, None)
    after = _profile(aws, tenant)
    assert out["freeNotices"] == [] and out["freeSwitched"] == [] and mails == []
    assert after["planId"] == "starter" and after["billing"]["priceHistory"] == before["billing"]["priceHistory"]
    assert not any(k.startswith("free") for k in after["billing"])


def test_free_counts_zero_mrr(finance, stripe, aws, tenant):
    from app.finance import _mrr
    _activate(aws, tenant)
    call("POST /platform/tenants/{tenantId}/billing/subscription", {"tenantId": tenant}, body={})
    assert _mrr(_profile(aws, tenant)) == Decimal("990.00")
    call("PUT /platform/tenants/{tenantId}/plan", {"tenantId": tenant}, body={"planId": "free"})
    assert _mrr(_profile(aws, tenant)) == Decimal("0.00")
