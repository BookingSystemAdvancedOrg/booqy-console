import { DesktopAppCard } from "../components/DesktopAppCard";

/** /download: the desktop app (the side menu's "Download app", browser only). */
export default function DownloadPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Download app</h1>
          <p className="muted">Booqy Console for Mac, Windows and Linux.</p>
        </div>
      </div>
      <DesktopAppCard heading={false} />
    </>
  );
}
