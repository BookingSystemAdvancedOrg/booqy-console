import { fireEvent, screen } from "@testing-library/react";

/** Opens a Select (role combobox) and clicks the option with this name. */
export function pick(combobox: HTMLElement, option: string | RegExp) {
  fireEvent.click(combobox);
  fireEvent.click(screen.getByRole("option", { name: option }));
}

/** The value a Select holds (its data-value). */
export const selectValue = (combobox: HTMLElement) => combobox.getAttribute("data-value");

/** The option names a Select offers, opened and closed again. */
export function optionNames(combobox: HTMLElement): string[] {
  fireEvent.click(combobox);
  const names = screen.getAllByRole("option").map((o) => o.textContent ?? "");
  fireEvent.keyDown(combobox, { key: "Escape" });
  return names;
}
