/** A long form as steps on one page (New customer): a sticky progress bar,
 * step cards that fold into a summary when done, and small rewards on the
 * way (the tick draws itself, the bar glows, a chime, a burst of sparks; a
 * confetti shower at the end). With "reduce motion" nothing moves: states
 * change at once, the chime stays (as the click does). */
import { KeyboardEvent, ReactNode, useId, useLayoutEffect } from "react";
import { CountUp, prefersReducedMotion } from "./motion";
import "./stepFlow.css";

/** The brand palette for sparks and confetti: wine, ink red, tan, walnut, sand, snow. */
export const SPARK_COLOURS = ["#350001", "#9e1d26", "#a88462", "#6b4a2e", "#d5c4ae", "#f6f1ea"];

/** A small "i" that shows its text on hover, focus or tap. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="info-tip">
      <button type="button" className="info-tip__btn" aria-label={label} aria-describedby={id}
              onKeyDown={(e) => { if (e.key === "Escape") (e.currentTarget as HTMLButtonElement).blur(); }}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 11v6M12 7.2v.1" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
      <span id={id} role="tooltip" className="info-tip__pop">{children}</span>
    </span>
  );
}

/** The tick that draws itself when a step is done. */
export function DrawnTick({ className = "" }: { className?: string }) {
  return (
    <svg className={`drawn-tick ${className}`} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round"
            pathLength={1} />
    </svg>
  );
}

/** Keeps --flow-top on <html> at the bottom of the sticky top bar, so the
 * progress bar sticks right under it and scrolled-to steps clear both. */
function useTopbarOffset() {
  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>(".topbar");
    const root = document.documentElement;
    const main = document.querySelector<HTMLElement>(".main");
    const update = () => {
      // Only a bar above the page counts; the side bar on wide screens sits beside it.
      const r = bar?.getBoundingClientRect();
      const m = main?.getBoundingClientRect();
      const above = r && (!m || (r.left < m.right && r.right > m.left));
      const top = above ? r.height + 12 : 0;
      root.style.setProperty("--flow-top", `${Math.round(top) + 8}px`);
    };
    update();
    window.addEventListener("resize", update);
    const ro = bar && typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    if (bar) ro?.observe(bar);
    return () => { ro?.disconnect(); window.removeEventListener("resize", update); root.style.removeProperty("--flow-top"); };
  }, []);
}

/** The bar: fill, the percentage counting up, and "Step 3 of 6". `won` runs the shimmer. */
export function StepProgress({ pct, done, total, current, won = false }: {
  pct: number; done: number; total: number; current: string; won?: boolean;
}) {
  useTopbarOffset();
  const step = Math.min(done + 1, total);
  return (
    <div className={`flow-progress${won ? " flow-progress--won" : ""}`} data-done={done}>
      <div className="flow-progress__track" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100}
           aria-valuenow={Math.round(pct)} aria-valuetext={`${Math.round(pct)} %`}>
        <div className="flow-progress__fill" style={{ transform: `scaleX(${pct / 100})` }} />
        {done > 0 && <span key={done} className="flow-progress__glow" aria-hidden="true" />}
        {won && <span className="flow-progress__shine" aria-hidden="true" />}
      </div>
      <span className="flow-progress__pct"><CountUp value={Math.round(pct)} format={(n) => `${Math.round(n)} %`} /></span>
      <span className="flow-progress__step">
        {done >= total ? <><DrawnTick /> {total} of {total}</> : <>Step {step} of {total}<span className="flow-progress__name"> · {current}</span></>}
      </span>
    </div>
  );
}

export interface StepCardProps {
  id: string;
  index: number;
  total: number;
  title: string;
  /** Open to edit (else folded into its summary). */
  open: boolean;
  done: boolean;
  /** The step just appeared: it rises in. */
  entering?: boolean;
  info?: ReactNode;
  summary?: ReactNode;
  /** No Edit link (the step can't change any more). */
  locked?: boolean;
  doneLabel?: string;
  onDone: () => void;
  onEdit: () => void;
  children: ReactNode;
}

