"""The Website page: booqy.se's cookieless statistics for any date range.

Reads the site-analytics table (infrastructure site-analytics/):
    AGG / DAY#<yyyy-mm-dd>    one day's aggregate (JSON in `stats`), written
                              every 15 minutes for today and yesterday
    JOB / latest              when the figures were last computed
    RAW#<day> / <ms>#...      raw hits (30 days): only the visitor hashes of
                              the last 30 minutes, for the live count

Every figure is a sum of day aggregates. Unique visitors are unique per day
(the salt behind the visitor hash changes every day by design), so a range's
visitors are the sum of the days' visitors. Days are Stockholm days.

GET /platform/website?from&to  ->  {enabled, period, previous, asOf, live,
    kpis, previousKpis, series, breakdowns, previousSources}
"""

import json
import time
from datetime import date, datetime, timedelta, timezone

from .core import ApiError, client, env, query_all

MAX_RANGE_DAYS = 400
LIVE_MINUTES = 30
TOP = 100
BREAKDOWNS = ("sources", "referrers", "campaigns", "contents", "terms", "landing", "pages", "countries", "regions",
              "cities", "devices", "browsers", "os", "languages")


def _table() -> str:
    return env("SITE_ANALYTICS_TABLE_NAME", "")


def _last_sunday(year: int, month: int) -> date:
    d = date(year, month + 1, 1) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def stockholm_today(now: datetime | None = None) -> date:
    """Europe/Stockholm without a tz database (the image has none): CEST from
    the last Sunday of March to the last Sunday of October, 01:00 UTC."""
    utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    start = datetime.combine(_last_sunday(utc.year, 3), datetime.min.time(), timezone.utc) + timedelta(hours=1)
    end = datetime.combine(_last_sunday(utc.year, 10), datetime.min.time(), timezone.utc) + timedelta(hours=1)
    return (utc + timedelta(hours=2 if start <= utc < end else 1)).date()


def _range(query: dict, today: date) -> tuple[date, date]:
    try:
        last = date.fromisoformat((query.get("to") or today.isoformat())[:10])
        first = date.fromisoformat((query.get("from") or (last - timedelta(days=29)).isoformat())[:10])
    except ValueError as e:
        raise ApiError(400, "validation_failed", "Dates must be yyyy-mm-dd", fields={"from": "yyyy-mm-dd"}) from e
    if first > last:
        first, last = last, first
    if (last - first).days >= MAX_RANGE_DAYS:
        raise ApiError(400, "validation_failed", f"At most {MAX_RANGE_DAYS} days at a time", fields={"to": "Too far"})
    return first, last


def merge(into: dict, add: dict) -> dict:
    """Deep sum of two aggregates: numbers add, lists add element-wise, maps merge."""
    for k, v in add.items():
        if isinstance(v, dict):
            merge(into.setdefault(k, {}), v)
        elif isinstance(v, list):
            cur = into.setdefault(k, [0] * len(v))
            for i, x in enumerate(v):
                cur[i] += x
        else:
            into[k] = into.get(k, 0) + v
    return into


def _ratio(a, b, scale=1.0, digits=1):
    return round(a * scale / b, digits) if b else None


def kpis(s: dict) -> dict:
    visits = s.get("visits", 0)
    return {
        "visitors": s.get("visitors", 0), "visits": visits, "pageviews": s.get("pageviews", 0),
        "conversions": s.get("conversions", 0), "convertedVisits": s.get("convertedVisits", 0),
        "conversionRate": _ratio(s.get("convertedVisits", 0), visits, 100, 2),
        "bounceRate": _ratio(s.get("bounces", 0), visits, 100),
        "avgEngagedSeconds": _ratio(s.get("engagedSeconds", 0), visits, 1, 0),
        "pagesPerVisit": _ratio(s.get("pageviews", 0), visits, 1, 2),
    }


