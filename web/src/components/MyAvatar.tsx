import { useEffect, useSyncExternalStore } from "react";
import { getMyAvatar, loadMyAvatar, subscribeMyAvatar } from "../avatar";
import { Avatar } from "./Avatar";

/** The signed-in operator's avatar (sidebar); loads once. */
export function MyAvatar({ name, email }: { name?: string; email?: string }) {
  const mine = useSyncExternalStore(subscribeMyAvatar, getMyAvatar, getMyAvatar);
  useEffect(() => {
    if (!mine.loaded) void loadMyAvatar();
  }, [mine.loaded]);
  return <Avatar url={mine.url} name={name} email={email} size="sm" />;
}
