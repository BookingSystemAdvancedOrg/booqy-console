import { Navigate } from "react-router-dom";
import { isDesktopShell } from "../desktopDownloads";

/** Old /download links: the Desktop app card in a browser, home inside the desktop app. */
export function DownloadRedirect() {
  return <Navigate to={isDesktopShell() ? "/" : "/settings#desktop-app"} replace />;
}
