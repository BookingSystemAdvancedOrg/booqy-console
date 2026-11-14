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

describe("api: live refetches", () => {
  it("a quiet refetch skips the busy bar; a normal load shows it", async () => {
    const { getBusyState } = await import("./test/busyProbe");
    const { quietly } = await import("./live");
    let during = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      during = getBusyState();
      return json(200, { plans: [] });
    }));
    await quietly(() => api.plans());
    expect(during).toBe(false);
    await api.plans();
    expect(during).toBe(true);
  });

  it("a save tells every live page to refetch, also after a 409", async () => {
    const { LIVE_SAVED_EVENT } = await import("./live");
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(LIVE_SAVED_EVENT, on);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(200, { tenant: {} }))
      .mockResolvedValueOnce(json(409, { error: "conflict", message: "Changed." }))
      .mockResolvedValueOnce(json(200, { plans: [] })));
    await api.updateTenant("t1", { name: "x" });
    await expect(api.updateTenant("t1", { name: "y" })).rejects.toMatchObject({ status: 409 });
    await api.plans();
    window.removeEventListener(LIVE_SAVED_EVENT, on);
    expect(seen).toEqual([{ path: "/platform/tenants/t1" }, { path: "/platform/tenants/t1", conflict: true }]);
  });
});
