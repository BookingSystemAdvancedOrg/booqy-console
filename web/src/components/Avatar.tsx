import { useState } from "react";
import { initials } from "../avatar";

/**
 * A round profile picture, or initials on a glass circle when there is none
 * (or it fails to load). The initials are drawn by CSS (data-initials), so a
 * button around the avatar is named only by its label.
 */
export function Avatar({ url, name, email, size = "md" }: { url?: string | null; name?: string | null; email?: string | null; size?: "sm" | "md" | "lg" | "xl" }) {
  const [broken, setBroken] = useState<string | null>(null);
  const show = url && broken !== url;
  return (
    <span className={`avatar avatar--${size}`} aria-hidden="true">
      {show ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setBroken(url)} /> : <span className="avatar__initials" data-initials={initials(name, email)} />}
    </span>
  );
}
