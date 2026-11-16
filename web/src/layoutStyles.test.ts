import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* Layout fixes from the 2026-11-16 UI audit. jsdom has no layout, so these
   read the style sheets and check the rules (and their order) that the
   screenshots at 375, 768, 1280 and 1920 were verified with. */
const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");
const styles = read("styles.css");
const ds = read("ds.css");
const phoneTables = read("phoneTables.css");
const phoneTargets = read("phoneTargets.css");
const website = read("pages/WebsitePage.css");

describe("audit layout fixes", () => {
  it("folds the operator row actions into the menu before they clip at 1280 (184)", () => {
    expect(ds).toContain("@container (max-width: 1180px) {\n  .row-actions--inline { display: none; }");
    expect(ds).not.toContain("@container (max-width: 560px) {\n  .row-actions--inline");
  });

  it("keeps a phone card label whole while values may still break anywhere (192)", () => {
    const label = phoneTables.slice(phoneTables.indexOf(".table.table > tbody > tr > td[data-label]::before {"));
    const rule = label.slice(0, label.indexOf("}"));
    expect(rule).toContain("word-break: normal;");
    // too narrow at 320: hyphenate or wrap inside the cell, never overflow into the next label
    expect(rule).toContain("overflow-wrap: break-word;");
    expect(rule).toContain("hyphens: auto;");
    expect(rule).not.toContain("overflow-wrap: normal");
    expect(phoneTables).toMatch(/text-align: right !important; white-space: normal !important; overflow-wrap: anywhere;/);
  });

  it("moves the KPI trend chip under a label that does not fit, and fills the orphan slot (193)", () => {
    expect(styles).toContain(".kpi__head { flex-wrap: wrap; row-gap: 4px; }");
    expect(styles).toContain(".kpi__head .kpi__label { min-width: 0; flex: 0 1 auto; max-width: 100%; overflow-wrap: break-word; }");
    expect(styles).toContain(".kpis--units > .kpi:nth-child(odd):last-child { grid-column: 1 / -1; }");
  });

  it("greys disabled primary buttons in dark mode too, after the lacquer rules (194)", () => {
    const disabled = styles.indexOf(':root[data-theme="dark"] .btn.btn--primary:disabled:not(.save-btn--done)');
    expect(disabled).toBeGreaterThan(-1);
    const lacquerDark = styles.indexOf(':root[data-theme="dark"] .btn--primary, :root[data-theme="dark"] .chip--on');
    const flatDark = styles.indexOf(':root[data-theme="dark"] .btn--primary { background: #f6f1ea;');
    expect(disabled).toBeGreaterThan(lacquerDark);
    expect(disabled).toBeGreaterThan(flatDark);
    const rule = styles.slice(disabled, styles.indexOf("}", disabled));
    expect(rule).toContain("background: var(--glass-fill); color: var(--print-2); border-color: var(--paper-line); box-shadow: none;");
  });

  it("keeps a finished save green while it is disabled, in both themes (194)", () => {
    const start = styles.indexOf("/* a finished save stays green");
    const selectors = styles.slice(start, styles.indexOf("{", start)).split("*/")[1];
    const list = selectors.split(",").map((x) => x.trim());
    expect(list).toHaveLength(4);
    for (const sel of list) expect(sel).toMatch(/:disabled:not\(\.save-btn--done\)$/);
    expect(styles).toContain(".save-btn--done, .save-btn--done:disabled { background: var(--ok);");
  });

  it("wraps the page tabs onto a second row instead of clipping them (195)", () => {
    const rule = '.tabs[data-glide="track"] { flex-wrap: wrap !important; row-gap: 2px !important; overflow: visible; border-radius: 20px !important; }';
    expect(styles).toContain(rule);
    // after the generic glide track rule, which forces nowrap
    expect(styles.indexOf(rule)).toBeGreaterThan(styles.indexOf('[data-glide="track"] {\n  flex-wrap: nowrap !important;'));
  });

  it("sets only the image of the dark volume track, so the phone's 6 px track size survives (196)", () => {
    const dark = styles.slice(styles.indexOf(':root[data-theme="dark"] .sound-volume input[type="range"] {'));
    const rule = dark.slice(0, dark.indexOf("}"));
    expect(rule).toContain("background-image: linear-gradient(");
    expect(rule).not.toMatch(/\bbackground:/);
    expect(phoneTargets).toContain("background-size: 100% 6px;");
  });

  it("stacks Visits per day and Traffic sources on laptops (212)", () => {
    expect(read("pages/WebsitePage.tsx")).toMatch(/<div className="charts web-traffic">\s*<Card title="Visits per day">/);
    expect(website).toContain("@media (max-width: 1440px) { .charts.web-traffic { grid-template-columns: minmax(0, 1fr); } }");
  });

  it("puts phone tabs in an even grid with no stretched last pill (213)", () => {
    const phone = phoneTables.slice(phoneTables.indexOf("@media (max-width: 640px) {"));
    // auto-fit collapses empty tracks, so two tabs (Finance) still fill the bar
    expect(phone).toContain('.tabs[data-glide="track"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); }');
    expect(phoneTables).not.toContain("auto-fill");
  });

  it("caps the ring legends and aligns the rings to the top (214)", () => {
    expect(styles).toContain(".ring { margin: 0; display: grid; align-content: start;");
    expect(styles).toMatch(/\.ring__legend \{[^}]*width: 100%; max-width: 260px;/);
  });
});
