"""Input validation. Every rule raises ApiError(400, "validation_failed")
with a per-field map, so the form can show messages next to the fields."""

import re
from decimal import Decimal

from .core import ApiError

SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$")
# Hostnames the platform uses (or will) under the platform domain.
RESERVED_SLUGS = {"app", "ops", "www", "mail", "api", "admin", "bounce", "status", "support",
                  "help", "docs", "static", "assets", "cdn", "auth", "login"}
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$")
PHONE_RE = re.compile(r"^\+?[0-9][0-9 ()-]{5,19}$")
ORG_NUMBER_RE = re.compile(r"^\d{6}-?\d{4}$")           # Swedish organisationsnummer
VAT_RE = re.compile(r"^SE\d{12}$")                       # Swedish momsregistreringsnummer
SENDER_RE = re.compile(r"^[A-Za-z0-9 ]{1,11}$")          # SMS alphanumeric sender id
HOST_RE = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
STRIPE_ACCOUNT_RE = re.compile(r"^acct_[A-Za-z0-9]{6,}$")
POSTAL_CODE_RE = re.compile(r"^\d{3} ?\d{2}$")


class Fields:
    """Collects field errors, raises them all at once."""

    def __init__(self, data: dict):
        self.data = data or {}
        self.errors: dict[str, str] = {}

    def fail(self, field: str, message: str) -> None:
        self.errors.setdefault(field, message)

    def done(self) -> None:
        if self.errors:
            raise ApiError(400, "validation_failed", "Some fields are invalid", fields=self.errors)

    def text(self, field, *, required=False, max_len=200, pattern=None, msg=None, lower=False):
        value = self.data.get(field)
        if value is None or (isinstance(value, str) and value.strip() == ""):
            if required:
                self.fail(field, "Required")
            return None
        if not isinstance(value, str):
            self.fail(field, "Must be text")
            return None
        value = value.strip()
        if lower:
            value = value.lower()
        if len(value) > max_len:
            self.fail(field, f"At most {max_len} characters")
            return None
        if pattern is not None and not pattern.match(value):
            self.fail(field, msg or "Invalid format")
            return None
        return value

    def email(self, field, required=False):
        return self.text(field, required=required, max_len=254, pattern=EMAIL_RE,
                         msg="Not a valid email address", lower=True)

    def phone(self, field, required=False):
        return self.text(field, required=required, max_len=20, pattern=PHONE_RE, msg="Not a valid phone number")

    def integer(self, field, *, required=False, minimum=None, maximum=None):
        value = self.data.get(field)
        if value is None:
            if required:
                self.fail(field, "Required")
            return None
        if isinstance(value, bool) or not isinstance(value, (int, Decimal)) or value != int(value):
            self.fail(field, "Must be a whole number")
            return None
        value = int(value)
        if minimum is not None and value < minimum:
            self.fail(field, f"At least {minimum}")
            return None
        if maximum is not None and value > maximum:
            self.fail(field, f"At most {maximum}")
            return None
        return value

    def boolean(self, field):
        value = self.data.get(field)
        if value is None:
            return None
        if not isinstance(value, bool):
            self.fail(field, "Must be true or false")
            return None
        return value


def slug(f: Fields, field="slug"):
    value = f.text(field, required=True, max_len=40, lower=True, pattern=SLUG_RE,
                   msg="3-40 characters: a-z, 0-9 and '-', not starting or ending with '-'")
    if value in RESERVED_SLUGS:
        f.fail(field, "Reserved name - pick another")
        return None
    return value


def address(f: Fields, field="address", required=False):
    """{street, postalCode, city, country} - stored as a map on the tenant."""
    value = f.data.get(field)
    if value is None:
        if required:
            f.fail(field, "Required")
        return None
    if not isinstance(value, dict):
        f.fail(field, "Must be an object")
        return None
    sub = Fields(value)
    out = {
        "street": sub.text("street", required=True, max_len=120),
        "postalCode": sub.text("postalCode", required=True, max_len=10, pattern=POSTAL_CODE_RE,
                               msg="Swedish postal code, e.g. 123 45"),
        "city": sub.text("city", required=True, max_len=80),
        "country": (sub.text("country", max_len=2) or "SE").upper(),
    }
    for k, msg in sub.errors.items():
        f.fail(f"{field}.{k}", msg)
    return None if sub.errors else out


def location_fields(data: dict, *, partial: bool, prefix: str = "") -> dict:
    """A restaurant location. `address` is a single line (the shape the admin
    app and the public endpoints already use)."""
    f = Fields(data)
    out = {
        "name": f.text("name", required=not partial, max_len=100),
        "address": f.text("address", required=not partial, max_len=200),
        "phone": f.phone("phone"),
        "email": f.email("email"),
    }
    if "stripeAccountId" in data:
        raw = data.get("stripeAccountId")
        if raw in (None, ""):
            out["stripeAccountId"] = ""          # "" = remove the override
        else:
            out["stripeAccountId"] = f.text("stripeAccountId", max_len=64, pattern=STRIPE_ACCOUNT_RE,
                                            msg="Stripe account id, e.g. acct_1A2b3C")
    if f.errors:
        raise ApiError(400, "validation_failed", "Some fields are invalid",
                       fields={f"{prefix}{k}": v for k, v in f.errors.items()})
    return {k: v for k, v in out.items() if v is not None}


def hostname(value) -> str:
    if not isinstance(value, str):
        raise ApiError(400, "validation_failed", "Invalid domain", fields={"domain": "Required"})
    host = value.strip().lower().rstrip(".")
    if host.startswith(("http://", "https://")) or "/" in host or "*" in host or not HOST_RE.match(host):
        raise ApiError(400, "validation_failed", "Invalid domain",
                       fields={"domain": "A hostname like www.restaurang.se (no https://, no wildcards)"})
    return host


# --- the admin app's location contract ----------------------------------------
# The application backend (get-location, create-location, availability, ...)
# requires these on every location row and refuses rows without them. A new
# location starts CLOSED every day: nothing can be booked until the restaurant
# owner sets real opening hours in the admin app.
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
APP_LOCATION_DEFAULTS = {
    "timezone": "Europe/Stockholm",
    "businessHours": {day: [] for day in WEEKDAYS},
    "bookingDurationHours": 2,
    "gracePeriodHours": 0,
}
E164_RE = re.compile(r"^\+[1-9][0-9]{7,14}$")


def e164(phone: str | None, default_country: str = "46") -> str | None:
    """'070-123 45 67' -> '+46701234567'; None when it can't be made E.164
    (the app only accepts E.164 in `phoneNumber`)."""
    if not phone:
        return None
    digits = re.sub(r"[\s()-]", "", phone)
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    elif digits.startswith("0"):
        digits = f"+{default_country}{digits[1:]}"
    elif not digits.startswith("+"):
        digits = f"+{default_country}{digits}"
    return digits if E164_RE.match(digits) else None


def app_location_fields(fields: dict) -> dict:
    """What a NEW location row needs on top of the operator's fields."""
    out = dict(APP_LOCATION_DEFAULTS)
    number = e164(fields.get("phone"))
    if number:
        out["phoneNumber"] = number
    return out
