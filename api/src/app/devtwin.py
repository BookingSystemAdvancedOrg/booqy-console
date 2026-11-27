"""Dev twins (dev only, docs/DEV-TWINS.md).

Every real customer (born in the PROD console) has a twin in dev: the same
name and slug, owned by Booqy (owner login DEV_TWIN_OWNER_EMAIL with the
slug, never the restaurant's own email) and fully set up with test data, so
whoever builds the restaurant's website (BooqyCustomers/site-<slug>, dev
branch -> <slug>.dev.booqy.se) has a dev Booqy Admin and real data to test
against. Prod is the real restaurant; the twin is ours to change.

How a twin comes about:
  - prod's site-repo creates the customer's site and asks dev for its side
    through the dev account's booqy-sites-prod-link role (site.site_task
    "mirror"). Only name, slug and plan cross; dev creates or adopts the
    tenant and starts the seed below;
  - Booqy Console in dev, "Create or refresh dev twin" on a customer
    (POST /platform/tenants/{tenantId}/dev-twin).

When the restaurant finishes its Kom igång setup in prod, the twin copies the
restaurant's PUBLIC content from prod's public API (devtwin_content.py); the
same on demand with "Copy public content now". Rules (one way only, markers,
slug clashes, reserved slugs, separate deletes): BooqyCustomers/site-template
docs/DATA-RULES.md.

Every twin has every guest-facing feature in dev, whatever prod's plan is
(owner 2026-11-24): catering, marketing, gift cards, waitlist, events and
the phone assistant (TWIN_FEATURES, TWIN_LIMITS), set on the mirror, on every
plan change and by the seed's first step. Dev only; prod never has twins.

The seed sets up every Kom igång step through the admin's own functions,
invoked directly as an owner of the twin (application
shared/console_invoke.py, dev only): the DPA, location contact details,
opening hours and special days, booking rules, card guarantee and online
ordering, the menu (lunch, starters, mains, desserts, drinks), a published
and active table layout, catering (settings, dishes with allergens, a
package, a discount tier, test terms), gift cards, the waitlist (public
join), one published test event, fake seller details, a simulated printer,
a staff login, guest SMS switched on (a setting the developer sets stays), the Google profile skipped and the phone assistant on the
simulated number. The console's own routes do what only the console does
(owner login, location, printer, staff) and Stripe: the twin takes payments
with one fully onboarded TEST-mode connected account
(DEV_TWIN_STRIPE_ACCOUNT_ID). Fake data only: phone numbers in the PTS
fiction range, Testgatan 1, team addresses, a test org. number; a twin's
phone that is real (outside that range, or prod's) is replaced.

Idempotent: every step looks first and only adds what is missing (by name
for dishes and categories); a developer's changes to the twin stay. Four
steps also replace values: features (a feature that is off goes on),
details (contact data that is not fake), catering (switched back on when
off, only its empty settings filled in) and legal (the seller details until
they carry the test org. number; an email, phone or address that is not
fake). One seed per twin at a time (kick's conditional write; a run older
than STALE_MINUTES counts as dead). The run's progress is PROFILE.devTwin
(status queued, running, ready, partial, failed; one line per step)."""

import json
import re
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from botocore.exceptions import ClientError

from .core import (ApiError, client, env, location_table, log, now_iso, query_all, tenant_table,
                   to_ddb_value, user_table, write_audit)
from .tenants import get_profile, tkey

OPERATOR = "dev-twin"                       # who the twin's functions see (createdBy operator:dev-twin)
DEFAULT_OWNER_EMAIL = "aws+{slug}@ithjalparna.se"
ACTIVE_WAIT_SECONDS = 150                   # per run; then it hands itself the rest
MAX_RUNS = 4
LOCKED = ("offboarding", "offboarded", "purged")
STEPS = ("features", "owner", "notifications", "stripe", "location", "details", "menu", "layout", "catering", "giftCards", "waitlist",
         "events", "legal", "printers", "staff", "dpa", "google", "phone")
REFRESH_ALL_MAX = 50                        # twins one "Refresh all dev twins" queues
STALE_MINUTES = 10                          # a queued or running seed older than this died (Lambda max 300 s)
BUSY = ("queued", "running")
# The admin's functions keep a tenant row for 60 s per container (application
# shared/tenant.py TENANT_CACHE_SECONDS): after the features step turned a
# feature on, the guest steps wait this out once so a warm function never
# answers feature_not_in_plan.
FEATURES_SETTLE_SECONDS = 61
TIMEZONE = "Europe/Stockholm"               # create-location needs one; a legacy row without it gets this

# Every guest-facing feature, on for every twin in dev (owner 2026-11-24).
TWIN_FEATURES = ("reservations", "ordering", "catering", "marketing", "giftCards", "waitlist", "events", "phoneAgent")
TWIN_LIMITS = {"phoneAgentMinutesPerMonth": 100}

# --------------------------------------------------------------- test data
PHONE = "+46701740605"                      # PTS range reserved for fiction (070-174 06 05)
STAFF_PHONE = "+46701740606"
ADDRESS = "Testgatan 1, 111 22 Stockholm"
LUNCH_AND_DINNER = [{"opensAt": "11:00", "closesAt": "14:00"}, {"opensAt": "17:00", "closesAt": "22:00"}]
HOURS = {
    "monday": LUNCH_AND_DINNER, "tuesday": LUNCH_AND_DINNER, "wednesday": LUNCH_AND_DINNER,
    "thursday": LUNCH_AND_DINNER,
    "friday": [{"opensAt": "11:00", "closesAt": "14:00"}, {"opensAt": "17:00", "closesAt": "23:00"}],
    "saturday": [{"opensAt": "12:00", "closesAt": "23:00"}],
    "sunday": [{"opensAt": "12:00", "closesAt": "21:00"}],
}
BOOKING = {"bookingDurationHours": 2, "gracePeriodHours": 0.25, "maxPartySizeOnline": 8, "lunchUntil": "15:00"}
GUARANTEE = {"enabled": True, "minPartySize": 6, "noShowFeePerPerson": 200, "lateCancelFeePerPerson": 100,
             "cancelCutoffHours": 24}
ORDERING = {"enabled": True, "pickup": True, "prepMinutes": 20, "lastOrderMinutes": 15}
CATEGORIES = ("Dagens lunch", "Förrätter", "Varmrätter", "Efterrätter", "Drycker")
DISHES = (
    ("Dagens lunch", "Dagens fisk", "Ugnsbakad torsk med dillsås och kokt potatis.", 135),
    ("Dagens lunch", "Dagens kött", "Kalvfärsbiff med potatispuré, gräddsås och pressgurka.", 135),
    ("Dagens lunch", "Dagens vegetariska", "Halloumibiff med bulgur, rostade grönsaker och tzatziki.", 125),
    ("Förrätter", "Toast Skagen", "Handskalade räkor, majonnäs, dill och löjrom på smörstekt bröd.", 145),
    ("Förrätter", "Burrata", "Burrata med tomater, basilika och rostat surdegsbröd.", 135),
    ("Varmrätter", "Pannbiff med lök", "Pannbiff med stekt lök, gräddsås, potatis och lingon.", 215),
    ("Varmrätter", "Grillad lax", "Grillad lax med dillstuvad potatis och citron.", 245),
    ("Varmrätter", "Svamprisotto", "Krämig risotto med karljohansvamp och parmesan.", 195),
    ("Efterrätter", "Kladdkaka", "Kladdkaka med vispgrädde och hallon.", 95),
    ("Efterrätter", "Crème brûlée", "Vaniljkräm med bränt socker.", 105),
    ("Drycker", "Äppelmust", "Svensk äppelmust, 33 cl.", 45),
    ("Drycker", "Lättöl", "Ljus lager, 2,25 %, 33 cl.", 45),
    ("Drycker", "Husets röda, glas", "Fruktigt och mjukt rött vin, 15 cl.", 115),
)
ALCOHOL = {"Husets röda, glas"}
TABLES = (  # label, seats, shape, x, z, size, zone
    ("1", 2, "round", -5.5, -3.5, 1.0, "Fönster"), ("2", 2, "round", -3.0, -3.5, 1.0, "Fönster"),
    ("3", 4, "rect", -0.5, -3.5, 1.4, "Fönster"), ("4", 4, "rect", 2.5, -3.5, 1.4, "Fönster"),
    ("5", 4, "rect", -4.0, 0.5, 1.4, "Mitten"), ("6", 6, "rect", 0.0, 0.5, 2.0, "Mitten"),
    ("7", 6, "rect", 4.0, 0.5, 2.0, "Mitten"), ("8", 8, "rect", 0.0, 3.5, 2.6, "Mitten"),
)
PHONE_CONFIG = {"agentName": "Sara", "tone": "friendly", "languages": ["en"], "recording": {"enabled": False},
                "minutesCapPerMonth": 100}
