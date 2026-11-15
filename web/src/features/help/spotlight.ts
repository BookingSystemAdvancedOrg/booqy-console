/**
 * Lights up what the assistant points at: waits until the page has drawn the
 * targets (up to WAIT_MS), scrolls there and gives them a ring that fades
 * after about 2.6 seconds. Several targets light up at once. Nothing else
 * happens: the page and its choices are left as they are, and it never
 * navigates back. Same as admin's spotlight.ts.
 *
 * Targets: "help:<data-help id>" or "text:<visible text>" (heading, field,
 * button, tab). A text lights up its row, field or card, not just the word.
 */

const WAIT_MS = 4000;
export const SPOT_MS = 2600;
const TEXT_TAGS = "h1,h2,h3,h4,label,button,a,legend,th,.strong,.field__label,.kpi__label";
const ROW = "[data-help],.setting-row,.field,.kpi,.tab,button,a,tr,li";

/** Is the element shown (not in a hidden part or display: none)? */
const visible = (el: Element) =>
  !(el as HTMLElement).closest("[hidden]") && getComputedStyle(el).display !== "none";

export function findTargets(targets: string[], root: ParentNode = document): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const t of targets) {
    if (t.startsWith("help:")) {
      const id = t.slice(5);
      for (const el of root.querySelectorAll<HTMLElement>("[data-help]")) if (el.dataset.help === id && visible(el)) found.push(el);
    } else if (t.startsWith("text:")) {
      const want = t.slice(5).trim().toLowerCase();
      for (const el of root.querySelectorAll<HTMLElement>(TEXT_TAGS)) {
        if ((el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() !== want || !visible(el)) continue;
        if (el.closest(".help-panel")) continue;
        const row = el.matches(ROW) ? el : (el.parentElement?.closest<HTMLElement>(ROW) ?? el);
        found.push(row);
        break;
      }
    }
  }
  return [...new Set(found)];
}

let active: { stop: () => void } | null = null;

/** Lights up the targets; resolves with how many were found. */
export function spotlight(targets: string[], opts: { waitMs?: number; reducedMotion?: boolean } = {}): Promise<number> {
  active?.stop();
  if (!targets.length) return Promise.resolve(0);
  const reduced = opts.reducedMotion ?? window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return new Promise((resolve) => {
    const started = Date.now();
    let timer = 0;
    let frame = 0;
    const lit: HTMLElement[] = [];
    const stop = () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      for (const el of lit) el.classList.remove("help-spotlight", "help-spotlight--fade");
    };
    active = { stop };
    const tryNow = () => {
      const els = findTargets(targets);
      if (!els.length && Date.now() - started < (opts.waitMs ?? WAIT_MS)) {
        frame = requestAnimationFrame(() => (timer = window.setTimeout(tryNow, 120)));
        return;
      }
      if (!els.length) return resolve(0);
      els[0].scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
      for (const el of els) {
        el.classList.remove("help-spotlight--fade");
        el.classList.add("help-spotlight");
        lit.push(el);
      }
      timer = window.setTimeout(() => {
        for (const el of lit) el.classList.add("help-spotlight--fade");
        timer = window.setTimeout(() => {
          stop();
          if (active?.stop === stop) active = null;
        }, 450);
      }, SPOT_MS);
      resolve(els.length);
    };
    tryNow();
  });
}
