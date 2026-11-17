"""Input validation. Every rule raises ApiError(400, "validation_failed")
with a per-field map, so the form can show messages next to the fields."""

import re
from decimal import Decimal

from .core import ApiError

SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$")
# Hostnames the platform uses (or will) under the platform domain.
RESERVED_SLUGS = {"app", "ops", "www", "mail", "api", "admin", "bounce", "status", "support",
                  "help", "docs", "static", "assets", "cdn", "auth", "login",
                  "restaurang", "restaurant",   # the admin app (and its old name)
                  "dev", "staging",             # delegated environment zones (dev.booqy.se)
                  "test", "test-dev"}           # the dev account's test sites zones (test.booqy.se, test-dev.booqy.se)
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$")
PHONE_RE = re.compile(r"^\+?[0-9][0-9 ()-]{5,19}$")
ORG_NUMBER_RE = re.compile(r"^\d{6}-?\d{4}$")           # Swedish organisationsnummer
VAT_RE = re.compile(r"^SE\d{12}$")                       # Swedish momsregistreringsnummer
SENDER_RE = re.compile(r"^[A-Za-z0-9 ]{1,11}$")          # SMS alphanumeric sender id
HOST_RE = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
STRIPE_ACCOUNT_RE = re.compile(r"^acct_[A-Za-z0-9]{6,}$")
POSTAL_CODE_RE = re.compile(r"^\d{3} ?\d{2}$")


def fields_message(n: int = 0) -> str:
    """The sentence above a form with marked fields."""
    if n > 1:
        return f"{n} fields need a change. Fix the marked fields and save again."
    return "A field needs a change. Fix the marked field and save again."


REQUIRED = "Fill this in."


class Fields:
    """Collects field errors, raises them all at once."""

    def __init__(self, data: dict):
        self.data = data or {}
        self.errors: dict[str, str] = {}

    def fail(self, field: str, message: str) -> None:
        self.errors.setdefault(field, message)

    def done(self) -> None:
        if self.errors:
            n = len(self.errors)
            raise ApiError(400, "validation_failed", fields_message(n), fields=self.errors)

    def text(self, field, *, required=False, max_len=200, pattern=None, msg=None, lower=False):
        value = self.data.get(field)
        if value is None or (isinstance(value, str) and value.strip() == ""):
            if required:
                self.fail(field, REQUIRED)
            return None
        if not isinstance(value, str):
            self.fail(field, "Write this as text.")
            return None
        value = value.strip()
        if lower:
            value = value.lower()
        if len(value) > max_len:
            self.fail(field, f"Too long. Use at most {max_len} characters.")
            return None
        if pattern is not None and not pattern.match(value):
            self.fail(field, msg or "This doesn't look right. Check it for typos.")
            return None
        return value

    def email(self, field, required=False):
        return self.text(field, required=required, max_len=254, pattern=EMAIL_RE,
                         msg="This email looks wrong. Write it like anna@restaurang.se.", lower=True)

    def phone(self, field, required=False):
        return self.text(field, required=required, max_len=20, pattern=PHONE_RE,
                         msg="This phone number looks wrong. Write it like 070-123 45 67.")

    def integer(self, field, *, required=False, minimum=None, maximum=None):
        value = self.data.get(field)
        if value is None:
            if required:
                self.fail(field, REQUIRED)
            return None
        if isinstance(value, bool) or not isinstance(value, (int, Decimal)) or value != int(value):
            self.fail(field, "Use a whole number, e.g. 3.")
            return None
        value = int(value)
        if minimum is not None and value < minimum:
            self.fail(field, f"Too low. Use {minimum} or more.")
            return None
        if maximum is not None and value > maximum:
            self.fail(field, f"Too high. Use {maximum} or less.")
            return None
        return value

    def boolean(self, field):
        value = self.data.get(field)
        if value is None:
            return None
        if not isinstance(value, bool):
            self.fail(field, "Pick yes or no.")
            return None
        return value


def slug(f: Fields, field="slug"):
    value = f.text(field, required=True, max_len=40, lower=True, pattern=SLUG_RE,
                   msg="Use 3-40 small letters, digits or hyphens, e.g. pizzeria-roma.")
    if value in RESERVED_SLUGS:
        f.fail(field, "Booqy uses this name itself. Pick another, e.g. pizzeria-roma.")
        return None
    return value


def luhn_ok(digits: str) -> bool:
    """Swedish org. numbers (and personnummer) end in a Luhn check digit."""
    total = 0
    for i, ch in enumerate(digits[:-1]):
        n = int(ch) * (2 if i % 2 == 0 else 1)
        total += n - 9 if n > 9 else n
    return (10 - total % 10) % 10 == int(digits[-1])


def org_number(f: Fields, field="orgNumber"):
    """'5566778899' or '556677-8899' -> '556677-8899', check digit verified."""
    value = f.text(field, max_len=11, pattern=ORG_NUMBER_RE,
                   msg="Write 10 digits like 556677-8899.")
    if value is None:
        return None
    digits = value.replace("-", "")
    if not luhn_ok(digits):
        f.fail(field, "The last digit doesn't fit the others. Check for a typo.")
        return None
    return f"{digits[:6]}-{digits[6:]}"


def vat_number(f: Fields, org: str | None, field="vatNumber"):
    """A Swedish VAT number is SE + the 10-digit org. number + 01."""
    value = f.text(field, max_len=14, pattern=VAT_RE,
                   msg="Write SE, the org. number and 01, e.g. SE556677889901.")
    if value and org:
        expected = f"SE{org.replace('-', '')}01"
        if value != expected:
            f.fail(field, f"This doesn't match the org. number. It should be {expected}.")
            return None
    return value


def address(f: Fields, field="address", required=False):
    """{street, postalCode, city, country} - stored as a map on the tenant."""
    value = f.data.get(field)
    if value is None:
        if required:
            f.fail(field, REQUIRED)
        return None
    if not isinstance(value, dict):
        f.fail(field, "Fill in street, postal code and city.")
        return None
    sub = Fields(value)
    out = {
        "street": sub.text("street", required=True, max_len=120),
        "postalCode": sub.text("postalCode", required=True, max_len=10, pattern=POSTAL_CODE_RE,
                               msg="Write a Swedish postal code, e.g. 123 45."),
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
                                            msg="Write a Stripe account id, e.g. acct_1A2b3C.")
    if f.errors:
        raise ApiError(400, "validation_failed", fields_message(len(f.errors)),
                       fields={f"{prefix}{k}": v for k, v in f.errors.items()})
    return {k: v for k, v in out.items() if v is not None}


def hostname(value) -> str:
    if not isinstance(value, str):
        raise ApiError(400, "validation_failed", "Type the domain, e.g. www.restaurang.se.",
                       fields={"domain": "Fill this in, e.g. www.restaurang.se."})
    host = value.strip().lower().rstrip(".")
    if host.startswith(("http://", "https://")) or "/" in host or "*" in host or not HOST_RE.match(host):
        raise ApiError(400, "validation_failed", "The domain looks wrong. Write it like www.restaurang.se.",
                       fields={"domain": "Write it like www.restaurang.se, without https:// or *."})
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
    "gracePeriodHours": Decimal("0.25"),  # 15 min, the shortest the admin offers
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
