import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { BOOQY_FAULT, describeError, errorDetails } from "./errors";

const api = (status: number, code: string, server?: string, extra: Record<string, unknown> = {}) => {
  const e = new ApiError(status, code, server ?? "", {}, extra);
  if (server) e.serverMessage = server;
  return e;
};

describe("who acts (console)", () => {
  it("Booqy's fault: 5xx, *_unavailable, internal_error, AccessDenied, bad responses, unknown codes", () => {
    for (const e of [
      api(500, "internal_error"),
      api(502, "stripe_unavailable", "Stripe didn't answer. Try again in a moment."),
      api(503, "service_unavailable"),
      api(403, "AccessDenied"),
      api(200, "bad_response"),
      api(400, "weird_new_code"),
    ]) {
      const info = describeError(e);
      expect(info.actor, info.code).toBe("booqy");
      expect(info.text).toContain(BOOQY_FAULT);
      expect(info.text).not.toMatch(/Try again in a moment\.\s*This/);
    }
    expect(describeError(api(502, "stripe_unavailable", "Stripe didn't answer. Try again in a moment.")).text)
      .toBe(`Stripe didn't answer. ${BOOQY_FAULT}`);
    expect(describeError({ odd: 1 }).actor).toBe("booqy");
  });

  it("the operator acts: the API's own message, or what to do and where", () => {
    expect(describeError(api(409, "slug_taken", "That address is taken. Pick another one."))).toMatchObject({
      actor: "operator", text: "That address is taken. Pick another one.",
    });
    expect(describeError(api(403, "forbidden")).link).toEqual({ to: "/operators", label: "Open Operators" });
    expect(describeError(api(0, "network")).text).toMatch(/internet connection/);
    expect(describeError(new TypeError("Failed to fetch")).actor).toBe("operator");
    expect(describeError(api(404, "not_found")).text).toMatch(/removed elsewhere/);
    expect(describeError(api(429, "too_many_requests")).text).toMatch(/Wait a few seconds/);
    expect(describeError(new Error("Pick a plan first.")).text).toBe("Pick a plan first.");
  });

  it("details to copy: code, status, request id, page and time, nothing else", () => {
    const info = describeError(api(500, "internal_error", undefined, { requestId: "abc-123" }));
    const text = errorDetails(info, "/tenants/t1?token=secret#x", new Date("2026-11-14T10:00:00Z"));
    expect(text).toBe([
      "Error: internal_error", "HTTP status: 500", "Request id: abc-123", "Page: /tenants/t1", "Time: 2026-11-14T10:00:00.000Z",
    ].join("\n"));
    expect(text).not.toContain("secret");
  });
});
