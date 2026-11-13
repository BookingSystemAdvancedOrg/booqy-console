import "./desktopApp.css";
import { useEffect, useState } from "react";
import { desktopAppVersion, desktopFiles, detectDesktopOs, type DesktopOs } from "../desktopDownloads";

/** Labels in the console's language; URLs from desktopDownloads (shared with admin). */
const LABELS: Record<DesktopOs, { title: string; detail: string; button: string }> = {
  "mac-arm64": { title: "Mac with Apple silicon", detail: "M1 or later, .dmg", button: "Download for Mac (Apple silicon)" },
  "mac-x64": { title: "Mac with Intel", detail: ".dmg", button: "Download for Mac (Intel)" },
  win: { title: "Windows 10 and 11", detail: ".exe", button: "Download for Windows" },
  linux: { title: "Linux (Ubuntu, Debian)", detail: ".deb", button: "Download for Linux (.deb)" },
  "linux-appimage": { title: "Linux, other", detail: "AppImage", button: "Download AppImage" },
};

/**
 * Settings > Desktop app: Booqy Console as an app (booqy-console/desktop).
 * Suggests the file for this computer and lists the rest. Unsigned for now,
 * so it explains Gatekeeper and SmartScreen.
 */
export function DesktopAppCard() {
  const files = desktopFiles("console", "Booqy-Console");
  const inApp = desktopAppVersion();
  const [os, setOs] = useState<DesktopOs | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void detectDesktopOs().then((v) => alive && setOs(v));
    return () => { alive = false; };
  }, []);
  const mine = os ? files.find((f) => f.os === os) : undefined;

  return (
    <section className="card" id="desktop-app">
      <div className="card__head"><h2>Desktop app</h2></div>
      <div className="card__body desktop-app">
        <p className="muted small">
          Booqy Console in its own window: same sign-in and features as here, always the latest console. The app asks when
          the app itself has a new version.
        </p>
        {inApp ? (
          <p className="strong">You are using the desktop app, version {inApp}. The Help menu has Check for updates.</p>
        ) : mine ? (
          <p><a className="btn btn--primary" href={mine.url} download>{LABELS[mine.os].button}</a></p>
        ) : os === null ? (
          <p className="muted small">The app is for computers. On phones and tablets, use the console in the browser.</p>
        ) : null}
        <ul className="desktop-app__list">
          {files.map((f) => (
            <li key={f.os} className={f.os === os ? "is-yours" : undefined}>
              <a href={f.url} download>
                <span className="strong">{LABELS[f.os].title}</span>
                <span className="mono muted small">{LABELS[f.os].detail}</span>
              </a>
            </li>
          ))}
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
