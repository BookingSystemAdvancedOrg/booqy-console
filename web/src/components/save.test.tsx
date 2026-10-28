import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field, useAction } from "./ui";
import { SaveButton, confirmLeave, hasUnsaved, useDirty } from "./save";

function Form({ saved = { name: "Pizza", city: "Malmö" }, onSave = async () => true }: { saved?: { name: string; city: string }; onSave?: () => Promise<boolean> }) {
  const [f, setF] = useState(saved);
  const a = useAction();
  const dirty = useDirty(f, saved);
  return (
    <form onSubmit={async (e) => { e.preventDefault(); if (await a.run(onSave)) dirty.markSaved(); }}>
      <Field label="Name" changed={dirty.changed("name")}>
        <input aria-label="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <SaveButton label="Save" busy={a.busy} done={a.done} dirty={dirty.dirty} />
    </form>
  );
}

const button = () => screen.getByRole("button");

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("useDirty and SaveButton", () => {
  it("rests disabled while clean, lights up on an edit and calms down when the edit is undone", () => {
    render(<Form />);
    expect(button()).toBeDisabled();
    expect(button()).toHaveClass("save-btn--clean");

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Pizza!" } });
    expect(button()).toBeEnabled();
    expect(button()).toHaveClass("save-btn--dirty");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByText("Name").closest(".field")).toHaveClass("field--changed");
    expect(hasUnsaved()).toBe(true);

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Pizza" } });
    expect(button()).toBeDisabled();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(hasUnsaved()).toBe(false);
  });

  it("shows Saved for a moment after a save, then is clean", async () => {
    vi.useFakeTimers();
    render(<Form />);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Pizza 2" } });
    await act(async () => { fireEvent.submit(button().closest("form")!); });
    expect(button()).toHaveTextContent("Saved");
    expect(button()).toHaveClass("save-btn--done");
    expect(hasUnsaved()).toBe(false);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(button()).toHaveClass("save-btn--clean");
  });

  it("stays dirty with Save to retry when the save fails", async () => {
    render(<Form onSave={async () => { throw new Error("nope"); }} />);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Pizza 3" } });
    await act(async () => { fireEvent.submit(button().closest("form")!); });
    expect(button()).toHaveClass("save-btn--dirty");
    expect(button()).toBeEnabled();
  });

  it("asks before leaving with unsaved changes", () => {
    render(<Form />);
    expect(confirmLeave()).toBe(true);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "x" } });
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(confirmLeave()).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
  });
});
