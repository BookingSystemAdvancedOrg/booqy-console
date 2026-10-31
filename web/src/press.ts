import { useSyncExternalStore } from "react";
import { SOUND_KEY, SOUND_VOLUME_KEY } from "./storageRegistry";

/**
 * Press feedback, the same as booqy.se and admin: a modern, quiet Windows-style click (Web
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

// a modern, quiet click like Windows: a short, clean "tk" with a little body.
// Brightest for links, a little deeper for buttons and the main actions. [pitch Hz, volume]
const VOICES: Record<"tick" | "press" | "cta", [number, number]> = {
  tick: [2400, 0.34],
  press: [2150, 0.42],
  cta: [1900, 0.48],
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

/** Volume 0-100. 70 is the standard level; 100 is a little louder, 0 is silent. */
export const DEFAULT_VOLUME = 70;

function storedVolume(): number {
  try {
    const raw = localStorage.getItem(SOUND_VOLUME_KEY);
    const v = Number(raw);
    return raw !== null && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

let volume = storedVolume();
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

export function soundVolume(): number {
  return volume;
}

/** Saves the volume. A click plays when the slider is released (preview), not while dragging. */
export function setSoundVolume(next: number, preview = false) {
  volume = Math.min(100, Math.max(0, Math.round(next)));
  try {
    localStorage.setItem(SOUND_VOLUME_KEY, String(volume));
  } catch {
    /* private mode without storage */
  }
  for (const listener of listeners) listener();
  if (preview) play("press");
}

export function useSoundVolume(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    soundVolume,
    () => DEFAULT_VOLUME,
  );
}

function play(kind: keyof typeof VOICES) {
  if (!on || volume <= 0) return;
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
    const t = c.currentTime + 0.003;
    const sr = c.sampleRate;
    // a limiter keeps the peaks down, so it never crackles
    const limit = c.createDynamicsCompressor();
    limit.threshold.value = -6;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.001;
    limit.release.value = 0.05;
    // the volume goes last, after the limiter: 70 = the standard level
    const master = c.createGain();
    master.gain.value = volume / DEFAULT_VOLUME;
    limit.connect(master);
    master.connect(c.destination);
    const out = c.createBiquadFilter();
    out.type = "lowpass";
    out.frequency.value = 6000;
    out.connect(limit);
    // the edge: 2 ms of soft noise that gives the click its crispness
    const buf = c.createBuffer(1, Math.ceil(sr * 0.002), sr);
    const d = buf.getChannelData(0);
    let seed = 7;
    for (let i = 0; i < d.length; i++) d[i] = ((seed = (seed * 16807) % 2147483647) / 1073741823.5 - 1) * Math.min(1, i / (sr * 0.0002)) * Math.pow(1 - i / d.length, 2);
    const src = c.createBufferSource();
    src.buffer = buf;
    const band = c.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = pitch * 1.3;
    band.Q.value = 2;
    const g = c.createGain();
    g.gain.value = vol * 6;
    src.connect(band).connect(g).connect(out);
    src.start(t);
    // the tone: a short, clean ping with a little body under it, like the Windows click
    const tone = (hz: number, gain: number, decay: number) => {
      const osc = c.createOscillator();
      osc.frequency.value = hz;
      const og = c.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(gain, t + 0.0008);
      og.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(og).connect(out);
      osc.start(t);
      osc.stop(t + decay + 0.003);
    };
    tone(pitch, vol * 2.6, 0.025);
    tone(pitch * 0.45, vol * 1.1, 0.015);
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
let unlocked = false;

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
      if (!unlocked) {
        const silent = ctx.createBufferSource();
        silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        silent.connect(ctx.destination);
        silent.start(0);
        unlocked = true;
      }
    } catch {
      /* no audio */
    }
  };
  for (const type of ["pointerup", "click", "touchend", "keydown"]) document.addEventListener(type, unlock, { capture: true, passive: true });
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
