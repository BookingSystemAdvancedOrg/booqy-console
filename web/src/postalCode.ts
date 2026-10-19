/** Swedish postal codes: shown as "123 45" while typing, sent as "12345".
 * The API accepts both forms (validation.POSTAL_CODE_RE). */

/** Digits only, never more than 5: what goes to the API. */
export function postalCodeDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 5);
}

/** '12345' -> '123 45'; the space appears once the 4th digit is typed. */
export function formatPostalCode(value: string): string {
  const d = postalCodeDigits(value);
  return d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
}

/** Props for a postal code <input>: numeric keyboard, room for "123 45". */
export const POSTAL_CODE_INPUT = { inputMode: "numeric", maxLength: 6, placeholder: "123 45", autoComplete: "postal-code" } as const;
