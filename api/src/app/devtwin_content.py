"""A dev twin copies the real restaurant's PUBLIC content (dev only).

Copying goes prod -> dev only, and only what any guest can already see on the
restaurant's website: dev reads prod's public API (site-config, the public
menu, the active table layout, the menu photos on the public CDN). Never
copied: Stripe accounts and keys, payments, bookings, orders, guests, staff
and their logins, phone and SMS numbers, email addresses, API keys; the twin
keeps its own fake versions (devtwin.py). Rules: BooqyCustomers/site-template
docs/DATA-RULES.md.

Started by prod (Tenant.SetupCompleted -> site-repo twinContent -> the site
task "content") or by "Copy public content now" on the twin in Booqy Console
Dev. Written through the admin's own functions as the twin's owner, like the
seed. The twin then mirrors prod's public content: dishes and categories by
name (a dish prod doesn't have is removed), the location's hours, special
days and booking rules, and prod's active layout (published and activated
again only when prod's changed). Progress: PROFILE.devTwinContent."""

import hashlib
import json
import urllib.error
import urllib.request

from .core import client, env, now_iso, tenant_table, to_ddb_value
from .devtwin import OPERATOR, Seeder, StepFailed, _self_arn, prod_public, prod_site
from .tenants import get_profile, tkey

STEPS = ("source", "location", "menu", "layout")
GUARANTEE_FIELDS = ("enabled", "minPartySize", "noShowFeePerPerson", "lateCancelFeePerPerson", "cancelCutoffHours")
ORDERING_FIELDS = ("enabled", "pickup", "prepMinutes", "lastOrderMinutes")
SPECIAL_DAY_FIELDS = ("date", "kind", "intervals", "note")
DISH_FIELDS = ("description", "price", "alcohol", "allergens", "options", "imageFocus")
MENU_ROUTE = "/locations/{locationId}/menu/{proxy+}"
ELEMENT_ROUTE = "/locations/{locationId}/layout-elements/{proxy+}"
IMAGE_TYPES = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp", "avif": "image/avif"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024


def _save(tenant_id: str, state: dict) -> None:
    client("dynamodb").update_item(TableName=tenant_table(), Key=tkey(tenant_id),
                                   UpdateExpression="SET devTwinContent = :d", ConditionExpression="attribute_exists(PK)",
                                   ExpressionAttributeValues={":d": to_ddb_value(state)})


def kick_content(tenant_id: str, requested_by: str, function_arn: str | None) -> dict:
    previous = get_profile(tenant_id).get("devTwinContent") or {}
    state = {**{k: previous[k] for k in ("images", "layoutHash", "copiedAt") if k in previous},
             "status": "queued", "requestedAt": now_iso(), "requestedBy": requested_by, "steps": {}}
    _save(tenant_id, state)
    if function_arn:
        client("lambda").invoke(FunctionName=_self_arn(function_arn), InvocationType="Event",
                                Payload=json.dumps({"twinTask": {"tenantId": tenant_id, "requestedBy": requested_by,
                                                                 "mode": "content"}}).encode())
    return state


