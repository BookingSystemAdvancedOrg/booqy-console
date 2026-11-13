import { api } from "./api";
import { withBusy } from "./busy";
import { forgetBackdropImage, readGlassBackdrop, refreshBackdropImage, setBackdropImageSource, setGlassBackdrop } from "./glassBackdrop";

/**
 * Your own picture behind the glass, stored on the server per operator
 * (GET/POST/DELETE /platform/me/backdrop). The picture is shrunk in the
 * browser to at most 2560 px and sent as JPEG straight to storage with a
 * short-lived presigned POST.
 */

export const MAX_SIDE = 2560;
export const MAX_BYTES = 10 * 1024 * 1024;
export type UploadError = "not-image" | "unreadable" | "too-large" | "failed";

setBackdropImageSource(async () => {
  const res = await api.backdrop();
  return typeof res?.url === "string" && res.url ? res.url : null;
});

/** After sign-in: fetch the picture when Your image is chosen on this device. */
export function syncBackdropImage(): void {
  if (readGlassBackdrop().mode === "image") void refreshBackdropImage();
}

/** Shrinks to at most MAX_SIDE as JPEG. HEIC works where the browser can read it (Safari). */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob) throw new Error("encode");
  return blob;
}

export async function uploadBackdropImage(file: File, origin?: { x: number; y: number }): Promise<UploadError | null> {
  if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) return "not-image";
  return withBusy(async () => {
    let blob: Blob;
    try {
      blob = await shrink(file);
    } catch {
      return "unreadable" as const;
    }
    if (blob.size > MAX_BYTES) return "too-large" as const;
    try {
      const post = await api.backdropUpload({ contentType: "image/jpeg", size: blob.size });
      const form = new FormData();
      for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
      form.append("file", blob, "backdrop.jpg");
      const res = await fetch(post.url, { method: "POST", body: form });
      if (!res.ok) return "failed" as const;
    } catch {
      return "failed" as const;
    }
    setGlassBackdrop({ mode: "image" });
    return (await refreshBackdropImage(origin)) ? null : ("failed" as const);
  });
}

export async function removeBackdropImage(origin?: { x: number; y: number }): Promise<boolean> {
  try {
    await api.removeBackdrop();
  } catch {
    return false;
  }
  forgetBackdropImage();
  setGlassBackdrop({ mode: "clear" }, origin);
  return true;
}
