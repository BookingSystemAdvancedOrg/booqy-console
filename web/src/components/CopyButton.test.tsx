import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";
import { NameServerBox, RecordsTable, RestaurantText, SupportCaseBox } from "./DomainWizard";

vi.mock("../api", () => ({ api: {}, ApiError: class extends Error {}, uploadToS3: vi.fn() }));

function clipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(writeText) }, configurable: true });
  return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
}
afterEach(() => { delete (navigator as unknown as Record<string, unknown>).clipboard; });

describe("CopyButton (finding 204)", () => {
  it("copies and says Copied", async () => {
    const write = clipboard(async () => {});
    render(<CopyButton text="ns-1.example" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
    expect(write).toHaveBeenCalledWith("ns-1.example");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Copy by hand")).toBeNull();
  });

  it("without clipboard access, opens the text selected to copy by hand", async () => {
    clipboard(async () => { throw new DOMException("denied", "NotAllowedError"); });
    render(<CopyButton text={"line 1\nline 2"} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
    const box = screen.getByLabelText("Copy by hand") as HTMLTextAreaElement;
    expect(box).toHaveValue("line 1\nline 2");
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe("line 1\nline 2".length);
  });

  it("is used by every copy in the domain wizard", async () => {
    clipboard(async () => { throw new Error("no clipboard"); });
    render(<>
      <RestaurantText text="Steg 1" />
      <RecordsTable records={[{ type: "TXT", name: "_x.example.se", host: "_x", value: "v=1" } as never]} />
      <NameServerBox domain="example.se" nameServers={["ns-1", "ns-2"]} />
      <SupportCaseBox domain="example.se" tenantId="t1" supportCase={{ service: "Domains", category: "Other", subject: "Subj", body: "Body" } as never} />
    </>);
    const buttons = [...screen.getAllByRole("button", { name: /^Copy/ })];
    expect(buttons).toHaveLength(5);
    for (const b of buttons) await act(async () => { fireEvent.click(b); });
    expect(screen.getAllByLabelText("Copy by hand").map((b) => (b as HTMLTextAreaElement).value))
      .toEqual(["Steg 1", "v=1", "ns-1\nns-2", "Subj", "Body"]);
  });
});
