import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCorpus, helpSlug, parseNav } from "../../../scripts/help-corpus.mjs";
import { KB, ROUTE_PATTERNS } from "./kb";

/**
 * Keeps the help in step with the console (runs in CI with npm test): every
 * route in main.tsx has help, every button goes to a page that exists, every
 * menu item, settings row, tab and KPI tile has a data-help id, and every
 * "help:" highlight points at an id that is in the code. Added a page or a
 * setting? Give it a data-help id, write its guide in helpKb.json and run
 * `npm run help-kb:sync` so the server has the same corpus.
 */

const SRC = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const MAIN = read("main.tsx");

// Routes that only redirect and need no help of their own.
const REDIRECTS = ["/download"];

function appRoutes(): string[] {
  return [...MAIN.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== "*");
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

/** The tab names of a page (const TABS / VIEWS = [...]). */
function tabs(path: string): string[] {
  const m = read(path).match(/const (?:TABS|VIEWS) = \[([^\]]+)\]/);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((t) => t[1]) : [];
}
const TAB_PAGES = { "tenant-tab": "pages/TenantPage.tsx", "mail-tab": "pages/MailPage.tsx", "finance-tab": "pages/FinancePage.tsx" };

describe("help knowledge base", () => {
  it("lists exactly the routes in main.tsx", () => {
    expect([...ROUTE_PATTERNS].sort()).toEqual(appRoutes().sort());
  });

  it("has help for every route", () => {
    const covered = new Set(KB.entries.map((e) => e.route));
    const missing = appRoutes().filter((r) => !REDIRECTS.includes(r) && !covered.has(r));
    expect(missing, `routes without a guide in helpKb.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("only points at routes that exist, without parameters", () => {
    for (const e of KB.entries) {
      if (e.route !== null) expect(ROUTE_PATTERNS, e.id).toContain(e.route);
      for (const a of e.actions ?? []) {
        expect(ROUTE_PATTERNS, a.id).toContain(a.to);
        expect(a.to, a.id).not.toContain(":");
        expect(a.highlight ?? ["x"], `${a.id}: an empty highlight list reads differently in Python`).not.toEqual([]);
      }
    }
  });

  it("has unique ids, English text without dashes and nothing sensitive", () => {
    const ids = KB.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const docs = buildCorpus().docs.map((d) => d.id);
    expect(new Set(docs).size).toBe(docs.length);
    const text = JSON.stringify(buildCorpus());
    expect(text).not.toMatch(/[\u2013\u2014]|&[nm]dash;/);
    expect(text).not.toMatch(/AKIA|arn:aws|sk_live|sk_test|pk_live|pk_test|whsec_|\b\d{12}\b|amazonaws|dynamodb|lambda|cognito|tenant_id/i);
    for (const e of KB.entries) {
      expect(e.steps.length + e.answer.length, e.id).toBeGreaterThan(0);
      expect(e.audience, e.id).toBe("all");
      if (e.live) expect(e.live.text, e.id).toContain("{value}");
    }
  });

  it("gives every menu item, settings row, tab and KPI tile a data-help id (CI coverage check)", () => {
    // The grouped menu gets its ids from the nav model; Settings and Download app are written out.
    expect(MAIN).toMatch(/<NavLink key=\{item\.to\}[^>]*data-help=\{`nav:\$\{item\.to\}`\}/);
    const grouped = MAIN.slice(MAIN.indexOf("const NAV"), MAIN.indexOf("const ALL_NAV"));
    for (const item of parseNav()) {
      if (grouped.includes(`to: "${item.to}"`)) continue;
      expect(MAIN, `menu item ${item.label} without data-help`).toContain(`data-help="nav:${item.to}"`);
    }
    const settings = read("pages/SettingsPage.tsx");
    const rows = [...settings.matchAll(/<div className="setting-row"[^>]*>/g)].map((m) => m[0]);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) expect(row, "setting-row without data-help").toMatch(/data-help="settings:[\w-]+"/);
    expect(read("components/DesktopAppCard.tsx")).toContain('data-help="settings:desktop-app"');
    for (const [prefix, path] of Object.entries(TAB_PAGES)) {
      expect(read(path), `${path}: tab buttons without data-help`).toContain(`data-help={\`${prefix}:\${helpSlug(name)}\`}`);
    }
    for (const path of ["pages/FinancePage.tsx", "components/PaymentsView.tsx"]) {
      expect(read(path), `${path}: Kpi without data-help`).toContain("data-help={`kpi:${helpSlug(label)}`}");
    }
    expect(read("components/ui.tsx"), "Card without data-help").toContain("data-help={`card:${helpSlug(props.title)}`}");
  });

  it("only highlights data-help ids that exist in the code", () => {
    const code = sources(SRC).join("\n");
    const known = new Set([...code.matchAll(/data-help="([^"]+)"/g)].map((m) => m[1]));
    for (const m of code.matchAll(/<Kpi\b[^>]*?label="([^"]+)"/g)) known.add(`kpi:${helpSlug(m[1])}`);
    for (const m of code.matchAll(/<Card\b[^>]*?title="([^"]+)"/g)) known.add(`card:${helpSlug(m[1])}`);
    for (const item of parseNav()) known.add(`nav:${item.to}`);
    for (const [prefix, path] of Object.entries(TAB_PAGES)) for (const t of tabs(path)) known.add(`${prefix}:${helpSlug(t)}`);
    const filters = read("pages/TenantsPage.tsx").match(/const FILTERS = \[([^\]]+)\]/)?.[1] ?? "";
    for (const f of filters.matchAll(/"([^"]+)"/g)) known.add(`customers:filter:${f[1]}`);
    const used = buildCorpus().docs.flatMap((d) => [...(d.highlight ?? []), ...(d.actions ?? []).flatMap((a) => a.highlight ?? [])]);
    const missing = [...new Set(used.filter((h) => h.startsWith("help:")).map((h) => h.slice(5)))].filter((id) => !known.has(id));
    expect(missing, `data-help ids that don't exist: ${missing.join(", ")}`).toEqual([]);
  });
});
