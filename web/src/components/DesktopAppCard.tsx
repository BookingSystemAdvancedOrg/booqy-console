import "./desktopApp.css";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { phoneKind, usePwaInstall } from "../pwa";
import { desktopFiles, installCommand, installShellFor, isDesktopShell, isPhoneOrTablet, readSignals, type InstallShell, recommend, type DesktopOs, type Recommendation } from "../desktopDownloads";

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
  // Phones and tablets: no file list, the console installs from the browser.
  if (isPhoneOrTablet({ ua: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints })) {
    return <PhoneInstallBody />;
  }
  return <DesktopAppCardBody heading={heading} />;
}

/** One install command with a Copy button. */
function CommandRow({ shell }: { shell: InstallShell }) {
  const command = installCommand("console", shell);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }
  return (
    <div className="desktop-app__cmd">
      <span className="muted small">{shell === "windows" ? "Windows: in PowerShell" : "Mac and Linux: in Terminal"}</span>
      <div className="desktop-app__cmd-row">
        <code>{command}</code>
        <button type="button" className="btn btn--small" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

/** The menu's "Download app" / "Install app" goes to /settings#desktop-app: scroll here, focus, light up briefly (every click). */
function useFlashOnHash() {
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
  return { ref, flash };
}

function ShareGlyph() {
  return (
    <svg className="phone-install__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3.5v11M8 7.5l4-4 4 4M7.5 10.5H6a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5h-1.5" />
    </svg>
  );
}
function AddGlyph() {
  return (
    <svg className="phone-install__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

/** Phones: install Booqy Console on the home screen. */
function PhoneInstallBody() {
  const { ref, flash } = useFlashOnHash();
  const { canPrompt, installed, prompt } = usePwaInstall();
  const kind = phoneKind();
  return (
    <section className={flash ? "card desktop-app-card is-flash" : "card desktop-app-card"} id="desktop-app" ref={ref} tabIndex={-1}>
      <div className="card__head"><h2>App on your phone</h2></div>
      <div className="card__body desktop-app">
        {installed ? (
          <p className="strong">The app is installed. Open Booqy Console from your home screen.</p>
        ) : (
          <>
            <p className="muted small">Add Booqy Console to your home screen and it opens as its own full-screen app, with the same sign-in and features as here.</p>
            {kind === "ios" ? (
              <ol className="phone-install__steps">
                <li><span className="phone-install__icon"><ShareGlyph /></span><span>Tap <span className="strong">Share</span> in Safari (at the bottom; top right on iPad).</span></li>
                <li><span className="phone-install__icon"><AddGlyph /></span><span>Scroll and choose <span className="strong">Add to Home Screen</span>.</span></li>
                <li><span className="phone-install__icon phone-install__icon--text">Add</span><span>Tap <span className="strong">Add</span> at the top right.</span></li>
              </ol>
            ) : canPrompt ? (
              <p><button type="button" className="btn btn--primary" onClick={() => void prompt()}>Install app</button></p>
            ) : (
              <ol className="phone-install__steps">
                <li><span className="phone-install__icon phone-install__icon--text">⋮</span><span>Tap the <span className="strong">⋮</span> menu at the top right in Chrome.</span></li>
                <li><span className="phone-install__icon"><AddGlyph /></span><span>Choose <span className="strong">Install app</span> or <span className="strong">Add to Home screen</span>.</span></li>
              </ol>
            )}
            {kind === "ios" && <p className="muted small">The first time in the app you sign in once more; the home screen app has its own sign-in.</p>}
          </>
        )}
      </div>
    </section>
  );
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

  const { ref, flash } = useFlashOnHash();

  return (
    <section className={flash ? "card desktop-app-card is-flash" : "card desktop-app-card"} id="desktop-app" data-help="settings:desktop-app" ref={ref} tabIndex={-1}>
      {heading && <div className="card__head"><h2>Desktop app</h2></div>}
      <div className="card__body desktop-app">
        <p className="muted small">
          Booqy Console in its own window: same sign-in and features as here, always the latest console. It updates itself
          without asking.
        </p>
        {rec !== undefined && (
          <div className="desktop-app__install">
            <h3 className="desktop-app__sub">Install with one command (recommended)</h3>
            <p className="muted small">
              Paste into {installShellFor(rec) === "windows" ? "PowerShell" : installShellFor(rec) === "unix" ? "Terminal" : "Terminal or PowerShell"} and
              press Return. It checks the file and installs without warning dialogs.
            </p>
            {installShellFor(rec) !== "windows" && <CommandRow shell="unix" />}
            {installShellFor(rec) !== "unix" && <CommandRow shell="windows" />}
            <h3 className="desktop-app__sub">Or download the file</h3>
          </div>
        )}
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
