import json
import os
from datetime import date, datetime, timedelta, timezone

import pytest

from conftest import REGION, call

TABLE = "dev-site-analytics"


def _stats(**over):
    s = {"visitors": 3, "visits": 4, "pageviews": 6, "conversions": 1, "convertedVisits": 1, "bounces": 2,
         "engagedSeconds": 200, "scroll": {"0": 0, "25": 1, "50": 1, "75": 0, "100": 2}, "hours": [0] * 23 + [4],
         "sources": {"search": {"v": 3, "c": 1, "b": 1}, "direct": {"v": 1, "c": 0, "b": 1}},
         "campaigns": {}, "pages": {"/": {"pv": 5, "s": 100, "n": 2}, "/demo": {"pv": 1, "s": 0, "n": 0}},
         "countries": {"SE": {"v": 4, "c": 1, "b": 2}}, "events": {"cta": {"/demo": 2}, "tab": {}}}
    s.update(over)
    return s


@pytest.fixture
def site(aws, monkeypatch):
    ddb = aws["ddb"]
    ddb.create_table(TableName=TABLE, BillingMode="PAY_PER_REQUEST",
                     AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"},
                                           {"AttributeName": "SK", "AttributeType": "S"}],
                     KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}])
    monkeypatch.setenv("SITE_ANALYTICS_TABLE_NAME", TABLE)
    from app import website
    monkeypatch.setattr(website, "stockholm_today", lambda now=None: date(2026, 10, 20))

    def day(d, **over):
        ddb.put_item(TableName=TABLE, Item={"PK": {"S": "AGG"}, "SK": {"S": f"DAY#{d}"},
                                            "stats": {"S": json.dumps(_stats(**over))}})
    return ddb, day


def test_disabled_without_a_table(aws, monkeypatch):
    monkeypatch.delenv("SITE_ANALYTICS_TABLE_NAME", raising=False)
    assert call("GET /platform/website") == (200, {"enabled": False})


def test_sums_the_range_and_the_previous_period(site):
    ddb, day = site
    day("2026-10-19")
    day("2026-10-20", visitors=5, visits=6, sources={"social": {"v": 6, "c": 0, "b": 6}})
    day("2026-10-17", visitors=1, visits=1)            # previous period (17-18)
    day("2026-10-10", visitors=99)                     # outside both
    status, body = call("GET /platform/website", query={"from": "2026-10-19", "to": "2026-10-20"})
    assert status == 200
    assert body["period"] == {"from": "2026-10-19", "to": "2026-10-20", "days": 2}
    assert body["previous"] == {"from": "2026-10-17", "to": "2026-10-18"}
    k = body["kpis"]
    assert (k["visitors"], k["visits"], k["pageviews"], k["conversions"]) == (8, 10, 12, 2)
    assert k["conversionRate"] == 20.0 and k["bounceRate"] == 40.0 and k["avgEngagedSeconds"] == 40
    assert body["previousKpis"]["visitors"] == 1
    assert [p["visitors"] for p in body["series"]] == [3, 5]
    sources = {r["key"]: r for r in body["breakdowns"]["sources"]}
    assert sources["social"]["visits"] == 6 and sources["search"]["visits"] == 3
    assert body["breakdowns"]["pages"][0] == {"key": "/", "pageviews": 10, "avgSeconds": 50}
    assert body["hours"][23] == 8
    assert body["scroll"]["100"] == 4
    assert body["events"]["cta"] == [{"key": "/demo", "count": 4}]
    assert body["previousSources"]["search"]["visits"] == 3


def test_live_counts_distinct_visitors_in_the_last_30_minutes(site):
    ddb, _ = site
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    for i, (v, ago) in enumerate((("a", 1), ("a", 2), ("b", 10), ("c", 45))):
        ddb.put_item(TableName=TABLE, Item={"PK": {"S": "RAW#2026-10-20"}, "SK": {"S": f"{now - ago * 60_000:013d}#{i}"},
                                            "v": {"S": v}})
    status, body = call("GET /platform/website", query={"from": "2026-10-14", "to": "2026-10-20"})
    assert body["live"] == {"minutes": 30, "visitors": 2}
    _, past = call("GET /platform/website", query={"from": "2026-09-01", "to": "2026-09-30"})
    assert past["live"] is None and past["previousKpis"] is None


def test_validation(site):
    assert call("GET /platform/website", query={"from": "x"})[0] == 400
    assert call("GET /platform/website", query={"from": "2024-01-01", "to": "2026-01-01"})[0] == 400
    assert call("GET /platform/website", groups="[]")[0] == 403


def test_stockholm_today_dst():
    from app.website import stockholm_today
    assert stockholm_today(datetime(2026, 10, 24, 22, 30, tzinfo=timezone.utc)) == date(2026, 10, 25)
    assert stockholm_today(datetime(2026, 10, 25, 22, 30, tzinfo=timezone.utc)) == date(2026, 10, 25)
    assert stockholm_today(datetime(2026, 7, 1, 21, 59, tzinfo=timezone.utc)) == date(2026, 7, 1)
    assert stockholm_today(datetime(2026, 7, 1, 22, 0, tzinfo=timezone.utc)) == date(2026, 7, 2)