def _rows(table: dict, top: int = TOP) -> list[dict]:
    """A breakdown as rows, biggest first: [{key, visits, conversions, bounces}] (pages: pageviews, avgSeconds)."""
    rows = []
    for key, v in table.items():
        if "pv" in v:
            rows.append({"key": key, "pageviews": v["pv"], "avgSeconds": _ratio(v.get("s", 0), v.get("n", 0), 1, 0)})
        else:
            rows.append({"key": key, "visits": v.get("v", 0), "conversions": v.get("c", 0), "bounces": v.get("b", 0)})
    rows.sort(key=lambda r: -(r.get("visits") if "visits" in r else r["pageviews"]))
    return rows[:top]


def _days(first: date, last: date) -> dict[str, dict]:
    items = query_all(TableName=_table(), KeyConditionExpression="PK = :pk AND SK BETWEEN :a AND :b",
                      ExpressionAttributeValues={":pk": {"S": "AGG"}, ":a": {"S": f"DAY#{first.isoformat()}"},
                                                 ":b": {"S": f"DAY#{last.isoformat()}"}})
    return {i["SK"][4:]: json.loads(i["stats"]) for i in items}


def live_visitors(today: date, now_ms: int | None = None) -> int:
    """Distinct visitor hashes in the raw hits of the last 30 minutes (today's and, just after midnight, yesterday's)."""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    since = f"{now_ms - LIVE_MINUTES * 60_000:013d}"
    seen = set()
    for day in (today - timedelta(days=1), today):
        for item in query_all(TableName=_table(), KeyConditionExpression="PK = :pk AND SK >= :since",
                              ExpressionAttributeValues={":pk": {"S": f"RAW#{day.isoformat()}"}, ":since": {"S": since}},
                              ProjectionExpression="v"):
            seen.add(item.get("v"))
    seen.discard(None)
    return len(seen)


def overview(req) -> tuple[int, dict]:
    if not _table():
        return 200, {"enabled": False}
    today = stockholm_today()
    first, last = _range(req.query or {}, today)
    n = (last - first).days + 1
    prev_last = first - timedelta(days=1)
    prev_first = prev_last - timedelta(days=n - 1)
    days = _days(prev_first, last)

    now: dict = {}
    before: dict = {}
    series = []
    for i in range(n):
        day = (first + timedelta(days=i)).isoformat()
        s = days.get(day, {})
        merge(now, s)
        series.append({"day": day, "visitors": s.get("visitors", 0), "visits": s.get("visits", 0),
                       "pageviews": s.get("pageviews", 0), "conversions": s.get("conversions", 0)})
    for i in range(n):
        merge(before, days.get((prev_first + timedelta(days=i)).isoformat(), {}))

    job = client("dynamodb").get_item(TableName=_table(), Key={"PK": {"S": "JOB"}, "SK": {"S": "latest"}}).get("Item")
    scroll = now.get("scroll", {})
    return 200, {
        "enabled": True,
        "period": {"from": first.isoformat(), "to": last.isoformat(), "days": n},
        "previous": {"from": prev_first.isoformat(), "to": prev_last.isoformat()},
        "asOf": job["asOf"]["S"] if job else None,
        "live": {"minutes": LIVE_MINUTES, "visitors": live_visitors(today)} if last >= today else None,
        "kpis": kpis(now),
        "previousKpis": kpis(before) if before else None,
        "series": series,
        "hours": now.get("hours", [0] * 24),
        "scroll": {band: scroll.get(band, 0) for band in ("0", "25", "50", "75", "100")},
        "events": {k: sorted(({"key": label, "count": c} for label, c in v.items()), key=lambda r: -r["count"])[:TOP]
                   for k, v in now.get("events", {}).items()},
        "breakdowns": {k: _rows(now.get(k, {})) for k in BREAKDOWNS},
        "previousSources": {r["key"]: r for r in _rows(before.get("sources", {}))},
    }
