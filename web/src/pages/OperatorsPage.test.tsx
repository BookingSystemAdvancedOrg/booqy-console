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
  mocks.operators.mockResolvedValue({ operators: ops, canChangeEmail: false });
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
  });

  it("opens Edit from the row's named button with the keyboard", async () => {
    render(<OperatorsPage me="me" />);
    const name = await screen.findByRole("button", { name: "Edit Zach" });
    expect((await rowOf("Zach")).hasAttribute("tabindex")).toBe(false);
    name.focus();
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
    expect(box.querySelector(".avatar--xl .avatar__initials")?.getAttribute("data-initials")).toBe("L");
  });

  it("leaves the action buttons to themselves", async () => {
    mocks.updateOperator.mockResolvedValue({});
    render(<OperatorsPage me="me" />);
    const row = await rowOf("Zach");
    await userEvent.click(within(row).getAllByRole("button", { name: "Disable" })[0]);
    expect(mocks.updateOperator).toHaveBeenCalledWith("u2", { enabled: false });
    expect(screen.queryByRole("dialog", { name: "Edit operator" })).toBeNull();
  });

  it("keeps the email read only, with a tip, for an operator", async () => {
    render(<OperatorsPage me="me" />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit Zach" }));
    const dialog = screen.getByRole("dialog", { name: "Edit operator" });
    expect(within(dialog).getByDisplayValue("zach@booqy.se")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "About the email" })).toBeInTheDocument();
  });

  it("lets an owner change any operator's email", async () => {
    mocks.operators.mockResolvedValue({ operators: ops, canChangeEmail: true });
    mocks.updateOperator.mockResolvedValue({});
    render(<OperatorsPage me="me" />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit Zach" }));
    const dialog = screen.getByRole("dialog", { name: "Edit operator" });
    const email = within(dialog).getByDisplayValue("zach@booqy.se");
    expect(email).toBeEnabled();
    expect(within(dialog).queryByRole("button", { name: "About the email" })).toBeNull();
    await userEvent.clear(email);
    await userEvent.type(email, "zach.new@booqy.se");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(mocks.updateOperator).toHaveBeenCalledWith("u2", { name: "Zach", email: "zach.new@booqy.se" });
  });

  it("tags owners and only lets an owner disable or delete one", async () => {
    mocks.operators.mockResolvedValue({ operators: [ops[0], { ...ops[1], role: "owner" }], canChangeEmail: false });
    render(<OperatorsPage me="me" />);
    const row = await rowOf("Zach");
    expect(within(row).getByText("owner")).toBeInTheDocument();
    for (const b of within(row).getAllByRole("button", { name: "Disable" })) expect(b).toBeDisabled();
    for (const b of within(row).getAllByRole("button", { name: "Delete" })) expect(b).toBeDisabled();
  });
});
