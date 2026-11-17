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

describe("api: the help assistant's question is quiet", () => {
  it("shows no busy bar and makes no page refetch", async () => {
    const { getBusyState } = await import("./test/busyProbe");
    const { LIVE_SAVED_EVENT } = await import("./live");
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(LIVE_SAVED_EVENT, on);
    let during = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      during = getBusyState();
      return json(200, { answer: { text: "x", steps: [], actions: [] }, mode: "kb" });
    }));
    await api.helpAnswer({ question: "q", history: [] });
    window.removeEventListener(LIVE_SAVED_EVENT, on);
    expect(during).toBe(false);
    expect(seen).toEqual([]);
  });

  it("an aborted question is a timeout, not a lost connection", async () => {
    // Like fetch: rejects when the signal is (or becomes) aborted.
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init.signal?.aborted) abort();
      init.signal?.addEventListener("abort", abort);
    })));
    const ctrl = new AbortController();
    const call = api.helpAnswer({ question: "q", history: [] }, ctrl.signal);
    ctrl.abort();
    await expect(call).rejects.toMatchObject({ status: 0, code: "timeout" });
  });

  it("an abort while the body is still arriving is the same timeout", async () => {
    const ctrl = new AbortController();
    // The headers are in; the body rejects once the signal aborts, like a real stream.
    const res = {
      status: 200,
      ok: true,
      headers: new Headers(),
      text: () => new Promise<string>((_, reject) => {
        ctrl.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    const call = api.helpAnswer({ question: "q", history: [] }, ctrl.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    ctrl.abort();
    await expect(call).rejects.toMatchObject({ status: 0, code: "timeout" });
  });

  it("a connection lost while the body arrives is offline", async () => {
    const res = { status: 200, ok: true, headers: new Headers(), text: () => Promise.reject(new TypeError("network")) } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    await expect(api.helpAnswer({ question: "q", history: [] })).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("keeps the server's request id on an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(503, { error: "service_unavailable", requestId: "req-123" })));
    await expect(api.helpAnswer({ question: "q", history: [] })).rejects.toMatchObject({ status: 503, extra: { requestId: "req-123" } });
  });
});

describe("api: the mail preview is quiet", () => {
  it("shows no busy bar and makes no page refetch on each typing pause", async () => {
    const { getBusyState } = await import("./test/busyProbe");
    const { LIVE_SAVED_EVENT } = await import("./live");
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(LIVE_SAVED_EVENT, on);
    let during = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      during = getBusyState();
      return json(200, { subject: "s", html: "<p>x</p>", text: "x" });
    }));
    await api.mailPreview({ subject: "s", body: "b" });
    window.removeEventListener(LIVE_SAVED_EVENT, on);
    expect(during).toBe(false);
    expect(seen).toEqual([]);
  });
});
