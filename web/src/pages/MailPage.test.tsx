import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import MailPage from "./MailPage";
import { api, ApiError } from "../api";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  api: { mailTemplate: vi.fn(), mailRecipients: vi.fn(), mailPreview: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.mailTemplate).mockResolvedValue({ senderName: "Booqy", from: "news@booqy.se", replyTo: "hej@booqy.se" } as never);
  vi.mocked(api.mailRecipients).mockResolvedValue({ count: 2, recipients: [] });
});

describe("MailPage: the preview", () => {
  it("says so when the preview fails, instead of a skeleton forever", async () => {
    vi.mocked(api.mailPreview).mockRejectedValue(new ApiError(503, "service_unavailable", "x"));
    render(<MemoryRouter><MailPage /></MemoryRouter>);
    expect(await screen.findByText(/Booqy's fault/, {}, { timeout: 2000 })).toBeInTheDocument();
    expect(document.querySelector(".mail-preview .skel-lines")).toBeNull();
  });

  it("shows the render when the preview works", async () => {
    vi.mocked(api.mailPreview).mockResolvedValue({ subject: "s", html: "<p>Hej</p>", text: "Hej" });
    render(<MemoryRouter><MailPage /></MemoryRouter>);
    expect(await screen.findByTitle("Email preview", {}, { timeout: 2000 })).toBeInTheDocument();
  });
});
