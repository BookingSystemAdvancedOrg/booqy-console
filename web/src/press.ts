import { useSyncExternalStore } from "react";
import { SOUND_KEY, SOUND_VOLUME_KEY } from "./storageRegistry";

/**
 * Press feedback, the same as booqy.se and admin: a crisp gaming-mouse click (Web
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

// a crisp, tight gaming-mouse click: the press and a quick release.
// Brightest for links, a little deeper for buttons and the main actions. [pitch Hz, peak]
const VOICES: Record<"tick" | "press" | "cta", [number, number]> = {
  tick: [4536, 0.425],
  press: [4200, 0.5],
  cta: [3864, 0.56],
};

/**
 * Rewards, as ready-made samples like the click (Safari): a bright two-note
 * chime when a step is done, a rising four-note one when something big is
 * done. Notes as [Hz, start s]; each a sine with a soft overtone and a quick
 * decay. Played with play(), so the sound setting and volume apply.
 */
const CHIMES = {
  chime: [[1318.5, 0], [1975.5, 0.075]],
  fanfare: [[1046.5, 0], [1318.5, 0.08], [1568, 0.16], [2093, 0.24]],
} satisfies Record<string, [number, number][]>;
type Chime = keyof typeof CHIMES;
type Voice = keyof typeof VOICES | Chime;

function chimeSamples(sr: number, notes: [number, number][]): Float32Array {
  const tail = 0.42;
  const n = Math.ceil(sr * (notes[notes.length - 1][1] + tail));
  const out = new Float32Array(n);
  for (const [hz, at] of notes) {
    const from = Math.floor(at * sr);
    for (let i = from; i < n; i++) {
      const t = (i - from) / sr;
      const env = Math.min(1, t / 0.004) * Math.exp(-t / 0.12);
      out[i] += env * (Math.sin(2 * Math.PI * hz * t) + 0.18 * Math.sin(2 * Math.PI * hz * 2.01 * t));
    }
  }
  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] *= 0.32 / max;
  return out;
}

/** The reward chime: "chime" for a step, "fanfare" for the finish. Silent when sound is off. */
export function playChime(kind: Chime = "chime") {
  play(kind);
}

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

/** Volume 0-100. 40 is the standard level, 0 is silent. */
export const DEFAULT_VOLUME = 40;
/** The gain at 100 %: as loud as 50 % used to be (full strength was too loud). */
const MAX_GAIN = 5 / 7;

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
 * The click as ready-made samples: a tight mouse click (press and
 * release). Computed once per voice in plain
 * JavaScript and then only played back. No filters or oscillators at click
 * time, so it sounds the same and works in Safari too.
 */
function clickSamples(sr: number, pitch: number, peak: number): Float32Array {
  const n = Math.ceil(sr * 0.08);
  const out = new Float32Array(n);
  // a ringing resonator (band-pass) gives the high, crisp plastic sound
  const w = (2 * Math.PI * pitch) / sr;
  const rr = Math.exp(-w / 24);
  let seed = 7;
  let y1 = 0;
  let y2 = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    seed = (seed * 16807) % 2147483647;
    const noise = seed / 1073741823.5 - 1;
    // the press and, 55 ms later, the release at half strength
    const hit = noise * (Math.exp(-t / 0.0004) + (t >= 0.055 ? 0.5 * Math.exp(-(t - 0.055) / 0.0004) : 0));
    const y = hit * (1 - rr) + 2 * rr * Math.cos(w) * y1 - rr * rr * y2;
    y2 = y1;
    y1 = y;
    const body = 0.25 * Math.sin(2 * Math.PI * pitch * 0.31 * t) * Math.exp(-t / 0.002);
    out[i] = Math.min(1, t / 0.0004) * (1.7 * y + body);
    max = Math.max(max, Math.abs(out[i]));
  }
  for (let i = 0; i < n; i++) out[i] *= peak / max;
  return out;
}

let unlocked = false;

// Safari can leave the audio engine silent: after sleep, a change of output
// (AirPods, a call, another app) or a while in the background, often while it
// says all is well ("running"). So a press after 30 seconds of quiet gets a new
// engine, tied to the output in use now; so does one after coming back to the
// tab, when Safari says the audio was interrupted, or when it has not woken a
// second after being woken.
let stale = false;
let wokeAt = 0;
let usedAt = 0;
const IDLE_MS = 30_000;

