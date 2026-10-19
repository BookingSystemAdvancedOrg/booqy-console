/** Swedish org. numbers: NNNNNN-NNNN with a Luhn check digit. The API
 * (validation.org_number / vat_number) applies the same rules. */

const digitsOf = (value: string) => value.replace(/\D/g, "").slice(0, 10);

/** '5566778899' -> '556677-8899' while typing; never more than 10 digits. */
export function formatOrgNumber(value: string): string {
  const d = digitsOf(value);
  return d.length > 6 ? `${d.slice(0, 6)}-${d.slice(6)}` : d;
}

export function luhnOk(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length - 1; i++) {
    const n = Number(digits[i]) * (i % 2 === 0 ? 2 : 1);
    total += n > 9 ? n - 9 : n;
  }
  return (10 - (total % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** Shown once all 10 digits are in; an incomplete number is left to the API. */
export function orgNumberProblem(value: string): string | undefined {
  const d = digitsOf(value);
  if (d.length === 10 && !luhnOk(d)) return "The last digit (check digit) doesn't match - look for a typo";
  return undefined;
}

/** SE + the 10 digits + 01, or "" until the org. number is complete. */
export function vatFromOrgNumber(value: string): string {
  const d = digitsOf(value);
  return d.length === 10 ? `SE${d}01` : "";
}
