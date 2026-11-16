import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCorpus } from "../../../scripts/help-corpus.mjs";
import { setCorpus } from "./corpus";
import { helpChatEnabled, openHelpChat } from "./chatState";
import { HelpChat, LIMITED_TEXT } from "./HelpChat";
import { REFUSE_TEXT } from "./retrieve";

const mocks = vi.hoisted(() => ({
  tenants: vi.fn(),
  financeOverview: vi.fn(),
  outbox: vi.fn(),
  helpStatus: vi.fn(),
  helpAnswer: vi.fn(),
}));
vi.mock("../../api", () => ({
  api: mocks,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code = "error", message = "", public fields: Record<string, string> = {}, public extra: Record<string, unknown> = {}) {
      super(message);
    }
  },
}));

function Where() {
  const { pathname, hash } = useLocation();
  return (
    <>
      <p data-testid="where">{`${pathname}${hash}`}</p>
      {/* What the assistant lights up on the real pages. */}
      {pathname === "/settings" && <div className="setting-row" data-help="settings:background">Background</div>}
      {pathname === "/finance" && <div className="kpi" data-help="kpi:mrr">MRR</div>}
      {pathname === "/" && <p data-help="customers:count">3 restaurants on the platform</p>}
    </>
  );
}

function renderChat(at = "/operators") {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <HelpChat />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Ask Booqy" }));
  return screen.getByRole("dialog", { name: "Help assistant" });
}

const question = () => screen.getByRole("textbox", { name: "Your question" });

