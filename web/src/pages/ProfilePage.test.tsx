import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorAccount } from "../types";

const mine: OperatorAccount = { username: "me", email: "lamo@booqy.se", name: "Lamo Koura", status: "CONFIRMED", enabled: true, role: "operator" };
const mocks = vi.hoisted(() => ({ operators: vi.fn(), myAvatar: vi.fn(), updateOperator: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import ProfilePage from "./ProfilePage";

const me = { username: "me", email: "lamo@booqy.se", name: "Lamo Koura" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.myAvatar.mockResolvedValue({ url: null });
  mocks.updateOperator.mockResolvedValue({});
});

describe("My profile", () => {
  it("saves your own name; the email is read only for an operator", async () => {
    mocks.operators.mockResolvedValue({ operators: [mine], canChangeEmail: false });
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<ProfilePage me={me} onSaved={onSaved} />);
    const name = await screen.findByDisplayValue("Lamo Koura");
    expect(screen.getByDisplayValue("lamo@booqy.se")).toBeDisabled();
    expect(screen.getByRole("button", { name: "About the email" })).toBeInTheDocument();
    expect(screen.getByText("Operator")).toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, "Lamo K");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.updateOperator).toHaveBeenCalledWith("me", { name: "Lamo K" });
    expect(onSaved).toHaveBeenCalled();
  });

  it("lets an owner change their own email", async () => {
    mocks.operators.mockResolvedValue({ operators: [{ ...mine, role: "owner" }], canChangeEmail: true });
    render(<ProfilePage me={me} onSaved={vi.fn().mockResolvedValue(undefined)} />);
    const email = await screen.findByDisplayValue("lamo@booqy.se");
    expect(email).toBeEnabled();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    await userEvent.clear(email);
    await userEvent.type(email, "lamo@ithjalparna.se");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.updateOperator).toHaveBeenCalledWith("me", { name: "Lamo Koura", email: "lamo@ithjalparna.se" });
  });
});
