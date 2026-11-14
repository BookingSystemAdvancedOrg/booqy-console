import { act, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_INTERVAL_MS, LIVE_SAVED_EVENT, backoffMs, quietly, isQuiet, useLiveRefresh } from "./live";
import { useLoad } from "./components/ui";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useLiveRefresh", () => {
  it("refetches every 15 s while visible and pauses while hidden", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useLiveRefresh(refetch));
    await tick(LIVE_INTERVAL_MS * 2);
    expect(refetch).toHaveBeenCalledTimes(2);
    setVisibility("hidden");
    await tick(LIVE_INTERVAL_MS * 3);
    expect(refetch).toHaveBeenCalledTimes(2);
    setVisibility("visible");
    await tick(0);
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("refetches at once on focus, online and after a save", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useLiveRefresh(refetch));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => { window.dispatchEvent(new CustomEvent(LIVE_SAVED_EVENT)); });
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("backs off after a failure", async () => {
    expect(backoffMs(1)).toBe(30_000);
    const refetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    renderHook(() => useLiveRefresh(refetch));
    await tick(LIVE_INTERVAL_MS);
    await tick(LIVE_INTERVAL_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
    await tick(LIVE_INTERVAL_MS);
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("quietly() marks only the requests it starts", async () => {
    const seen: boolean[] = [];
    await quietly(async () => { seen.push(isQuiet()); });
    seen.push(isQuiet());
    expect(seen).toEqual([true, false]);
  });
});

describe("useLoad is live", () => {
  it("refetches quietly: no busy bar, same object when unchanged, new data when changed", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ name: "Lamo" })
      .mockResolvedValueOnce({ name: "Lamo" })
      .mockResolvedValue({ name: "Lamo AB" });
    const { result } = renderHook(() => useLoad(load));
    await tick(0);
    const first = result.current.data;
    expect(first).toEqual({ name: "Lamo" });
    await tick(LIVE_INTERVAL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe(first);
    expect(result.current.loading).toBe(false);
    await tick(LIVE_INTERVAL_MS);
    expect(result.current.data).toEqual({ name: "Lamo AB" });
  });

  it("a failed quiet refetch keeps the data and shows no error", async () => {
    const load = vi.fn().mockResolvedValueOnce(["a"]).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useLoad(load));
    await tick(0);
    await tick(LIVE_INTERVAL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(["a"]);
    expect(result.current.error).toBeNull();
  });

  it("a form fed from the data keeps what you typed while the data changes", async () => {
    function Page({ load }: { load: () => Promise<{ name: string }> }) {
      const { data } = useLoad(load);
      const [draft, setDraft] = useState<string | null>(null);
      return (
        <>
          <p>Saved: {data?.name}</p>
          {data && draft === null && <button onClick={() => setDraft(data.name)}>Edit</button>}
          {draft !== null && <input aria-label="Name" value={draft} onChange={(e) => setDraft(e.target.value)} />}
        </>
      );
    }
    const load = vi.fn().mockResolvedValueOnce({ name: "Lamo" }).mockResolvedValue({ name: "Lamo AB" });
    render(<Page load={load} />);
    await tick(0);
    act(() => screen.getByRole("button", { name: "Edit" }).click());
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Lamo Group");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(LIVE_INTERVAL_MS);
    expect(screen.getByText("Saved: Lamo AB")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Lamo Group");
  });
});
