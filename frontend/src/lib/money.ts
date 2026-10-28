/**
 * The ONE rule for turning what a human typed into a money amount.
 *
 * WHY THIS FILE EXISTS — `parseFloat(x) || 0` was the house rule for money
 * inputs, and it turns "I could not read that" into a confident RM 0.00.
 * HOOKKA hit the identical defect as BUG-2026-06-11-002. The triggers are not
 * typos, they are ordinary days:
 *
 *   - clearing a price to retype it and tabbing away    -> ""      -> 0
 *   - pasting "RM 1200" out of WhatsApp or Excel        -> NaN     -> 0
 *   - a full-width IME number ("１２００")               -> NaN     -> 0
 *   - "1,200" with a thousands comma                    -> 1       -> RM 1.00
 *
 * The last one is the dangerous one: RM 0.00 at least looks wrong on the
 * document. RM 1.00 looks like a price somebody meant.
 *
 * So this parser does two things `parseFloat` will not. It ACCEPTS what a
 * human plainly meant — a currency prefix, spaces, thousands commas, full-width
 * digits — and it REFUSES what is genuinely ambiguous instead of guessing. A
 * refusal is returned to the caller as a plain-language sentence to show the
 * user and BLOCK the save, never as a silent zero. Owner's ruling 2026-07-19:
 * 打错价钱肯定是要警告啊.
 *
 * Money is INTEGER SEN throughout — the digits are assembled with integer
 * arithmetic and never multiplied by 100 as a float, because 19.99 * 100 is
 * 1998.9999999999998 and Math.round only hides that for the values people
 * happen to test.
 *
 * EMPTY IS NOT INVALID. A blank optional field means "nothing entered", which
 * several callers legitimately treat as "skip this row". It is reported as
 * `empty: true` with sen 0 so the caller decides, rather than being conflated
 * with unreadable input the way `|| 0` conflated both.
 */

export type MoneyParseOk = {
  ok: true;
  /** Integer sen. 0 when `empty`. */
  sen: number;
  /** True when the field was blank — "nothing entered", not "unreadable". */
  empty: boolean;
};

export type MoneyParseFail = {
  ok: false;
  /** One plain-language sentence, ready to show the user. No codes, no jargon. */
  message: string;
};

export type MoneyParseResult = MoneyParseOk | MoneyParseFail;

/** Largest amount we will accept: RM 9,999,999,999.99. Well inside integer
 *  precision once expressed in sen, and far above any real furniture order —
 *  a value past this is a mis-paste, not a price. */
const MAX_SEN = 999_999_999_999;

/**
 * Normalise the characters a human (or their keyboard) may have produced into
 * plain ASCII. Full-width digits and punctuation come from IME input; the
 * non-breaking space comes from copy-paste out of Excel and web pages.
 */
function normaliseDigits(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xff10 && code <= 0xff19) out += String.fromCharCode(code - 0xff10 + 0x30); // ０-９
    else if (code === 0xff0e) out += '.'; // ．
    else if (code === 0xff0c) out += ','; // ，
    else if (code === 0xff0b) out += '+'; // ＋
    else if (code === 0xff0d || code === 0x2212) out += '-'; // －, −
    else if (code === 0x00a0 || code === 0x202f || code === 0x2007) out += ' '; // NBSP family
    else out += ch;
  }
  return out;
}

/**
 * Parse a decimal the user typed into an integer scaled by 10^`decimals`.
 *
 * This is the shared core: money is this with `decimals: 2`, and quantities are
 * this with a wider allowance. Both need the same acceptance and — more
 * importantly — the same refusals, which is the whole reason they are not two
 * functions that will drift.
 */
