// Operator sign-in, inside the app (pages/LoginPage.tsx). Amplify talks to the
// OPERATOR user pool directly with SRP - the password never leaves the
// browser in plain form - and handles the pool's challenges: first-login
// password change, TOTP MFA setup and TOTP codes. Tokens live in
// localStorage, so closing the tab keeps you signed in; the refresh token
// lasts 30 days (owner 2026-11-13: sign in about once a month).
//
// The API takes the ACCESS token. Authorization = token from this pool for
// this app client (API Gateway) + member of platform_admin (the Lambda).
import { Amplify } from "aws-amplify";
import { fetchAuthSession, signOut as amplifySignOut } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { Hub, defaultStorage } from "aws-amplify/utils";

// VITE_COGNITO_AUTHORITY is https://cognito-idp.<region>.amazonaws.com/<poolId>
const userPoolId = import.meta.env.VITE_COGNITO_AUTHORITY.replace(/\/$/, "").split("/").pop()!;

Amplify.configure({
  Auth: { Cognito: { userPoolId, userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID } },
});
cognitoUserPoolsTokenProvider.setKeyValueStorage(defaultStorage);

export interface Operator {
  username: string;
  email: string;
}

/**
 * Cognito could not be reached (offline, network error, throttling, 5xx).
 * This is NOT signed out: the tokens stay in storage and are used again as
 * soon as the connection is back.
 */
export class AuthUnavailableError extends Error {
  constructor() {
    super("Couldn't reach the server. Check your internet connection and try again.");
    this.name = "AuthUnavailableError";
  }
}

// The errors after which Amplify clears the tokens (TokenOrchestrator
// isAuthenticationError): only these mean signed out.
const SIGNED_OUT_ERRORS = [
  "NotAuthorizedException",
  "TokenRevokedException",
  "UserNotFoundException",
  "PasswordResetRequiredException",
  "UserNotConfirmedException",
  "RefreshTokenReuseException",
];

export function isSignedOutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" && SIGNED_OUT_ERRORS.some((n) => name.startsWith(n));
}

/** fetchAuthSession, with transient failures as AuthUnavailableError. null tokens = signed out. */
async function session(forceRefresh = false) {
  try {
    return (await fetchAuthSession({ forceRefresh })).tokens ?? null;
  } catch (err) {
    if (isSignedOutError(err)) return null;
    throw new AuthUnavailableError();
  }
}

/**
 * The signed-in operator, or null when signed out. Refreshes expired tokens
 * on the way. Throws AuthUnavailableError when Cognito can't be reached: the
 * operator is still signed in and the shell tries again.
 */
export async function currentOperator(): Promise<Operator | null> {
  const tokens = await session();
  if (!tokens?.accessToken || !tokens.idToken) return null;
  return {
    username: String(tokens.accessToken.payload.username ?? ""),
    email: String(tokens.idToken.payload.email ?? ""),
  };
}

export async function accessToken(): Promise<string> {
  const tokens = await session();
  if (!tokens?.accessToken) {
    notifySignedOut();
    throw new Error("Signed out");
  }
  return tokens.accessToken.toString();
}

/**
 * After a 401 from the API: refresh once. The new access token, or null when
 * Cognito says the session is over. Throws AuthUnavailableError when it
 * can't be reached.
 */
export async function refreshedAccessToken(): Promise<string | null> {
  const tokens = await session(true);
  return tokens?.accessToken ? tokens.accessToken.toString() : null;
}

export async function signOut(): Promise<void> {
  try {
    // global: also revokes the refresh token server-side
    await amplifySignOut({ global: true });
  } catch {
    await amplifySignOut();
  }
}

/** Retries after an AuthUnavailableError: a few seconds, then less often (capped at a minute). */
export const RECONNECT_DELAYS_MS: readonly number[] = [3_000, 10_000, 20_000, 30_000, 60_000];

/**
 * Calls `attempt` on a backoff and whenever the connection may be back
 * (online, window focus, tab visible again, which also covers waking from
 * sleep) until the returned stop function is called.
 */
export function retryUntilReachable(attempt: () => void): () => void {
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      attempt();
      schedule();
    }, RECONNECT_DELAYS_MS[Math.min(i++, RECONNECT_DELAYS_MS.length - 1)]);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") attempt();
  };
  schedule();
  window.addEventListener("online", attempt);
  window.addEventListener("focus", attempt);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("online", attempt);
    window.removeEventListener("focus", attempt);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Shell listens to this to show the login page. */
export function notifySignedOut() {
  Hub.dispatch("booqy", { event: "signedOut" });
}

/**
 * Calls `cb` when the operator signs in or out. A failed token refresh counts
 * only when Cognito says the session is over: Amplify dispatches
 * tokenRefresh_failure on every transient error too, and reacting to those
 * would refresh again at once, in a loop. retryUntilReachable is the only
 * retry path.
 */
export function onAuthChange(cb: () => void): () => void {
  const a = Hub.listen("auth", ({ payload }) => {
    const { event } = payload;
    const error = (payload as { data?: { error?: unknown } }).data?.error;
    if (event === "signedIn" || event === "signedOut" || (event === "tokenRefresh_failure" && isSignedOutError(error))) cb();
  });
  const b = Hub.listen("booqy", cb);
  return () => {
    a();
    b();
  };
}
