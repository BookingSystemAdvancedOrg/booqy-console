import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "./Avatar";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A person's profile picture large, alone in a centred glass panel (the same
 * pattern as admin's dish image lightbox). Without a picture it shows large
 * initials. The name and email sit under it. Closes with Esc, a click outside
 * the panel or the close button; focus stays inside and returns afterwards.
 *
 * Esc is caught in the window's capture phase and stopped there, so a dialog
 * underneath is not closed by the same key press. Render it outside clickable
 * rows: React events bubble from portals up the component tree.
 */
export function AvatarLightbox({ url, name, email, onClose }: { url?: string | null; name?: string | null; email?: string | null; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.current.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (before?.isConnected) before.focus();
    };
  }, []);

  const title = name?.trim() || email || "Profile picture";
  return createPortal(
    <div className="lightbox-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div ref={panel} className="lightbox" role="dialog" aria-modal="true" aria-label={`Profile picture: ${title}`}>
        <figure className="avatar-lightbox">
          <Avatar url={url} name={name} email={email} size="xl" />
          <figcaption>
            <span className="avatar-lightbox__name">{title}</span>
            {name?.trim() && email && <span className="avatar-lightbox__email">{email}</span>}
          </figcaption>
        </figure>
        <button ref={closeBtn} type="button" className="lightbox__close" aria-label="Close" onClick={() => closeRef.current()}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}
