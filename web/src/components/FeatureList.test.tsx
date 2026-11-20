import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURE_KEYS, FEATURE_LABELS } from "../contracts";
import { FEATURE_HELP } from "../featureHelp";
import { FeatureList } from "./FeatureList";

function Harness({ initial = {} as Record<string, boolean> }) {
  const [on, setOn] = useState(initial);
  return (
    <>
      <FeatureList keys={[...FEATURE_KEYS]} checked={on} onToggle={(k, v) => setOn({ ...on, [k]: v })} />
      <button type="button">Outside</button>
    </>
  );
}

describe("FEATURE_HELP", () => {
  it("has a short line, details and an example for every contract feature, and nothing else", () => {
    expect(Object.keys(FEATURE_HELP).sort()).toEqual([...FEATURE_KEYS].sort());
    for (const k of FEATURE_KEYS) {
      const h = FEATURE_HELP[k];
      expect(h.line.trim().length, k).toBeGreaterThan(0);
      expect(h.line.split(/\s+/).length, `${k} line`).toBeLessThanOrEqual(11);
      expect(h.about.trim().length, k).toBeGreaterThan(40);
      expect(h.example.trim().length, k).toBeGreaterThan(20);
      for (const t of [h.line, h.about, h.example]) {
        expect(t, k).not.toMatch(/[\u2013\u2014]|&[mn]dash;|[<>]|\uFFFD|\u00C3|certif|kassa|card reader/i);
      }
    }
  });
});

describe("FeatureList", () => {
  it("lists every feature as a checkbox named by its label, with its line", () => {
    render(<Harness initial={{ reservations: true }} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(FEATURE_KEYS.length);
    expect(screen.getByLabelText("Reservations")).toBeChecked();
    expect(screen.getByLabelText("Catering")).not.toBeChecked();
    expect(screen.getByLabelText("Catering")).toHaveAccessibleDescription(FEATURE_HELP.catering.line);
    expect(screen.getByText(FEATURE_HELP.waitlist.line)).toBeInTheDocument();
  });

  it("toggles the box from the name, not from the ?", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Gift cards"));
    expect(screen.getByLabelText("Gift cards")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "About Gift cards" }));
    expect(screen.getByRole("checkbox", { name: "Gift cards" })).toBeChecked();
    expect(screen.getByRole("dialog", { name: "Gift cards" })).toBeInTheDocument();
  });

  it("opens with the details and example, closes on ?, Escape and an outside click", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const btn = screen.getByRole("button", { name: "About Catering" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await user.click(btn);
    const dlg = screen.getByRole("dialog", { name: "Catering" });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(btn).toHaveAttribute("aria-controls", dlg.id);
    expect(within(dlg).getByText(FEATURE_HELP.catering.about)).toBeInTheDocument();
    expect(dlg).toHaveTextContent(`Example: ${FEATURE_HELP.catering.example}`);
    expect(dlg).toHaveFocus();
    await user.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(btn);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(btn).toHaveFocus();

    await user.click(btn);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from the keyboard with Enter and Space, Tab returns to the ?", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const btn = screen.getByRole("button", { name: "About Phone agent" });
    btn.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Phone agent" })).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(btn).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByRole("dialog", { name: "Phone agent" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Phone agent" })).not.toBeChecked();
  });

  it("keeps only one open at a time", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "About Reservations" }));
    await user.click(screen.getByRole("button", { name: "About Waitlist" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Waitlist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About Reservations" })).toHaveAttribute("aria-expanded", "false");
  });

  it("renders text as plain text, Swedish letters and quotes intact", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: `About ${FEATURE_LABELS.guestCrm.en}` }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Gäster");
    fireEvent.click(screen.getByRole("button", { name: "About Online ordering" }));
    expect(screen.getByRole("dialog")).toHaveTextContent('"ready" SMS');
  });
  describe("on a phone", () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    it("opens the details as a bottom sheet over a scrim, and a tap on the scrim closes it without reaching the list", async () => {
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("640"), media: q, addEventListener() {}, removeEventListener() {} }));
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "About Catering" }));
      const dialog = screen.getByRole("dialog", { name: "Catering" });
      expect(dialog).toHaveClass("feat-pop--sheet");
      expect(dialog.style.top).toBe("");
      const scrim = document.querySelector(".feat-scrim")!;
      expect(scrim).not.toBeNull();
      fireEvent.pointerDown(scrim);
      expect(screen.getByRole("dialog")).toBeInTheDocument();   // stays until the click, so no tap falls through
      fireEvent.click(scrim);
      // the sheet slides away first (ux-motion #18), then it is gone
      expect(dialog).toHaveAttribute("data-closing");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.querySelector(".feat-scrim")).toBeNull();
      expect(screen.getByLabelText("Catering")).not.toBeChecked();
    });
  });
});
