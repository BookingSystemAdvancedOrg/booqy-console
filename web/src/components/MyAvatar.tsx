import { useEffect, useSyncExternalStore } from "react";
import { getMyAvatar, loadMyAvatar, subscribeMyAvatar } from "../avatar";
import { Avatar } from "./Avatar";

/** The signed-in operator's avatar (side menu, bottom bar); loads once. */
export function MyAvatar({ name, email, size = "sm" }: { name?: string; email?: string; size?: "sm" | "md" | "lg" }) {
  const mine = useSyncExternalStore(subscribeMyAvatar, getMyAvatar, getMyAvatar);
  useEffect(() => {
    if (!mine.loaded) void loadMyAvatar();
  }, [mine.loaded]);
  return <Avatar url={mine.url} name={name} email={email} size={size} />;
}