export function parseScaledDecimal(
  raw: unknown,
  opts: { decimals: number; allowNegative?: boolean; label?: string },
): MoneyParseResult {
  const { decimals, allowNegative = true } = opts;
  const label = opts.label ?? 'That amount';

  if (raw == null) return { ok: true, sen: 0, empty: true };

  /* A number that arrived already parsed (a default, a server value) is trusted
     only if it is finite. NaN/Infinity reaching here means an earlier `|| 0`
     site upstream, and passing it through would launder exactly the bug this
     file exists to stop. */
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { ok: false, message: `${label} isn't a number we can read. Please type it again.` };
    }
    raw = raw.toString();
  }

  if (typeof raw !== 'string') {
    return { ok: false, message: `${label} isn't a number we can read. Please type it again.` };
  }

  const original = raw.trim();
  if (original === '') return { ok: true, sen: 0, empty: true };

  // Accept what a human plainly meant: currency prefix, stray spaces.
  let s = normaliseDigits(original).trim();
  s = s.replace(/^(rm|myr|\$)\s*/i, '').trim();

  // Sign, if any, before we look at the digits.
  let negative = false;
  if (s.startsWith('-')) { negative = true; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) { s = s.slice(1).trim(); }

  // Internal spaces are never meaningful in an amount ("1 200" is a paste).
  s = s.replace(/\s+/g, '');
  if (s === '') return { ok: false, message: `${label} looks incomplete. Please type the number again.` };

  /* Thousands separators are accepted ONLY in a shape that is unambiguously
     grouping: 1,200 / 12,345,678. "1,20" is refused rather than quietly read as
     120, because in a decimal-comma locale it means 1.20 and we cannot know
     which the person meant. Guessing here is how "1,200" became RM 1.00. */
  const [intPartRaw, ...restParts] = s.split('.');
  if (restParts.length > 1) {
    return { ok: false, message: `${label} has more than one decimal point, so we can't tell what it should be. Please type it again.` };
  }
  const fracPartRaw = restParts[0] ?? '';

  let intPart = intPartRaw;
  if (intPart.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+$/.test(intPart)) {
      return { ok: false, message: `${label} has commas in a place we can't read. Please type it without commas, for example 1200.50.` };
    }
    intPart = intPart.replace(/,/g, '');
  }
  if (fracPartRaw.includes(',')) {
    return { ok: false, message: `${label} has a comma after the decimal point, so we can't tell what it should be. Please type it again.` };
  }

  if (intPart === '' && fracPartRaw === '') {
    return { ok: false, message: `${label} looks incomplete. Please type the number again.` };
  }
  if (intPart !== '' && !/^\d+$/.test(intPart)) {
    return { ok: false, message: `${label} isn't a number we can read. Please type digits only, for example 1200.50.` };
  }
  if (fracPartRaw !== '' && !/^\d+$/.test(fracPartRaw)) {
    return { ok: false, message: `${label} isn't a number we can read. Please type digits only, for example 1200.50.` };
  }

  /* Refused, not rounded. Silently turning 1.005 into RM 1.01 (or 1.00) is a
     small lie told with confidence, and the person who typed it is the only one
     who knows which they meant. */
  if (fracPartRaw.length > decimals) {
    return {
      ok: false,
      message: decimals === 2
        ? `${label} has too many decimal places. Money goes to 2 decimals, for example 1200.50.`
        : `${label} has too many decimal places. Please use at most ${decimals}.`,
    };
  }

  if (negative && !allowNegative) {
    return { ok: false, message: `${label} can't be negative. Please enter a positive amount.` };
  }

  // Integer assembly — never a float multiply. "12.3" with decimals 2 becomes
  // 12 * 100 + 30.
  const frac = fracPartRaw.padEnd(decimals, '0');
  const scale = 10 ** decimals;
  const whole = intPart === '' ? 0 : Number(intPart);
  const fracValue = frac === '' ? 0 : Number(frac);
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fracValue)) {
    return { ok: false, message: `${label} is larger than we can handle. Please check the figure.` };
  }
  let value = whole * scale + fracValue;
  if (!Number.isSafeInteger(value) || value > MAX_SEN) {
    return { ok: false, message: `${label} is larger than we can handle. Please check the figure.` };
  }
  if (negative) value = -value;

  return { ok: true, sen: value, empty: false };
}

/**
 * Parse a money field into INTEGER SEN. The single entry point every money
 * input should use.
 *
 * @param label how to name this field back to the user, e.g. `Unit price on line 2`.
 */
export function parseMoneyToSen(
  raw: unknown,
  label?: string,
  opts?: { allowNegative?: boolean },
): MoneyParseResult {
  return parseScaledDecimal(raw, { decimals: 2, allowNegative: opts?.allowNegative ?? false, label });
}

/**
 * Parse a quantity. Same acceptance and same refusals as money — a quantity
 * that silently reads as 0 zeroes the line amount just as surely as a bad
 * price does, which is why it shares the core rather than keeping its own
 * `parseFloat(x) || 0`.
 */
export function parseQuantity(raw: unknown, label?: string): MoneyParseResult {
  return parseScaledDecimal(raw, { decimals: 3, allowNegative: false, label: label ?? 'That quantity' });
}

/** Integer sen -> the RM number an API payload expects. Exact for any value
 *  this parser can produce (at most 2 decimals, within safe-integer range). */
export function senToRm(sen: number): number {
  return sen / 100;
}

/** Quantity scaled by 1000 (what `parseQuantity` returns) -> a plain number. */
export function scaledToQuantity(scaled: number): number {
  return scaled / 1000;
}
