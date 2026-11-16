import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DateInput, MonthPicker, formatDate, parseDate } from "./DateInput";
import { Field, Modal } from "./ui";

function Harness({ initial = "", min, max, onValue }: { initial?: string; min?: string; max?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Field label="From"><DateInput value={value} min={min} max={max} onChange={(e) => { setValue(e.target.value); onValue?.(e.target.value); }} /></Field>
      <output data-testid="value">{value}</output>
      <button type="button" onClick={() => setValue("2026-01-05")}>Preset</button>
    </>
  );
}

const field = () => screen.getByLabelText("From") as HTMLInputElement;

describe("formatDate and parseDate", () => {
  it("formats ISO as DD/MM/YYYY and reads the usual ways of typing a day", () => {
    expect(formatDate("2026-10-22")).toBe("22/10/2026");
    expect(formatDate("")).toBe("");
    expect(parseDate("22/10/2026")).toBe("2026-10-22");
    expect(parseDate("2.3.2026")).toBe("2026-03-02");
    expect(parseDate("22102026")).toBe("2026-10-22");
    expect(parseDate("2026-10-22")).toBe("2026-10-22");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("10/22/2026")).toBeNull();   // never US order
  });
});

describe("DateInput", () => {
  it("is a text field in DD/MM/YYYY, never the browser's date field", () => {
    render(<Harness initial="2026-11-16" />);
    expect(field()).toHaveAttribute("type", "text");
    expect(field()).toHaveAttribute("placeholder", "DD/MM/YYYY");
    expect(field()).toHaveValue("16/11/2026");
    expect(document.querySelector("input[type=date]")).toBeNull();
  });

  it("emits yyyy-mm-dd for a whole day and an empty value while incomplete", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(field(), { target: { value: "05/0" } });
    expect(onValue).toHaveBeenLastCalledWith("");
    fireEvent.change(field(), { target: { value: "05/03/2027" } });
    expect(onValue).toHaveBeenLastCalledWith("2027-03-05");
    expect(screen.getByTestId("value")).toHaveTextContent("2027-03-05");
  });

  it("takes an ISO value set like the native field (tests, paste)", () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: "2027-01-31" } });
    expect(field()).toHaveValue("31/01/2027");
    expect(screen.getByTestId("value")).toHaveTextContent("2027-01-31");
  });

  it("marks a day outside min/max invalid and emits nothing", () => {
    render(<Harness min="2026-11-01" max="2026-11-30" />);
    fireEvent.change(field(), { target: { value: "01/12/2026" } });
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("value")).toBeEmptyDOMElement();
  });

  it("follows a value set from outside", () => {
    render(<Harness initial="2026-11-16" />);
    fireEvent.click(screen.getByRole("button", { name: "Preset" }));
    expect(field()).toHaveValue("05/01/2026");
  });

  it("picks a day in the Booqy calendar, weeks starting on Monday, outside days disabled", () => {
    render(<Harness initial="2026-11-16" max="2026-11-20" />);
    fireEvent.click(screen.getByRole("button", { name: "Open calendar" }));
    const cal = screen.getByRole("dialog", { name: "Choose date" });
    expect(within(cal).getByText("November 2026")).toBeInTheDocument();
    expect(cal.querySelector(".date-cal__wd")).toHaveTextContent("Mon");
    expect(within(cal).getByRole("button", { name: "16 November 2026" })).toHaveAttribute("aria-pressed", "true");
    expect(within(cal).getByRole("button", { name: "21 November 2026" })).toBeDisabled();
    fireEvent.click(within(cal).getByRole("button", { name: "18 November 2026" }));
    expect(screen.queryByRole("dialog", { name: "Choose date" })).toBeNull();
    expect(field()).toHaveValue("18/11/2026");
    expect(screen.getByTestId("value")).toHaveTextContent("2026-11-18");
  });

  it("moves with the arrow keys and closes on Escape without closing the modal around it", () => {
    const onClose = vi.fn();
    function InModal() {
      const [v, setV] = useState("2026-11-16");
      return <Modal title="Rebuild" onClose={onClose}><DateInput aria-label="From" value={v} onChange={(e) => setV(e.target.value)} /></Modal>;
    }
    render(<InModal />);
    fireEvent.click(screen.getByRole("button", { name: "Open calendar" }));
    const cal = screen.getByRole("dialog", { name: "Choose date" });
    expect(document.activeElement).toHaveAttribute("data-iso", "2026-11-16");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toHaveAttribute("data-iso", "2026-11-17");
    fireEvent.mouseDown(cal);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose date" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open calendar" }));
  });

  it("Escape on the text field or the calendar button closes only the calendar, not the modal", () => {
    const onClose = vi.fn();
    function InModal() {
      const [v, setV] = useState("2026-11-16");
      return <Modal title="Rebuild" onClose={onClose}><DateInput aria-label="From" value={v} onChange={(e) => setV(e.target.value)} /></Modal>;
    }
    render(<InModal />);
    const btn = screen.getByRole("button", { name: "Open calendar" });
    fireEvent.click(btn);
    const input = screen.getByRole("textbox", { name: "From" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose date" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(btn);
    btn.focus();
    fireEvent.keyDown(btn, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose date" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // With the calendar closed, Escape still reaches the modal.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape on the MonthPicker button closes only the month panel, not the modal", () => {
    const onClose = vi.fn();
    render(<Modal title="Payments" onClose={onClose}><MonthPicker aria-label="Month" value="2026-11" onChange={() => {}}>Nov</MonthPicker></Modal>);
    const btn = screen.getByRole("button", { name: /^Month:/ });
    fireEvent.click(btn);
    expect(screen.getByRole("dialog", { name: "Choose month" })).toBeInTheDocument();
    btn.focus();
    fireEvent.keyDown(btn, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose month" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a click outside", () => {
    render(<Harness initial="2026-11-16" />);
    fireEvent.click(screen.getByRole("button", { name: "Open calendar" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("MonthPicker", () => {
  function Months({ max }: { max?: string }) {
    const [m, setM] = useState("2026-10");
    return <><MonthPicker value={m} max={max} onChange={setM} aria-label="Month">{m}</MonthPicker><output data-testid="m">{m}</output></>;
  }

  it("opens a Booqy year of months instead of the browser's month field and picks yyyy-mm", () => {
    render(<Months max="2026-11" />);
    expect(document.querySelector("input[type=month]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Month: October 2026" }));
    const cal = screen.getByRole("dialog", { name: "Choose month" });
    expect(within(cal).getByRole("button", { name: "October 2026" })).toHaveAttribute("aria-pressed", "true");
    expect(within(cal).getByRole("button", { name: "December 2026" })).toBeDisabled();
    fireEvent.click(within(cal).getByRole("button", { name: "Previous year" }));
    fireEvent.click(within(cal).getByRole("button", { name: "March 2025" }));
    expect(screen.getByTestId("m")).toHaveTextContent("2025-03");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
