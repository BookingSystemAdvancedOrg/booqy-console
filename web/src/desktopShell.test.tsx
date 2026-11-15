import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCard } from "./components/DesktopAppCard";
import { DownloadRedirect } from "./components/DownloadRedirect";
import { isDesktopShell, showDownloadNav } from "./desktopDownloads";

// No download UI inside the desktop app: every surface checks isDesktopShell().
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const SHELL = `${BROWSER} BooqyDesktop/1.2.0 BooqyGlass/vibrancy`;

function as(ua: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.hash}</p>;
}

describe("download UI only outside the desktop app", () => {
  afterEach(() => vi.restoreAllMocks());

  it("isDesktopShell reads the shell flag from the user agent", () => {
    expect(isDesktopShell(SHELL)).toBe(true);
    expect(isDesktopShell(BROWSER)).toBe(false);
  });

  it("menu: no Download app in the shell", () => {
    expect(showDownloadNav({ userAgent: SHELL, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(showDownloadNav({ userAgent: BROWSER, platform: "MacIntel", maxTouchPoints: 0 })).toBe(true);
  });

  it("settings card: nothing in the shell, the card in a browser", () => {
    as(SHELL);
    const { container, unmount } = render(<MemoryRouter><DesktopAppCard /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
    unmount();
    as(BROWSER);
    render(<MemoryRouter><DesktopAppCard /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Desktop app" })).toBeInTheDocument();
  });

  it("/download: home in the shell, the card in a browser", () => {
    const at = (ua: string) => {
      as(ua);
      const { unmount } = render(
        <MemoryRouter initialEntries={["/download"]}>
          <Routes>
            <Route path="/download" element={<DownloadRedirect />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>,
      );
      const where = screen.getByTestId("where").textContent;
      unmount();
      return where;
    };
    expect(at(SHELL)).toBe("/");
    expect(at(BROWSER)).toBe("/settings#desktop-app");
  });
});
