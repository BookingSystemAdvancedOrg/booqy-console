import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({ accessToken: async () => "t", notifySignedOut: () => undefined, signOut: async () => undefined }));

import { ApiError } from "../api";
import { ErrorNotice, Field, errorMessage } from "./ui";

describe("errorMessage", () => {
  it("never shows [object Object] or the browser's network text", () => {
    expect(errorMessage({ a: 1 })).toMatch(/^Something went wrong/);
    expect(errorMessage(new TypeError("Failed to fetch"))).toMatch(/^Couldn't reach the API/);
    expect(errorMessage(new ApiError(409, "self", "You can't disable your own account"))).toBe("You can't disable your own account");
    expect(errorMessage("Plain text.")).toBe("Plain text.");
  });

  it("renders as an alert", () => {
    render(<ErrorNotice error={{ weird: true }} />);
    expect(screen.getByRole("alert")).not.toHaveTextContent("object");
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
