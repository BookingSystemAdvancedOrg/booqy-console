import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import LoginPage from "./LoginPage";

vi.mock("aws-amplify/auth", () => ({
  confirmResetPassword: vi.fn(), confirmSignIn: vi.fn(), resetPassword: vi.fn(), signIn: vi.fn(), signOut: vi.fn(),
}));

describe("LoginPage: cookies and storage", () => {
  it("does not claim the Console keeps only the sign-in for this tab", () => {
    render(<MemoryRouter><LoginPage onSignedIn={() => undefined} /></MemoryRouter>);
    expect(screen.queryByText(/for this tab/)).not.toBeInTheDocument();
    expect(screen.getByText(/keeps only what it needs to sign you in and remember your settings/)).toBeInTheDocument();
  });
});
