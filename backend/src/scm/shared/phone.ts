// Phone format helpers. Storage = E.164 ("+60116155633"),
// display = pretty Malaysian convention ("+60 11-6155 6133").
//
// Commander 2026-05-27 (Task #91): "电话format 要统一".
// Phones were previously stored / displayed inconsistently across the app —
// some "+601161556133" (E.164 no spaces), some "0123456789", some
// "+60 12-345 6789". This module is the SOLE source of truth for both
// directions of the conversion. UI inputs normalize on change, display
// callsites format on render, and the API normalizes defensively on
// POST/PATCH so the DB only ever holds the canonical E.164 form.
//
// Design constraint: no libphonenumber-js (200KB+). Pure regex + slice.
// Fallback: if the stored string doesn't match a recognised Malaysian
// pattern (e.g. legacy / international), we return it as-is rather than
// mangle it.

/** Strip every character except digits. `+` is reinjected after we decide
 *  whether the input had a country code. */
const onlyDigits = (s: string): string => s.replace(/\D+/g, '');

/**
 * BUG-114: "+60" glued onto a number that already carried it — "+60" +
 * "60192689927" = "6060192689927", or "+60" + "0192689927" = "600192689927"
 * (a pasted full number behind the +60 picker, or the pre-#4282 slip scan).
 * No Malaysian national number starts with 60 or the trunk 0, so both are
 * decidable: drop the extra 60s / 0s when what is left is a plausible
 * Malaysian national length (8-10 digits). Anything else is left as it was.
 */
export function collapseDoubledMalaysianPrefix(digits: string): string {
  if (!digits.startsWith('60')) return digits;
  const national = digits.slice(2);
  const stripped = national.replace(/^(?:60|0)+/, '');
  if (stripped === national || stripped.length < 8 || stripped.length > 10) return digits;
  return '60' + stripped;
}

/**
 * Normalize a user-typed phone string to E.164 storage form.
 *
 * Country handling:
 *  - If the user typed an explicit leading `+` (e.g. "+65 9123 4567" for
 *    Singapore, "+62 ..." for Indonesia), that country code is PRESERVED —
 *    we never force Malaysia onto an internationally-prefixed number.
 *  - Otherwise the input is treated as Malaysian local for the common case:
 *      · starts with `60` → kept
 *      · starts with `0`  → drop the 0, prepend `60`
 *      · 8+ bare digits   → prepend `60`
 *  - strips spaces, dashes, parens
 *  - returns `+<digits>` or null when input is empty / too short to be plausible
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const hadPlus = String(raw).trim().startsWith('+');
  const digits = onlyDigits(String(raw));
  if (digits.length === 0) return null;

  let normalized: string;
  if (hadPlus) {
    // Explicit international prefix — trust the user's country code and keep
    // the digits exactly as typed (Malaysia or otherwise).
    normalized = digits;
  } else if (digits.startsWith('60')) {
    normalized = digits;
  } else if (digits.startsWith('0')) {
    // Malaysian local form: drop the leading 0 and prepend 60.
    normalized = '60' + digits.slice(1);
  } else if (digits.length >= 8) {
    // Bare 8+ digits with no country code — assume Malaysia.
    normalized = '60' + digits;
  } else {
    // Too short to be a real phone number (likely mid-typing).
    return null;
  }

  normalized = collapseDoubledMalaysianPrefix(normalized);

  // After normalization we should have at least 7 total digits to be plausible.
  if (normalized.length < 7) return null;

  return '+' + normalized;
}

/**
 * Format a stored E.164 phone for display. Falls back to raw input
 * if not a recognised Malaysian pattern.
 *
 * Mobile (Malaysia): "+60 11-6155 6133" — country + space + first digit-block
 *                    after `60` (1–2 digits ending the carrier prefix `1X`) +
 *                    dash + 4-digit + space + 4-digit. 9–10 local digits.
 * Landline (Malaysia): "+60 3-1234 5678" — country + space + state code (1–2
 *                      digits) + dash + 4 + space + 4. 8–9 local digits.
 */
