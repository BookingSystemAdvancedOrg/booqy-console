"""News to the restaurant owners: newsletters, what's coming, important
notices, sent from the platform's no-reply address with replies going to
support. One stored brand template (sender name, logo, colour, signature,
footer) dresses every newsletter the same way.

Rows in the tenant table, all under PK PLATFORM#MAIL:
    SK TEMPLATE                      the brand template (one row)
    SK NEWSLETTER#<iso>#<id>         one row per newsletter: subject, body,
                                     recipient snapshot, counts, status

Sending: a test goes to the operator who asked (one email, in the request).
A real send writes the row (status "sending") and the Lambda invokes itself
asynchronously ({"mailTask": "send", ...}) so the API returns at once; the
task sends one email at a time and hands over to a fresh invocation before
the timeout. Without a function ARN (tests) it sends in the request.

Email: multipart/related (text + HTML + the logo as an inline image,
cid:logo), SendRawEmail. In dev with the mail outbox on, the message is
saved there instead (logo as a data URI so the outbox can show it).

Env: NO_REPLY_EMAIL_ADDRESS (From), SUPPORT_EMAIL_ADDRESS (default
Reply-To), MAIL_OUTBOX_BUCKET_NAME (dev only), OPERATOR_USER_POOL_ID (the
test recipient's address)."""

import base64
import binascii
import html
import json
import re
import time
import uuid
from datetime import datetime, timezone
from email.header import Header
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from pathlib import Path

from botocore.exceptions import BotoCoreError, ClientError

from . import validation as v
from .core import ApiError, client, env, from_ddb, log, new_id, not_found, now_iso, query_all, tenant_table, to_ddb

PK = "PLATFORM#MAIL"
TEMPLATE_SK = "TEMPLATE"
NEWSLETTER_PREFIX = "NEWSLETTER#"
DEFAULT_REPLY_TO = "support@ithjalparna.se"
DEFAULT_ACCENT = "#350001"
LOGO_MAX_BYTES = 200_000
LOGO_TYPES = {"image/png": "png", "image/jpeg": "jpg"}
SUBJECT_MAX = 150
BODY_MAX = 20_000
SEND_PAUSE_S = 0.12          # ~8/s, under the SES rate; the sandbox is 1/s and retries cover that
HANDOVER_MS = 6_000          # re-invoke when less than this remains
HEX_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")
URL_RE = re.compile(r"(https?://[^\s<>\"']+)")
_INVERT_MS = 10 ** 13 - 1


# ------------------------------------------------------------------ template
def _default_template() -> dict:
    return {
        "senderName": "Booqy",
        "replyTo": env("SUPPORT_EMAIL_ADDRESS", DEFAULT_REPLY_TO) or DEFAULT_REPLY_TO,
        "logo": {"kind": "booqy"},
        "accentColor": DEFAULT_ACCENT,
        "signature": "Vänliga hälsningar\nTeamet bakom Booqy",
        "footer": "Booqy drivs av IT-hjälparna. Du får det här mejlet för att din restaurang använder Booqy.",
    }


def _load_template() -> dict:
    row = from_ddb(client("dynamodb").get_item(
        TableName=tenant_table(), Key={"PK": {"S": PK}, "SK": {"S": TEMPLATE_SK}}).get("Item"))
    template = _default_template()
    if row:
        for key in ("senderName", "replyTo", "logo", "accentColor", "signature", "footer", "updatedAt", "updatedBy"):
            if row.get(key) is not None:
                template[key] = row[key]
    return template


def _public_template(template: dict) -> dict:
    """The template as the console sees it: the logo bytes stay out of the
    JSON except as a data URI for the picker's preview."""
    out = {k: template.get(k) for k in ("senderName", "replyTo", "accentColor", "signature", "footer", "updatedAt", "updatedBy")}
    logo = template.get("logo") or {"kind": "booqy"}
    out["logo"] = {"kind": logo.get("kind", "booqy"), "name": logo.get("name"),
                   "dataUrl": _logo_data_url(template)}
    out["from"] = env("NO_REPLY_EMAIL_ADDRESS", "no-reply@booqy.se")
    return out


