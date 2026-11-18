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

The seed sets up every Kom igång step through the admin's own functions,
invoked directly as an owner of the twin (application
shared/console_invoke.py, dev only): the DPA, location contact details,
opening hours and special days, booking rules, card guarantee and online
ordering, the menu (lunch, starters, mains, desserts, drinks), a published
and active table layout, a simulated printer, a staff login, the Google
profile skipped and the phone assistant on the simulated number. The
console's own routes do what only the console does (owner login, location,
printer, staff) and Stripe: the twin takes payments with one fully
onboarded TEST-mode connected account (DEV_TWIN_STRIPE_ACCOUNT_ID).

Idempotent: every step looks first and only adds what is missing (by name
for dishes and categories); a developer's changes to the twin stay. The
run's progress is PROFILE.devTwin (status queued, running, ready, partial,
failed; one line per step)."""

import json
from datetime import date, timedelta
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
STEPS = ("owner", "stripe", "location", "details", "menu", "layout", "printers", "staff", "dpa", "google", "phone")

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


def enabled() -> bool:
    return env("ENVIRONMENT", "prod") != "prod" and bool(env("DEV_TWIN_FUNCTION_PREFIX", ""))


def owner_email(slug: str, suffix: str = "") -> str:
    template = env("DEV_TWIN_OWNER_EMAIL", "") or DEFAULT_OWNER_EMAIL
    return template.replace("{slug}", f"{slug}{suffix}")


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
    if env("ENVIRONMENT", "prod") == "prod" or not env("DEV_TWIN_PROD_API_URL", ""):
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


def kick(tenant_id: str, requested_by: str, function_arn: str | None, *, run: int = 1) -> dict:
    """Queues a seed (an async invoke of this function); answers the state."""
    state = {"status": "queued", "requestedAt": now_iso(), "requestedBy": requested_by, "steps": {}}
    _save(tenant_id, state)
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
    _twin_only(profile)
    if (profile.get("devTwin") or {}).get("status") in ("queued", "running"):
        return 202, {"devTwin": profile["devTwin"]}
    state = kick(tenant_id, req.actor, req.function_arn)
    write_audit(tenant_id, "dev_twin_requested", req.actor, {})
    return 202, {"devTwin": state}


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
                kick(self.tenant_id, self.requested_by, self.context.invoked_function_arn, run=self.run_no + 1)
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

    # -- steps ------------------------------------------------------------
    def step_owner(self) -> str | None:
        """A Booqy team login owns the twin; the restaurant's details that an
        older mirror copied over are removed from the dev profile."""
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
        personal = [k for k in ("legalName", "orgNumber", "contactEmail", "contactPhone", "address")
                    if self.profile.get(k)]
        if personal:
            client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(self.tenant_id),
                                           UpdateExpression="REMOVE " + ", ".join(personal))
            notes.append("Restaurant's own details removed from the twin")
        return "; ".join(notes) or None

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
        from .locations import create_location
        items = query_all(TableName=location_table(), KeyConditionExpression="PK = :pk",
                          ExpressionAttributeValues={":pk": {"S": f"TENANT#{self.tenant_id}"}})
        items.sort(key=lambda i: i.get("createdAt") or "")
        if items:
            self.location = items[0]
            return None
        _, out = create_location(self.req({}, {"name": self.profile.get("name") or self.profile["slug"],
                                               "address": ADDRESS, "phone": PHONE}))
        self.location = out["location"]
        return "Location created"

    def need_location(self) -> None:
        if not self.location:
            raise StepFailed("No location (see the location step).")

    def step_details(self) -> str | None:
        """Contact details, opening hours, special days, booking rules, card
        guarantee and online ordering: only what the location lacks."""
        self.need_location()
        loc = self.location
        body = {}
        if not loc.get("address"):
            body["address"] = ADDRESS
        if not loc.get("phoneNumber"):
            body["phoneNumber"] = PHONE
        if not loc.get("email"):
            body["email"] = owner_email(self.profile["slug"])
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
        if not body:
            return None
        if not loc.get("email") and loc.get("phoneNumber"):
            body.setdefault("phoneNumber", loc["phoneNumber"])   # the first contact edit sends both
        if not loc.get("phoneNumber") and loc.get("email"):
            body.setdefault("email", loc["email"])
        _, out = self.call("create-location", "PUT", self.loc_path(), "/locations/{locationId}", body)
        if isinstance(out, dict) and out.get("locationId"):
            self.location = {**loc, **out}
        return "Set: " + ", ".join(sorted(body))

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


def _today(timezone: str | None) -> date:
    from datetime import datetime
    try:
        return datetime.now(ZoneInfo(timezone or "Europe/Stockholm")).date()
    except (KeyError, ValueError):
        return datetime.now(ZoneInfo("Europe/Stockholm")).date()


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
