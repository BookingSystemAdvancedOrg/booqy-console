import { api } from "./api";
import { withBusy } from "./busy";

/**
 * The signed-in operator's profile picture. The browser crops a square the
 * operator positioned (cropSquare) and uploads it; the API re-encodes it to a
 * 256 px WebP. Only your own picture can be changed; everyone sees all of them
 * in the operator list.
 */

let mine: { url: string | null; loaded: boolean } = { url: null, loaded: false };
const listeners = new Set<() => void>();

export function getMyAvatar() {
  return mine;
}
export function subscribeMyAvatar(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function set(url: string | null) {
  mine = { url, loaded: true };
  for (const fn of listeners) fn();
}

export async function loadMyAvatar(): Promise<void> {
  try {
    set((await api.myAvatar()).url ?? null);
  } catch {
    set(null);
  }
}

/** The fallback: first and last name's initials, one name's first letter, else the e-mail's first letter. */
export function initials(name?: string | null, email?: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (email ?? "?").trim().charAt(0).toUpperCase() || "?";
}

export type Crop = { x: number; y: number; scale: number };

/**
 * Where the image sits in a square viewport of side `view`: scale makes it
 * cover the square (times zoom), x and y are its top-left corner, clamped so
 * the square is always covered.
 */
export function coverCrop(width: number, height: number, view: number, zoom: number, dx: number, dy: number): Crop {
  const scale = Math.max(view / width, view / height) * Math.max(1, zoom);
  const w = width * scale;
  const h = height * scale;
  const clamp = (v: number, min: number) => Math.min(0, Math.max(min, v));
  return { scale, x: clamp((view - w) / 2 + dx, view - w), y: clamp((view - h) / 2 + dy, view - h) };
}

/** Draws the positioned square to a `size` px JPEG. */
export async function cropSquare(img: HTMLImageElement, crop: Crop, view: number, size = 512): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  const k = size / view;
  ctx.drawImage(img, crop.x * k, crop.y * k, img.naturalWidth * crop.scale * k, img.naturalHeight * crop.scale * k);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("encode");
  return blob;
}

export async function saveMyAvatar(blob: Blob): Promise<boolean> {
  return withBusy(async () => {
    try {
      const post = await api.avatarUpload({ contentType: "image/jpeg", size: blob.size });
      const form = new FormData();
      for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
      form.append("file", blob, "avatar.jpg");
      const res = await fetch(post.url, { method: "POST", body: form });
      if (!res.ok) return false;
      set((await api.avatarComplete()).url);
      return true;
    } catch {
      return false;
    }
  });
}

export async function removeMyAvatar(): Promise<boolean> {
  try {
    await withBusy(() => api.deleteAvatar());
  } catch {
    return false;
  }
  set(null);
  return true;
}
