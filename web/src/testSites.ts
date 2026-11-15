/** Test sites (owner 2026-11-15): outside prod no domain is bought, connected
 * or transferred; a test customer's "own domain" is mapped onto the test
 * sites zones instead (the API's domains.test_hosts does the same). Pure:
 * tested in testSites.test.ts. */

export const TEST_MAIN_ZONE = "test.booqy.se";
export const TEST_DEV_ZONE = "test-dev.booqy.se";

/** Read at call time, so tests can switch it with vi.stubEnv. */
export function isProd(): boolean {
  return (import.meta.env.VITE_ENVIRONMENT ?? "dev") === "prod";
}

/** "www.Example.se" as { domain: "example.se", main: "example-se.test.booqy.se", dev: "example-se.test-dev.booqy.se" },
 * or null while it isn't a domain yet. */
export function testMapping(input: string): { domain: string; main: string; dev: string } | null {
  const domain = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
  const label = domain.replace(/\./g, "-");
  if (label.length > 63) return null;
  return { domain, main: `${label}.${TEST_MAIN_ZONE}`, dev: `${label}.${TEST_DEV_ZONE}` };
}