def get_template(req) -> tuple[int, dict]:
    return 200, {"template": _public_template(_load_template())}


def _parse_logo(f: v.Fields, current: dict) -> dict | None:
    raw = f.data.get("logo")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        f.fail("logo", "Must be an object")
        return None
    kind = raw.get("kind")
    if kind == "booqy":
        return {"kind": "booqy"}
    if kind != "custom":
        f.fail("logo.kind", "Must be booqy or custom")
        return None
    data_url = raw.get("dataUrl")
    if not data_url:
        # Keep the logo already uploaded.
        if (current.get("logo") or {}).get("kind") == "custom":
            return current["logo"]
        f.fail("logo", "Upload a PNG or JPEG logo, or choose the Booqy logo")
        return None
    match = re.match(r"^data:(image/png|image/jpeg);base64,([A-Za-z0-9+/=\s]+)$", str(data_url))
    if not match:
        f.fail("logo", "The logo must be a PNG or JPEG")
        return None
    try:
        blob = base64.b64decode(match.group(2), validate=False)
    except (binascii.Error, ValueError):
        f.fail("logo", "The logo file is damaged")
        return None
    if len(blob) > LOGO_MAX_BYTES:
        f.fail("logo", f"The logo must be under {LOGO_MAX_BYTES // 1000} kB (the console shrinks it; try a smaller file)")
        return None
    name = str(raw.get("name") or "logo")[:100]
    return {"kind": "custom", "contentType": match.group(1), "data": base64.b64encode(blob).decode("ascii"), "name": name}


def put_template(req) -> tuple[int, dict]:
    current = _load_template()
    f = v.Fields(req.body)
    sender = f.text("senderName", required=True, max_len=60)
    reply_to = f.email("replyTo", required=True)
    accent = f.text("accentColor", required=True, max_len=7, pattern=HEX_COLOUR, msg="A colour like #350001")
    signature = f.text("signature", max_len=600) or ""
    footer = f.text("footer", max_len=600) or ""
    logo = _parse_logo(f, current)
    f.done()
    row = {"PK": PK, "SK": TEMPLATE_SK, "senderName": sender, "replyTo": reply_to, "accentColor": accent,
           "signature": signature, "footer": footer, "logo": logo or current.get("logo") or {"kind": "booqy"},
           "updatedAt": now_iso(), "updatedBy": req.actor}
    client("dynamodb").put_item(TableName=tenant_table(), Item=to_ddb(row))
    return 200, {"template": _public_template(_load_template())}


# ---------------------------------------------------------------------- logo
def _booqy_logo() -> bytes:
    return (Path(__file__).parent / "assets" / "booqy-logo.png").read_bytes()


def _logo_bytes(template: dict) -> tuple[bytes, str]:
    logo = template.get("logo") or {}
    if logo.get("kind") == "custom" and logo.get("data"):
        return base64.b64decode(logo["data"]), logo.get("contentType") or "image/png"
    return _booqy_logo(), "image/png"


def _logo_data_url(template: dict) -> str:
    blob, content_type = _logo_bytes(template)
    return f"data:{content_type};base64,{base64.b64encode(blob).decode('ascii')}"


# ----------------------------------------------------------------- rendering
def _esc(text: str) -> str:
    return html.escape(text, quote=True)


def _inline(text: str, accent: str) -> str:
    """Escape, then turn URLs into links and **bold** into <strong>."""
    parts = []
    for i, piece in enumerate(URL_RE.split(text)):
        if i % 2 == 1:
            parts.append(f'<a href="{_esc(piece)}" style="color:{accent};text-decoration:underline">{_esc(piece)}</a>')
        else:
            escaped = _esc(piece)
            escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
            parts.append(escaped)
    return "".join(parts)


def _blocks(body: str) -> list[tuple[str, list[str]]]:
    """Paragraphs are separated by blank lines; lines starting with "- " form
    a list; a line starting with "# " is a heading."""
    blocks: list[tuple[str, list[str]]] = []
    for chunk in re.split(r"\n\s*\n", body.strip().replace("\r\n", "\n")):
        lines = [l.rstrip() for l in chunk.split("\n") if l.strip()]
        if not lines:
            continue
        if all(l.lstrip().startswith(("- ", "* ")) for l in lines):
            blocks.append(("list", [l.lstrip()[2:].strip() for l in lines]))
        elif len(lines) == 1 and lines[0].startswith("# "):
            blocks.append(("heading", [lines[0][2:].strip()]))
        else:
            blocks.append(("para", lines))
    return blocks


