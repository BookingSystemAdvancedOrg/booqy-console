import { api, ApiError, type BackdropItem } from "./api";
import { withBusy } from "./busy";
import { forgetBackdropImage, readGlassBackdrop, refreshBackdropImage, setBackdropImageSource, setGlassBackdrop } from "./glassBackdrop";

/**
 * Your own pictures behind the glass: a library per operator on the server (up
 * to max pictures). Every upload is added; one of them is the selected
 * background. API: GET /platform/me/backdrops, POST .../upload, POST
 * .../{id}/complete, PUT .../selected, DELETE .../{id}.
 */

export type { BackdropItem };
export type Library = { items: BackdropItem[]; selectedId: string | null; max: number; loaded: boolean };
export type UploadError = "not-image" | "unreadable" | "too-large" | "limit" | "failed";

export const MAX_SIDE = 2560;
export const MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX = 20;

let library: Library = { items: [], selectedId: null, max: DEFAULT_MAX, loaded: false };
const listeners = new Set<() => void>();

export function getLibrary(): Library {
  return library;
}
export function subscribeLibrary(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function set(next: Partial<Library>) {
  library = { ...library, ...next };
  for (const fn of listeners) fn();
}
export function selectedItem(): BackdropItem | null {
  return library.items.find((i) => i.id === library.selectedId) ?? null;
}

setBackdropImageSource(async () => {
  if (!library.loaded) await loadLibrary();
  return selectedItem()?.url ?? null;
});

export async function loadLibrary(): Promise<Library> {
  try {
    const res = await api.backdrops();
    set({ items: res.items ?? [], selectedId: res.selectedId ?? null, max: res.max ?? DEFAULT_MAX, loaded: true });
  } catch {
    set({ loaded: true });
  }
  return library;
}

/** After sign-in: read the library when Your image is chosen on this device. */
export function syncBackdropImage(): void {
  if (readGlassBackdrop().mode === "image") void refreshBackdropImage();
}

async function shrink(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob) throw new Error("encode");
  return { blob, width, height };
}

/** Posts the form to storage with progress (fetch has no upload progress). */
function postWithProgress(url: string, form: FormData, onProgress: (share: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.send(form);
  });
}

/** Adds a picture to the library and selects it as the background. */
export async function uploadBackdrop(file: File, onProgress: (share: number) => void = () => {}): Promise<UploadError | null> {
  if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) return "not-image";
  if (library.items.length >= library.max) return "limit";
  return withBusy(async () => {
    let shrunk: Awaited<ReturnType<typeof shrink>>;
    try {
      shrunk = await shrink(file);
    } catch {
      return "unreadable" as const;
    }
    if (shrunk.blob.size > MAX_BYTES) return "too-large" as const;
    onProgress(0);
    let item: BackdropItem;
    try {
      const post = await api.backdropUpload({ contentType: "image/jpeg", size: shrunk.blob.size, width: shrunk.width, height: shrunk.height });
      const form = new FormData();
      for (const [k, v] of Object.entries(post.fields)) form.append(k, v);
      form.append("file", shrunk.blob, "backdrop.jpg");
      if (!(await postWithProgress(post.url, form, onProgress))) return "failed" as const;
      item = (await api.backdropComplete(post.id)).item;
    } catch (err) {
      return err instanceof ApiError && err.status === 409 ? ("limit" as const) : ("failed" as const);
    }
    set({ items: [item, ...library.items.filter((i) => i.id !== item.id)] });
    await selectBackdrop(item.id);
    return null;
  });
}

/** Selects a picture as the background (null: none) and sweeps it in. */
export async function selectBackdrop(id: string | null, origin?: { x: number; y: number }): Promise<boolean> {
  try {
    await api.selectBackdrop(id);
  } catch {
    return false;
  }
  set({ selectedId: id });
  if (id) {
    setGlassBackdrop({ mode: "image" });
    await refreshBackdropImage(origin);
  } else {
    forgetBackdropImage();
    setGlassBackdrop({ mode: "clear" }, origin);
  }
  return true;
}

export async function deleteBackdrop(id: string): Promise<boolean> {
  const wasSelected = library.selectedId === id;
  try {
    await api.deleteBackdrop(id);
  } catch {
    return false;
  }
  set({ items: library.items.filter((i) => i.id !== id), selectedId: wasSelected ? null : library.selectedId });
  if (wasSelected) {
    forgetBackdropImage();
    setGlassBackdrop({ mode: "clear" });
  }
  return true;
}