# PTS numbers reserved for fiction (E.164, inclusive): only these on a twin.
FICTION_PHONES = (("+46701740605", "+46701740699"), ("+46313900600", "+46313900699"),
                  ("+46846500400", "+46846500499"), ("+46406280400", "+46406280499"),
                  ("+46980319200", "+46980319299"))
FICTION_ADDRESS = "testgatan"
# Test org. number: valid check digit, first digit 4, a group Skatteverket's
# numbering (SKV 709: 1, 2, 3, 5 to 9) gives no organisation, so it can't be
# a real company's.
LEGAL_ORG_NUMBER = "402000-0008"
LEGAL_ADDRESS = {"street": "Testgatan 1", "postalCode": "111 22", "city": "Stockholm", "country": "SE"}

CATERING_TERMS = ("Testvillkor: detta är en testrestaurang i Booqys utvecklingsmiljö. Ingen catering levereras och "
                  "inga riktiga betalningar görs (Stripe testläge). Avbokning senast 5 dagar före leverans är "
                  "kostnadsfri, därefter debiteras 50 procent av offerten.")
CATERING = {"enabled": True, "pickup": True, "delivery": True, "deliveryArea": "Stockholm (test)",
            "minPortions": 10, "maxPortions": 300, "minGuests": 15,
            "leadTimeRules": [{"fromGuests": 15, "toGuests": 49, "days": 5}, {"fromGuests": 50, "toGuests": 99, "days": 8},
                              {"fromGuests": 100, "toGuests": None, "days": 10}],
            "deliveryBands": [{"upToKm": 10, "price": 295}, {"upToKm": 25, "price": 495}], "maxDeliveryKm": 25,
            "cleaningFee": 300, "offerValidDays": 7, "allowSimpleAcceptance": True, "terms": CATERING_TERMS}
# EU 1169/2011 codes (application shared/catering.py) for the seed's dishes.
DISH_ALLERGENS = {
    "Dagens fisk": ["fish", "milk"], "Dagens kött": ["gluten", "eggs", "milk"],
    "Dagens vegetariska": ["gluten", "milk"], "Toast Skagen": ["gluten", "crustaceans", "eggs", "fish", "milk"],
    "Burrata": ["gluten", "milk"], "Pannbiff med lök": ["gluten", "eggs", "milk"], "Grillad lax": ["fish", "milk"],
    "Svamprisotto": ["milk", "celery"], "Kladdkaka": ["gluten", "eggs", "milk"], "Crème brûlée": ["eggs", "milk"],
}
DISH_DIETARY = {"Dagens vegetariska": ["vegetarian"], "Burrata": ["vegetarian"], "Svamprisotto": ["vegetarian"],
                "Crème brûlée": ["vegetarian", "gluten_free"]}
CATERING_ALLERGENS = ("gluten", "crustaceans", "eggs", "fish", "peanuts", "soy", "milk", "nuts", "celery", "mustard",
                      "sesame", "sulphites", "lupin", "molluscs")
NOT_FOR_CATERING = ("Dagens lunch", "Drycker")      # categories the catering menu leaves out
CATERING_MAX_DISHES = 12
PACKAGE = {"name": "Testpaket trerätters", "description": "Förrätt, varmrätt och efterrätt för hela sällskapet.",
           "pricePerGuest": 345, "minGuests": 15, "active": True}
PACKAGE_DISHES = ("Burrata", "Grillad lax", "Kladdkaka")
DISCOUNT_TIER = {"name": "Stort sällskap", "fromPortions": 50, "toPortions": None, "discountPercent": 10,
                 "active": True}
WAITLIST_DEFAULTS = {"holdMinutes": 10, "maxWaiting": 50}     # application shared/features/waitlist defaults
GIFT_CARDS = {"enabled": True, "amountsSek": [250, 500, 1000], "customMinSek": 100, "customMaxSek": 5000,
              "validityMonths": 24}
EVENT_TITLE = "Testkväll"
SEED_EVENT_ID = re.compile(r"testkvall\d{8}")   # the seed's own event (testkvall<YYYYMMDD>), never a developer's
EVENT_DAYS_AHEAD = 30
EVENT_SKIP_DAYS = ((12, 24), (12, 25), (12, 31), (1, 1))
EVENT = {"description": "Testevenemang i Booqys utvecklingsmiljö. Biljetterna betalas med Stripes testkort, "
                        "inget dras på riktigt.",
         "capacity": 40, "starts": "19:00", "ends": "23:00",
         "ticketTypes": [{"typeId": "entre_standard", "name": "Entré", "priceOre": 15000, "vatRate": 25,
                          "sortOrder": 0},
                         {"typeId": "entre_middag", "name": "Entré med middag", "priceOre": 49500, "vatRate": 12,
                          "includes": "Trerättersmiddag", "sortOrder": 1}]}


def is_dev() -> bool:
    """Only an ENVIRONMENT of exactly dev; a missing or misnamed one is prod."""
    return env("ENVIRONMENT", "") == "dev"


def enabled() -> bool:
    return is_dev() and bool(env("DEV_TWIN_FUNCTION_PREFIX", ""))


def owner_email(slug: str, suffix: str = "") -> str:
    template = env("DEV_TWIN_OWNER_EMAIL", "") or DEFAULT_OWNER_EMAIL
    return template.replace("{slug}", f"{slug}{suffix}")


def fiction_phone(value) -> bool:
    """A number in the PTS range reserved for fiction (070-174 06 05 style)."""
    if not isinstance(value, str):
        return False
    number = "".join(ch for ch in value if ch.isdigit() or ch == "+")
    if number.startswith("00"):
        number = "+" + number[2:]
    elif number.startswith("0"):
        number = "+46" + number[1:]
    return any(len(number) == len(low) and low <= number <= high for low, high in FICTION_PHONES)


def twin_overrides(overrides: dict | None = None) -> dict:
    """Plan overrides with every guest-facing feature on and the twin's
    limits (at least TWIN_LIMITS): what a twin gets on top of its plan."""
    out = dict(overrides or {})
    out["features"] = {**(out.get("features") or {}), **{k: True for k in TWIN_FEATURES}}
    limits = dict(out.get("limits") or {})
    for key, value in TWIN_LIMITS.items():
        limits[key] = max(int(limits.get(key) or 0), value)
    out["limits"] = limits
    return out


def applies_to(profile: dict) -> bool:
    """A twin in dev (the twin's feature overrides apply). Never in prod,
    where Anar's real tenant matches LEGACY_TWINS: dev twins on (enabled,
    which needs ENVIRONMENT dev and the twin function prefix, empty in
    prod)."""
    return enabled() and is_twin(profile)


# ------------------------------------------------- twins versus test customers
# Rules: BooqyCustomers/site-template docs/DATA-RULES.md. A twin is born from a
# prod customer only (site task "mirror") and carries twinOf {env, tenantId};
# a customer created in this console is a dev test customer (siteKind
# "test") and never becomes a twin.
LEGACY_TWINS = ("anar",)   # owner 2026-11-18: Anar's manual dev tenant is Anar's twin


def is_twin(profile: dict) -> bool:
    return bool(profile.get("twinOf")) or profile.get("siteKind") == "prod-link" \
        or profile.get("slug") in LEGACY_TWINS and profile.get("siteKind") != "test"


def clash(profile: dict, prod_tenant_id: str | None) -> tuple[str, str] | None:
    """(code, operator message) when prod's customer may not take this dev
    customer as its twin, else None. Never merged, never written over."""
    slug = profile.get("slug")
    if profile.get("siteKind") == "test":
        return ("slug_used_by_test_customer",
                f"A dev test customer already uses the slug {slug}. Rename or delete it in Booqy Console Dev, "
                "then create the twin.")
    twin_of = (profile.get("twinOf") or {}).get("tenantId")
    if twin_of and prod_tenant_id and twin_of != prod_tenant_id:
        return ("slug_used_by_other_twin",
                f"The slug {slug} is the dev twin of another prod customer. Delete that twin in Booqy Console Dev, "
                "then create this one.")
    if not is_twin(profile):
        return ("slug_used_by_dev_customer",
                f"A dev customer that is not a twin already uses the slug {slug}. Rename or delete it in Booqy "
                "Console Dev, then create the twin.")
    return None


