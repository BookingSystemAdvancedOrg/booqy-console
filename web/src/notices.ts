import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { quietly, useLiveRefresh } from "./live";

/**
 * Unseen operator notices (the bell): one quiet call per live pulse, shared
 * by the side menu and the phones' Inbox dot. The Notifications page marks
 * them seen and dispatches NOTICES_SEEN_EVENT so the badge clears at once.
 */
export const NOTICES_SEEN_EVENT = "booqy:notices-seen";

export function useUnseenNotices(enabled = true): number {
  const [unseen, setUnseen] = useState(0);
  const load = useCallback(
    () => Promise.resolve().then(() => quietly(() => api.notices())).then((r) => setUnseen(r?.unseen ?? 0)),
    [],
  );
  useEffect(() => { if (enabled) void load().catch(() => {}); }, [enabled, load]);
  useEffect(() => {
    const clear = () => setUnseen(0);
    window.addEventListener(NOTICES_SEEN_EVENT, clear);
    return () => window.removeEventListener(NOTICES_SEEN_EVENT, clear);
  }, []);
  useLiveRefresh(() => load().catch(() => {}), { enabled });
  return unseen;
}

/** "9+" past nine: the badge stays one small pill. */
export const badgeText = (n: number) => (n > 9 ? "9+" : String(n));
