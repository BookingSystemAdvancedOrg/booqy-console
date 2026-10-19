import { InputHTMLAttributes, useLayoutEffect, useRef } from "react";
import { editPhone, formatPhone } from "../phone";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  /** The number as stored/sent, preferably E.164 ("+46723001573"). */
  value: string;
  /** Always gets E.164 (or "" for an empty field). */
  onChange: (value: string) => void;
};

/**
 * A phone field that formats while typing: "0723001573" shows as
 * "+46 72 300 15 73" and onChange gets "+46723001573". The same component
 * exists in all three apps (see phone.ts).
 */
export function PhoneInput({ value, onChange, placeholder = "+46 70 123 45 67", ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const display = formatPhone(value);

  // After reformatting: put the caret back where the person was typing.
  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current !== null && el && document.activeElement === el) {
      el.setSelectionRange(caret.current, caret.current);
    }
    caret.current = null;
  });

  return (
    <input
      ref={ref}
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      placeholder={placeholder}
      {...rest}
      value={display}
      onChange={(e) => {
        const next = editPhone(display, e.target.value, e.target.selectionStart ?? e.target.value.length);
        caret.current = next.caret;
        onChange(next.value);
      }}
    />
  );
}
