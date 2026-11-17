import { ApiError } from "./api";

/**
 * Every error in the console says who acts, in plain words:
 *
 * - The operator can fix it: the text says how, with a link to the exact
 *   place when there is one (403 -> Operators).
 * - It is Booqy's fault (5xx, *_unavailable, internal_error, AccessDenied,
 *   an unreadable response, codes the console doesn't know): the text says
 *   so, and ErrorNotice shows the details to copy (code, status, request
 *   id, page, time) so the request can be found in the logs. Operators are
 *   the product team, so there is no "report" button here (admin has one).
 *
 * The console writes the text itself for every code it knows (CODE_TEXT),
 * so a raw API, Stripe or AWS message never reaches the screen. A feature's
 * own text (api.ts `messages`) comes first; an unknown code's API message is
 * shown only when it reads as a plain sentence (isPlain), else Booqy's fault.
 */

export type ErrorActor = "operator" | "booqy";

export interface ErrorLink {
  to: string;
  label: string;
}

export interface ErrorInfo {
  text: string;
  actor: ErrorActor;
  link?: ErrorLink;
  code: string;
  status: number;
  requestId?: string;
}

export const BOOQY_FAULT = "This is Booqy's fault, not yours. Try again, or copy the details so we can fix it.";

export const NETWORK = "We can't reach Booqy right now. Check your internet and try again.";

const OPERATORS_LINK: ErrorLink = { to: "/operators", label: "Open Operators" };
const DEV_TURNS_ON = "A Booqy developer needs to turn it on.";

type Known = { text: string; actor?: ErrorActor; link?: ErrorLink };