def mark_twin(tenant_id: str, prod_tenant_id: str | None) -> None:
    """siteKind prod-link and twinOf {env: prod, tenantId}; clears an old clash."""
    values = {":k": {"S": "prod-link"}}
    expr = "SET siteKind = :k"
    if prod_tenant_id:
        expr += ", twinOf = :t"
        values[":t"] = to_ddb_value({"env": "prod", "tenantId": prod_tenant_id, "linkedAt": now_iso()})
    client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id), UpdateExpression=expr + " REMOVE twinClash",
                                   ConditionExpression="attribute_exists(PK)", ExpressionAttributeValues=values)


def record_clash(tenant_id: str, prod_tenant_id: str | None, code: str, message: str, actor: str) -> None:
    """Shown on that dev customer in Booqy Console Dev until it is resolved."""
    client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id), UpdateExpression="SET twinClash = :c",
                                   ConditionExpression="attribute_exists(PK)", ExpressionAttributeValues={
                                       ":c": to_ddb_value({"code": code, "message": message, "at": now_iso(),
                                                           **({"prodTenantId": prod_tenant_id} if prod_tenant_id else {})})})
    write_audit(tenant_id, "twin_refused_slug_clash", actor, {"code": code, "prodTenantId": prod_tenant_id})


def flag_prod_offboarded(tenant_id: str, actor: str) -> None:
    """Prod offboarded the customer: the twin is only flagged. Nothing is
    deleted without an operator (Suspend or offboard on the twin)."""
    client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id),
                                   UpdateExpression="SET twinProdOffboardedAt = :n",
                                   ConditionExpression="attribute_exists(PK)",
                                   ExpressionAttributeValues={":n": {"S": now_iso()}})
    write_audit(tenant_id, "twin_prod_offboarded", actor, {})


# ---------------------------------------------- prod's public API (read only)
def prod_public(path: str, *, timeout: float = 10.0):
    """GET on prod's PUBLIC API (what any guest's browser reads). None on 404."""
    import urllib.error
    import urllib.request
    base = env("DEV_TWIN_PROD_API_URL", "").rstrip("/")
    if not base:
        raise StepFailed("Prod's public API isn't configured here (dev_twin_prod_api_url).")
    request = urllib.request.Request(f"{base}{path}", headers={"Accept": "application/json",
                                                              "User-Agent": "booqy-dev-twin/1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b"null")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise StepFailed(f"Prod's public API answered {e.code} for {path.split('?')[0]}") from None
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise StepFailed(f"Prod's public API didn't answer ({type(e).__name__}). Try again.") from None


def prod_site(slug: str) -> dict | None:
    """Prod's public site config for <slug>.<prod domain>, or None."""
    from urllib.parse import quote
    domain = env("DEV_TWIN_PROD_DOMAIN", "") or "booqy.se"
    return prod_public(f"/site-config?host={quote(f'{slug}.{domain}')}")


def prod_slug_taken(slug: str) -> bool:
    """A prod customer uses this slug (its slug address answers). A prod API
    that can't be reached never blocks: False, logged."""
    if not is_dev() or not env("DEV_TWIN_PROD_API_URL", ""):
        return False
    try:
        site = prod_site(slug)
    except StepFailed as e:
        log.warning(json.dumps({"prodSlugCheck": slug, "error": str(e)}))
        return False
    return bool(site and (site.get("tenant") or {}).get("slug") == slug)


# ------------------------------------------------------------------- state
def _save(tenant_id: str, state: dict) -> None:
    client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id), UpdateExpression="SET devTwin = :d",
                                   ConditionExpression="attribute_exists(PK)",
                                   ExpressionAttributeValues={":d": to_ddb_value(state)})


def _self_arn(function_arn: str) -> str:
    """The live alias: an unqualified invoke (prod's link role) may only hand
    over site tasks, so the seed always runs through the alias."""
    if function_arn.endswith(":$LATEST"):
        function_arn = function_arn[: -len(":$LATEST")]
    return function_arn if function_arn.count(":") == 7 else f"{function_arn}:live"


def _stale_before() -> str:
    """now_iso() of STALE_MINUTES ago (ISO strings compare as times)."""
    cut = datetime.now(timezone.utc) - timedelta(minutes=STALE_MINUTES)
    return cut.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def busy(state) -> bool:
    """A seed is queued or running and not stale (a run the Lambda timeout
    killed stays "running"; after STALE_MINUTES it may be started again)."""
    if not isinstance(state, dict) or state.get("status") not in BUSY:
        return False
    since = state.get("requestedAt") if state["status"] == "queued" else state.get("startedAt")
    return isinstance(since, str) and since >= _stale_before()


def kick(tenant_id: str, requested_by: str, function_arn: str | None, *, run: int = 1,
         force: bool = False) -> dict | None:
    """Queues a seed (an async invoke of this function); answers the state,
    or None when another seed for the twin is busy (a conditional write, so
    two quick presses never start two seeds). force: the run handing itself
    the rest."""
    state = {"status": "queued", "requestedAt": now_iso(), "requestedBy": requested_by, "steps": {}}
    if force:
        _save(tenant_id, state)
    else:
        try:
            client("dynamodb").update_item(
                TableName=tenant_table(), Key=tkey(tenant_id), UpdateExpression="SET devTwin = :d",
                ConditionExpression="attribute_exists(PK) AND (attribute_not_exists(devTwin.#st) "
                                    "OR NOT devTwin.#st IN (:q, :r) "
                                    "OR (devTwin.#st = :q AND (attribute_not_exists(devTwin.requestedAt) "
                                    "OR devTwin.requestedAt < :cut)) "
                                    "OR (devTwin.#st = :r AND (attribute_not_exists(devTwin.startedAt) "
                                    "OR devTwin.startedAt < :cut)))",
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={":d": to_ddb_value(state), ":q": {"S": "queued"}, ":r": {"S": "running"},
                                           ":cut": {"S": _stale_before()}})
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return None
            raise
    if function_arn:
        client("lambda").invoke(FunctionName=_self_arn(function_arn), InvocationType="Event",
                                Payload=json.dumps({"twinTask": {"tenantId": tenant_id, "requestedBy": requested_by,
                                                                 "run": run}}).encode())
    return state