export function formatPhone(stored: string | null | undefined): string {
  if (stored == null) return '';
  const raw = String(stored).trim();
  if (raw === '') return '';

  const digits = onlyDigits(raw);
  if (digits.length === 0) return raw;

  // Only attempt the Malaysian formatter for +60 numbers. Anything else
  // (rare non-MY entries, half-typed input) gets returned untouched so we
  // don't garble it.
  if (!digits.startsWith('60')) return formatInternational(raw, digits);

  const local = digits.slice(2); // strip "60"

  // Mobile: starts with `1`, total local length 9 or 10.
  // E.g. "1161556133" (10) → "11-6155 6133"
  //      "161556133"  (9)  → "16-155 6133" — we still want the dash after the
  //      carrier digit-block. Malaysian mobile prefix is `1X` (`X` = digit),
  //      so for a 9-digit local we group "16-1556 133"? — actually Maxis-era
  //      9-digit numbers are formatted as `1X-XXX XXXX`: take the first 2
  //      after `60` as the prefix, then 3 + 4. For 10-digit (e.g. 11-xxxx-
  //      xxxx) it's `1X-XXXX XXXX`: prefix 2, then 4 + 4.
  if (local.startsWith('1')) {
    if (local.length === 10) {
      // 11-6155 6133 pattern
      const prefix = local.slice(0, 2);
      const mid = local.slice(2, 6);
      const tail = local.slice(6);
      return `+60 ${prefix}-${mid} ${tail}`;
    }
    if (local.length === 9) {
      // 16-155 6133 pattern (older 9-digit mobile)
      const prefix = local.slice(0, 2);
      const mid = local.slice(2, 5);
      const tail = local.slice(5);
      return `+60 ${prefix}-${mid} ${tail}`;
    }
    // Unrecognised mobile length — give up, return raw.
    return raw;
  }

  // Landline: starts with state digit `3` (KL/Selangor), `4` (Penang),
  // `7` (Johor), etc. Local digits 8 or 9 total.
  // E.g. "316155633" (9) → "3-1615 5633" — single state digit + 4 + 4
  //      "31234567" (8)  → "3-123 4567" — single state digit + 3 + 4
  if (local.length === 9) {
    const state = local.slice(0, 1);
    const mid = local.slice(1, 5);
    const tail = local.slice(5);
    return `+60 ${state}-${mid} ${tail}`;
  }
  if (local.length === 8) {
    const state = local.slice(0, 1);
    const mid = local.slice(1, 4);
    const tail = local.slice(4);
    return `+60 ${state}-${mid} ${tail}`;
  }

  // Anything else (too short / too long for MY) — leave alone.
  return raw;
}


/* ────────────────────────────────────────────────────────────────────────
   Country dial codes — for the country-selectable phone input. Malaysia is
   first so it is the default selection everywhere (Backend + POS). Curated
   list (no libphonenumber): ASEAN + the regions we actually trade with.
   ──────────────────────────────────────────────────────────────────────── */
export type CountryDial = { iso: string; name: string; dial: string; flag: string };

export const COUNTRY_DIAL_CODES: CountryDial[] = [
  { iso: 'MY', name: 'Malaysia',        dial: '60',  flag: '🇲🇾' }, // default
  { iso: 'SG', name: 'Singapore',       dial: '65',  flag: '🇸🇬' },
  { iso: 'ID', name: 'Indonesia',       dial: '62',  flag: '🇮🇩' },
  { iso: 'TH', name: 'Thailand',        dial: '66',  flag: '🇹🇭' },
  { iso: 'BN', name: 'Brunei',          dial: '673', flag: '🇧🇳' },
  { iso: 'VN', name: 'Vietnam',         dial: '84',  flag: '🇻🇳' },
  { iso: 'PH', name: 'Philippines',     dial: '63',  flag: '🇵🇭' },
  { iso: 'KH', name: 'Cambodia',        dial: '855', flag: '🇰🇭' },
  { iso: 'MM', name: 'Myanmar',         dial: '95',  flag: '🇲🇲' },
  { iso: 'LA', name: 'Laos',            dial: '856', flag: '🇱🇦' },
  { iso: 'CN', name: 'China',           dial: '86',  flag: '🇨🇳' },
  { iso: 'HK', name: 'Hong Kong',       dial: '852', flag: '🇭🇰' },
  { iso: 'TW', name: 'Taiwan',          dial: '886', flag: '🇹🇼' },
  { iso: 'IN', name: 'India',           dial: '91',  flag: '🇮🇳' },
  { iso: 'BD', name: 'Bangladesh',      dial: '880', flag: '🇧🇩' },
  { iso: 'PK', name: 'Pakistan',        dial: '92',  flag: '🇵🇰' },
  { iso: 'LK', name: 'Sri Lanka',       dial: '94',  flag: '🇱🇰' },
  { iso: 'AU', name: 'Australia',       dial: '61',  flag: '🇦🇺' },
  { iso: 'NZ', name: 'New Zealand',     dial: '64',  flag: '🇳🇿' },
  { iso: 'JP', name: 'Japan',           dial: '81',  flag: '🇯🇵' },
  { iso: 'KR', name: 'South Korea',     dial: '82',  flag: '🇰🇷' },
  { iso: 'AE', name: 'UAE',             dial: '971', flag: '🇦🇪' },
  { iso: 'SA', name: 'Saudi Arabia',    dial: '966', flag: '🇸🇦' },
  { iso: 'GB', name: 'United Kingdom',  dial: '44',  flag: '🇬🇧' },
  { iso: 'US', name: 'USA / Canada',    dial: '1',   flag: '🇺🇸' },
];

