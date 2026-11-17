import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({ AuthUnavailableError: class extends Error {}, accessToken: async () => "t", refreshedAccessToken: async () => "t", notifySignedOut: () => undefined, signOut: async () => undefined }));

import { ApiError } from "../api";
import { ErrorNotice, Field, errorMessage, fmtDate } from "./ui";

describe("errorMessage", () => {
  it("never shows [object Object] or the browser's network text", () => {
    expect(errorMessage({ a: 1 })).toMatch(/^Something went wrong at Booqy\. This is Booqy's fault/);
    expect(errorMessage(new TypeError("Failed to fetch"))).toMatch(/^We can't reach Booqy/);
    expect(errorMessage(new ApiError(409, "self", "You can't disable your own account"))).toBe("You can't do this to your own account. Ask another operator.");
    expect(errorMessage("Plain text.")).toBe("Plain text.");
  });

  it("renders as an alert", () => {
    render(<ErrorNotice error={{ weird: true }} />);
    expect(screen.getByRole("alert")).not.toHaveTextContent("object");
  });
});

describe("ErrorNotice Try again", () => {
  it("offers Try again for a Booqy fault and a lost connection, not for the operator's own fix", () => {
    const retry = vi.fn();
    const { rerender } = render(<ErrorNotice error={new ApiError(500, "internal_error", "boom")} onRetry={retry} />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    rerender(<ErrorNotice error={new TypeError("Failed to fetch")} onRetry={retry} />);
    screen.getByRole("button", { name: "Try again" }).click();
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<ErrorNotice error="Pick a plan first." onRetry={retry} />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("fmtDate", () => {
  it("is English like the rest of the console", () => {
    expect(fmtDate("2026-09-01T10:00:00Z")).toMatch(/^1 Sept? 2026, \d\d:\d\d$/);
    expect(fmtDate(undefined)).toBe("-");
  });
});

describe("Field", () => {
  it("ties the error to its control", () => {
    render(<Field label="Email" error="Enter a valid email"><input /></Field>);
    const input = screen.getByRole("textbox", { name: /Email/ });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a valid email");
  });

  it("describes the control with its hint when there is no error", () => {
    render(<Field label="Slug" hint="Lowercase letters"><input /></Field>);
    const input = screen.getByRole("textbox", { name: /Slug/ });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveAccessibleDescription("Lowercase letters");
  });
});
