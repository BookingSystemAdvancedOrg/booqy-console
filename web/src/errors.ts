import { ApiError } from "./api";

/**
 * Every error in the console says who acts:
 *
 * - The operator can fix it: the text says how, with a link to the exact
 *   place when there is one (403 -> Operators).
 * - It is Booqy's fault (5xx, *_unavailable, internal_error, AccessDenied,
 *   an unreadable response, codes the console doesn't know): the text says
 *   so, and ErrorNotice shows the details to copy (code, status, request
 *   id, page, time) so the request can be found in the logs. Operators are
 *   the product team, so there is no "report" button here (admin has one).
 *
 * The API's own message (platform-tenants writes them for operators) is the
 * per-code text for 4xx answers; a 5xx message gets the "Booqy's fault"
 * sentence instead of a bare "try again".
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

export const BOOQY_FAULT =
  "This is a Booqy fault (a bug or an outage), not something you did. Try again; if it keeps failing, copy the details and look the request up in the logs.";

const NETWORK = "Couldn't reach the API. Check your internet connection (wifi or VPN) and try again.";

const OPERATOR: Record<string, { text: string; link?: ErrorLink }> = {
  network: { text: NETWORK },
  unauthorized: { text: "You were signed out. Sign in again and redo what you were doing." },
  forbidden: {
    text: "Your account isn't allowed to do this. Sign out and in again; if it persists, another operator checks your account under Operators.",
    link: { to: "/operators", label: "Open Operators" },
  },
  not_found: { text: "Not found: it may have been removed elsewhere. The page shows what is left by itself." },
  too_many_requests: { text: "Too many requests right now. Wait a few seconds and try again." },
  rate_limited: { text: "Too many requests right now. Wait a few seconds and try again." },
  conflict: { text: "Someone changed this at the same time. The latest is shown now; make your change again if it is still needed." },
};

/** Status and code that make it Booqy's fault, whatever the message says. */
export function isBooqyFault(status: number, code: string): boolean {
  return status >= 500 || code === "internal_error" || code === "bad_response" || code.endsWith("_unavailable")
    || /access_?denied/i.test(code);
}

/** A server message without a trailing bare "Try again (in a moment)." */
function withoutBareRetry(message: string): string {
  return message.replace(/[;,.]?\s*try again( in a (moment|minute|few minutes)| later)?[.!]?$/i, "").trim();
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?)]$/.test(t) ? t : `${t}.`;
}

export function describeError(error: unknown): ErrorInfo {
  if (error instanceof ApiError) {
    const { status, code } = error;
    const requestId = typeof error.extra?.requestId === "string" ? error.extra.requestId : undefined;
    const base = { code, status, ...(requestId ? { requestId } : {}) };
    // serverMessage is set by api.ts; an ApiError a page built itself carries its text as the message.
    const server = error.serverMessage ?? (error.message && !error.message.includes("Booqy fault") ? error.message : undefined);
    if (status === 0 || code === "network") return { ...base, actor: "operator", text: NETWORK };
    if (isBooqyFault(status, code)) {
      const what = server ? sentence(withoutBareRetry(server)) : "Something failed on Booqy's side.";
      return { ...base, actor: "booqy", text: `${what} ${BOOQY_FAULT}` };
    }
    const known = OPERATOR[code];
    if (server) return { ...base, actor: "operator", text: server, ...(known?.link ? { link: known.link } : {}) };
    if (known) return { ...base, actor: "operator", ...known };
    if (status === 401) return { ...base, actor: "operator", ...OPERATOR.unauthorized };
    if (status === 403) return { ...base, actor: "operator", ...OPERATOR.forbidden };
    if (status === 404) return { ...base, actor: "operator", ...OPERATOR.not_found };
    if (status === 409) return { ...base, actor: "operator", ...OPERATOR.conflict };
    if (status === 429) return { ...base, actor: "operator", ...OPERATOR.too_many_requests };
    // A code the console doesn't know and no message: ours to fix.
    return { ...base, actor: "booqy", text: `Something failed on Booqy's side. ${BOOQY_FAULT}` };
  }
  if (error instanceof TypeError) return { actor: "operator", text: NETWORK, code: "network", status: 0 };
  if (error instanceof Error && /^[A-Z].*[.!?)]$/s.test(error.message.trim())) {
    // Our own sentences (a page's "Pick a plan first.") are for the operator.
    return { actor: "operator", text: error.message, code: "client", status: 0 };
  }
  if (typeof error === "string" && error) return { actor: "operator", text: error, code: "client", status: 0 };
  return { actor: "booqy", text: `Something failed on Booqy's side. ${BOOQY_FAULT}`, code: "unknown", status: 0 };
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