def render_text(subject: str, body: str, template: dict) -> str:
    lines = [subject, "=" * min(len(subject), 60), ""]
    for kind, items in _blocks(body):
        if kind == "list":
            lines.extend(f"- {i}" for i in items)
        elif kind == "heading":
            lines.append(items[0].upper())
        else:
            lines.extend(items)
        lines.append("")
    if template.get("signature"):
        lines.extend([template["signature"].strip(), ""])
    lines.append("-- ")
    if template.get("footer"):
        lines.append(template["footer"].strip())
    lines.append(f"Frågor? Svara på mejlet eller skriv till {template.get('replyTo') or DEFAULT_REPLY_TO}.")
    return "\n".join(lines).strip() + "\n"


def render_html(subject: str, body: str, template: dict, *, logo_src: str) -> str:
    accent = template.get("accentColor") or DEFAULT_ACCENT
    if not HEX_COLOUR.match(accent):
        accent = DEFAULT_ACCENT
    font = "Archivo, 'Helvetica Neue', Helvetica, Arial, sans-serif"
    parts = []
    for kind, items in _blocks(body):
        if kind == "list":
            lis = "".join(f'<li style="margin:0 0 6px">{_inline(i, accent)}</li>' for i in items)
            parts.append(f'<ul style="margin:0 0 18px;padding-left:22px;font:16px/1.6 {font};color:#1c1918">{lis}</ul>')
        elif kind == "heading":
            parts.append(f'<h2 style="margin:26px 0 10px;font:800 20px/1.2 {font};letter-spacing:-0.01em;color:#1c1918">{_inline(items[0], accent)}</h2>')
        else:
            parts.append(f'<p style="margin:0 0 18px;font:16px/1.6 {font};color:#1c1918">{"<br>".join(_inline(l, accent) for l in items)}</p>')
    signature = ""
    if template.get("signature"):
        sig = "<br>".join(_inline(l, accent) for l in template["signature"].strip().split("\n"))
        signature = (f'<p style="margin:26px 0 0;padding-top:18px;border-top:1.5px dashed #d9d4c8;'
                     f'font:16px/1.6 {font};color:#1c1918">{sig}</p>')
    sender = _esc(template.get("senderName") or "Booqy")
    reply_to = _esc(template.get("replyTo") or DEFAULT_REPLY_TO)
    footer_text = _inline(template["footer"].strip(), "#57504d") if template.get("footer") else ""
    return (
        '<!doctype html><html lang="sv"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{_esc(subject)}</title></head>"
        '<body style="margin:0;padding:0;background:#f1eee6">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1eee6">'
        '<tr><td align="center" style="padding:32px 16px 40px">'
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">'
        # the rail
        f'<tr><td style="height:12px;background:#bfc3c7;border-radius:3px 3px 0 0;border-bottom:2px solid #80868c"></td></tr>'
        # the ticket
        '<tr><td style="background:#fbfaf6;padding:36px 40px 32px">'
        f'<img src="{_esc(logo_src)}" alt="{sender}" width="120" style="display:block;width:120px;max-width:40%;height:auto;margin:0 0 26px">'
        f'<h1 style="margin:0 0 18px;font:800 28px/1.1 {font};letter-spacing:-0.02em;color:#1c1918">{_esc(subject)}</h1>'
        f'<div style="height:3px;width:56px;background:{accent};margin:0 0 22px"></div>'
        + "".join(parts) + signature +
        "</td></tr>"
        # torn edge
        '<tr><td style="height:8px;background:#fbfaf6;background-image:linear-gradient(135deg,#fbfaf6 50%,#f1eee6 50%),'
        'linear-gradient(225deg,#fbfaf6 50%,#f1eee6 50%);background-size:12px 8px;background-position:0 0,6px 0;background-repeat:repeat-x"></td></tr>'
        # footer
        f'<tr><td style="padding:22px 8px 0;font:12px/1.6 {font};color:#57504d">'
        f'{footer_text}{"<br>" if footer_text else ""}'
        f'Frågor? Svara på det här mejlet eller skriv till <a href="mailto:{reply_to}" style="color:#57504d">{reply_to}</a>.'
        "</td></tr>"
        "</table></td></tr></table></body></html>"
    )