describe("HelpChat", () => {
  beforeAll(() => setCorpus(buildCorpus()));
  beforeEach(() => {
    vi.stubEnv("VITE_API_URL", "");          // no API: answers come from the corpus here
    mocks.tenants.mockResolvedValue([
      { tenantId: "a", status: "active", chargesEnabled: true },
      { tenantId: "b", status: "active", chargesEnabled: false },
      { tenantId: "c", status: "offboarded", chargesEnabled: false },
    ]);
    mocks.financeOverview.mockResolvedValue({ kpis: { mrrSek: 12345, payingCustomers: 2, outstandingSek: 0 } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("names the launcher itself, so it still has a name on phones where the label is hidden", async () => {
    renderChat();
    const launcher = await screen.findByRole("button", { name: "Ask Booqy" });
    expect(launcher).toHaveAttribute("aria-label", "Ask Booqy");
  });

  it("answers today's Background question and lights the setting up in Settings", async () => {
    const user = userEvent.setup();
    renderChat();
    await openPanel(user);
    expect(question()).toHaveFocus();
    await user.type(question(), "How do I change the background behind the glass?{Enter}");
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("Your image"));
    const go = screen.getByRole("button", { name: "Open Settings" });
    expect(go).toHaveClass("btn--primary");
    await user.click(go);
    expect(screen.getByTestId("where")).toHaveTextContent("/settings");
    await waitFor(() => expect(document.querySelector('[data-help="settings:background"]')).toHaveClass("help-spotlight"));
  });

  it("answers MRR with the live number and shows it on Finance, lit up, with the panel open", async () => {
    const user = userEvent.setup();
    renderChat();
    await openPanel(user);
    await user.type(question(), "What is our MRR?{Enter}");
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent(/MRR is 12.345 kr right now/));
    expect(screen.getByTestId("where")).toHaveTextContent("/finance");
    await waitFor(() => expect(document.querySelector('[data-help="kpi:mrr"]')).toHaveClass("help-spotlight"));
    expect(screen.getByRole("dialog", { name: "Help assistant" })).toBeInTheDocument();
  });

  it("counts the customers from the same API as the Customers page", async () => {
    const user = userEvent.setup();
    renderChat();
    await openPanel(user);
    await user.type(question(), "How many customers are waiting for Stripe?{Enter}");
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("1 active customer can't take card payments yet"));
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });

  it("says so when the number can't be fetched", async () => {
    mocks.tenants.mockRejectedValue(new Error("down"));
    const user = userEvent.setup();
    renderChat();
    await openPanel(user);
    await user.type(question(), "How many customers do we have?{Enter}");
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("I couldn't fetch that number right now."));
  });

  it("refuses secrets", async () => {
    const user = userEvent.setup();
    renderChat();
    await openPanel(user);
    await user.type(question(), "What is the Stripe secret key?{Enter}");
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent(REFUSE_TEXT));
    expect(document.querySelector(".help-go")).toBeNull();
  });

  it("asks the server when there is one, and says to wait on 429", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example");
    const { ApiError } = await import("../../api");
    mocks.helpStatus.mockResolvedValue({ enabled: true, mode: "kb" });
    mocks.helpAnswer.mockRejectedValue(new (ApiError as unknown as new (s: number) => Error)(429));
    const user = userEvent.setup();
    renderChat();
    await openPanel(user);
    await user.type(question(), "How do I add a new customer?{Enter}");
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent(LIMITED_TEXT));
    expect(mocks.helpAnswer).toHaveBeenCalledWith({ question: "How do I add a new customer?", history: [] }, expect.any(AbortSignal));
  });

  it("falls back to the corpus when the server fails", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example");
    mocks.helpStatus.mockResolvedValue({ enabled: true, mode: "kb" });
    mocks.helpAnswer.mockRejectedValue(new Error("500"));
    const user = userEvent.setup();
    renderChat();
    await openPanel(user);
    await user.type(question(), "How do I add a new customer?{Enter}");
    await screen.findByRole("button", { name: "Open New customer" });
  });

  it("closes and disappears when it is switched off while open, with no local answer", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example");
    const { ApiError } = await import("../../api");
    mocks.helpStatus.mockResolvedValue({ enabled: true, mode: "kb" });
    mocks.helpAnswer.mockRejectedValue(new (ApiError as unknown as new (s: number, c: string) => Error)(403, "help_assistant_off"));
    const user = userEvent.setup();
    renderChat();
    await openPanel(user);
    await user.type(question(), "How do I add a new customer?{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Ask Booqy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open New customer" })).toBeNull();
    expect(helpChatEnabled()).toBe(false);
    act(() => openHelpChat());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says it is Booqy's fault, with the request id to copy, when not even the corpus can answer", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example");
    const { ApiError } = await import("../../api");
    mocks.helpStatus.mockResolvedValue({ enabled: true, mode: "kb" });
    mocks.helpAnswer.mockRejectedValue(
      new (ApiError as unknown as new (s: number, c: string, m: string, f: object, e: object) => Error)(503, "service_unavailable", "", {}, { requestId: "req-42" }),
    );
    setCorpus(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    try {
      const user = userEvent.setup();
      renderChat();
      await openPanel(user);
      await user.type(question(), "How do I add a new customer?{Enter}");
      await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("Booqy fault"));
      await user.click(screen.getByRole("button", { name: "Details" }));
      expect(screen.getByRole("log")).toHaveTextContent("Request id: req-42");
      // Try again asks once more, without a second copy of the question.
      setCorpus(buildCorpus());
      await user.click(screen.getByRole("button", { name: "Try again" }));
      await screen.findByRole("button", { name: "Open New customer" });
      expect(screen.getAllByText("How do I add a new customer?")).toHaveLength(1);
      expect(screen.queryByText(/Booqy fault/)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      setCorpus(buildCorpus());
    }
  });

  it("is not shown when the server has it off", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example");
    mocks.helpStatus.mockResolvedValue({ enabled: false, mode: "off" });
    renderChat();
    await waitFor(() => expect(mocks.helpStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Ask Booqy" })).toBeNull();
  });

  it("closes with Escape and gives focus back", async () => {
    const user = userEvent.setup();
    renderChat();
    await openPanel(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Booqy" })).toHaveFocus());
  });

  it("opens from the command palette", async () => {
    renderChat();
    await screen.findByRole("button", { name: "Ask Booqy" });
    act(() => openHelpChat());
    expect(screen.getByRole("dialog", { name: "Help assistant" })).toBeInTheDocument();
  });
});
