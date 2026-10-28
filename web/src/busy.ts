import { useSyncExternalStore } from "react";

/**
 * Everything in flight: every API request (api.ts request), every upload
 * and every sign-in step counts up when it starts and down when it ends,
 * and BusyBar shows the strip at the top while anything is running. New
 * pages get it for free; something slow that doesn't go through the API can
 * use withBusy itself. Same idea as the admin app's busy bar.
 */
let count = 0;
let finishedAt = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function busyStart(): void {
  count += 1;
  emit();
}

export function busyEnd(): void {
  count = Math.max(0, count - 1);
  if (count === 0) finishedAt = Date.now();
  emit();
}

export async function withBusy<T>(work: () => Promise<T>): Promise<T> {
  busyStart();
  try {
    return await work();
  } finally {
    busyEnd();
  }
}

export interface BusyState {
  active: boolean;
  /** When the last piece of work finished (for the "done" sweep). */
  finishedAt: number;
}

let snapshot: BusyState = { active: false, finishedAt: 0 };

function getSnapshot(): BusyState {
  if (snapshot.active !== count > 0 || snapshot.finishedAt !== finishedAt) {
    snapshot = { active: count > 0, finishedAt };
  }
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBusy(): BusyState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Tests only. */
export function resetBusyForTests(): void {
  count = 0;
  finishedAt = 0;
  emit();
}
