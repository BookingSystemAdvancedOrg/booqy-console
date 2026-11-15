import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCard } from "./components/DesktopAppCard";
import { isIos, phoneKind, showPhoneInstallNav } from "./pwa";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

function as(ua: string, platform: string, touch: number, standalone = false) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  Object.defineProperty(navigator, "maxTouchPoints", { value: touch, configurable: true }); // not in jsdom
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: standalone && q.includes("standalone"), media: q, addEventListener() {}, removeEventListener() {} }));
}

describe("app on the phone (PWA)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "maxTouchPoints");
  });

  it("tells iPhone, iPad and Android apart", () => {
    expect(isIos(IPHONE, "iPhone", 5)).toBe(true);
    expect(isIos(MAC, "MacIntel", 5)).toBe(true);
    expect(phoneKind({ userAgent: ANDROID, platform: "Linux armv8l", maxTouchPoints: 5 })).toBe("android");
  });

  it("Install app only on phones in the browser, not installed, not in the desktop app", () => {
    as(IPHONE, "iPhone", 5);
    expect(showPhoneInstallNav()).toBe(true);
    as(MAC, "MacIntel", 0);
    expect(showPhoneInstallNav()).toBe(false);
    as(IPHONE, "iPhone", 5, true);
    expect(showPhoneInstallNav()).toBe(false);
    as(`${IPHONE} BooqyDesktop/1.3.3`, "iPhone", 5);
    expect(showPhoneInstallNav()).toBe(false);
  });

  it("iPhone: home screen steps, no desktop file list", () => {
    as(IPHONE, "iPhone", 5);
    render(<MemoryRouter><DesktopAppCard /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "App on your phone" })).toBeInTheDocument();
    expect(screen.getByText("Add to Home Screen")).toBeInTheDocument();
    expect(screen.queryByText("Mac with Apple silicon")).toBeNull();
  });

  it("already installed: says so", () => {
    as(IPHONE, "iPhone", 5, true);
    render(<MemoryRouter><DesktopAppCard /></MemoryRouter>);
    expect(screen.getByText(/The app is installed/)).toBeInTheDocument();
  });
});