/** Plain text per API code. A "booqy" entry says what failed; BOOQY_FAULT follows it. */
const CODE_TEXT: Record<string, Known> = {
  network: { text: NETWORK },
  timeout: { text: "Booqy took too long to answer. Try again in a moment." },
  unauthorized: { text: "You were signed out. Sign in again, then redo your last step." },
  forbidden: {
    text: "Your account can't do this. Sign out and in again. If it still fails, ask another operator to check your account.",
    link: OPERATORS_LINK,
  },
  not_found: { text: "We can't find this. It may have been removed. The page now shows what is left." },
  too_many_requests: { text: "Too many tries at once. Wait a few seconds and try again." },
  rate_limited: { text: "Too many tries at once. Wait a few seconds and try again." },
  conflict: { text: "Someone else changed this just now. You see the latest now. Make your change again if needed." },

  // The operator acts.
  slug_taken: { text: "Another customer already uses that address. Pick another one." },
  user_exists: { text: "This email already has an account. Use another email." },
  invalid_status: { text: "This can't be done for the customer right now. Wait until setup has finished, then try again." },
  already_invoiced: { text: "That period is already invoiced. Pick a later start date." },
  already_removed: { text: "This was already removed. The page now shows what is left." },
  already_signed_in: { text: "This operator has already signed in. They can use Forgot password instead." },
  already_subscribed: { text: "The customer already has a running agreement. Change it on the Plan tab." },
  amount_not_possible: { text: "Stripe can't credit that amount on this invoice. Try a slightly smaller amount." },
  below_location_count: {
    text: "The customer has more locations than the new plan allows. Their locations keep working, but they can't add new ones.",
  },
  blocked_dnssec: { text: "The domain has a lock (DNSSEC) switched on. The restaurant switches it off where they bought the domain." },
  charged_automatically: { text: "This invoice is paid by card. Stripe tries the card again by itself." },
  count_changed: { text: "The number of locations changed just now. Try again." },
  credit_in_progress: { text: "Another refund of this invoice is running. Wait a minute, then reload the page." },
  domain_exists: { text: "This domain is already added. You find it in the list." },
  domain_in_use: { text: "Another customer already uses this domain. Check that you typed the right one." },
  domain_unavailable: { text: "This domain can't be bought. Someone may own it already. Try another name." },
  in_progress: { text: "The domain company is still working on this. Wait until it is done, then try again." },
  last_operator: { text: "You can't do this to the last active operator. Add another operator first.", link: OPERATORS_LINK },
  limit_reached: { text: "There is no room for more pictures. Remove one first." },
  managed_from_prod: { text: "Domains are handled in the production console. Make this change there." },
  more_than_left: { text: "That is more than is left on the invoice. Enter a smaller amount." },
  no_card: { text: "The restaurant hasn't added a card yet. Send them the card link." },
  no_email: { text: "There is no email address to send to. Add one, then try again." },
  no_lines: { text: "This invoice has nothing to credit." },
  no_own_domain: { text: "Add the restaurant's own domain on the Domains tab first." },
  no_plan: { text: "The customer has no plan yet. Pick one on the Plan tab first." },
  no_recipients: { text: "There are no active customers to send to." },
  no_stripe_account: { text: "The customer's Stripe account isn't ready yet. Wait for setup, or retry setup." },
  not_an_image: { text: "That file isn't a picture. Pick a JPG or PNG." },
  not_creditable: { text: "Only a paid or open invoice can be credited." },
  not_live: { text: "Finish connecting the domain first. The site must be live before the domain can move." },
  not_open: { text: "Only an open invoice can get a reminder." },
  not_paid: { text: "Only a paid invoice can be refunded. Credit it instead." },
  not_registered_here: { text: "This domain was bought somewhere else. Get the move code from that company." },
  not_retryable: { text: "This can't be tried again. Start the move again from the Domains tab." },
  not_simulated: { text: "This order is real, so it can't be simulated. Simulation only works on test orders in the dev console." },
  not_subscribed: { text: "The customer has no running agreement." },
  not_trial: { text: "The customer already pays for a plan." },
  nothing_left: { text: "Nothing is left to refund or credit on this invoice." },
  nothing_to_send: { text: "The restaurant has nothing to do for this domain right now." },
  own_domain_not_live: { text: "The restaurant's own domain isn't live yet. Wait until it is, then try again." },
  own_domain_order: { text: "This address belongs to the restaurant's own domain. Remove the own domain on the Domains card first." },
  paid_out_of_band: { text: "This was paid outside Stripe, so there is no card payment to refund. Credit it instead." },
  plan_limit_reached: { text: "The plan has no room for more locations. Raise the limit on the Plan tab first." },
  platform_domain: { text: "The Booqy address is only removed when the customer leaves Booqy." },
  price_changed: { text: "The price changed. Check the new price and confirm again." },
  prod_only: { text: "Domains are bought and moved only in the production console. Here, Add domain shows it on the test sites." },
  registration_refused: { text: "The domain couldn't be bought. Check the contact details and that the domain is still free." },
  resubmit: { text: "Start the move again with a new transfer code." },
  self: { text: "You can't do this to your own account. Ask another operator.", link: OPERATORS_LINK },
  stripe_error: { text: "Stripe said no to this. Check the customer in Stripe, then try again." },
  transfer_exists: { text: "This domain is already being moved. Wait for it to finish." },
  transfer_refused: { text: "The domain couldn't be moved. Check the transfer code and that the domain is unlocked at its current company." },
  unsupported_tld: { text: "This kind of domain can't be moved to Booqy. Keep it where it is now." },
  upload_failed: { text: "The file didn't upload. Pick a PDF under 10 MB and try again." },
  upload_missing: { text: "The file didn't arrive. Upload it again." },

  // Switched off in this console: a developer acts, nothing to retry.
  avatars_not_configured: { text: `Profile pictures aren't switched on here. ${DEV_TURNS_ON}` },
  backdrops_not_configured: { text: `Background pictures aren't switched on here. ${DEV_TURNS_ON}` },
  domains_not_configured: { text: `Buying domains isn't switched on here. ${DEV_TURNS_ON}` },
  platform_domain_not_configured: { text: `Restaurant domains aren't switched on here. ${DEV_TURNS_ON}` },
  site_repos_off: { text: `Website building isn't switched on here. ${DEV_TURNS_ON}` },
  test_sites_off: { text: `Test sites aren't switched on here. ${DEV_TURNS_ON}` },
  no_plans: { text: "There are no plans here yet. A Booqy developer needs to add them." },

  // Booqy acts: what failed, then BOOQY_FAULT.
  internal_error: { actor: "booqy", text: "Something went wrong at Booqy." },
  bad_response: { actor: "booqy", text: "Booqy sent an answer we can't read." },
  invalid_json: { actor: "booqy", text: "Booqy couldn't read what this page sent." },
  invalid_cursor: { actor: "booqy", text: "Booqy couldn't load the next page of the list." },
  invalid_limit: { actor: "booqy", text: "Booqy couldn't load the list." },
  feature_unavailable: { actor: "booqy", text: "This part of Booqy didn't answer." },
  service_unavailable: { actor: "booqy", text: "Booqy didn't answer." },
  stripe_unavailable: { actor: "booqy", text: "Stripe didn't answer." },
  stripe_unreachable: { actor: "booqy", text: "Stripe didn't answer." },
  price_unavailable: { actor: "booqy", text: "We couldn't get the current price." },
  mail_failed: { actor: "booqy", text: "The email wasn't sent." },
  workflow_not_started: { actor: "booqy", text: "Setup didn't start." },
  workflow_start_failed: { actor: "booqy", text: "Setup didn't start." },
  site_repo_failed: { actor: "booqy", text: "The website couldn't be set up." },
  dns_setup_failed: { actor: "booqy", text: "The domain couldn't be set up." },
  no_vat_rate: { actor: "booqy", text: "Invoicing isn't set up right, so no invoice was sent." },
  no_seller_details: { actor: "booqy", text: "Invoicing isn't set up right, so no invoice was sent." },
};

