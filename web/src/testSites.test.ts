import { afterEach, describe, expect, it, vi } from "vitest";
import { isProd, testMapping } from "./testSites";

describe("testMapping", () => {
  it("maps a domain (with or without www) onto both test zones", () => {
    expect(testMapping("www.Example.se")).toEqual({
      domain: "example.se", main: "example-se.test.booqy.se", dev: "example-se.test-dev.booqy.se" });
    expect(testMapping("https://pizza.roma.com/")).toEqual({
      domain: "pizza.roma.com", main: "pizza-roma-com.test.booqy.se", dev: "pizza-roma-com.test-dev.booqy.se" });
  });

  it("is null until it is a domain", () => {
    for (const input of ["", "example", "exa mple.se", "-x.se", `${"a".repeat(62)}.se`]) expect(testMapping(input)).toBeNull();
  });
});

describe("isProd", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("follows VITE_ENVIRONMENT", () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    expect(isProd()).toBe(true);
    vi.stubEnv("VITE_ENVIRONMENT", "dev");
    expect(isProd()).toBe(false);
  });
});
