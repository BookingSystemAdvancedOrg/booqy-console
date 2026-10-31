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
  "a[href], button, summary, [role='tab'], [role='button'], label[for], select, input[type='checkbox'], input[type='radio'], .choice, .plan, .chip, .logo-option, tr.row-link";
const BLOCK = "button, summary, [role='tab'], [role='button'], .btn, .chip, .choice, .plan, .logo-option, .topbar__nav a";
const CTA = ".btn--primary, button[type='submit']";

// a modern, quiet click like Windows: a short, clean "tk" with a little body.
// Brightest for links, a little deeper for buttons and the main actions. [pitch Hz, peak]
const VOICES: Record<"tick" | "press" | "cta", [number, number]> = {
  tick: [2400, 0.425],
  press: [2150, 0.5],
  cta: [1900, 0.56],
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

/**
 * The click as ready-made samples: a short noisy edge, a clean ping and a
 * little body, like the Windows click. Computed once per voice in plain
 * JavaScript and then only played back. No filters or oscillators at click
 * time, so it sounds the same and works in Safari too.
 */
function clickSamples(sr: number, pitch: number, peak: number): Float32Array {
  const n = Math.ceil(sr * 0.045);
  const out = new Float32Array(n);
  let seed = 7;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ping = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t / 0.007);
    const body = 0.5 * Math.sin(2 * Math.PI * pitch * 0.45 * t) * Math.exp(-t / 0.005);
    seed = (seed * 16807) % 2147483647;
    const edge = 0.35 * (seed / 1073741823.5 - 1) * Math.exp(-t / 0.0007);
    out[i] = Math.min(1, t / 0.0006) * (ping + body + edge);
    max = Math.max(max, Math.abs(out[i]));
  }
  for (let i = 0; i < n; i++) out[i] *= peak / max;
  return out;
}

const buffers = new Map<string, AudioBuffer>();

/** The voice as an audio buffer, built once per audio context and sample rate. */
function clickBuffer(c: AudioContext, kind: keyof typeof VOICES): AudioBuffer {
  const key = `${kind}@${c.sampleRate}`;
  let buf = buffers.get(key);
  if (!buf) {
    const [pitch, peak] = VOICES[kind];
    const samples = clickSamples(c.sampleRate, pitch, peak);
    buf = c.createBuffer(1, samples.length, c.sampleRate);
    buf.getChannelData(0).set(samples);
    buffers.set(key, buf);
  }
  return buf;
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
    const c = ctx;
    const src = c.createBufferSource();
    src.buffer = clickBuffer(c, kind);
    const gain = c.createGain();
    gain.gain.value = volume / DEFAULT_VOLUME;
    src.connect(gain);
    gain.connect(c.destination);
    src.start(0);
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