class ContentCopy(Seeder):
    def run(self) -> dict:
        from .devtwin import is_twin
        profile = get_profile(self.tenant_id, required=False)
        if not profile or not is_twin(profile) or profile.get("status") != "active":
            return {"status": "skipped"}
        self.profile = profile
        previous = profile.get("devTwinContent") or {}
        self.images: dict = dict(previous.get("images") or {})
        self.state = {"status": "running", "requestedBy": self.requested_by, "startedAt": now_iso(), "steps": {},
                      **({"layoutHash": previous["layoutHash"]} if previous.get("layoutHash") else {})}
        _save(self.tenant_id, self.state)
        self.prod_location = None
        for step in STEPS:
            try:
                note = getattr(self, f"copy_{step}")()
                self.state["steps"][step] = {"ok": True, "note": note or "Same as prod"}
            except StepFailed as e:
                self.state["steps"][step] = {"ok": False, "note": str(e)[:300]}
                if step == "source":
                    break
            self.state["images"] = self.images
            _save(self.tenant_id, self.state)
        failed = [s for s, r in self.state["steps"].items() if not r["ok"]]
        self.state.update(status="partial" if failed else "ready", finishedAt=now_iso(), images=self.images)
        if not failed:
            self.state["copiedAt"] = self.state["finishedAt"]
        _save(self.tenant_id, self.state)
        from .core import write_audit
        write_audit(self.tenant_id, "dev_twin_content_copied", OPERATOR, {"status": self.state["status"],
                                                                          "failed": failed})
        return {"status": self.state["status"], "failed": failed}

    # -- prod -------------------------------------------------------------
    def copy_source(self) -> str:
        site = prod_site(self.profile["slug"])
        if not site or (site.get("tenant") or {}).get("slug") != self.profile["slug"]:
            raise StepFailed(f"Prod has no public site for {self.profile['slug']} yet. The restaurant finishes its "
                             "setup in prod first.")
        prod_id = site["tenant"].get("tenantId")
        twin_of = (self.profile.get("twinOf") or {}).get("tenantId")
        if twin_of and prod_id != twin_of:
            raise StepFailed("Prod's customer with this slug is not the one this twin belongs to. Nothing copied.")
        locations = site.get("locations") or []
        if not locations:
            raise StepFailed("The prod restaurant has no location yet.")
        self.prod_location = locations[0]
        self.location = self._twin_location()
        note = f"Prod location {self.prod_location.get('name') or ''}".strip()
        return note + (f" (first of {len(locations)})" if len(locations) > 1 else "")

    def _twin_location(self) -> dict:
        from .core import location_table, query_all
        items = query_all(TableName=location_table(), KeyConditionExpression="PK = :pk",
                          ExpressionAttributeValues={":pk": {"S": f"TENANT#{self.tenant_id}"}})
        if not items:
            raise StepFailed("The twin has no location. Refresh the dev twin first.")
        return sorted(items, key=lambda i: i.get("createdAt") or "")[0]

    def prod_path(self, rest: str) -> str:
        return f"/locations/{self.prod_location['locationId']}{rest}"

    # -- location ---------------------------------------------------------
    def copy_location(self) -> str | None:
        """Name, address, hours, special days and booking rules; never the
        restaurant's phone number or email (the twin keeps its own)."""
        src, loc = self.prod_location, self.location
        want = {k: src[k] for k in ("name", "address", "timezone", "businessHours", "bookingDurationHours",
                                    "maxPartySizeOnline") if src.get(k) not in (None, "")}
        if src.get("gracePeriodMinutes") is not None:
            want["gracePeriodHours"] = round(float(src["gracePeriodMinutes"]) / 60, 6)
        want["specialDays"] = [{k: d[k] for k in SPECIAL_DAY_FIELDS if k in d} for d in src.get("specialDays") or []]
        for key, fields in (("guarantee", GUARANTEE_FIELDS), ("ordering", ORDERING_FIELDS)):
            if isinstance(src.get(key), dict):
                want[key] = {k: src[key][k] for k in fields if k in src[key]}
        body = {k: v for k, v in want.items() if _plain(loc.get(k)) != _plain(v)}
        if not body:
            return None
        self.call("create-location", "PUT", self.loc_path(), "/locations/{locationId}", body)
        return "Updated: " + ", ".join(sorted(body))

    # -- menu -------------------------------------------------------------
    def copy_menu(self) -> str | None:
        menu = prod_public(self.prod_path("/menu"))
        if not menu:
            raise StepFailed("Prod has no public menu yet.")
        prod_items = [i for i in menu.get("items") or [] if i.get("name")]
        prod_cats = menu.get("categories") or []
        prod_cat_name = {c["categoryId"]: c["name"] for c in prod_cats}
        names = [c["name"] for c in prod_cats]
        _, cats = self.call("get-menu", "GET", self.loc_path("/menu/categories"), MENU_ROUTE)
        twin_cats = list(cats.get("categories") or [])
        have = {c["name"] for c in twin_cats}
        notes = []
        if any(n not in have for n in names):      # add first; removing comes after the dishes moved
            cats = self._put_categories(twin_cats + [{"name": n} for n in names if n not in have], cats)
            notes.append("categories")
        cat_id = {c["name"]: c["categoryId"] for c in cats.get("categories") or []}
        _, items = self.call("get-menu", "GET", self.loc_path("/menu/items"), MENU_ROUTE)
        twin_items = {i["name"]: i for i in items.get("items") or []}
        added = changed = removed = 0
        for item in prod_items:
            want = {k: item[k] for k in DISH_FIELDS if k in item}
            want.update(name=item["name"], active=True, alcohol=bool(item.get("alcohol")),
                        category=cat_id.get(prod_cat_name.get(item.get("category"), ""), next(iter(cat_id.values()))),
                        imageKey=self._photo(item.get("imageKey")))
            mine = twin_items.get(item["name"])
            if not mine:
                self.call("manage-menu", "POST", self.loc_path("/menu/items"), MENU_ROUTE, want)
                added += 1
                continue
            diff = {k: v for k, v in want.items() if _plain(mine.get(k)) != _plain(v)}
            if diff:
                self.call("manage-menu", "PUT", self.loc_path(f"/menu/items/{mine['menuItemId']}"), MENU_ROUTE, diff)
                changed += 1
        prod_names = {i["name"] for i in prod_items}
        for name, mine in twin_items.items():
            if name not in prod_names:
                self.call("manage-menu", "DELETE", self.loc_path(f"/menu/items/{mine['menuItemId']}"), MENU_ROUTE)
                removed += 1
        ordered = [{"categoryId": cat_id[n], "name": n} for n in names if n in cat_id]
        if ordered and [c["name"] for c in cats.get("categories") or []] != names:
            self._put_categories(ordered, cats)
            notes.append("category order")
        counts = [f"{n} {w}" for n, w in ((added, "added"), (changed, "changed"), (removed, "removed")) if n]
        if counts:
            notes.insert(0, "dishes " + ", ".join(counts))
        return "; ".join(notes) or None

    def _put_categories(self, entries: list[dict], current: dict) -> dict:
        body = {"categories": [{k: c[k] for k in ("categoryId", "name") if k in c} for c in entries],
                "version": current.get("version", 0)}
        status, out = self.call("manage-menu", "PUT", self.loc_path("/menu/categories"), MENU_ROUTE, body,
                                ok=(200, 409))
        if status == 409 and out.get("code") == "stale_categories":
            body["version"] = out.get("version", 0)
            _, out = self.call("manage-menu", "PUT", self.loc_path("/menu/categories"), MENU_ROUTE, body)
        elif status == 409:
            raise StepFailed(f"manage-menu PUT categories: 409 {out.get('code')}")
        return out

    def _photo(self, prod_key: str | None) -> str | None:
        """The prod photo uploaded to the twin once (kept by prod key)."""
        if not prod_key:
            return None
        if prod_key in self.images:
            return self.images[prod_key]
        base = env("DEV_TWIN_PROD_IMAGE_URL", "").rstrip("/")
        if not base:
            return None
        ext = prod_key.rsplit(".", 1)[-1].lower()
        content_type = IMAGE_TYPES.get(ext)
        if not content_type:
            return None
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{base}/{prod_key}", headers={
                    "User-Agent": "booqy-dev-twin/1"}), timeout=20) as response:
                data = response.read(MAX_IMAGE_BYTES + 1)
        except (urllib.error.URLError, TimeoutError):
            raise StepFailed("A dish photo couldn't be read from prod. Try again.") from None
        if len(data) > MAX_IMAGE_BYTES:
            return None
        _, upload = self.call("pre-signed-url", "GET", "/menu-images/presigned-url", query={
            "locationId": self.location["locationId"], "contentType": content_type, "size": str(len(data))})
        put = urllib.request.Request(upload["uploadUrl"], data=data, method="PUT",
                                     headers=upload.get("requiredHeaders") or {"Content-Type": content_type})
        try:
            urllib.request.urlopen(put, timeout=30).close()
        except (urllib.error.URLError, TimeoutError):
            raise StepFailed("A dish photo couldn't be uploaded to the twin. Try again.") from None
        self.images[prod_key] = upload["imageKey"]
        return upload["imageKey"]

    # -- layout -----------------------------------------------------------
    def copy_layout(self) -> str | None:
        layout = prod_public(self.prod_path("/layout/active")) or {}
        floors, elements = layout.get("floors") or [], layout.get("elements") or []
        if not elements:
            return "Prod has no active table layout yet"
        digest = hashlib.sha256(json.dumps(layout, sort_keys=True, default=str).encode()).hexdigest()
        if self.state.get("layoutHash") == digest:
            return None
        _, existing = self.call("manage-layout-element", "GET", self.loc_path("/layout-elements/items"), ELEMENT_ROUTE)
        for element in (existing.get("items") if isinstance(existing, dict) else existing) or []:
            self.call("manage-layout-element", "DELETE", self.loc_path(f"/layout-elements/items/{element['elementId']}"),
                      ELEMENT_ROUTE)
        ids: dict = {}

        def add(fields: dict) -> None:
            _, out = self.call("manage-layout-element", "POST", self.loc_path("/layout-elements/items"), ELEMENT_ROUTE,
                               fields)
            ids[fields.pop("_from")] = out["elementId"]

        for floor in floors:
            mine = [e for e in elements if e.get("floorId") == floor["floorId"]] or elements
            span_x = max(abs(float(e.get("x", 0))) + float(e.get("width", 1)) for e in mine)
            span_z = max(abs(float(e.get("z", 0))) + float(e.get("depth", 1)) for e in mine)
            add({"_from": floor["floorId"], "type": "floor", "name": floor.get("name") or "Matsal",
                 "level": floor.get("level", 0), "x": 0, "y": 0, "z": 0, "rotationY": 0,
                 "width": round(2 * span_x, 2), "height": 3, "depth": round(2 * span_z, 2)})
        order = {"wall": 0, "floorArea": 1, "door": 2, "window": 2}
        for e in sorted(elements, key=lambda e: order.get(e.get("type"), 3)):
            fields = {k: v for k, v in e.items() if k not in ("elementId",)}
            for ref in ("floorId", "wallId"):
                if fields.get(ref):
                    if fields[ref] not in ids:
                        fields.pop(ref)
                    else:
                        fields[ref] = ids[fields[ref]]
            add({"_from": e["elementId"], **fields})
        _, snapshot = self.call("publish-layout", "POST", self.loc_path("/layout/publish"),
                                "/locations/{locationId}/layout/publish", {})
        version = snapshot.get("version")
        route = "/locations/{locationId}/layout/versions/{versionId}/activate"
        path = self.loc_path(f"/layout/versions/{version}/activate")
        status, out = self.call("activate-layout-version", "POST", path, route, {}, ok=(200, 201, 204, 409))
        note = f"version {version} published and active"
        if status == 409 and out.get("code") == "too_early":
            self.call("activate-layout-version", "POST", path, route, {"effectiveFrom": out["earliestCutoverAt"]})
            note = f"version {version} published, active from {out['earliestCutoverAt']}"
        elif status == 409:
            raise StepFailed(f"Prod's layout was published (version {version}) but not activated: {out.get('code')}")
        self.state["layoutHash"] = digest
        return f"{len(elements)} elements; {note}"


def _plain(value):
    """Comparable JSON form (DynamoDB Decimals and ints alike)."""
    return json.loads(json.dumps(value, sort_keys=True, default=lambda d: float(d)))