/** One step: open with its fields and a Done button, or done as a summary with Edit. */
export function StepCard(p: StepCardProps) {
  const headId = useId();
  const last = p.index === p.total - 1;
  // Enter in a one-line field finishes the step (Done), not the whole form.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.key !== "Enter" || e.defaultPrevented || !(t instanceof HTMLInputElement) || ["checkbox", "radio"].includes(t.type)) return;
    e.preventDefault();
    p.onDone();
  };
  return (
    <section id={`step-${p.id}`} aria-labelledby={headId} data-help={`card:${p.id}`} data-step={p.index}
             className={`card step${p.open ? " step--open" : ""}${p.done ? " step--done" : ""}${p.entering ? " step--enter" : ""}`}>
      <header className="card__head step__head">
        <h2 id={headId}>
          <span className="step__num" aria-hidden="true">{p.done ? <DrawnTick /> : p.index + 1}</span>
          <span>{p.title}</span>
          {p.done && <span className="sr-only"> (done)</span>}
        </h2>
        <div className="card__actions">
          {p.info}
          {p.done && !p.open && !p.locked && (
            <button type="button" className="linkish step__edit" onClick={p.onEdit} aria-label={`Edit ${p.title}`}>Edit</button>
          )}
        </div>
      </header>
      {p.done && !p.open && p.summary && <div className="step__summary">{p.summary}</div>}
      <div className="card__body step__body" hidden={!p.open} onKeyDown={onKeyDown}>
        {p.children}
        <div className="step__foot">
          <button type="button" className="btn btn--primary step__done" onClick={p.onDone}>
            {p.doneLabel ?? (p.done ? "Done" : last ? "Done, review" : "Done, next")}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Short summary values of a done step: "label value" pairs, the empty ones left out. */
export function Summary({ items }: { items: [string, ReactNode][] }) {
  const shown = items.filter(([, v]) => v !== "" && v !== null && v !== undefined && v !== false);
  if (shown.length === 0) return <p className="step-sum step-sum--none">Nothing added</p>;
  return (
    <dl className="step-sum">
      {shown.map(([k, v]) => (
        <div key={k} className="step-sum__item"><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

/** Scrolls a step into view below the sticky bars and focuses its first field. */
export function revealStep(el: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView?.({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  const fields = [...el.querySelectorAll<HTMLElement>(".step__body input:not([type='hidden']):not([readonly]):not(:disabled), .step__body textarea:not(:disabled), .step__body select:not(:disabled), .step__body button:not(:disabled)")];
  // the first one on screen (a plan's radio sits under its card)
  const first = fields.find((f) => f.getClientRects().length > 0) ?? fields[0];
  (first ?? el).focus?.({ preventScroll: true });
}

/** A small burst of sparks from an element (the tick of a done step). */
export function burst(origin: Element | null, count = 14): HTMLElement | null {
  if (!origin || prefersReducedMotion() || typeof document === "undefined") return null;
  const r = origin.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "spark-layer";
  layer.style.left = `${r.left + r.width / 2}px`;
  layer.style.top = `${r.top + r.height / 2}px`;
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  let left = count;
  for (let i = 0; i < count; i++) {
    const s = document.createElement("i");
    s.style.background = SPARK_COLOURS[i % SPARK_COLOURS.length];
    if (i % 3 === 0) s.style.borderRadius = "1px";
    layer.appendChild(s);
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const d = 26 + Math.random() * 30;
    const done = () => { s.remove(); if (--left === 0) layer.remove(); };
    if (typeof s.animate !== "function") { done(); continue; }
    s.animate(
      [
        { transform: "translate(-50%, -50%) scale(0.4)", opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(a) * d * 0.7}px), calc(-50% + ${Math.sin(a) * d * 0.7}px)) scale(1)`, opacity: 1, offset: 0.45 },
        { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + 8}px)) scale(0.2)`, opacity: 0 },
      ],
      { duration: 620 + Math.random() * 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    ).onfinish = done;
  }
  return layer;
}

/** The big one: a shower of brand-coloured confetti over the page (canvas, about 2 s). */
export function confetti(pieces = 150): HTMLCanvasElement | null {
  if (prefersReducedMotion() || typeof document === "undefined" || typeof requestAnimationFrame !== "function") return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.className = "confetti-layer";
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);
  const parts = Array.from({ length: pieces }, (_, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const angle = (-Math.PI / 2) + side * (0.25 + Math.random() * 0.55);
    const speed = 9 + Math.random() * 9;
    return {
      x: side < 0 ? w * 0.12 : w * 0.88, y: h * 0.9,
      vx: Math.cos(angle) * speed * (w / 1280 + 0.5), vy: Math.sin(angle) * speed * (h / 900 + 0.4),
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
      size: 6 + Math.random() * 6, colour: SPARK_COLOURS[i % SPARK_COLOURS.length], round: i % 5 === 0,
    };
  });
  const start = performance.now();
  const life = 2300;
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = t > life - 600 ? Math.max(0, (life - t) / 600) : 1;
    for (const p of parts) {
      p.vy += 0.32;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.colour;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * (0.4 + Math.abs(Math.cos(p.r))));
      ctx.restore();
    }
    if (t < life) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
  return canvas;
}