/** Default country dial code (Malaysia). */
export const DEFAULT_DIAL = '60';

// Longest dial codes first so prefix matching is greedy (e.g. 673 before 6, 65).
const DIALS_BY_LEN = [...COUNTRY_DIAL_CODES].sort((a, b) => b.dial.length - a.dial.length);

/**
 * Split a stored E.164 phone into its country dial code + national part, for
 * the country-selectable input. Empty / unparseable input defaults to Malaysia
 * with an empty national part. Matching is greedy on the longest known dial code.
 */
export function splitE164(stored: string | null | undefined): { dial: string; national: string } {
  const raw = String(stored ?? '');
  const digits = collapseDoubledMalaysianPrefix(onlyDigits(raw));
  if (digits.length === 0) return { dial: DEFAULT_DIAL, national: '' };
  // Country-code matching ONLY when the value carries an explicit international
  // `+` prefix. Without it the digits are a bare national number and the greedy
  // dial-code scan would mis-claim a Malaysian mobile as a foreign country —
  // most painfully "197770309" (a +60 number written without the country code,
  // per the OCR "+60 without the leading 0" rule) matching US +1 and showing
  // the selector as "us +1" on a Malaysian number (bug #1, 2026-06-24). A real
  // foreign number always reaches the UI in E.164 (+65…/+62…) so the `+` gate
  // never strips a legitimate country code.
  if (raw.trim().startsWith('+')) {
    for (const c of DIALS_BY_LEN) {
      if (digits.startsWith(c.dial)) return { dial: c.dial, national: digits.slice(c.dial.length) };
    }
  } else if (digits.startsWith('60')) {
    // Plus-less but explicitly Malaysian (e.g. "60197770309").
    return { dial: DEFAULT_DIAL, national: digits.slice(2) };
  }
  // No explicit country code and not 60-prefixed — assume a Malaysian national
  // number. Strip the local trunk prefix `0` when defaulting to +60: a slip /
  // OCR phone written "0197770309" is the Malaysian local form whose leading 0
  // is replaced by the +60 country code, so the national part is "197770309" →
  // displays "19-777 0309", never "0197770309" (request 2026-06-24).
  return { dial: DEFAULT_DIAL, national: digits.replace(/^0+/, '') };
}

/**
 * Combine a country dial code + national digits into E.164 storage form.
 * Returns '' when there is no national number (so an empty field clears cleanly).
 */
export function combineE164(dial: string, national: string): string {
  const raw = onlyDigits(String(national ?? ''));
  if (raw === '') return '';
  const d = onlyDigits(String(dial ?? '')) || DEFAULT_DIAL;
  // Defence-in-depth for the PhoneInput dedup (owner sighting 2026-07-22:
  // "+60601161556133"). splitE164 already applies the same strip on the
  // read path, and the input onChange strips it there — repeat here so a
  // caller that hand-composes a national from an unclean source can't
  // reintroduce the double-dial-code invariant that the DB has no defence
  // against once the number is stored.
  const n = raw.startsWith(d) ? raw.slice(d.length) : raw;
  return `+${collapseDoubledMalaysianPrefix(`${d}${n}`)}`;
}