const FIELDS_MARKED = "Some fields need fixing. They are marked, fix them and save again.";
const FORM_CHECK = "Something in the form doesn't look right. Check it and try again.";
const SOMETHING_FAILED = "Something went wrong at Booqy.";

/** Status and code that make it Booqy's fault, whatever the message says. */
export function isBooqyFault(status: number, code: string): boolean {
  return status >= 500 || code === "internal_error" || code === "bad_response" || code.endsWith("_unavailable")
    || /access_?denied/i.test(code);
}

/** True when a message from elsewhere (the API, a browser) can be shown as it is:
 * a short plain sentence with no codes, no technical words and no raw data. */
export function isPlain(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 200 || !/^[A-Z0-9"']/.test(t)) return false;
  if (/[{}[\]<>=\\|`]|\w_\w|\b[a-z]+[A-Z]\w*\b/.test(t)) return false;
  return !/\b(api|server|token|session|request|endpoint|json|http|https|status|null|undefined|true|false|exception|error|stack|lambda|dynamo\w*|cognito|route 53|aws|tenant|invalid|parameter|timeout|webhook|idempoten\w*|var)\b|\b[45]\d\d\b(?!\s*(kr|kronor|sek|days|minutes|%))/i.test(t);
}

/** A reason a backend job stored (lastError and the like) as a sentence when it reads plainly, else undefined. */
export function plainReason(raw: string | null | undefined): string | undefined {
  const t = raw?.trim();
  return t && isPlain(t) ? sentence(t) : undefined;
}

/** A message without a trailing bare "Try again (in a moment)." */
function withoutBareRetry(message: string): string {
  return message.replace(/[;,.]?\s*try again( in a (moment|minute|few minutes)| later)?[.!]?$/i, "").trim();
}

function sentence(text: string): string {
  const t = text.trim().replace(/!+$/, ".");
  return /[.?)]$/.test(t) ? t : `${t}.`;
}

/** An API field message in plain words with an example of a right value (the Field's label names the field). */
export function fieldText(raw: string): string {
  const t = (raw ?? "").trim();
  let m: RegExpMatchArray | null;
  if (!t || t === "Required") return "Fill this in.";
  if (/valid email/i.test(t) || t === "Not an email address") return "Write the email like this: anna@restaurang.se.";
  if (/valid phone/i.test(t)) return "Write the phone number like this: 070-123 45 67.";
  if (/postal code/i.test(t)) return "Write the postal code like this: 123 45.";
  if (/^10 digits as NNNNNN-NNNN/.test(t)) return "Write the org. number like this: 556677-8899.";
  if (/check digit/i.test(t)) return "One digit looks wrong. Check the number for a typo.";
  if ((m = t.match(/should be (SE\d{12})/))) return `It should be ${m[1]} to match the org. number.`;
  if (/^SE \+ the 10-digit/.test(t)) return "Write the VAT number like this: SE556677889901.";
  if (/^3-40 characters/.test(t)) return "Use 3 to 40 small letters, digits or hyphens, like pizza-roma.";
  if (/^Reserved name/.test(t)) return "Booqy keeps this name for itself. Pick another one, like pizza-roma.";
  if (/^A hostname like/.test(t)) return "Write only the domain, like www.restaurang.se.";
  if (/^Stripe account id/.test(t)) return "Write the Stripe account id, like acct_1A2b3C.";
  if (/^A colour like/.test(t)) return "Write the colour like this: #3a2418.";
  if (/yyyy-mm-dd/.test(t)) return "Pick a date, like 2027-01-31.";
  if (t === "Must be a whole number") return "Use a whole number, like 5.";
  if (t === "Must be an amount" || t === "Enter an amount") return "Enter an amount in kronor, like 499.";
  if (t === "At most 2 decimals") return "Use at most 2 decimals, like 499.50.";
  if (t === "More than 0") return "Use a number above 0.";
  if ((m = t.match(/^At most (\d+) characters$/))) return `Too long. Use at most ${m[1]} characters.`;
  if ((m = t.match(/^At least (-?[\d.]+)$/))) return `Use ${m[1]} or more.`;
  if ((m = t.match(/^At most ([\d.]+)$/))) return `Use ${m[1]} or less.`;
  if (t === "Does not match") return "This doesn't match. Type it exactly as shown.";
  if (t === "Invalid format" || /^Must be (text|an object|a list|true or false)/.test(t) || /^Must be \w+ or \w+$/.test(t)) {
    return "This doesn't look right. Check it for typos.";
  }
  return isPlain(t) ? sentence(t) : "This doesn't look right. Check it for typos.";
}

/** Every field message of an API answer, in plain words. */
export function fieldTexts(fields: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, fieldText(v)]));
}

function booqy(base: Omit<ErrorInfo, "text" | "actor">, what: string): ErrorInfo {
  return { ...base, actor: "booqy", text: `${sentence(withoutBareRetry(what))} ${BOOQY_FAULT}` };
}

export function describeError(error: unknown): ErrorInfo {
  if (error instanceof ApiError) {
    const { status, code } = error;
    const requestId = typeof error.extra?.requestId === "string" ? error.extra.requestId : undefined;
    const base = { code, status, ...(requestId ? { requestId } : {}) };
    // A feature's own text (api.ts `messages`) is ours: it is shown as written.
    const own = error.ownMessage;
    // serverMessage is set by api.ts; an ApiError a page built itself carries its text as the message.
    const server = error.serverMessage ?? error.message;
    if (status === 0 && code !== "timeout") return { ...base, actor: "operator", text: NETWORK };
    if (code === "network") return { ...base, actor: "operator", text: NETWORK };
    if (own) return isBooqyFault(status, code) ? booqy(base, own) : { ...base, actor: "operator", text: own };
    const known = CODE_TEXT[code];
    if (known) {
      if (known.actor === "booqy") return booqy(base, known.text);
      return { ...base, actor: "operator", text: known.text, ...(known.link ? { link: known.link } : {}) };
    }
    if (isBooqyFault(status, code)) return booqy(base, SOMETHING_FAILED);
    if (code === "validation_failed") {
      if (Object.keys(error.fields ?? {}).length) return { ...base, actor: "operator", text: FIELDS_MARKED };
      return { ...base, actor: "operator", text: server && isPlain(server) ? sentence(server) : FORM_CHECK };
    }
    if (server && isPlain(server)) return { ...base, actor: "operator", text: sentence(server) };
    if (status === 401) return { ...base, actor: "operator", ...CODE_TEXT.unauthorized };
    if (status === 403) return { ...base, actor: "operator", ...CODE_TEXT.forbidden };
    if (status === 404) return { ...base, actor: "operator", ...CODE_TEXT.not_found };
    // A 409 with an unreadable message is a rule the console doesn't know: ours to word, so Booqy's fault below.
    if (status === 409 && !server) return { ...base, actor: "operator", ...CODE_TEXT.conflict };
    if (status === 429) return { ...base, actor: "operator", ...CODE_TEXT.too_many_requests };
    // A code the console doesn't know and no readable message: ours to fix.
    return booqy(base, SOMETHING_FAILED);
  }
  if (error instanceof TypeError) return { actor: "operator", text: NETWORK, code: "network", status: 0 };
  if (error instanceof Error && /^[A-Z].*[.?)]$/s.test(error.message.trim()) && isPlain(error.message)) {
    // Our own sentences (a page's "Pick a plan first.") are for the operator.
    return { actor: "operator", text: error.message, code: "client", status: 0 };
  }
  if (typeof error === "string" && error && isPlain(error)) return { actor: "operator", text: sentence(error), code: "client", status: 0 };
  return booqy({ code: "unknown", status: 0 }, SOMETHING_FAILED);
}

/** The lines an operator copies from a Booqy fault: never a token or form content. */
export function errorDetails(info: ErrorInfo, path: string = window.location.pathname, at: Date = new Date()): string {
  return [
    `Error: ${info.code}`,
    `HTTP status: ${info.status || "-"}`,
    `Request id: ${info.requestId ?? "-"}`,
    `Page: ${path.split(/[?#]/)[0] || "/"}`,
    `Time: ${at.toISOString()}`,
  ].join("\n");
}
