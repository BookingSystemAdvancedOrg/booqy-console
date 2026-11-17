import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ outbox: vi.fn(), outboxMessage: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import OutboxPage from "./OutboxPage";

beforeEach(() => vi.clearAllMocks());

describe("Outbox message that fails to load (finding 180)", () => {
  it("offers Try again, which loads it", async () => {
    mocks.outbox.mockResolvedValue({ enabled: true, messages: [{ id: "m1", at: "2026-11-01T10:00:00Z", channel: "email", to: "a@b.se", subject: "Welcome" }], next: null });
    mocks.outboxMessage.mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ id: "m1", at: "2026-11-01T10:00:00Z", channel: "email", to: "a@b.se", subject: "Welcome", text: "Hej https://x.se/a" });
    render(<MemoryRouter><OutboxPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "Welcome" }));
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "https://x.se/a" })).toBeInTheDocument();
    expect(mocks.outboxMessage).toHaveBeenCalledTimes(2);
  });
});

describe("Outbox list that fails to load (finding 180)", () => {
  it("Try again shows the loading state, then the rows", async () => {
    let answer: (v: unknown) => void = () => {};
    mocks.outbox.mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(new Promise((r) => { answer = r; }));
    render(<MemoryRouter><OutboxPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Loading the outbox")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    answer({ enabled: true, messages: [{ id: "m1", at: "2026-11-01T10:00:00Z", channel: "email", to: "a@b.se", subject: "Welcome" }], next: null });
    expect(await screen.findByRole("button", { name: "Welcome" })).toBeInTheDocument();
    expect(mocks.outbox).toHaveBeenCalledTimes(2);
  });
});
