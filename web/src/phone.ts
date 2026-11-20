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
 * (Stockholm), "+46 31 123 45 67" (other area codes). Foreign numbers: the
 * country code (1-3 digits) and the country's groups: "+358 75 9899 9876".
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
  return foreign(digits);
}

/** Two-digit country codes (ITU); 1 and 7 have one digit, all others three. */
const CC_TWO = new Set(
  ("20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 " +
    "60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98").split(" "),
);

function countryCodeLength(digits: string): number {
  if (digits[0] === "1" || digits[0] === "7") return 1;
  return CC_TWO.has(digits.slice(0, 2)) ? 2 : 3;
}

/** Groups of three, the last ones of four when that fits: 7 = 3 4, 8 = 4 4, 10 = 3 3 4. */
function chunks(n: number): number[] {
  if (n <= 4) return [n];
  if (n === 5) return [2, 3];
  const threes = (count: number) => Array.from({ length: count }, () => 3);
  if (n % 3 === 0) return threes(n / 3);
  if (n % 3 === 1) return [...threes((n - 4) / 3), 4];
  return [...threes((n - 8) / 3), 4, 4];
}

function foreign(digits: string): string {
  const cc = digits.slice(0, countryCodeLength(digits));
  const rest = digits.slice(cc.length);
  let sizes: number[];
  if (cc === "358") {
    // Area code: 9 (Helsinki) has one digit, the rest two (40, 50, 75 ...).
    const area = rest.startsWith("9") ? 1 : 2;
    sizes = [area, ...chunks(Math.max(rest.length - area, 1))];
  } else if (cc === "47") sizes = /^[49]/.test(rest) ? [3, 2, 3] : [2, 2, 2, 2];
  else if (cc === "45") sizes = [2, 2, 2, 2];
  else if (cc === "1") sizes = [3, 3, 4];
  else sizes = chunks(rest.length);
  return ["+" + cc, ...groups(rest, sizes)].join(" ");
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
