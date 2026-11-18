import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field, useAction } from "./ui";
import { SaveBar, SaveButton, confirmLeave, discardUnsaved, hasUnsaved, restoreUnsaved, useDirty } from "./save";

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

  it("lets one confirmed reload through and guards again when it did not happen", () => {
    render(<Form />);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "y" } });
    const unload = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    expect(unload()).toBe(true);
    discardUnsaved();
    expect(hasUnsaved()).toBe(true);
    expect(unload()).toBe(false);
    restoreUnsaved();
    expect(hasUnsaved()).toBe(true);
    expect(unload()).toBe(true);
    const ask = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(confirmLeave()).toBe(true);
    expect(ask).toHaveBeenCalledOnce();
    expect(hasUnsaved()).toBe(true);
  });
});

function BarForm({ onSave = async () => true }: { onSave?: () => Promise<boolean> }) {
  const saved = { name: "Pizza", city: "Malmö" };
  const [f, setF] = useState(saved);
  const a = useAction();
  const dirty = useDirty(f, saved);
  return (
    <form noValidate onSubmit={async (e) => { e.preventDefault(); if (await a.run(onSave)) dirty.markSaved(); }}>
      <Field label="Name" error={a.fields.name}>
        <input aria-label="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <SaveBar dirty={dirty.dirty} busy={a.busy} done={a.done} failed={!!a.error}
               onDiscard={() => { setF(dirty.base); a.setError(null); }} />
    </form>
  );
}

describe("SaveBar", () => {
  const save = () => screen.getByRole("button", { name: /save/i });
  const bar = () => screen.getByTestId("save-bar");

  it("rests in place with Save disabled while clean", () => {
    render(<BarForm />);
    expect(save()).toBeDisabled();
    expect(bar()).not.toHaveClass("save-bar--dirty");
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
  });

  it("follows the screen with Save enabled after a change, and is clean again after reverting", () => {
    render(<BarForm />);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Pizza!" } });
    expect(save()).toBeEnabled();
    expect(bar()).toHaveClass("save-bar--dirty");
    expect(bar()).toHaveTextContent("Unsaved changes");
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Pizza" } });
    expect(save()).toBeDisabled();
    expect(bar()).not.toHaveClass("save-bar--dirty");
  });

  it("Discard changes puts the saved values back", () => {
    render(<BarForm />);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Burger" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("name")).toHaveValue("Pizza");
    expect(save()).toBeDisabled();
    expect(hasUnsaved()).toBe(false);
  });

  it("is sticky (the CSS hook) only while dirty", () => {
    render(<BarForm />);
    expect(bar().className).toBe("save-bar");
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "x" } });
    expect(bar().className).toBe("save-bar save-bar--dirty");
  });

  it("after a failed save keeps the changes, goes to the error and reads Save and retry", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<BarForm onSave={async () => { throw new Error("nope"); }} />);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Pizza 4" } });
    await act(async () => { fireEvent.submit(save().closest("form")!); });
    expect(screen.getByLabelText("name")).toHaveValue("Pizza 4");
    expect(save()).toHaveTextContent("Save and retry");
    expect(save()).toBeEnabled();
    expect(focus).not.toHaveBeenCalled(); // no field marked: the error note is scrolled to instead
  });

  it("a Cancel shows while clean and gives way to Discard once dirty", () => {
    const cancel = vi.fn();
    function Edit() {
      const [v, setV] = useState("a");
      const dirty = useDirty(v, "a");
      return (<><input aria-label="v" value={v} onChange={(e) => setV(e.target.value)} />
        <SaveBar dirty={dirty.dirty} onSave={() => undefined} onCancel={cancel} onDiscard={() => setV(dirty.base)} /></>);
    }
    render(<Edit />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("v"), { target: { value: "b" } });
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeInTheDocument();
  });
});
