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

// a traditional mechanical switch: a firm click as it goes down and a lighter
// tick as it springs back. Brightest for links, a little deeper and fuller for
// buttons and the main actions. [pitch Hz, volume]
const VOICES: Record<"tick" | "press" | "cta", [number, number]> = {
  tick: [4200, 0.34],
  press: [3600, 0.42],
  cta: [3100, 0.48],
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
    const c = ctx;
    const t = c.currentTime + 0.002;
    const sr = c.sampleRate;
    const out = c.createBiquadFilter();
    out.type = "lowpass";
    out.frequency.value = 7000;
    out.connect(c.destination);
    // one snap of the switch: 4 ms of noise ringing at one pitch, plus a tiny
    // knock under it. The noise is the same every time (fixed seed), like a real
    // switch, so every press sounds alike and the volume never jumps
    const snap = (at: number, hz: number, gain: number) => {
      const buf = c.createBuffer(1, Math.ceil(sr * 0.004), sr);
      const d = buf.getChannelData(0);
      let seed = 7;
      for (let i = 0; i < d.length; i++) d[i] = ((seed = (seed * 16807) % 2147483647) / 1073741823.5 - 1) * Math.min(1, i / (sr * 0.0003)) * Math.pow(1 - i / d.length, 2);
      const src = c.createBufferSource();
      src.buffer = buf;
      const ring = c.createBiquadFilter();
      ring.type = "bandpass";
      ring.frequency.value = hz;
      ring.Q.value = 5;
      const g = c.createGain();
      g.gain.value = gain * 6;
      src.connect(ring).connect(g).connect(out);
      src.start(at);
      const osc = c.createOscillator();
      osc.frequency.value = hz * 0.3;
      const og = c.createGain();
      og.gain.setValueAtTime(0, at);
      og.gain.linearRampToValueAtTime(gain * 0.8, at + 0.001);
      og.gain.exponentialRampToValueAtTime(0.0001, at + 0.012);
      osc.connect(og).connect(out);
      osc.start(at);
      osc.stop(at + 0.014);
    };
    // press, then the lighter release a moment later
    snap(t, pitch, vol);
    snap(t + 0.026, pitch * 1.2, vol * 0.45);
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
