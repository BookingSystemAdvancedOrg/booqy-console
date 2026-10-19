/**
 * Phone numbers as people type them: "0723001573" shows as
 * "+46 72 300 15 73" right away and is sent as "+46723001573" (E.164, which
 * the API accepts). The same logic lives in admin-front-end and
 * customer-front-end (src/shared/phone.ts, tested there) - change all three
 * together.
 */

/** At most this many digits after +46 (Swedish national numbers). */
const SE_MAX = 9;
/** E.164 allows at most 15 digits in total. */
const E164_MAX = 15;

/**
 * What gets sent: "+46723001573", "" for an empty field, and "+" while a
 * foreign number has just been started. 07.../08... become +46, 00 becomes +.
 * Input starting with neither + nor 0 is left as typed (12345678 may be a
 * typo), so validation flags it.
 */
export function toE164(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const plus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!plus) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.startsWith("0")) digits = "46" + digits.slice(1);
    else return digits.slice(0, E164_MAX);
  }
  if (digits.startsWith("46")) {
    let national = digits.slice(2);
    if (national.startsWith("0")) national = national.slice(1); // +46 070... -> +46 70...
    digits = "46" + national.slice(0, SE_MAX);
  } else {
    digits = digits.slice(0, E164_MAX);
  }
  if (!digits) return plus ? "+" : "";
  return "+" + digits;
}

function groups(digits: string, sizes: number[]): string[] {
  const out: string[] = [];
  let rest = digits;
  for (const size of sizes) {
    if (!rest) break;
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Display: "+46 72 300 15 73" (mobile), "+46 8 123 45 67" / "+46 8 123 456 78"
 * (Stockholm), "+46 31 123 45 67" (other area codes). Foreign numbers get
 * the country code (guessed as two digits) and then groups of three.
 */
export function formatPhone(value: string): string {
  const e164 = toE164(value);
  if (!e164.startsWith("+") || e164.length <= 1) return e164;
  const digits = e164.slice(1);
  if (digits.startsWith("46")) {
    const national = digits.slice(2);
    const sizes = national.startsWith("8") ? (national.length === 9 ? [1, 3, 3, 2] : [1, 3, 2, 2]) : [2, 3, 2, 2];
    return ["+46", ...groups(national, sizes)].join(" ");
  }
  return ["+" + digits.slice(0, 2), ...groups(digits.slice(2), [3, 3, 3, 3])].join(" ");
}

/**
 * One edit in the field: the value to send, the new display and where the
 * caret goes. Deleting a space (backspace between two groups) removes the
 * digit before it instead - otherwise backspace would do nothing. The caret
 * lands before as many digits as were after it, so it stays put when the
 * groups shift.
 */
export function editPhone(previous: string, raw: string, caret: number): { value: string; display: string; caret: number } {
  let text = raw;
  let at = caret;
  const significant = (s: string) => s.replace(/[^\d+]/g, "");
  if (raw.length < previous.length && significant(raw) === significant(previous)) {
    const idx = raw.slice(0, caret).search(/\d(?=\D*$)/);
    if (idx >= 0) {
      text = raw.slice(0, idx) + raw.slice(idx + 1);
      at = idx;
    }
  }
  const after = (text.slice(at).match(/\d/g) ?? []).length;
  const value = toE164(text);
  const display = formatPhone(value);
  let pos = display.length;
  if (after > 0) {
    let seen = 0;
    for (let i = display.length - 1; i >= 0; i--) {
      if (/\d/.test(display[i]) && ++seen === after) {
        pos = i;
        break;
      }
    }
    if (seen < after) pos = 0;
  }
  return { value, display, caret: pos };
}
