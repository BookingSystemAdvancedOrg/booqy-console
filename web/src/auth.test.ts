import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const amp = vi.hoisted(() => ({ fetchAuthSession: vi.fn(), signOut: vi.fn(async () => undefined), dispatch: vi.fn() }));

vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("aws-amplify/auth", () => ({ fetchAuthSession: amp.fetchAuthSession, signOut: amp.signOut }));
vi.mock("aws-amplify/auth/cognito", () => ({ cognitoUserPoolsTokenProvider: { setKeyValueStorage: vi.fn() } }));
vi.mock("aws-amplify/utils", () => ({ Hub: { dispatch: amp.dispatch, listen: vi.fn(() => () => undefined) }, defaultStorage: {} }));

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
});