def start(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/dev-twin: create or refresh the twin."""
    if not enabled():
        raise ApiError(404, "not_found", "Dev twins exist in the dev console only.")
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    if (req.body or {}).get("all") is True:
        return refresh_all(req)
    _twin_only(profile)
    if busy(profile.get("devTwin")):
        return 202, {"devTwin": profile["devTwin"]}
    state = kick(tenant_id, req.actor, req.function_arn)
    if state is None:                              # another press got there first
        return 202, {"devTwin": get_profile(tenant_id).get("devTwin")}
    write_audit(tenant_id, "dev_twin_requested", req.actor, {})
    return 202, {"devTwin": state}


def refresh_all(req) -> tuple[int, dict]:
    """{"all": true} on the route above (dev only): the seed again for every
    active twin, so each gets new steps after a deploy (see the module
    docstring for what a run replaces); a twin whose seed is already running
    is left to it."""
    if not enabled():
        raise ApiError(404, "not_found", "Dev twins exist in the dev console only.")
    tenants = query_all(TableName=tenant_table(), IndexName="GSI1", KeyConditionExpression="GSI1PK = :t",
                        ExpressionAttributeValues={":t": {"S": "TENANT"}})
    queued, skipped = [], []
    for t in sorted(tenants, key=lambda r: r.get("slug") or ""):
        if not is_twin(t) or t.get("siteKind") == "test":
            continue
        slug = t.get("slug") or t["tenantId"]
        if t.get("status") not in ("active", "provisioning"):       # the seed waits for onboarding
            skipped.append({"slug": slug, "reason": f"Customer is {t.get('status')}"})
        elif busy(t.get("devTwin")):            # GSI1 lags; kick's condition is the real check
            skipped.append({"slug": slug, "reason": "Already running"})
        elif len(queued) >= REFRESH_ALL_MAX:
            skipped.append({"slug": slug, "reason": "Too many at once. Refresh all again when these are done."})
        elif kick(t["tenantId"], req.actor, req.function_arn) is None:
            skipped.append({"slug": slug, "reason": "Already running"})
        else:
            write_audit(t["tenantId"], "dev_twin_requested", req.actor, {"all": True})
            queued.append(slug)
    return 202, {"queued": queued, "skipped": skipped}


def _twin_only(profile: dict) -> None:
    if profile.get("siteKind") == "test":
        raise ApiError(409, "not_a_twin", "This is a dev test customer: it lives in dev only and has no twin. "
                                          "Twins come from prod customers.")
    if not is_twin(profile):
        raise ApiError(409, "not_a_twin", "This dev customer is not a twin of a prod customer. Twins are created "
                                          "from prod Booqy Console.")
    if profile.get("status") in LOCKED or profile.get("status") == "suspended":
        raise ApiError(409, "invalid_status", f"This customer is {profile.get('status')}. Restore or resume it "
                                              "first, then refresh the dev twin.")


def start_content(req) -> tuple[int, dict]:
    """POST /platform/tenants/{tenantId}/dev-twin/content: copy the real
    restaurant's public content from prod's public API now."""
    from .devtwin_content import kick_content
    if not enabled():
        raise ApiError(404, "not_found", "Dev twins exist in the dev console only.")
    tenant_id = req.path["tenantId"]
    profile = get_profile(tenant_id)
    _twin_only(profile)
    if (profile.get("devTwinContent") or {}).get("status") in ("queued", "running"):
        return 202, {"devTwinContent": profile["devTwinContent"]}
    state = kick_content(tenant_id, req.actor, req.function_arn)
    write_audit(tenant_id, "dev_twin_content_requested", req.actor, {})
    return 202, {"devTwinContent": state}


def twin_task(event: dict, context) -> dict:
    """{"twinTask": {tenantId, requestedBy, run}}: the seed itself (async)."""
    if not enabled():
        return {"status": "off"}
    task = event.get("twinTask") if isinstance(event.get("twinTask"), dict) else {}
    tenant_id = task.get("tenantId")
    if not isinstance(tenant_id, str) or not tenant_id:
        return {"status": "invalid"}
    if task.get("mode") == "content":
        from .devtwin_content import ContentCopy
        return ContentCopy(tenant_id, task.get("requestedBy") or OPERATOR, 1, context).run()
    return Seeder(tenant_id, task.get("requestedBy") or OPERATOR, int(task.get("run") or 1), context).run()


# ---------------------------------------------------------------- the seed
class StepFailed(Exception):
    pass


class Seeder:
    def __init__(self, tenant_id: str, requested_by: str, run: int, context):
        self.tenant_id, self.requested_by, self.run_no, self.context = tenant_id, requested_by, run, context
        self.state: dict = {}
        self.location: dict | None = None
        self.locations: list[dict] = []
        self._prod_phones: set[str] | None = None
        self._features_on_at: float | None = None      # time.monotonic() of the features step's write

    # -- plumbing ---------------------------------------------------------
    def call(self, name: str, method: str, path: str, route: str | None = None, body: dict | None = None,
             ok=(200, 201, 204), query: dict | None = None) -> tuple[int, dict]:
        """One of the admin's functions as the twin's owner (console_invoke)."""
        call = {"operator": OPERATOR, "tenantId": self.tenant_id, "method": method, "path": path}
        if route:
            call["route"] = route
        if query:
            call["query"] = query
        if body is not None:
            call["body"] = body
        response = client("lambda").invoke(FunctionName=f"{env('DEV_TWIN_FUNCTION_PREFIX')}{name}:live",
                                           InvocationType="RequestResponse",
                                           Payload=json.dumps({"booqyConsole": call}).encode())
        result = json.loads(response["Payload"].read() or b"null")
        if response.get("FunctionError") or not isinstance(result, dict):
            raise StepFailed(f"{name} {method} {path} failed")
        status = int(result.get("statusCode") or 500)
        out = json.loads(result.get("body") or "null") if result.get("body") else {}
        if status not in ok:
            detail = " ".join(str(out[k]) for k in ("code", "error", "message") if out.get(k)) \
                if isinstance(out, dict) else ""
            raise StepFailed(f"{name} {method} {path}: {status} {detail[:200]}".strip())
        return status, out if isinstance(out, (dict, list)) else {}

    def req(self, path: dict, body: dict | None = None):
        return SimpleNamespace(path={"tenantId": self.tenant_id, **path}, body=body or {}, query={},
                               actor=OPERATOR, claims={}, function_arn=None)

    def loc_path(self, rest: str = "") -> str:
        return f"/locations/{self.location['locationId']}{rest}"

    def remaining_ms(self) -> int:
        getter = getattr(self.context, "get_remaining_time_in_millis", None)
        return getter() if getter else 300_000

    # -- the run ----------------------------------------------------------
    def run(self) -> dict:
        profile = get_profile(self.tenant_id, required=False)
        if not profile or profile.get("status") in LOCKED:
            return {"status": "gone"}
        if not is_twin(profile):
            return {"status": "not_a_twin"}
        self.profile = profile
        self._learn_twin_of()
        self.state = {"status": "running", "requestedBy": self.requested_by, "startedAt": now_iso(),
                      "ownerEmail": owner_email(profile["slug"]), "steps": {}}
        if not self._wait_active():
            if self.run_no < MAX_RUNS and getattr(self.context, "invoked_function_arn", None):
                kick(self.tenant_id, self.requested_by, self.context.invoked_function_arn, run=self.run_no + 1,
                     force=True)
                return {"status": "waiting"}
            self.state.update(status="failed", finishedAt=now_iso(),
                              error="The customer never became active. Retry setup on the Overview, then refresh.")
            _save(self.tenant_id, self.state)
            return {"status": "failed"}
        _save(self.tenant_id, self.state)
        for step in STEPS:
            if self.remaining_ms() < 20_000:
                self.state["steps"][step] = {"ok": False, "note": "Out of time. Refresh the dev twin again."}
                continue
            try:
                note = getattr(self, f"step_{step}")()
                self.state["steps"][step] = {"ok": True, "note": note or "Already set"}
            except (StepFailed, ApiError, ClientError) as e:
                log.warning(json.dumps({"devTwin": step, "tenantId": self.tenant_id, "error": str(e)[:300]}))
                self.state["steps"][step] = {"ok": False, "note": str(e)[:300]}
            _save(self.tenant_id, self.state)
        failed = [s for s, r in self.state["steps"].items() if not r["ok"]]
        self.state.update(status="partial" if failed else "ready", finishedAt=now_iso())
        _save(self.tenant_id, self.state)
        write_audit(self.tenant_id, "dev_twin_seeded", OPERATOR, {"status": self.state["status"], "failed": failed})
        return {"status": self.state["status"], "failed": failed}

    def _learn_twin_of(self) -> None:
        """A twin from before the marker (Anar's manual one): its prod tenant
        id from prod's public site config, best effort."""
        if self.profile.get("twinOf") or not env("DEV_TWIN_PROD_API_URL", ""):
            return
        try:
            site = prod_site(self.profile["slug"])
        except StepFailed:
            return
        prod_id = ((site or {}).get("tenant") or {}).get("tenantId")
        if prod_id and (site["tenant"].get("slug") == self.profile["slug"]):
            mark_twin(self.tenant_id, prod_id)
            self.profile["twinOf"] = {"env": "prod", "tenantId": prod_id}

    def _wait_active(self) -> bool:
        import time
        waited = 0
        while self.profile.get("status") != "active":
            if self.profile.get("status") not in ("provisioning", "failed") or waited >= ACTIVE_WAIT_SECONDS \
                    or self.remaining_ms() < 60_000:
                return False
            time.sleep(5)
            waited += 5
            self.profile = get_profile(self.tenant_id)
        return True

    def features(self) -> dict:
        return (self.profile.get("entitlements") or {}).get("features") or {}

    def features_settled(self) -> None:
        """Once per run, after the features step turned a feature on: waits
        until no admin function can still hold the old tenant row
        (FEATURES_SETTLE_SECONDS). Skipped when the run lacks the time; the
        step then reports what the function answered."""
        import time
        if self._features_on_at is None:
            return
        wait = self._features_on_at + FEATURES_SETTLE_SECONDS - time.monotonic()
        self._features_on_at = None
        if wait > 0 and self.remaining_ms() > wait * 1000 + 60_000:
            time.sleep(wait)

    def team_email(self, email) -> bool:
        return team_email(email, self.profile["slug"])

    def prod_phones(self) -> set[str]:
        """Prod's public phone numbers for this restaurant (best effort): a
        twin never shows them."""
        if self._prod_phones is None:
            self._prod_phones = set()
            if env("DEV_TWIN_PROD_API_URL", ""):
                try:
                    site = prod_site(self.profile["slug"]) or {}
                except StepFailed:
                    site = {}
                if (site.get("tenant") or {}).get("slug") == self.profile["slug"]:
                    numbers = [loc.get("phoneNumber") for loc in site.get("locations") or []]
                    numbers.append((site.get("legal") or {}).get("contactPhone"))
                    self._prod_phones = {_digits(n) for n in numbers if n}
        return self._prod_phones

    def fake_phone(self, value) -> bool:
        return fiction_phone(value) and _digits(value) not in self.prod_phones()

    def content_copied(self) -> bool:
        """The location took prod's public content (its address is prod's
        public one, DATA-RULES.md)."""
        steps = (self.profile.get("devTwinContent") or {}).get("steps") or {}
        return bool((steps.get("location") or {}).get("ok"))

    # -- steps ------------------------------------------------------------
    def step_features(self) -> str | None:
        """Every guest-facing feature on (and the phone minutes), whatever
        prod's plan is (dev only, owner 2026-11-24)."""
        if not enabled():
            raise StepFailed("Twin features are dev only.")
        ent = self.profile.get("entitlements") if isinstance(self.profile.get("entitlements"), dict) else {}
        features, limits = dict(ent.get("features") or {}), dict(ent.get("limits") or {})
        missing = [k for k in TWIN_FEATURES if not features.get(k)]
        low = {k: v for k, v in TWIN_LIMITS.items() if int(limits.get(k) or 0) < v}
        if not missing and not low:
            return None
        features.update({k: True for k in missing})
        limits.update(low)
        if ent:
            expression = "SET entitlements.features = :f, entitlements.limits = :l ADD entitlements.featuresEver :e"
            values = {":f": to_ddb_value(features), ":l": to_ddb_value(limits), ":e": to_ddb_value(set(TWIN_FEATURES))}
        else:
            expression = "SET entitlements = :ent"
            values = {":ent": to_ddb_value({"maxLocations": 1, "features": features, "limits": limits,
                                            "featuresEver": set(TWIN_FEATURES)})}
        client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(self.tenant_id), UpdateExpression=expression,
                                       ConditionExpression="attribute_exists(PK)", ExpressionAttributeValues=values)
        import time
        self._features_on_at = time.monotonic() if missing else None
        self.profile["entitlements"] = {**ent, "features": features, "limits": limits}
        write_audit(self.tenant_id, "dev_twin_features_on", OPERATOR, {"features": missing, "limits": low})
        return "On: " + ", ".join(missing + [f"{k} {v}" for k, v in low.items()])

    def step_owner(self) -> str | None:
        """A Booqy team login owns the twin (the legal step replaces the
        restaurant's details an older mirror copied over with fake ones)."""
        from .users import _set_primary, invite_owner
        email = owner_email(self.profile["slug"])
        users = query_all(TableName=user_table(), IndexName=env("USER_TENANT_INDEX_NAME"),
                          KeyConditionExpression="tenantId = :t", ExpressionAttributeValues={":t": {"S": self.tenant_id}})
        notes = []
        if not any(u.get("role") == "owner_user" and (u.get("email") or "").lower() == email.lower() for u in users):
            invite_owner(self.req({}, {"email": email, "name": "Booqy utvecklare"}))
            notes.append(f"Owner login {email} invited")
        if (self.profile.get("ownerEmail") or "").lower() != email.lower():
            _set_primary(self.tenant_id, OPERATOR, email, "Booqy utvecklare")
            notes.append("Contact owner is the team login")
        return "; ".join(notes) or None

    def step_notifications(self) -> str | None:
        """Guest SMS on (the setting is off by default), so booking, reminder and
        cancellation texts can be tried in dev. A value the developer set stays."""
        current = self.profile.get("notifications")
        current = current if isinstance(current, dict) else {}
        if isinstance(current.get("sms"), bool):
            return None
        merged = {**current, "sms": True}
        client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(self.tenant_id),
                                       UpdateExpression="SET notifications = :n",
                                       ExpressionAttributeValues={":n": to_ddb_value(merged)})
        self.profile["notifications"] = merged
        return "Guest SMS on"

    def step_stripe(self) -> str | None:
        """The shared TEST-mode connected account (fully onboarded), so card
        guarantees and orders work in the twin."""
        from .stripe_connect import _api_key, stripe_request
        account_id = env("DEV_TWIN_STRIPE_ACCOUNT_ID", "")
        current = self.profile.get("stripe") or {}
        if not account_id:
            raise StepFailed("No shared Stripe test account is configured (dev_twin_stripe_account_id).")
        if not _api_key().startswith(("sk_test_", "rk_test_")):
            raise StepFailed("The Stripe key here is not a test key; dev twins never use live mode.")
        if current.get("accountId") == account_id and current.get("chargesEnabled"):
            return None
        acct = stripe_request("GET", f"/accounts/{account_id}")
        if not acct.get("charges_enabled"):
            raise StepFailed(f"The shared Stripe test account {account_id} can't take payments yet.")
        state = {"accountId": account_id, "chargesEnabled": True, "payoutsEnabled": bool(acct.get("payouts_enabled")),
                 "detailsSubmitted": bool(acct.get("details_submitted")), "disconnected": False,
                 "requirementsDue": [], "taxRates": current.get("taxRates") if current.get("accountId") == account_id
                 else {}, "sharedTestAccount": True, "updatedAt": now_iso()}
        client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(self.tenant_id),
                                       UpdateExpression="SET stripe = :s",
                                       ExpressionAttributeValues={":s": to_ddb_value(state)})
        self.profile["stripe"] = state
        return f"Shared test account {account_id}"

    def step_location(self) -> str | None:
        """The twin's location, one guests can reach: public routes resolve a
        location the way application shared/tenant.py tenant_of_location
        does (byLocationId, a tenantId matching PK, exactly one tenant). A
        row that only lacks tenantId or locationId gets it; when none can be
        reached, a fresh location with the seed's data is made."""
        from .locations import create_location
        self.locations = twin_locations(self.tenant_id)
        notes = []
        for item in self.locations:
            fixed = self._repair(item)
            if fixed:
                notes.append(fixed)
            if resolves(self.tenant_id, item):
                self.location = item
                return "; ".join(notes) or None
        broken = ", ".join(_location_id(i) for i in self.locations)
        try:
            _, out = create_location(self.req({}, {"name": self.profile.get("name") or self.profile["slug"],
                                                   "address": ADDRESS, "phone": PHONE}))
        except ApiError as e:
            if broken:
                raise StepFailed(f"Guests can't reach location {broken}. {e}") from None
            raise
        self.location = out["location"]
        self.locations.append(self.location)
        return "; ".join(notes + [f"Location created (guests couldn't reach {broken})" if broken
                                  else "Location created"])

    def _repair(self, item: dict) -> str | None:
        """Sets a missing tenantId or locationId (the id from SK) on the row;
        nothing else is ever changed here."""
        location_id = _location_id(item)
        fix = {k: v for k, v in (("tenantId", self.tenant_id), ("locationId", location_id))
               if k not in item and v}
        if not fix or item.get("PK") != f"TENANT#{self.tenant_id}":
            return None
        names = {f"#k{i}": k for i, k in enumerate(fix)}
        conditions = " AND ".join(f"attribute_not_exists(#k{i})" for i in range(len(fix)))
        try:
            client("dynamodb").update_item(
                TableName=location_table(), Key={"PK": {"S": item["PK"]}, "SK": {"S": item["SK"]}},
                UpdateExpression="SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(fix))),
                ConditionExpression=f"attribute_exists(PK) AND {conditions}", ExpressionAttributeNames=names,
                ExpressionAttributeValues={f":v{i}": {"S": v} for i, v in enumerate(fix.values())})
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            return None
        item.update(fix)
        write_audit(self.tenant_id, "dev_twin_location_repaired", OPERATOR,
                    {"locationId": location_id, "fields": sorted(fix)})
        return f"{', '.join(sorted(fix))} set on location {location_id}"

    def need_location(self) -> None:
        if not self.location:
            raise StepFailed("No location (see the location step).")

    def contact_fixes(self, loc: dict, *, copied: bool) -> dict:
        """A location's contact data that is not fake: a phone outside the
        fiction range (or prod's), an email that is not a team address, an
        address that is not Testgatan unless it came from prod's public
        content (copied: the content copy's location)."""
        body = {}
        address = loc.get("address")
        if not address or (FICTION_ADDRESS not in str(address).lower() and not copied):
            body["address"] = ADDRESS
        if not self.fake_phone(loc.get("phoneNumber")):
            body["phoneNumber"] = PHONE
        if not self.team_email(loc.get("email")):
            body["email"] = owner_email(self.profile["slug"])
        if "email" in body or "phoneNumber" in body:     # a contact edit sends both
            body.setdefault("phoneNumber", loc.get("phoneNumber"))
            body.setdefault("email", loc.get("email"))
        return body

    def step_details(self) -> str | None:
        """Contact details, opening hours, special days, booking rules, card
        guarantee and online ordering: only what the location lacks. Contact
        data is always fake (contact_fixes), on every location of the twin.
        The catering notifyPhone is the catering step's."""
        self.need_location()
        loc = self.location
        body = self.contact_fixes(loc, copied=self.content_copied())
        if not loc.get("timezone"):
            body["timezone"] = TIMEZONE
        if not any((loc.get("businessHours") or {}).get(d) for d in HOURS):
            body["businessHours"] = HOURS
        for key, value in BOOKING.items():
            if loc.get(key) in (None, ""):
                body[key] = value
        if not loc.get("specialDays"):
            body["specialDays"] = special_days(_today(loc.get("timezone")))
        if not loc.get("guarantee"):
            body["guarantee"] = GUARANTEE
        if not loc.get("ordering") and self.features().get("ordering", True):
            body["ordering"] = ORDERING
        notes = []
        if body:
            _, out = self.call("create-location", "PUT", self.loc_path(), "/locations/{locationId}", body)
            self.location = {**loc, **body, **(out if isinstance(out, dict) and out.get("locationId") else {})}
            notes.append("Set: " + ", ".join(sorted(body)))
        others = 0
        for other in self.locations:
            other_id = _location_id(other)
            if other_id == loc["locationId"]:
                continue
            fixes = self.contact_fixes(other, copied=False)
            if not fixes:
                continue
            if resolves(self.tenant_id, other):
                self.call("create-location", "PUT", f"/locations/{other_id}", "/locations/{locationId}", fixes)
            else:
                # create-location answers 404 for a row guests can't reach (the
                # location step left it), so the console's own location edit
                from .locations import update_location
                update_location(self.req({"locationId": other_id},
                                         {"phone" if k == "phoneNumber" else k: v for k, v in fixes.items()}))
            other.update(fixes)
            others += 1
        if others:
            notes.append(f"fake contact data on {others} more location{'s' if others > 1 else ''}")
        return "; ".join(notes) or None

    def step_menu(self) -> str | None:
        self.need_location()
        route = "/locations/{locationId}/menu/{proxy+}"
        _, cats = self.call("get-menu", "GET", self.loc_path("/menu/categories"), route)
        entries = list(cats.get("categories") or [])
        by_name = {c["name"]: c["categoryId"] for c in entries}
        notes = []
        missing = [n for n in CATEGORIES if n not in by_name]
        if missing:
            body = {"categories": [{"name": "Dagens lunch"}] if "Dagens lunch" in missing else []}
            body["categories"] += [{"categoryId": c["categoryId"], "name": c["name"]} for c in entries]
            body["categories"] += [{"name": n} for n in missing if n != "Dagens lunch"]
            body["version"] = cats.get("version", 0)
            _, cats = self.call("manage-menu", "PUT", self.loc_path("/menu/categories"), route, body)
            by_name = {c["name"]: c["categoryId"] for c in cats.get("categories") or []}
            notes.append(f"{len(missing)} categories")
        _, items = self.call("get-menu", "GET", self.loc_path("/menu/items"), route)
        have = {i.get("name") for i in (items.get("items") or [])}
        added = 0
        for category, name, description, price in DISHES:
            if name in have:
                continue
            self.call("manage-menu", "POST", self.loc_path("/menu/items"), route, {
                "name": name, "description": description, "price": price, "category": by_name[category],
                "imageKey": None, "active": True, **({"alcohol": True} if name in ALCOHOL else {})})
            added += 1
        if added:
            notes.append(f"{added} dishes")
        return ("Added " + ", ".join(notes)) if notes else None

    def step_layout(self) -> str | None:
        """A dining room with eight tables, published and active."""
        self.need_location()
        _, versions = self.call("list-layout-version", "GET", self.loc_path("/layout/versions"),
                                "/locations/{locationId}/layout/versions")
        if any(v.get("isCurrent") for v in versions.get("items") or []):
            return None
        el_route = "/locations/{locationId}/layout-elements/{proxy+}"
        _, existing = self.call("manage-layout-element", "GET", self.loc_path("/layout-elements/items"), el_route)
        elements = existing.get("items") if isinstance(existing, dict) else existing
        notes = []
        if not any(e.get("type") == "table" for e in elements or []):
            self._draw_room(el_route)
            notes.append("8 tables drawn")
        _, snapshot = self.call("publish-layout", "POST", self.loc_path("/layout/publish"),
                                "/locations/{locationId}/layout/publish", {})
        version = snapshot.get("version")
        self.call("activate-layout-version", "POST", self.loc_path(f"/layout/versions/{version}/activate"),
                  "/locations/{locationId}/layout/versions/{versionId}/activate", {})
        notes.append(f"version {version} published and active")
        return "; ".join(notes)

    def _draw_room(self, route: str) -> None:
        def add(fields: dict) -> dict:
            _, out = self.call("manage-layout-element", "POST", self.loc_path("/layout-elements/items"), route, {
                "y": 0, "z": 0, "rotationY": 0, **fields})
            return out

        floor = add({"type": "floor", "name": "Matsal", "level": 0, "x": 0, "z": 0, "width": 16, "height": 3,
                     "depth": 12})
        fid = floor["elementId"]
        walls = [add({"type": "wall", "floorId": fid, "x": x, "z": z, "width": w, "height": 1.8, "depth": 0.2,
                      "rotationY": r}) for x, z, w, r in ((0, -6, 16, 0), (0, 6, 16, 0), (-8, 0, 12, 90),
                                                          (8, 0, 12, 90))]
        add({"type": "door", "kind": "entrance", "floorId": fid, "wallId": walls[1]["elementId"], "x": 5, "z": 6,
             "width": 1.6, "height": 2.0, "depth": 0.28})
        for label, seats, shape, x, z, size, zone in TABLES:
            add({"type": "table", "floorId": fid, "label": label, "seats": seats, "shape": shape, "zone": zone,
                 "x": x, "z": z, "width": size, "height": 0.75, "depth": size if shape == "round" else 1.0})

    # -- guest features (dev: every twin has them, TWIN_FEATURES) ----------
    def step_catering(self) -> str | None:
        """Settings (pickup and delivery, lead times, delivery bands, test
        terms), dishes from the twin's menu with allergens, one package and
        one discount tier: only what is missing. Catering a developer
        switched off goes back on with their settings; only the empty ones
        get the seed's (catering_body)."""
        if not self.features().get("catering"):
            return "Not in the plan"
        self.need_location()
        self.features_settled()
        notes = []
        settings_route = "/locations/{locationId}/catering/settings"
        current = self.location.get("cateringSettings") if isinstance(self.location.get("cateringSettings"), dict) \
            else {}
        body = self.catering_body(_plain(current))
        if body:
            _, saved = self.call("catering-settings", "PUT", self.loc_path("/catering/settings"), settings_route, body)
            self.location["cateringSettings"] = saved if isinstance(saved, dict) else {**current, **body}
            notes.append("settings" if "enabled" in body else "settings " + ", ".join(sorted(body)))
        notes += self._catering_menu()
        _, tiers = self.call("catering-discount-tiers", "GET", self.loc_path("/catering/discount-tiers"),
                             "/locations/{locationId}/catering/discount-tiers")
        if not tiers.get("tiers"):
            self.call("catering-discount-tiers", "POST", self.loc_path("/catering/discount-tiers"),
                      "/locations/{locationId}/catering/discount-tiers", DISCOUNT_TIER)
            notes.append("discount tier")
        return ("Added " + ", ".join(notes)) if notes else None

    def catering_body(self, current: dict) -> dict:
        """The catering settings PUT (it merges over the stored ones): the
        contacts when not fake, the test terms when empty; when catering is
        off, enabled plus every seed setting the location has no value for
        (a developer's own minimum, lead times, bands or terms stay)."""
        body = {k: v for k, v, ok in (("notifyEmail", owner_email(self.profile["slug"]),
                                       self.team_email(current.get("notifyEmail"))),
                                      ("notifyPhone", PHONE, self.fake_phone(current.get("notifyPhone"))))
                if not ok}
        if not current.get("enabled"):
            body.update({k: v for k, v in CATERING.items() if _empty(current.get(k))}, enabled=True)
            if "deliveryBands" in body or "maxDeliveryKm" in body:     # the last band's upToKm is the maximum
                body.update(deliveryBands=CATERING["deliveryBands"], maxDeliveryKm=CATERING["maxDeliveryKm"])
            if not (body.get("pickup", current.get("pickup")) or body.get("delivery", current.get("delivery"))):
                body["pickup"] = True                              # catering on needs pickup or delivery
        elif _empty(current.get("terms")):
            body["terms"] = CATERING_TERMS
        return body

    def _catering_menu(self) -> list[str]:
        menu = "/locations/{locationId}/catering/menu"
        _, items = self.call("get-menu", "GET", self.loc_path("/menu/items"), "/locations/{locationId}/menu/{proxy+}")
        _, cats = self.call("get-menu", "GET", self.loc_path("/menu/categories"),
                            "/locations/{locationId}/menu/{proxy+}")
        category = {c["categoryId"]: c["name"] for c in cats.get("categories") or []}
        regular = [i for i in items.get("items") or [] if i.get("name") and i.get("active", True)]
        by_id = {i.get("menuItemId"): i for i in regular}
        by_name = {i["name"]: i for i in regular}
        _, have = self.call("catering-settings", "GET", self.loc_path("/catering/menu/dishes"), f"{menu}/dishes")
        dishes = list(have.get("dishes") or [])
        notes = []
        # allergens on a dish that has none, where the menu (or the seed) knows them
        filled = 0
        for dish in dishes:
            if dish.get("allergens") or dish.get("dietary"):
                continue
            source = by_id.get(dish.get("sourceMenuItemId")) or by_name.get(dish.get("name")) or {"name": dish["name"]}
            allergens = _allergens(source)
            if not allergens:
                continue
            body = {k: _plain(dish[k]) for k in ("name", "description", "pricePerPortion", "active", "sort",
                                                 "sourceMenuItemId") if dish.get(k) is not None}
            body.update(allergens=allergens, dietary=DISH_DIETARY.get(source["name"], []),
                        version=int(dish.get("version") or 1))
            _, saved = self.call("catering-settings", "PUT", self.loc_path(f"/catering/menu/dishes/{dish['dishId']}"),
                                 f"{menu}/dishes/{{dishId}}", body)
            dish.update(saved if isinstance(saved, dict) else body)
            filled += 1
        names = {d.get("name") for d in dishes}
        sources = {d.get("sourceMenuItemId") for d in dishes if d.get("sourceMenuItemId")}
        added = 0
        for item in regular:
            if len(dishes) >= CATERING_MAX_DISHES:
                break
            if item.get("alcohol") or category.get(item.get("category")) in NOT_FOR_CATERING \
                    or item["name"] in names or item.get("menuItemId") in sources:
                continue
            price = _plain(item.get("price"))
            if not isinstance(price, (int, float)) or price <= 0:
                continue
            body = {"name": item["name"][:120], "description": str(item.get("description") or "")[:500],
                    "pricePerPortion": min(price, 10000), "allergens": _allergens(item),
                    "dietary": DISH_DIETARY.get(item["name"], []), "active": True,
                    **({"sourceMenuItemId": item["menuItemId"]} if item.get("menuItemId") else {})}
            _, saved = self.call("catering-settings", "POST", self.loc_path("/catering/menu/dishes"),
                                 f"{menu}/dishes", body)
            dishes.append(saved if isinstance(saved, dict) and saved.get("dishId") else body)
            names.add(item["name"])
            added += 1
        if added:
            notes.append(f"{added} dishes")
        if filled:
            notes.append(f"allergens on {filled} dishes")
        _, packages = self.call("catering-settings", "GET", self.loc_path("/catering/menu/packages"),
                                f"{menu}/packages")
        active = [d for d in dishes if d.get("dishId") and d.get("active", True)]
        if not packages.get("packages") and active:
            chosen = [d["dishId"] for name in PACKAGE_DISHES for d in active if d.get("name") == name][:3] \
                or [d["dishId"] for d in active[:3]]
            self.call("catering-settings", "POST", self.loc_path("/catering/menu/packages"), f"{menu}/packages",
                      {**PACKAGE, "dishIds": chosen})
            notes.append("1 package")
        return notes

    def step_giftCards(self) -> str | None:   # noqa: N802 - the step's key is the feature's
        """Gift cards on (250, 500, 1000 kr or an own amount, 24 months)."""
        if not self.features().get("giftCards"):
            return "Not in the plan"
        self.features_settled()
        _, current = self.call("gift-cards", "GET", "/tenant/gift-cards/settings")
        if current.get("enabled"):
            return None
        body = {**GIFT_CARDS, **{k: current[k] for k in ("amountsSek", "customMinSek", "customMaxSek",
                                                          "validityMonths") if current.get(k)},
                "enabled": True, "version": int(current.get("version") or 0)}
        self.call("gift-cards", "PUT", "/tenant/gift-cards/settings", body=body)
        return "On, " + ", ".join(str(a) for a in body["amountsSek"]) + " kr"

    def step_waitlist(self) -> str | None:
        """The waitlist on, guests may join from the site."""
        if not self.features().get("waitlist"):
            return "Not in the plan"
        self.need_location()
        self.features_settled()
        try:
            _, queue = self.call("waitlist", "GET", self.loc_path("/waitlist"), "/locations/{locationId}/waitlist",
                                 query={"date": _today(self.location.get("timezone")).isoformat()})
            current = queue.get("settings") or {}
        except StepFailed:
            # The queue view also works out table suggestions; without them the
            # first save (version 0) still goes through.
            current = {"version": 0, **WAITLIST_DEFAULTS}
        if current.get("enabled") and current.get("publicJoin"):
            return None
        body = {"enabled": True, "publicJoin": True, "version": int(current.get("version") or 0),
                **{k: int(current[k]) for k in ("holdMinutes", "maxWaiting") if current.get(k) is not None}}
        self.call("waitlist", "PUT", self.loc_path("/waitlist/settings"), "/locations/{locationId}/waitlist/settings",
                  body)
        return "On, public join"

    def step_events(self) -> str | None:
        """One published test evening 30 days ahead with two ticket types,
        while the twin has no upcoming one of its own (eventId
        testkvall<YYYYMMDD>; a developer's events, drafts included, are
        never touched)."""
        if not self.features().get("events"):
            return "Not in the plan"
        self.need_location()
        self.features_settled()
        route = "/locations/{locationId}/events"
        _, listed = self.call("events-tickets", "GET", self.loc_path("/events"), route)
        events = listed.get("events") or []
        taken = {e.get("eventId") for e in events}
        tests = [e for e in events if SEED_EVENT_ID.fullmatch(str(e.get("eventId") or ""))
                 and e.get("status") != "cancelled" and e.get("nextOccurrence")]
        if any(e.get("status") == "published" for e in tests):
            return None
        if tests:
            event_id = tests[0]["eventId"]
            _, view = self.call("events-tickets", "GET", self.loc_path(f"/events/{event_id}"), route + "/{eventId}")
        else:
            from datetime import datetime, time
            zone = _zone(self.location.get("timezone"))
            day = _today(self.location.get("timezone")) + timedelta(days=EVENT_DAYS_AHEAD)
            while (day.month, day.day) in EVENT_SKIP_DAYS or f"testkvall{day:%Y%m%d}" in taken:
                day += timedelta(days=1)                        # the seed's closed and late days, a cancelled one
            start = datetime.combine(day, time.fromisoformat(EVENT["starts"]), zone)
            end = datetime.combine(day, time.fromisoformat(EVENT["ends"]), zone)
            event_id = f"testkvall{day:%Y%m%d}"
            _, view = self.call("events-tickets", "POST", self.loc_path("/events"), route, {
                "eventId": event_id, "title": EVENT_TITLE, "description": EVENT["description"],
                "occurrences": [{"startAt": start.isoformat(), "endAt": end.isoformat(),
                                 "capacity": EVENT["capacity"]}],
                "ticketTypes": EVENT["ticketTypes"], "settings": {}})
        if view.get("status") == "published":
            return None
        self.call("events-tickets", "POST", self.loc_path(f"/events/{event_id}/publish"),
                  route + "/{eventId}/publish", {"version": int(view.get("version") or 1)})
        return f"{EVENT_TITLE} published"

    def step_legal(self) -> str | None:
        """Fake seller details for receipts, offers and the legal pages: a
        test org. number, the team address, Testgatan 1, a fiction phone.
        Until the profile carries the test org. number, its seller details
        are the restaurant's (an older mirror's copy) and all of them go;
        afterwards a developer's own legal name, VAT number and address stay.
        An email that is not a team address (contact, reply-to, billing) and
        a phone outside the fiction range are always replaced."""
        org, p = LEGAL_ORG_NUMBER, self.profile
        team = owner_email(p["slug"])
        ours = p.get("orgNumber") == org
        want = {"orgNumber": org}
        for key, value in (("legalName", f"{p.get('name') or p['slug']} Test AB"),
                           ("vatNumber", f"SE{org.replace('-', '')}01"), ("address", LEGAL_ADDRESS)):
            if not ours or _empty(p.get(key)):
                want[key] = value
        if not self.team_email(p.get("contactEmail")):
            want["contactEmail"] = team
        for key in ("replyToEmail", "billingEmail"):
            if not _empty(p.get(key)) and not self.team_email(p.get(key)):
                want[key] = team
        if not self.fake_phone(p.get("contactPhone")):
            want["contactPhone"] = PHONE
        changed = {k: v for k, v in want.items() if _plain(p.get(k)) != v}
        if not changed:
            return None
        names = {f"#k{i}": k for i, k in enumerate(changed)}
        values = {f":v{i}": to_ddb_value(v) for i, v in enumerate(changed.values())}
        client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(self.tenant_id),
                                       UpdateExpression="SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(changed))),
                                       ConditionExpression="attribute_exists(PK)", ExpressionAttributeNames=names,
                                       ExpressionAttributeValues=values)
        self.profile.update(changed)
        return "Set: " + ", ".join(sorted(changed))

    def step_printers(self) -> str | None:
        """A simulated kitchen printer (dev only): its notes show in the console."""
        from .printers import _devices, add_printer
        self.need_location()
        if _devices(self.location["locationId"]):
            return None
        add_printer(self.req({"locationId": self.location["locationId"]},
                             {"name": "Köket", "kind": "kok", "protocol": "sim"}))
        return "Simulated kitchen printer added"

    def step_staff(self) -> str | None:
        from .users import create_user
        self.need_location()
        staff = query_all(TableName=user_table(), IndexName=env("USER_TENANT_INDEX_NAME"),
                          KeyConditionExpression="tenantId = :t", FilterExpression="#r = :s",
                          ExpressionAttributeNames={"#r": "role"},
                          ExpressionAttributeValues={":t": {"S": self.tenant_id}, ":s": {"S": "staff"}})
        if any(s.get("status") != "system" for s in staff):   # not the phone assistant's account
            return None
        email = owner_email(self.profile["slug"], "-personal")
        create_user(self.req({}, {"role": "staff_user", "name": "Test Personal", "email": email,
                                  "phone": STAFF_PHONE, "locationId": self.location["locationId"]}))
        return f"Staff login {email} invited"

    def step_dpa(self) -> str | None:
        _, tenant = self.call("tenant-account", "GET", "/tenant")
        dpa = tenant.get("dpa") or {}
        if dpa.get("upToDate") or not dpa.get("currentVersion"):
            return None
        self.call("tenant-account", "POST", "/tenant/dpa/accept", body={"version": dpa["currentVersion"]})
        return f"Accepted version {dpa['currentVersion']}"

    def step_google(self) -> str | None:
        if not self.features().get("googleBusiness"):
            return "Not in the plan"
        self.need_location()
        route = "/locations/{locationId}/google-business"
        _, view = self.call("google-business", "GET", self.loc_path("/google-business"), route)
        if view.get("link") or view.get("skipped"):
            return None
        self.call("google-business", "PUT", self.loc_path("/google-business/link"), route + "/link",
                  {"skipped": True})
        return "Skipped (optional step)"

    def step_phone(self) -> str | None:
        """Name, hours (always), the simulated number, forwarded and tested."""
        if not self.features().get("phoneAgent"):
            return "Not in the plan"
        self.need_location()
        self.features_settled()
        notes = []
        _, overview = self.call("phone-agent", "GET", "/tenant/phone-agent")
        config = overview.get("config") or {}
        if int(config.get("version") or 0) == 0:
            self.call("phone-agent", "PUT", "/tenant/phone-agent/config",
                      body={**PHONE_CONFIG, "version": int(config.get("version") or 0)})
            notes.append("assistant named")
        route = "/locations/{locationId}/phone-agent"
        _, loc = self.call("phone-agent", "GET", self.loc_path("/phone-agent"), route)
        hours = loc.get("mode") == "always" or any((loc.get("agentHours") or {}).values())
        if not (loc.get("enabled") and loc.get("number")) or not hours:
            _, loc = self.call("phone-agent", "PUT", self.loc_path("/phone-agent"), route, {
                "enabled": True, "mode": loc.get("mode") if hours else "always",
                "agentHours": loc.get("agentHours") or {}, "version": int(loc.get("version") or 0)})
            notes.append("on, simulated number")
        setup = loc.get("setup") or {}
        if not setup.get("forwardedAt") or not setup.get("testedAt"):
            self.call("phone-agent", "POST", self.loc_path("/phone-agent/setup"), route + "/setup",
                      {"forwarded": True, "tested": True, "version": int(loc.get("version") or 0)})
            notes.append("forwarding and test call marked done")
        return "; ".join(notes) or None


