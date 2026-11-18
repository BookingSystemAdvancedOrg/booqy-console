import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* No edges (owner 2026-11-18): every edge in the console is transparent.
   jsdom has no cascade worth trusting, so this reads the sheets: the last
   global layer, the edge tokens and every 1 to 2 px ring or 1 px line drawn
   with a box-shadow. Focus rings (3 px, outline) are not edges and stay. */
const SRC = resolve(__dirname);
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const sheets = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sheets(p) : p.endsWith(".css") ? [p] : [];
  });
const allCss = [...sheets(SRC).map((p) => [p, readFileSync(p, "utf8")] as const), ["updateNotice.ts", read("updateNotice.ts")] as const];

const EDGE_TOKENS = ["paper-line", "line", "line-soft", "fg-line", "hairline", "hairline-strong", "glass-border", "field-border", "field-border-hover", "notice-ok-line", "notice-warn-line", "notice-error-line"];
const COLOR = String.raw`(?:rgba?\((?:[^()]|\([^()]*\))*\)|#[0-9a-fA-F]{3,8}\b|currentColor|color-mix\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|var\(--[\w-]+\))`;

describe("no edges", () => {
  it("loads the no-edges layer last, with the global transparent border rule", () => {
    const main = read("main.tsx");
    const imports = [...main.matchAll(/^import "(\.[^"]+\.css)";/gm)].map((m) => m[1]);
    expect(imports.at(-1)).toBe("./noEdges.css");
    const layer = read("noEdges.css");
    expect(layer).toMatch(/:not\(\.press-ripple, \.bq-ripple\)::after \{\s*border-color: transparent !important;\s*column-rule-color: transparent !important;/);
    expect(layer).toContain("hr { border-color: transparent !important;");
    expect(layer).toContain("--bq-line: transparent;");
    // the focus indicator is never switched off here
    expect(layer).not.toMatch(/outline[\w-]*\s*:/);
  });

  it("sets every edge colour token to transparent in light and dark", () => {
    const css = read("styles.css") + read("ds.css");
    for (const t of EDGE_TOKENS) {
      const defs = [...css.matchAll(new RegExp(String.raw`--${t}:\s*([^;]+);`, "g"))].map((m) => m[1].trim());
      expect(defs.length, t).toBeGreaterThan(0);
      for (const v of defs) expect(v, `--${t}`).toBe("transparent");
    }
  });

  it("draws no ring or lit line with a box-shadow outside focus rules", () => {
    const ring = new RegExp(String.raw`(?:inset\s+)?0\s+0\s+0\s+([\d.]+)px\s+(${COLOR})`, "g");
    const line = new RegExp(String.raw`inset\s+0\s+-?1px\s+0\s+(${COLOR})`, "g");
    // a focus rule is one where every selector is a focus selector; "a:focus-visible, a[aria-expanded]" is not
    const topLevel = (sel: string) => {
      const parts: string[] = [];
      let depth = 0, cur = "";
      for (const ch of sel) {
        if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        cur += ch;
      }
      return [...parts, cur].map((s) => s.trim()).filter(Boolean);
    };
    const isFocusRule = (sel: string) => topLevel(sel).every((s) => s.includes(":focus"));
    const offenders: string[] = [];
    for (const [file, css] of allCss) {
      for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]*)\{([^{}]*)\}/g)) {
        if (isFocusRule(m[1])) continue;
        for (const d of m[2].matchAll(/(?:box-shadow|--[\w-]+)\s*:([^;]*)/g)) {
          // any width, thin rims and wider frames alike; 100 px and up is a tint or a scrim (inset fill), not an edge
          for (const r of d[1].matchAll(ring)) {
            if (Number(r[1]) >= 100 || r[2] === "transparent") continue;
            offenders.push(`${file}: ${m[1].trim()} ${r[0]}`);
          }
          for (const r of d[1].matchAll(line)) offenders.push(`${file}: ${m[1].trim()} ${r[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps fills that used to borrow an edge colour visible", () => {
    const styles = read("styles.css");
    expect(styles).toContain(".printing i { display: block; height: 7px; border-radius: 2px; background: var(--paper-shade);");
    expect(styles).toMatch(/--paper-shade: #[0-9a-f]{6};/);
  });
});
