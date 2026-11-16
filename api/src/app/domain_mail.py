"""The restaurant's own-domain e-mails, in Swedish (owner 2026-11-15: short,
numbered, so plain an eight-year-old can follow them). Sent from the
platform's no-reply address in the console's brand template (mail.py), to
the restaurant's contact address; in dev with the mail outbox on they land
in the outbox. Never raises: a failed e-mail is logged and reported as
False, the domain work goes on.

Each text also has an English twin for the operator console (en=True),
and texts() returns the Swedish steps the console shows for copying."""

from .core import env, log

# Error classes of a domain order: who acts and what to do, in both
# languages. {domain} and {date} are filled in.
ERRORS = {
    "bad_auth_code": ("restaurant",
                      "The transfer code is wrong or expired. Get a new one from the current registrar (one.com: "
                      "Domain, Transfer / EPP code) and start the move again.",
                      "Flyttkoden stämmer inte eller har gått ut. Hämta en ny flyttkod hos er nuvarande leverantör "
                      "(till exempel one.com) och skicka den till oss."),
    "locked": ("restaurant",
               "{domain} is locked at its registrar. The restaurant unlocks it (transfer lock), then start the move again.",
               "{domain} är låst hos er nuvarande leverantör. Logga in där och lås upp domänen (det heter ofta "
               "\"transfer lock\" eller \"överföringslås\"). Skicka sedan en ny flyttkod till oss."),
    "rejected": ("restaurant",
                 "The move of {domain} was declined, by the owner's e-mail or by the old registrar. The restaurant "
                 "asks the registrar to release it, then start the move again.",
                 "Flytten av {domain} blev nekad. Antingen tryckte någon på Neka i mejlet, eller så stoppade er "
                 "nuvarande leverantör flytten. Kontakta leverantören och be dem släppa domänen. Sedan försöker vi igen."),
    "too_recent": ("restaurant",
                   "{domain} was registered or moved less than 60 days ago and can't move again yet. Try again {date}.",
                   "{domain} köptes eller flyttades för mindre än 60 dagar sedan. Då får den inte flyttas igen än. "
                   "Vi kan flytta den {date}. Svara på det här mejlet då, så startar vi flytten igen."),
    "transfer_expired": ("restaurant",
                         "Nobody approved the move of {domain} within 14 days, so it stopped. Nothing changed for the "
                         "domain. Ask the owner to look for the approval e-mail, then start the move again.",
                         "Ingen godkände flytten av {domain} inom 14 dagar, så den stoppades. Domänen är kvar hos er "
                         "nuvarande leverantör och allt fungerar som förut. Svara på det här mejlet så startar vi "
                         "flytten igen."),
    "records_timeout": ("restaurant",
                        "There is still no www record pointing at Booqy for {domain}. Send the restaurant the steps "
                        "again, then press Retry.",
                        "Vi hittar fortfarande ingen www-rad som pekar på Booqy för {domain}. Följ stegen i vårt "
                        "förra mejl, eller svara på det här mejlet så hjälper vi er."),
    "nameservers_timeout": ("restaurant",
                            "The name servers of {domain} were not switched. Send the restaurant the steps again, "
                            "then press Retry.",
                            "Namnservrarna för {domain} är inte bytta än. Följ stegen i vårt förra mejl, eller svara "
                            "på det här mejlet så hjälper vi er."),
    "dnssec": ("restaurant",
               "DNSSEC is on for {domain}. The restaurant turns it off at the registrar and waits an hour; then press "
               "Check now.",
               "Stäng av DNSSEC för {domain} hos er leverantör (till exempel one.com). Vänta en timme. Sedan "
               "kontrollerar vi igen."),
    "unsupported_tld": ("restaurant",
                        "{domain} can't be bought or moved to Booqy. Keep it where it is (Keep current registrar).",
                        "{domain} kan inte flyttas till Booqy. Den får ligga kvar där den är, och vi kopplar den "
                        "till er hemsida ändå."),
    "booqy": ("booqy",
              "Booqy's fault: something failed on our side while setting up {domain}. Booqy is notified; press "
              "Retry once it's fixed.",
              "Booqys fel. Något gick fel hos oss när vi kopplade {domain}. Vi är meddelade och fixar det. Ni behöver "
              "inte göra något."),
}


def error(code: str, domain: str, date: str = "när 60 dagar har gått") -> dict:
    """{errorCode, who, lastError (English), lastErrorSv} for an order row."""
    who, en, sv = ERRORS.get(code) or ERRORS["booqy"]
    date_en = "once 60 days have passed" if date == "när 60 dagar har gått" else date
    return {"errorCode": code if code in ERRORS else "booqy", "who": who,
            "lastError": en.format(domain=domain, date=date_en), "lastErrorSv": sv.format(domain=domain, date=date)}


# --------------------------------------------------------------------- texts
def records_steps(domain: str, target: str, dev_target: str | None) -> str:
    www = f"www.{domain}"
    lines = [
        f"Er hemsida ska snart synas på {www}. Gör så här, det tar fem minuter:",
        "",
        f"1. Logga in där ni köpte {domain} (till exempel one.com).",
        f"2. Öppna DNS-inställningarna för {domain}.",
        "3. Finns det redan en rad som heter www? Ta bort den.",
        f"4. Lägg till en ny rad: Typ CNAME, Namn www, Värde {target}",
    ]
    n = 5
    if dev_target:
        lines.append(f"{n}. Lägg till en rad till: Typ CNAME, Namn dev, Värde {dev_target}")
        n += 1
    lines.append(f"{n}. Leta upp \"Vidarebefordran\" (eller \"Webbomdirigering\") och skicka {domain} vidare till "
                 f"https://{www}. Välj \"permanent\" eller \"301\" om ni får välja.")
    lines += ["", "Klart! Ni behöver inte göra något mer. Vi kollar själva och mejlar er när hemsidan är live."]
    return "\n".join(lines)


