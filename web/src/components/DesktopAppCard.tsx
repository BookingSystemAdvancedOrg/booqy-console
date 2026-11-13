import "./desktopApp.css";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { desktopFiles, isDesktopShell, readSignals, recommend, type DesktopOs, type Recommendation } from "../desktopDownloads";

/** Labels in the console's language; URLs from desktopDownloads (shared with admin). */
const LABELS: Record<DesktopOs, { title: string; detail: string; button: string }> = {
  "mac-arm64": { title: "Mac with Apple silicon", detail: "M1 or later, .dmg", button: "Download for Mac (Apple silicon)" },
  "mac-x64": { title: "Mac with Intel", detail: ".dmg", button: "Download for Mac (Intel)" },
  win: { title: "Windows 10 and 11", detail: ".exe", button: "Download for Windows" },
  "linux-appimage": { title: "Linux, AppImage", detail: "any distribution", button: "Download AppImage" },
  linux: { title: "Linux, .deb", detail: "Ubuntu and Debian", button: "Download .deb" },
};

/**
 * Settings > Desktop app: Booqy Console as an app (booqy-console/desktop).
 * Suggests the file for this computer and lists the rest. Unsigned for now,
 * so it explains Gatekeeper and SmartScreen.
 */
/** "Recommended for your computer", with the Windows version when known. */
function badge(rec: Recommendation): string {
  return `Recommended for your computer${rec.windows ? ` (Windows ${rec.windows})` : ""}`;
}

export function DesktopAppCard({ heading = true }: { heading?: boolean }) {
  // Inside the desktop app there is nothing to download: no card at all.
  if (isDesktopShell()) return null;
  return <DesktopAppCardBody heading={heading} />;
}

function DesktopAppCardBody({ heading }: { heading: boolean }) {
  const files = desktopFiles("console", "Booqy-Console");
  // undefined = still reading, null = no safe recommendation (show the list only).
  const [rec, setRec] = useState<Recommendation | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void readSignals().then((s) => alive && setRec(recommend(s))).catch(() => alive && setRec(null));
    return () => { alive = false; };
  }, []);
  const mine = rec ? files.find((f) => f.os === rec.os) : undefined;

  // The menu's "Download app" goes to /settings#desktop-app: scroll here, move
  // focus and light the card up briefly, on every click (location.key).
  const location = useLocation();
  const ref = useRef<HTMLElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (location.hash !== "#desktop-app" || !el) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1800);
    return () => window.clearTimeout(t);
  }, [location.hash, location.key]);

  return (
    <section className={flash ? "card desktop-app-card is-flash" : "card desktop-app-card"} id="desktop-app" ref={ref} tabIndex={-1}>
      {heading && <div className="card__head"><h2>Desktop app</h2></div>}
      <div className="card__body desktop-app">
        <p className="muted small">
          Booqy Console in its own window: same sign-in and features as here, always the latest console. The app asks when
          the app itself has a new version.
        </p>
        {mine && rec ? (
          <p><a className="btn btn--primary" href={mine.url} download>{LABELS[rec.os].button}</a></p>
        ) : rec === null ? (
          <p className="muted small">Pick the file for your computer from the list.</p>
        ) : null}
        <ul className="desktop-app__list">
          {files.map((f) => {
            const yours = rec?.os === f.os;
            return (
              <li key={f.os} className={yours ? "is-yours" : undefined}>
                <a href={f.url} download>
                  <span className="strong desktop-app__title">
                    {LABELS[f.os].title}
                    {yours && rec && <span className="desktop-app__badge">{badge(rec)}</span>}
                  </span>
                  <span className="mono muted small">{LABELS[f.os].detail}</span>
                </a>
              </li>
            );
          })}
        </ul>
        <details className="desktop-app__help">
          <summary className="strong">Opening it the first time</summary>
          <p className="muted small">The app is not signed with Apple or Microsoft yet, so the computer warns once.</p>
          <p className="small"><span className="strong">Mac:</span> drag Booqy Console to Applications and open it. If macOS says it cannot be verified, click Done, open System Settings &gt; Privacy &amp; Security, scroll down and click Open Anyway. After an update macOS may ask about the keychain: choose Always Allow.</p>
          <p className="small"><span className="strong">Windows:</span> if Windows shows "Windows protected your PC", click More info, then Run anyway.</p>
          <p className="small"><span className="strong">Linux:</span> open the .deb in the software installer, or make the AppImage executable and run it.</p>
        </details>
      </div>
    </section>
  );
}