def _validate_message(body: dict) -> tuple[str, str]:
    f = v.Fields(body)
    subject = f.text("subject", required=True, max_len=SUBJECT_MAX)
    text = f.text("body", required=True, max_len=BODY_MAX)
    f.done()
    return subject, text


def preview(req) -> tuple[int, dict]:
    """POST /platform/mail/preview - the newsletter as it will be sent, with
    the template (or the template fields passed along, for the editor)."""
    template = _load_template()
    override = req.body.get("template")
    if isinstance(override, dict):
        f = v.Fields(override)
        for key, max_len in (("senderName", 60), ("signature", 600), ("footer", 600)):
            value = f.text(key, max_len=max_len)
            if value is not None:
                template[key] = value
        reply_to = f.email("replyTo")
        if reply_to:
            template["replyTo"] = reply_to
        accent = f.text("accentColor", max_len=7, pattern=HEX_COLOUR, msg="A colour like #350001")
        if accent:
            template["accentColor"] = accent
        logo = _parse_logo(f, template)
        if logo:
            template["logo"] = logo
        f.done()
    subject = (req.body.get("subject") or "").strip() or "Nyheter från Booqy"
    text = (req.body.get("body") or "").strip() or "Hej!\n\nHär kommer ett exempel på hur ett utskick ser ut."
    return 200, {"subject": subject, "html": render_html(subject, text, template, logo_src=_logo_data_url(template)),
                 "text": render_text(subject, text, template)}


# ---------------------------------------------------------------- recipients
def _recipients() -> list[dict]:
    """Every active customer's owner, one row per address."""
    rows = query_all(TableName=tenant_table(), IndexName="GSI1",
                     KeyConditionExpression="GSI1PK = :t", ExpressionAttributeValues={":t": {"S": "TENANT"}})
    seen: dict[str, dict] = {}
    for t in rows:
        if t.get("status") != "active":
            continue
        email = (t.get("ownerEmail") or "").strip().lower()
        if not email or email in seen:
            continue
        seen[email] = {"email": email, "name": t.get("ownerName") or "", "tenantName": t.get("name") or "",
                       "tenantId": t.get("tenantId")}
    return sorted(seen.values(), key=lambda r: (r["tenantName"].lower(), r["email"]))


def list_recipients(req) -> tuple[int, dict]:
    rows = _recipients()
    return 200, {"count": len(rows), "recipients": rows}


# -------------------------------------------------------------------- sending
def _outbox_bucket() -> str | None:
    if env("ENVIRONMENT", "") == "prod":
        return None
    return env("MAIL_OUTBOX_BUCKET_NAME", "") or None


def _from_header(template: dict) -> str:
    display = (template.get("senderName") or "Booqy").replace('"', "").replace("\n", " ")[:60]
    return formataddr((display, env("NO_REPLY_EMAIL_ADDRESS", "no-reply@booqy.se")), charset="utf-8")


def _build_mime(to: str, subject: str, text: str, html_body: str, template: dict) -> bytes:
    related = MIMEMultipart("related")
    related["Subject"] = str(Header(subject, "utf-8"))
    related["From"] = _from_header(template)
    related["To"] = to
    related["Reply-To"] = template.get("replyTo") or DEFAULT_REPLY_TO
    alternative = MIMEMultipart("alternative")
    alternative.attach(MIMEText(text, "plain", "utf-8"))
    alternative.attach(MIMEText(html_body, "html", "utf-8"))
    related.attach(alternative)
    blob, content_type = _logo_bytes(template)
    image = MIMEImage(blob, _subtype=content_type.split("/", 1)[1])
    image.add_header("Content-ID", "<logo>")
    image.add_header("Content-Disposition", "inline", filename=f"logo.{LOGO_TYPES.get(content_type, 'png')}")
    related.attach(image)
    return related.as_bytes()


