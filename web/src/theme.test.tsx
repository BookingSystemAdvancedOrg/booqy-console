import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./components/ThemeToggle";
import { applyTheme, currentTheme, setTheme, storedTheme } from "./theme";
import { THEME_KEY } from "./storageRegistry";

describe("theme", () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_KEY);
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => {
    localStorage.removeItem(THEME_KEY);
    document.documentElement.removeAttribute("data-theme");
  });

  it("is light until the operator chooses, whatever the system says", () => {
    expect(storedTheme()).toBeNull();
    expect(currentTheme()).toBe("light");
  });

  it("setTheme stores the choice and marks the page", () => {
    setTheme("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("applyTheme only marks the page", () => {
    applyTheme("dark");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(currentTheme()).toBe("dark");
  });

  it("the toggle is a pressed button for dark mode", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: "Dark mode" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });
});