/**
 * Validate that a phone is a usable Malaysian mobile (+60 1x ... where
 * total digits 11-12). Returns true / false.
 */
export function isValidMalaysianPhone(stored: string | null | undefined): boolean {
  if (stored == null) return false;
  const digits = onlyDigits(String(stored));
  if (digits.length < 11 || digits.length > 12) return false;
  if (!digits.startsWith('60')) return false;
  const local = digits.slice(2);
  if (!local.startsWith('1')) return false;
  return local.length === 9 || local.length === 10;
}

/**
 * Canonicalise a phone value that may NOT be a single number.
 *
 * normalizePhone strips every non-digit, which is correct for a field that
 * holds one number and catastrophic for one that does not. The company
 * branding phone is free text and has historically held a list
 * ("03-1234 5678 / 019-876 5432") or an extension — running normalizePhone
 * over that concatenates two numbers into one nonsense string, and that string
 * is printed on every invoice and delivery order.
 *
 * So this canonicalises only a value that is unambiguously ONE number, and
 * returns anything else untouched. Refusing is always safe: the worst case is
 * a value that keeps the format a human typed.
 */
export function canonicalizeSinglePhone(raw: string | null | undefined): string {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return '';
  // A separator that implies a LIST, or an extension marker. Either way this is
  // not one number and must not be collapsed into one.
  if (/[/,;&]|\bext\.?\b|\bx\d/i.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D+/g, '');
  // E.164 allows at most 15 digits; below 7 is not a phone. Outside that range
  // the value is something else (two numbers run together, an account number).
  if (digits.length < 7 || digits.length > 15) return trimmed;
  return normalizePhone(trimmed) ?? trimmed;
}

/* Readable grouping for a NON-Malaysian number.
 *
 * Before this existed, formatPhone returned any non-+60 value untouched, so a
 * Singapore customer's number printed on an invoice as the unbroken run
 * "+6561234567" while the Malaysian one beside it read "+60 12-345 6789".
 *
 * WHAT THIS IS NOT: locale-canonical formatting. Doing that properly needs
 * libphonenumber, which this module deliberately does not carry (200KB+, see
 * the header). So this splits the KNOWN dial code off — the same curated list
 * the country picker uses, matched longest-first so 673 wins over 6 — and
 * groups the national part for READABILITY:
 *
 *    8  digits -> 4 4      "+65 6123 4567"
 *    9  digits -> 3 3 3    "+66 812 345 678"
 *    10 digits -> 3 3 4    "+1 415 555 0123"
 *    11 digits -> 3 4 4    "+86 138 0013 8000"
 *    else      -> blocks of 4 from the RIGHT, first block takes the remainder
 *
 * Several of those match the local convention (SG, CN, ID, US); Thailand's
 * real grouping is 2-3-4, so "+66 812 345 678" is readable but not canonical.
 * That trade is deliberate and is why this is named "international" rather than
 * "format": it makes a foreign number legible without claiming to be correct
 * for 200 numbering plans.
 *
 * Unknown dial code, or a length too short to group, returns the input
 * untouched — never mangled.
 */
function formatInternational(raw: string, digits: string): string {
  const country = DIALS_BY_LEN.find((c) => digits.startsWith(c.dial));
  if (!country) return raw;
  const national = digits.slice(country.dial.length);
  if (national.length < 6) return raw;

  const groups: string[] = [];
  const push = (...sizes: number[]) => {
    let i = 0;
    for (const n of sizes) { groups.push(national.slice(i, i + n)); i += n; }
  };
  if (national.length === 8) push(4, 4);
  else if (national.length === 9) push(3, 3, 3);
  else if (national.length === 10) push(3, 3, 4);
  else if (national.length === 11) push(3, 4, 4);
  else {
    // Blocks of 4 from the right; whatever is left leads.
    let rest = national;
    const tail: string[] = [];
    while (rest.length > 4) { tail.unshift(rest.slice(-4)); rest = rest.slice(0, -4); }
    groups.push(rest, ...tail);
  }
  return `+${country.dial} ${groups.join(' ')}`;
}