def _send_one(to: str, subject: str, body: str, template: dict) -> None:
    text = render_text(subject, body, template)
    bucket = _outbox_bucket()
    if bucket:
        html_body = render_html(subject, body, template, logo_src=_logo_data_url(template))
        now = datetime.now(timezone.utc)
        message_id = f"{_INVERT_MS - int(now.timestamp() * 1000):013d}-{uuid.uuid4().hex[:12]}"
        entry = {"id": message_id, "at": now.isoformat().replace("+00:00", "Z"), "channel": "email", "to": to,
                 "from": _from_header(template), "replyTo": [template.get("replyTo") or DEFAULT_REPLY_TO],
                 "subject": subject, "text": text, "html": html_body}
        client("s3").put_object(Bucket=bucket, Key=f"outbox/{message_id}.json",
                                Body=json.dumps(entry, ensure_ascii=False).encode("utf-8"),
                                ContentType="application/json; charset=utf-8")
        return
    html_body = render_html(subject, body, template, logo_src="cid:logo")
    raw = _build_mime(to, subject, text, html_body, template)
    client("ses").send_raw_email(Source=env("NO_REPLY_EMAIL_ADDRESS", "no-reply@booqy.se"),
                                 Destinations=[to], RawMessage={"Data": raw})


def _operator_email(req) -> str:
    try:
        user = client("cognito-idp").admin_get_user(UserPoolId=env("OPERATOR_USER_POOL_ID"), Username=req.actor)
    except ClientError:
        raise ApiError(400, "no_email", "Couldn't find your operator account's email address") from None
    attrs = {a["Name"]: a["Value"] for a in user.get("UserAttributes") or []}
    email = (attrs.get("email") or "").strip().lower()
    if not email:
        raise ApiError(400, "no_email", "Your operator account has no email address")
    return email


def _newsletter_key(newsletter_id: str, created_at: str) -> dict:
    return {"PK": {"S": PK}, "SK": {"S": f"{NEWSLETTER_PREFIX}{created_at}#{newsletter_id}"}}


def _view(row: dict) -> dict:
    return {k: row.get(k) for k in ("newsletterId", "subject", "body", "status", "createdAt", "createdBy",
                                      "recipientCount", "sentCount", "failedCount", "finishedAt", "lastError")}


def list_newsletters(req) -> tuple[int, dict]:
    rows = query_all(TableName=tenant_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :n)",
                     ExpressionAttributeValues={":pk": {"S": PK}, ":n": {"S": NEWSLETTER_PREFIX}},
                     ScanIndexForward=False)
    return 200, {"newsletters": [_view(r) for r in rows]}


def _find(newsletter_id: str) -> dict:
    # The SK carries the creation time; the row is found by id among the (few) newsletters.
    rows = query_all(TableName=tenant_table(), KeyConditionExpression="PK = :pk AND begins_with(SK, :n)",
                     ExpressionAttributeValues={":pk": {"S": PK}, ":n": {"S": NEWSLETTER_PREFIX}},
                     ScanIndexForward=False)
    for row in rows:
        if row.get("newsletterId") == newsletter_id:
            return row
    raise not_found("No such newsletter")


def get_newsletter(req) -> tuple[int, dict]:
    row = _find(req.path.get("newsletterId") or "")
    return 200, {"newsletter": _view(row), "recipients": row.get("recipients") or []}


def send(req) -> tuple[int, dict]:
    """POST /platform/mail/newsletters - {"subject", "body", "test": true}
    sends one copy to the operator; without test, to every owner."""
    subject, body = _validate_message(req.body)
    template = _load_template()
    if req.body.get("test"):
        to = _operator_email(req)
        _send_one(to, subject, body, template)
        return 200, {"test": True, "sentTo": to}
    recipients = _recipients()
    if not recipients:
        raise ApiError(400, "no_recipients", "There are no active customers to send to")
    created_at = now_iso()
    newsletter_id = new_id()
    row = {"PK": PK, "SK": f"{NEWSLETTER_PREFIX}{created_at}#{newsletter_id}", "newsletterId": newsletter_id,
           "subject": subject, "body": body, "status": "sending", "createdAt": created_at, "createdBy": req.actor,
           "recipients": [{"email": r["email"], "tenantName": r["tenantName"], "status": "pending"} for r in recipients],
           "recipientCount": len(recipients), "sentCount": 0, "failedCount": 0, "cursor": 0}
    client("dynamodb").put_item(TableName=tenant_table(), Item=to_ddb(row))
    if req.function_arn:
        _invoke_self(req.function_arn, {"mailTask": "send", "newsletterId": newsletter_id, "createdAt": created_at})
    else:
        _send_task({"newsletterId": newsletter_id, "createdAt": created_at}, None)
        row = _find(newsletter_id)
    return 202, {"newsletter": _view(row)}


