import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  AuthUnavailableError: class AuthUnavailableError extends Error {},
  accessToken: vi.fn(async () => "old"),
  refreshedAccessToken: vi.fn(async (): Promise<string | null> => "fresh"),
  notifySignedOut: vi.fn(),
  signOut: vi.fn(async () => undefined),
}));
vi.mock("../auth", () => auth);

import { metaAdsApi } from "./meta-ads/api";
import { phoneAgentApi } from "./phone-agent/api";
import { googleBusinessApi } from "./google-business/api";
import { exportLedger } from "./personalliggare/api";
import { describeError } from "../errors";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("feature clients go through api.ts", () => {
  it("a quiet live refetch skips the busy bar", async () => {
    const { getBusyState } = await import("../test/busyProbe");
    const { quietly } = await import("../live");
    let during = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      during = getBusyState();
      return json(200, { killSwitch: false, maxMonthlyCapSek: 20000 });
    }));
    await quietly(() => metaAdsApi.settings());
    expect(during).toBe(false);
    await quietly(() => phoneAgentApi.tenant("t1"));
    expect(during).toBe(false);
    await quietly(() => googleBusinessApi.tenant("t1"));
    expect(during).toBe(false);
  });

  it("a 401 refreshes the token once and retries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { status: "connected", links: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(googleBusinessApi.tenant("t1")).resolves.toEqual({ status: "connected", links: [] });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh");
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("signs out when the session is over", async () => {
    auth.refreshedAccessToken.mockResolvedValueOnce(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(401, {})));
    await expect(phoneAgentApi.settings()).rejects.toMatchObject({ status: 401 });
    expect(auth.notifySignedOut).toHaveBeenCalled();
  });

  it("keeps the request id on a 5xx and says it is a Booqy fault", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(502, { error: "internal_error" }, { "apigw-requestid": "req-9" })));
    const err = await metaAdsApi.tenant("t1").catch((e) => e);
    expect(err).toMatchObject({ status: 502, extra: { requestId: "req-9" } });
    expect(describeError(err).text).toMatch(/Booqy's fault/);
    expect(err.message).not.toMatch(/Request failed/);
  });

  it("a 403 says who acts instead of 'Request failed (forbidden).'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { error: "forbidden" })));
    const err = await metaAdsApi.settings().catch((e) => e);
    expect(describeError(err)).toMatchObject({ text: expect.stringMatching(/check your account/), link: { to: "/operators" } });
  });

  it("keeps each feature's own 404 and 503 texts", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(404, { error: "not_found", message: "x" }))
      .mockResolvedValueOnce(json(503, { error: "feature_unavailable" }))
      .mockResolvedValueOnce(json(404, { error: "not_found" }))
      .mockResolvedValueOnce(json(400, { error: "invalid_cap", fields: { maxMinutesCap: "invalid_cap" } })));
    await expect(metaAdsApi.settings()).rejects.toMatchObject({ message: "Meta ads isn't switched on here, or we can't find this customer." });
    await expect(googleBusinessApi.tenant("t1")).rejects.toMatchObject({ message: "Google Business Profile didn't answer. Try again in a minute." });
    await expect(exportLedger("t1", { locationId: "l", from: "2026-01-01", to: "2026-02-01" }))
      .rejects.toMatchObject({ message: "There is no staff ledger for this location, or the staff ledger isn't switched on here." });
    await expect(phoneAgentApi.saveSettings({ killSwitch: true, maxMinutesCap: 1 }))
      .rejects.toMatchObject({ status: 400, message: "Use whole minutes from 0 to 100000, like 600.", fields: { maxMinutesCap: "invalid_cap" } });
  });

  it("maps the Meta ads invalid_cap to the cap range", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(400, { error: "invalid_cap", fields: { maxMonthlyCapSek: "invalid_cap" } })));
    await expect(metaAdsApi.saveSettings({ killSwitch: false, maxMonthlyCapSek: 5 }))
      .rejects.toMatchObject({ status: 400, message: "Use whole kronor from 100 to 1 000 000, like 5000.", fields: { maxMonthlyCapSek: "invalid_cap" } });
  });

  it("a save tells live pages to refetch", async () => {
    const { LIVE_SAVED_EVENT } = await import("../live");
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(LIVE_SAVED_EVENT, on);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, { paused: true })));
    await metaAdsApi.setPaused("t1", true);
    window.removeEventListener(LIVE_SAVED_EVENT, on);
    expect(seen).toEqual([{ path: "/platform/tenants/t1/meta-ads" }]);
  });
});
