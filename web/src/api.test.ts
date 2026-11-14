import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  AuthUnavailableError: class AuthUnavailableError extends Error {},
  accessToken: vi.fn(async () => "old"),
  refreshedAccessToken: vi.fn(async (): Promise<string | null> => "fresh"),
  notifySignedOut: vi.fn(),
  signOut: vi.fn(async () => undefined),
}));
vi.mock("./auth", () => auth);

import { api } from "./api";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("api: a 401 is not a sign-out by itself", () => {
  it("refreshes once and retries the call with the new token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(401, { message: "Unauthorized" }))
      .mockResolvedValueOnce(json(200, { plans: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.plans()).resolves.toEqual([]);
    expect(auth.refreshedAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh");
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("signs out when the refresh says the session is over", async () => {
    auth.refreshedAccessToken.mockResolvedValueOnce(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(401, {})));

    await expect(api.plans()).rejects.toMatchObject({ status: 401 });
    expect(auth.signOut).toHaveBeenCalled();
    expect(auth.notifySignedOut).toHaveBeenCalled();
  });

  it("Cognito unreachable is a network error and keeps the operator signed in", async () => {
    auth.accessToken.mockRejectedValueOnce(new auth.AuthUnavailableError());
    vi.stubGlobal("fetch", vi.fn());

    await expect(api.plans()).rejects.toMatchObject({ status: 0, code: "network" });
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
