import { useBusy } from "../busy";
import { renderHook } from "@testing-library/react";

/** Tests only: whether the busy bar is showing right now. */
export function getBusyState(): boolean {
  const { result, unmount } = renderHook(() => useBusy());
  const active = result.current.active;
  unmount();
  return active;
}