def team_email(email, slug: str) -> bool:
    """A Booqy team address: the owner template's plus-address form at its
    domain (aws+<anything>@ithjalparna.se) or its base mailbox
    (aws@ithjalparna.se); with a template without a plus part, only the
    twin's owner and staff logins. Any other address at the domain is a
    person's, not fake."""
    if not isinstance(email, str) or "@" not in email:
        return False
    template = (env("DEV_TWIN_OWNER_EMAIL", "") or DEFAULT_OWNER_EMAIL).lower()
    local, _, domain = template.rpartition("@")
    prefix = local.split("{slug}", 1)[0]
    email = email.strip().lower()
    if prefix.endswith("+") and len(prefix) > 1:
        name, _, at = email.rpartition("@")
        return at == domain and (name == prefix[:-1] or (name.startswith(prefix) and len(name) > len(prefix)))
    return email in (owner_email(slug).lower(), owner_email(slug, "-personal").lower())


def _location_id(item: dict) -> str:
    return item.get("locationId") or str(item.get("SK") or "").removeprefix("LOCATION#")


def twin_locations(tenant_id: str) -> list[dict]:
    """The twin's location rows, oldest first."""
    items = query_all(TableName=location_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :l)",
                      ExpressionAttributeValues={":pk": {"S": f"TENANT#{tenant_id}"}, ":l": {"S": "LOCATION#"}})
    return sorted(items, key=lambda i: i.get("createdAt") or "")