/** Does the next press need a fresh audio engine (see above)? */
function needsNew(c: AudioContext): boolean {
  return stale || Date.now() - usedAt > IDLE_MS || c.state === "closed" || (c.state !== "running" && wokeAt > 0 && performance.now() - wokeAt > 1000);
}

/**
 * A press while the audio engine is not ready. Safari only wakes audio on a
 * click, a release or a key, not on the press itself, so the click plays when
 * the finger or mouse button comes up (unlock) instead of staying silent.
 */
let pending: { kind: Voice; at: number } | null = null;

/** Plays a waiting click once the engine runs; one older than a second is dropped. */
function flush() {
  const c = ctx;
  if (!pending || !c || c.state !== "running") return;
  const { kind, at } = pending;
  pending = null;
  if (performance.now() - at < 1000) sound(c, kind);
}

function audio(): AudioContext | null {
  if (ctx && needsNew(ctx)) {
    ctx.close().catch(() => {});
    ctx = null;
    unlocked = false;
  }
  stale = false;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const c = new AC();
    c.onstatechange = () => {
      if (c.state === "running") wokeAt = 0;
      else if ((c.state as string) === "interrupted") stale = true;
    };
    ctx = c;
    wokeAt = 0;
    usedAt = Date.now();
  }
  return ctx;
}

function wake(c: AudioContext): Promise<void> {
  if (!wokeAt) wokeAt = performance.now();
  return c.resume();
}

const buffers = new Map<string, AudioBuffer>();

/** The voice as an audio buffer, built once per audio context and sample rate. */
function clickBuffer(c: AudioContext, kind: Voice): AudioBuffer {
  const key = `${kind}@${c.sampleRate}`;
  let buf = buffers.get(key);
  if (!buf) {
    const samples = kind in CHIMES ? chimeSamples(c.sampleRate, CHIMES[kind as Chime]) : clickSamples(c.sampleRate, ...VOICES[kind as keyof typeof VOICES]);
    buf = c.createBuffer(1, samples.length, c.sampleRate);
    buf.getChannelData(0).set(samples);
    buffers.set(key, buf);
  }
  return buf;
}

function play(kind: Voice) {
  if (!on || volume <= 0) return;
  try {
    const c = ctx;
    if (c && !needsNew(c) && c.state === "running") {
      sound(c, kind);
      return;
    }
    // Not ready: the click waits for the release (unlock), or for the engine
    // to wake if this already is a click or a key
    pending = { kind, at: performance.now() };
    const ready = c ? (needsNew(c) ? null : c) : audio();
    if (ready) wake(ready).then(flush, () => {});
  } catch {
    /* no sound */
  }
}

function sound(c: AudioContext, kind: Voice) {
  try {
    const src = c.createBufferSource();
    src.buffer = clickBuffer(c, kind);
    const gain = c.createGain();
    gain.gain.value = (volume / 100) * MAX_GAIN;
    src.connect(gain);
    gain.connect(c.destination);
    src.start(0);
    usedAt = Date.now();
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
  if (x != null && y != null) signal(x, y);
}

// the signal: a dot and two rings where you press, anywhere on the page
function signal(x: number, y: number) {
  if (reducedMotion()) return;
  const ripple = document.createElement("span");
  ripple.className = "press-ripple";
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  document.body.appendChild(ripple);
  window.setTimeout(() => ripple.remove(), 900);
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
      const c = audio();
      if (!c) return;
      if (c.state !== "running") wake(c).then(flush, () => {});
      if (!unlocked) {
        const silent = c.createBufferSource();
        silent.buffer = c.createBuffer(1, 1, c.sampleRate);
        silent.connect(c.destination);
        silent.start(0);
        unlocked = true;
      }
      flush();
    } catch {
      /* no audio */
    }
  };
  for (const type of ["pointerup", "click", "touchend", "keydown"]) document.addEventListener(type, unlock, { capture: true, passive: true });
  // back on the tab: the next press gets a fresh audio engine
  document.addEventListener("visibilitychange", () => {
    if (ctx && document.visibilityState === "visible") stale = true;
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      const el = (e.target as Element | null)?.closest?.(TARGETS);
      if (!el || (el as HTMLButtonElement).disabled) {
        signal(e.clientX, e.clientY);
        return;
      }
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
