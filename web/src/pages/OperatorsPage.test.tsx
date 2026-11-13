import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorAccount } from "../types";

const ops: OperatorAccount[] = [
  { username: "me", email: "lamo@booqy.se", name: "", status: "CONFIRMED", enabled: true, avatarUrl: null },
  { username: "u2", email: "zach@booqy.se", name: "Zach", status: "CONFIRMED", enabled: true, avatarUrl: "https://img.example/z.webp" },
];
const mocks = vi.hoisted(() => ({
  operators: vi.fn(), myAvatar: vi.fn(), updateOperator: vi.fn(), resendInvite: vi.fn(), deleteOperator: vi.fn(), createOperator: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import OperatorsPage from "./OperatorsPage";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.operators.mockResolvedValue(ops);
  mocks.myAvatar.mockResolvedValue({ url: null });
});

const rowOf = async (text: string) => (await screen.findByText(text)).closest("tr") as HTMLTableRowElement;

describe("Operators rows", () => {
  it("shows the email's local part, not a dash, for an operator without a name", async () => {
    render(<OperatorsPage me="me" />);
    expect(await screen.findByText("lamo")).toBeInTheDocument();
    expect(screen.queryByText("-", { selector: ".operator-name *" })).toBeNull();
  });

  it("opens Edit when the row is clicked, with a prompt to add the missing name", async () => {
    render(<OperatorsPage me="me" />);
    await userEvent.click(await screen.findByText("lamo@booqy.se"));
    const dialog = screen.getByRole("dialog", { name: "Edit operator" });
    expect(within(dialog).getByPlaceholderText("Add a name")).toBeInTheDocument();
    expect(within(dialog).getByText(/No name yet/)).toBeInTheDocument();
  });

  it("opens Edit with Enter on the focused row", async () => {
    render(<OperatorsPage me="me" />);
    const row = await rowOf("Zach");
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Edit operator" })).toBeInTheDocument();
  });

  it("opens the lightbox, not Edit, when the picture is clicked", async () => {
    render(<OperatorsPage me="me" />);
    await userEvent.click(await screen.findByRole("button", { name: "Show the profile picture of Zach" }));
    const box = screen.getByRole("dialog", { name: "Profile picture: Zach" });
    expect(within(box).getByText("zach@booqy.se")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Edit operator" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Profile picture/ })).toBeNull();
  });

  it("shows large initials in the lightbox when there is no picture", async () => {
    render(<OperatorsPage me="me" />);
    await userEvent.click(await screen.findByRole("button", { name: "Show the profile picture of lamo@booqy.se" }));
    const box = screen.getByRole("dialog", { name: "Profile picture: lamo@booqy.se" });
    expect(box.querySelector(".avatar--xl")?.textContent).toBe("L");
  });

  it("leaves the action buttons to themselves", async () => {
    mocks.updateOperator.mockResolvedValue({});
    render(<OperatorsPage me="me" />);
    const row = await rowOf("Zach");
    await userEvent.click(within(row).getAllByRole("button", { name: "Disable" })[0]);
    expect(mocks.updateOperator).toHaveBeenCalledWith("u2", { enabled: false });
    expect(screen.queryByRole("dialog", { name: "Edit operator" })).toBeNull();
  });
});