def _invoke_self(function_arn: str, payload: dict) -> None:
    client("lambda").invoke(FunctionName=function_arn, InvocationType="Event",
                            Payload=json.dumps(payload).encode("utf-8"))


def _send_task(event: dict, context) -> dict:
    """The asynchronous send: one recipient at a time from the stored
    cursor, counts written back every message, hand-over before timeout."""
    newsletter_id = event.get("newsletterId") or ""
    created_at = event.get("createdAt") or ""
    key = _newsletter_key(newsletter_id, created_at)
    ddb = client("dynamodb")
    row = from_ddb(ddb.get_item(TableName=tenant_table(), Key=key).get("Item"))
    if not row or row.get("status") != "sending":
        return {"status": "skipped"}
    template = _load_template()
    recipients = row.get("recipients") or []
    cursor = int(row.get("cursor") or 0)
    sent, failed = int(row.get("sentCount") or 0), int(row.get("failedCount") or 0)
    last_error = None
    while cursor < len(recipients):
        if context is not None and context.get_remaining_time_in_millis() < HANDOVER_MS:
            ddb.update_item(TableName=tenant_table(), Key=key,
                            UpdateExpression="SET #c = :c, sentCount = :s, failedCount = :f, recipients = :r",
                            ExpressionAttributeNames={"#c": "cursor"},
                            ExpressionAttributeValues={":c": {"N": str(cursor)}, ":s": {"N": str(sent)},
                                                       ":f": {"N": str(failed)}, ":r": to_ddb({"r": recipients})["r"]})
            _invoke_self(context.invoked_function_arn, {"mailTask": "send", "newsletterId": newsletter_id,
                                                        "createdAt": created_at})
            return {"status": "handed_over", "cursor": cursor}
        recipient = recipients[cursor]
        try:
            _send_one(recipient["email"], row["subject"], row["body"], template)
            recipient["status"] = "sent"
            sent += 1
        except (ClientError, BotoCoreError) as exc:
            err = getattr(exc, "response", {}).get("Error", {}) if hasattr(exc, "response") else {}
            last_error = f"{err.get('Code') or type(exc).__name__}: {err.get('Message') or exc}"[:300]
            log.warning("newsletter %s: %s failed: %s", newsletter_id, recipient["email"], last_error)
            recipient["status"] = "failed"
            recipient["error"] = last_error
            failed += 1
        cursor += 1
        if cursor < len(recipients):
            time.sleep(SEND_PAUSE_S)
    update = {"cursor": cursor, "sentCount": sent, "failedCount": failed, "recipients": recipients,
              "status": "sent" if failed == 0 else ("failed" if sent == 0 else "partly_sent"),
              "finishedAt": now_iso(), "lastError": last_error}
    names = {f"#{k}": k for k in update}
    values = {f":{k}": to_ddb({k: val})[k] for k, val in update.items() if val is not None}
    sets = ", ".join(f"#{k} = :{k}" for k in update if update[k] is not None)
    removes = [f"#{k}" for k in update if update[k] is None]
    expression = f"SET {sets}" + (f" REMOVE {', '.join(removes)}" if removes else "")
    ddb.update_item(TableName=tenant_table(), Key=key, UpdateExpression=expression,
                    ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    log.info(json.dumps({"newsletter": newsletter_id, "sent": sent, "failed": failed}))
    return {"status": update["status"], "sent": sent, "failed": failed}


def mail_task(event: dict, context) -> dict:
    if event.get("mailTask") == "send":
        return _send_task(event, context)
    return {"status": "unknown_task"}