def resolves(tenant_id: str, item: dict) -> bool:
    """Guests reach this location: as application shared/tenant.py
    tenant_of_location, a string tenantId equal to PK's tenant, a locationId
    that is the row's own, and no other tenant's row with that id in
    byLocationId (the index lags a just-repaired row, so this row is
    judged on its own fields)."""
    location_id = item.get("locationId")
    if item.get("tenantId") != tenant_id or item.get("PK") != f"TENANT#{tenant_id}" \
            or not isinstance(location_id, str) or item.get("SK") != f"LOCATION#{location_id}":
        return False
    rows = query_all(TableName=location_table(), IndexName=env("LOCATION_ID_INDEX_NAME", "byLocationId"),
                     KeyConditionExpression="locationId = :l", ExpressionAttributeValues={":l": {"S": location_id}})
    others = {r.get("tenantId") for r in rows if isinstance(r.get("tenantId"), str)
              and r.get("PK") == f"TENANT#{r.get('tenantId')}"} - {tenant_id}
    return not others


def _empty(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _zone(timezone: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(timezone or "Europe/Stockholm")
    except (KeyError, ValueError):
        return ZoneInfo("Europe/Stockholm")


def _today(timezone: str | None) -> date:
    from datetime import datetime
    return datetime.now(_zone(timezone)).date()


def _digits(value) -> str:
    """A phone number to compare: digits only, Swedish trunk 0 as 46."""
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if digits.startswith("00"):
        return digits[2:]
    return "46" + digits[1:] if digits.startswith("0") else digits


def _plain(value):
    """DynamoDB numbers as int or float (JSON and comparisons)."""
    from decimal import Decimal
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def _allergens(item: dict) -> list[str]:
    """A dish's EU allergen codes: the menu's own, else the seed's."""
    own = [a for a in item.get("allergens") or [] if a in CATERING_ALLERGENS]
    return own or list(DISH_ALLERGENS.get(item.get("name"), []))


def special_days(today: date) -> list[dict]:
    """Avvikande dagar ahead of `today`: Christmas Eve closed, New Year's Eve
    late, a private party (no online bookings) in two weeks."""
    def next_day(month: int, day: int) -> date:
        d = date(today.year, month, day)
        return d if d > today else date(today.year + 1, month, day)

    days = {
        next_day(12, 24): {"kind": "closed", "note": "Julafton, vi har stängt"},
        next_day(12, 31): {"kind": "hours", "intervals": [{"opensAt": "18:00", "closesAt": "23:30"}],
                           "note": "Nyårsmeny, sittning 18:00"},
        today + timedelta(days=14): {"kind": "no_online", "note": "Privat sällskap, ring oss för bord"},
    }
    return [{"date": d.isoformat(), **v} for d, v in sorted(days.items())]
