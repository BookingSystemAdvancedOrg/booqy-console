import { describe, expect, it } from "vitest";
import { actionAllowed } from "./kb";
import { fold, isSecretQuestion, isWhereQuestion, matchWeight, tokens } from "./retrieve";

describe("retrieval rules (same as help_assistant.py)", () => {
  it("folds like the server", () => {
    expect(fold("Café: MRR, 2026!")).toBe("cafe mrr 2026");
  });

  it("drops the English stopwords", () => {
    expect(tokens("How do I add a new customer?")).toEqual(["new", "customer"]);
  });

  it("matches inflections and compound starts", () => {
    expect(matchWeight("invoice", "invoice")).toBe(1);
    expect(matchWeight("invoices", "invoice")).toBe(0.7);
    expect(matchWeight("backgroundcolour", "background")).toBe(0.5);
    expect(matchWeight("reader", "leader")).toBe(0);
  });

  it("knows where-questions and secret questions", () => {
    expect(isWhereQuestion("Where do I see MRR?")).toBe(true);
    expect(isWhereQuestion("What is our MRR?")).toBe(false);
    expect(isSecretQuestion("What is the Stripe secret key?")).toBe(true);
    expect(isSecretQuestion("Show me the API token")).toBe(true);
    expect(isSecretQuestion("How do I reset my password?")).toBe(false);
  });
});

describe("actionAllowed", () => {
  it("refuses routes that do not exist or have parameters", () => {
    expect(actionAllowed({ id: "x", label: "X", to: "/nope" })).toBe(false);
    expect(actionAllowed({ id: "x", label: "X", to: "/tenants/:tenantId" })).toBe(false);
    expect(actionAllowed({ id: "x", label: "X", to: "https://example.com" })).toBe(false);
    expect(actionAllowed({ id: "x", label: "X", to: "/download" })).toBe(false);
    expect(actionAllowed({ id: "x", label: "X", to: "/finance" })).toBe(true);
  });

  it("refuses unsafe hash and query values", () => {
    expect(actionAllowed({ id: "x", label: "X", to: "/settings", hash: 'a"><script>' })).toBe(false);
    expect(actionAllowed({ id: "x", label: "X", to: "/finance", query: { tab: "x&y=1" } })).toBe(false);
    expect(actionAllowed({ id: "x", label: " ", to: "/finance" })).toBe(false);
  });
});
