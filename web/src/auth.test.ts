import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const amp = vi.hoisted(() => {
  // A Hub that really calls its listeners, like Amplify's (synchronously).
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
  return {
    fetchAuthSession: vi.fn(),
    signOut: vi.fn(async () => undefined),
    dispatch: vi.fn(),
    listeners,
    listen: (channel: string, cb: (e: { payload: unknown }) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(cb);
      return () => listeners.get(channel)!.delete(cb);
    },
    fire: (channel: string, payload: unknown) => listeners.get(channel)?.forEach((cb) => cb({ payload })),
  };
});

vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("aws-amplify/auth", () => ({ fetchAuthSession: amp.fetchAuthSession, signOut: amp.signOut }));
vi.mock("aws-amplify/auth/cognito", () => ({ cognitoUserPoolsTokenProvider: { setKeyValueStorage: vi.fn() } }));
vi.mock("aws-amplify/utils", () => ({ Hub: { dispatch: amp.dispatch, listen: amp.listen }, defaultStorage: {} }));

const tokens = (access = "acc") => ({
  tokens: {
    accessToken: { payload: { username: "op" }, toString: () => access },
    idToken: { payload: { email: "op@booqy.se" }, toString: () => "id" },
  },
});
const named = (name: string) => Object.assign(new Error(name), { name });

async function load() {
  vi.resetModules();
  vi.stubEnv("VITE_COGNITO_AUTHORITY", "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_pool");
  vi.stubEnv("VITE_COGNITO_CLIENT_ID", "client");
  return import("./auth");
}

beforeEach(() => {
  amp.fetchAuthSession.mockReset();
  amp.dispatch.mockReset();
  amp.listeners.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("console auth: only real auth failures sign out", () => {
  it("a network error while refreshing keeps the operator signed in (throws, not null)", async () => {
    const auth = await load();
    amp.fetchAuthSession.mockRejectedValue(named("Unknown"));
    await expect(auth.currentOperator()).rejects.toBeInstanceOf(auth.AuthUnavailableError);
  });

  it("throttling or a Cognito outage is transient too", async () => {
    const auth = await load();
    amp.fetchAuthSession.mockRejectedValue(named("TooManyRequestsException"));
    await expect(auth.currentOperator()).rejects.toBeInstanceOf(auth.AuthUnavailableError);
    amp.fetchAuthSession.mockRejectedValue(named("InternalErrorException"));
    await expect(auth.currentOperator()).rejects.toBeInstanceOf(auth.AuthUnavailableError);
  });

  it("an expired or revoked refresh token signs out", async () => {
    const auth = await load();
    amp.fetchAuthSession.mockResolvedValue({ tokens: undefined });
    await expect(auth.currentOperator()).resolves.toBeNull();
    amp.fetchAuthSession.mockRejectedValue(named("TokenRevokedException"));
    await expect(auth.currentOperator()).resolves.toBeNull();
  });

  it("returns the operator from the tokens", async () => {
    const auth = await load();
    amp.fetchAuthSession.mockResolvedValue(tokens());
    await expect(auth.currentOperator()).resolves.toEqual({ username: "op", email: "op@booqy.se" });
  });

  it("refreshedAccessToken forces a refresh", async () => {
    const auth = await load();
    amp.fetchAuthSession.mockResolvedValue(tokens("fresh"));
    await expect(auth.refreshedAccessToken()).resolves.toBe("fresh");
    expect(amp.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("retryUntilReachable tries again within seconds, and on online/focus, until stopped", async () => {
    vi.useFakeTimers();
    const auth = await load();
    const attempt = vi.fn();
    const stop = auth.retryUntilReachable(attempt);
    await vi.advanceTimersByTimeAsync(auth.RECONNECT_DELAYS_MS[0]);
    expect(attempt).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    expect(attempt).toHaveBeenCalledTimes(3);
    stop();
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("a transient refresh failure does not trigger another refresh at once (no retry storm)", async () => {
    const auth = await load();
    // Amplify 6 dispatches tokenRefresh_failure synchronously, then throws.
    amp.fetchAuthSession.mockImplementation(async () => {
      const error = named("NetworkError");
      amp.fire("auth", { event: "tokenRefresh_failure", data: { error } });
      throw error;
    });
    const refresh = vi.fn(() => {
      auth.currentOperator().catch(() => undefined);
    });
    const stop = auth.onAuthChange(refresh);
    refresh();
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(amp.fetchAuthSession).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("sign-in, sign-out and a definitive refresh failure still reach the shell", async () => {
    const auth = await load();
    const cb = vi.fn();
    const stop = auth.onAuthChange(cb);
    amp.fire("auth", { event: "signedIn" });
    amp.fire("auth", { event: "signedOut" });
    amp.fire("auth", { event: "tokenRefresh_failure", data: { error: named("NotAuthorizedException") } });
    amp.fire("auth", { event: "tokenRefresh" });
    amp.fire("booqy", { event: "signedOut" });
    stop();
    amp.fire("auth", { event: "signedOut" });
    expect(cb).toHaveBeenCalledTimes(4);
  });
});
