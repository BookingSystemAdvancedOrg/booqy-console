import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { BOOQY_FAULT, describeError, errorDetails, fieldText, isPlain, plainReason } from "./errors";

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
    // A known code gets the console's own words, whatever the API wrote.
    expect(describeError(api(409, "slug_taken", "That slug is already used by another customer"))).toMatchObject({
      actor: "operator", text: "Another customer already uses that address. Pick another one.",
    });
    expect(describeError(api(403, "forbidden")).link).toEqual({ to: "/operators", label: "Open Operators" });
    expect(describeError(api(0, "network")).text).toBe("We can't reach Booqy right now. Check your internet and try again.");
    expect(describeError(new TypeError("Failed to fetch")).actor).toBe("operator");
    expect(describeError(api(404, "not_found")).text).toMatch(/may have been removed/);
    expect(describeError(api(429, "too_many_requests")).text).toMatch(/Wait a few seconds/);
    expect(describeError(new Error("Pick a plan first.")).text).toBe("Pick a plan first.");
  });

  it("never shows a raw API, Stripe or AWS message", () => {
    // known codes: the console's words, not the API's
    expect(describeError(api(502, "stripe_error", "Stripe: No such customer: 'cus_123'")).text).toBe(
      "Stripe said no to this. Check the customer in Stripe, then try again.");
    expect(describeError(api(502, "registration_refused", "Route 53 refused the registration: InvalidInput")).text)
      .not.toMatch(/Route 53|InvalidInput/);
    expect(describeError(api(409, "below_location_count", "Send force=true to apply anyway")).text).not.toMatch(/force/);
    // unknown codes: the API's message only when it reads plainly
    expect(describeError(api(409, "new_rule", "Pick a later date"))).toMatchObject({ actor: "operator", text: "Pick a later date." });
    for (const raw of ["KeyError: 'tenantId'", "status must be active", "invalid_cursor", "Request failed (400)", "{\"a\":1}"]) {
      expect(describeError(api(400, "new_rule", raw)).actor, raw).toBe("booqy");
    }
    // a feature's own text wins, and a field refusal points at the fields
    const own = api(404, "not_found", "x");
    own.ownMessage = "Meta ads isn't switched on here.";
    expect(describeError(own).text).toBe("Meta ads isn't switched on here.");
    const fields = new ApiError(400, "validation_failed", "2 fields need fixing", { email: "Required" });
    expect(describeError(fields).text).toMatch(/fields need fixing/);
    expect(describeError(api(0, "timeout")).text).toMatch(/too long/);
  });

  it("field messages in plain words with an example", () => {
    expect(fieldText("Required")).toBe("Fill this in.");
    expect(fieldText("Not a valid email address, e.g. anna@restaurang.se")).toMatch(/anna@restaurang\.se/);
    expect(fieldText("Not a valid phone number, e.g. 070-123 45 67 or +46 70 123 45 67")).toMatch(/070-123 45 67/);
    expect(fieldText("At most 200 characters")).toBe("Too long. Use at most 200 characters.");
    expect(fieldText("Doesn't match the org. number - it should be SE556677889901")).toBe(
      "It should be SE556677889901 to match the org. number.");
    expect(fieldText("Must be an object")).toMatch(/doesn't look right/);
    expect(fieldText("Pick the plan after Free")).toBe("Pick the plan after Free.");
    expect(fieldText("invalid_cap")).toMatch(/doesn't look right/);
  });

  it("isPlain and plainReason keep sentences, drop raw text", () => {
    expect(isPlain("Pick another one")).toBe(true);
    expect(isPlain("GitHub 403")).toBe(false);
    expect(isPlain("At most 500 kr is left")).toBe(true);
    expect(plainReason("CNAME missing")).toBe("CNAME missing.");
    expect(plainReason("botocore.exceptions.ClientError: AccessDenied")).toBeUndefined();
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