def nameserver_steps(domain: str, name_servers: list[str], dnssec: bool = False) -> str:
    lines = []
    if dnssec:
        lines += [f"Viktigt först: stäng av DNSSEC för {domain} hos er leverantör och vänta en timme. "
                  "Annars slutar domänen att fungera när ni byter namnservrar.", ""]
    lines += [
        f"1. Logga in där ni köpte {domain} (till exempel one.com).",
        f"2. Öppna inställningen för namnservrar (\"Name servers\") för {domain}.",
        "3. Välj att använda egna namnservrar.",
        "4. Ta bort de gamla och skriv in de här fyra, en på varje rad:",
        *[f"- {ns}" for ns in name_servers],
        "5. Spara.",
        "",
        "Klart! Det kan ta några timmar innan bytet syns. Vi kollar själva och mejlar er när hemsidan är live. "
        "Er e-post fortsätter att fungera, vi har kopierat inställningarna.",
    ]
    return "\n".join(lines)


def transfer_steps(domain: str) -> str:
    return "\n".join([
        f"Nu flyttar vi {domain} till Booqy. Hemsidan och e-posten fungerar som vanligt hela tiden.",
        "",
        "Det enda ni behöver göra:",
        f"1. Öppna mejlet om flytten av {domain}. Det kommer till den e-postadress som står som ägare till "
        "domänen hos er nuvarande leverantör (till exempel one.com).",
        "2. Klicka på länken i mejlet och godkänn flytten.",
        "",
        "Hittar ni inte mejlet? Titta i skräpposten. Det kan ta upp till en timme innan det kommer.",
        "",
        "Vi mejlar er när allt är klart.",
    ])


def _template(kind: str, **c) -> tuple[str, str]:
    d = c["domain"]
    if kind == "records_steps":
        return f"Så kopplar ni {d} till er hemsida", "Hej!\n\n" + records_steps(d, c["target"], c.get("dev_target"))
    if kind == "records_reminder":
        return (f"Påminnelse: {d} är inte kopplad än",
                "Hej!\n\nVi hittar inte den nya www-raden för " + d + " än. Här är stegen igen:\n\n"
                + records_steps(d, c["target"], c.get("dev_target")))
    if kind == "nameserver_steps":
        return f"Så kopplar ni {d} till Booqy", "Hej!\n\n" + nameserver_steps(d, c["name_servers"], c.get("dnssec", False))
    if kind == "transfer_approve":
        return f"Godkänn flytten av {d}", "Hej!\n\n" + transfer_steps(d)
    if kind == "transfer_reminder":
        return (f"Påminnelse: godkänn flytten av {d}",
                "Hej!\n\nFlytten av " + d + " väntar fortfarande på ert godkännande. Vi har skickat mejlet om "
                "godkännande en gång till.\n\n" + transfer_steps(d))
    if kind == "live":
        lines = [f"Nu är er hemsida live på https://{c['canonical']}.", "",
                 "De gamla adresserna skickar gästerna vidare dit automatiskt. Alla länkar i våra mejl, sms och "
                 f"QR-koder går till {c['canonical']}."]
        if c.get("dev"):
            lines += ["", f"Testversionen av hemsidan finns på https://{c['dev']}."]
        return f"{c['canonical']} är live!", "Hej!\n\n" + "\n".join(lines)
    if kind == "action_needed":
        return (f"Vi behöver er hjälp med {d}",
                "Hej!\n\n" + c["text"] + "\n\nSvara på det här mejlet när det är gjort, så fortsätter vi.")
    if kind == "auth_code":
        return (f"Flyttkod för {d}",
                f"Hej!\n\n{d} är fortfarande er. Vill ni flytta den till en annan leverantör använder ni den här "
                f"flyttkoden:\n\n{c['code']}\n\nGe koden till den nya leverantören. Koden är hemlig: dela den inte "
                "med någon annan.")
    if kind == "removed_records":
        return (f"{d} är bortkopplad från Booqy",
                f"Hej!\n\nVi har kopplat bort {d} från er hemsida hos Booqy. Ta bort de här raderna i DNS hos er "
                "leverantör:\n\n- CNAME www\n- CNAME dev\n\nStäng också av vidarebefordran av " + d
                + " om ni inte ska använda den längre.")
    raise ValueError(f"unknown domain mail {kind!r}")


def recipient(profile: dict) -> str | None:
    email = (profile.get("contactEmail") or profile.get("ownerEmail") or "").strip().lower()
    return email or None


def send(profile: dict, kind: str, **context) -> bool:
    """One e-mail to the restaurant. False when there is no address or the
    send failed (logged without the body: an auth code never reaches a log)."""
    to = recipient(profile)
    if not to:
        log.info("domain mail %s: no recipient for %s", kind, profile.get("tenantId"))
        return False
    from . import mail                          # mail imports nothing from here
    subject, body = _template(kind, **context)
    try:
        mail._send_one(to, subject, body, mail._load_template())
    except Exception as e:  # noqa: BLE001 - an e-mail never stops the domain work
        log.warning("domain mail %s to tenant %s failed: %s", kind, profile.get("tenantId"), type(e).__name__)
        return False
    log.info("domain mail %s sent for %s (%s)", kind, context.get("domain"), env("ENVIRONMENT", "dev"))
    return True
