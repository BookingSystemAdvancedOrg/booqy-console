import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => {
  class ApiError extends Error {
    constructor(public status: number) {
      super("api");
    }
  }
  const state = { items: [] as unknown[], selectedId: null as string | null };
  return {
    ApiError,
    api: {
      backdrops: async () => ({ items: state.items, selectedId: state.selectedId, max: 20 }),
      selectBackdrop: async (id: string | null) => ((state.selectedId = id), { selectedId: id }),
      deleteBackdrop: async () => ({}),
      backdropUpload: async () => {
        throw new ApiError(409);
      },
      backdropComplete: async () => ({}),
    },
  };
});

import { applyGlassBackdrop, forgetBackdropImage, readGlassBackdrop } from "./glassBackdrop";
import { deleteBackdrop, getLibrary, loadLibrary, selectBackdrop, uploadBackdrop } from "./backdropStore";

afterEach(() => {
  localStorage.clear();
  forgetBackdropImage();
  applyGlassBackdrop({ mode: "clear" });
});

describe("picture library", () => {
  it("starts empty and moves nobody to Your image", async () => {
    const lib = await loadLibrary();
    expect(lib.loaded).toBe(true);
    expect(readGlassBackdrop()).toEqual({ mode: "clear" });
  });

  it("refuses files that are not pictures", async () => {
    expect(await uploadBackdrop(new File(["x"], "a.txt", { type: "text/plain" }))).toBe("not-image");
  });

  it("refuses when the library is full", async () => {
    const lib = getLibrary();
    for (let i = 0; i < lib.max; i++) lib.items.push({ id: `f${i}`, url: "u", thumbUrl: "t", uploadedAt: "2026-01-01", width: 1, height: 1 });
    expect(await uploadBackdrop(new File(["x"], "a.jpg", { type: "image/jpeg" }))).toBe("limit");
    lib.items.length = 0;
  });

  it("removing the selected picture goes back to see-through", async () => {
    await selectBackdrop("x1");
    expect(getLibrary().selectedId).toBe("x1");
    await deleteBackdrop("x1");
    expect(getLibrary().selectedId).toBeNull();
    expect(readGlassBackdrop()).toEqual({ mode: "clear" });
  });
});
