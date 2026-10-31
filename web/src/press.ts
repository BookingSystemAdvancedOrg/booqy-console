import { useSyncExternalStore } from "react";
import { SOUND_KEY } from "./storageRegistry";

/**
 * Press feedback, the same as booqy.se and admin: a subtle, traditional click (Web
 * Audio, made on the fly, no files) and a squeeze plus a tan ripple, on
 * pointerdown and on Enter or Space. Never on hover. Sound is on by default
 * and starts on the first press (autoplay rules); Settings switches it
 * off ("booqy-sound" in localStorage). Reduced motion: the ripple
 * becomes a blink, the sound stays.
 */

const TARGETS =
  "a[href], button, summary, [role='tab'], [role='button'], label[for], select, input[type='checkbox'], input[type='radio'], .choice, .plan, .chip, .logo-option";
const BLOCK = "button, summary, [role='tab'], [role='button'], .btn, .chip, .choice, .plan, .logo-option, .topbar__nav a";
const CTA = ".btn--primary, button[type='submit']";

// a traditional click, kept subtle: a short, soft snap with a small round
// tone under it, like a good switch heard from a step away. Brightest for
// links, a little deeper for buttons and the main actions. [pitch Hz, volume]
const VOICES: Record<"tick" | "press" | "cta", [number, number]> = {
  tick: [3000, 0.13],
  press: [2600, 0.17],
  cta: [2200, 0.21],
};

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function storedSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

let on = storedSound();
let ctx: AudioContext | null = null;
const listeners = new Set<() => void>();

export function soundOn(): boolean {
  return on;
}

export function setSound(next: boolean) {
  on = next;
  try {
    localStorage.setItem(SOUND_KEY, next ? "on" : "off");
  } catch {
    /* private mode without storage */
  }
  for (const listener of listeners) listener();
  if (next) play("press"); // a confirmation click when sound comes back on
}

export function useSound(): [boolean, () => void] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    soundOn,
    () => true,
  );
  return [value, () => setSound(!value)];
}

function play(kind: keyof typeof VOICES) {
  if (!on) return;
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    // Safari starts the audio asleep: wake it, then play once it is running
    if (ctx.state !== "running") {
      const c = ctx;
      c.resume().then(() => {
        if (c.state === "running") play(kind);
      }, () => {});
      return;
    }
    const [pitch, vol] = VOICES[kind];
    const t = ctx.currentTime + 0.002;
    const sr = ctx.sampleRate;
    const out = ctx.createBiquadFilter();
    out.type = "lowpass";
    out.frequency.value = 4500;
    out.connect(ctx.destination);
    // the snap: 6 ms of noise, eased in over half a millisecond so it never cracks
    const buf = ctx.createBuffer(1, Math.ceil(sr * 0.006), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.min(1, i / (sr * 0.0005)) * Math.pow(1 - i / d.length, 4);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = pitch;
    band.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(band).connect(g).connect(out);
    src.start(t);
    // the body: a short round tone under the snap, what makes it a button and not static
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(pitch * 0.42, t);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.36, t + 0.015);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(vol * 0.6, t + 0.001);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.02);
  } catch {
    /* no audio: the visual is enough */
  }
}

function kindOf(el: Element): keyof typeof VOICES {
  if (el.matches(CTA)) return "cta";
  if (el.matches("button, summary, [role='tab'], [role='button'], .btn, .chip, .choice, .plan, select, input, label")) return "press";
  return "tick";
}

function visual(el: Element, x: number | null, y: number | null) {
  const cls = el.matches(BLOCK) ? "is-pressed" : "is-pressed-text";
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), 160);
  if (reducedMotion() || x == null || y == null) return;
  const ripple = document.createElement("span");
  ripple.className = "press-ripple";
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  document.body.appendChild(ripple);
  window.setTimeout(() => ripple.remove(), 260);
}

let installed = false;

/** Listens once on the document; every press anywhere in the console gets the feedback. */
export function installPress() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // Safari only lets audio start inside a click or key press, so the first
  // one also wakes the audio up for the presses that follow
  const unlock = () => {
    if (!on) return;
    try {
      if (!ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
      }
      if (ctx.state !== "running") void ctx.resume();
    } catch {
      /* no audio */
    }
  };
  for (const type of ["click", "touchend", "keydown"]) document.addEventListener(type, unlock, { capture: true, passive: true });
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      const el = (e.target as Element | null)?.closest?.(TARGETS);
      if (!el || (el as HTMLButtonElement).disabled) return;
      play(kindOf(el));
      visual(el, e.clientX, e.clientY);
    },
    { passive: true },
  );
  document.addEventListener("keydown", (e) => {
    if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
    const el = document.activeElement;
    if (!el || !el.matches(TARGETS) || el.matches("input[type='text'], input[type='email'], input[type='tel'], input[type='search'], textarea")) return;
    if (e.key === " " && el.matches("a[href]")) return;
    const r = el.getBoundingClientRect();
    play(kindOf(el));
    visual(el, r.left + r.width / 2, r.top + r.height / 2);
  });
}
