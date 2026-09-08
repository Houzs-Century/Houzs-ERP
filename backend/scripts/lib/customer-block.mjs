/* customer-block — WHAT A DOCUMENT'S CUSTOMER BLOCK IS, and where each field of
 * it may legitimately come from. Stated ONCE so the probe that counts the gap
 * and the repair that closes it cannot answer differently.
 *
 * NO SHEBANG, ON PURPOSE (see lib/release-discipline.mjs for why an imported
 * .mjs must not carry one).
 *
 * PURE: text in, decisions out. No database, no filesystem, no process.exit.
 *
 * ── THE TWO RULES ───────────────────────────────────────────────────────────
 *
 * 1. A DELIVERY ORDER'S CUSTOMER BLOCK IS ITS SALES ORDER'S.
 *    `DO_CARRY` below is the field map, and it is a SUBSET of
 *    src/scm/lib/so-to-do-fields.ts's `soHeaderToDoSource` — the file that
 *    already owns "what an SO carries into a DO" for both live converters. This
 *    is deliberately narrower than that map: the contact and address block a
 *    driver needs, and nothing else. `venue` / `venue_id` are excluded even
 *    though the live converter carries them, because venue text is rewritten by
 *    a canonicalising trigger on write and a repair must not move a value it did
 *    not measure.
 *
 * 2. A CITY IS ONLY WRITTEN WHEN THE BOOK SAYS IT AND THE ADDRESS MASTER AGREES.
 *    AutoCount has NO city column. `InvAddr4` is the STATE — measured on the
 *    committed cut, its commonest values are Selangor (2,647), Penang (1,797),
 *    Johor (820) — so copying InvAddr4 into `city` would stamp a state name onto
 *    thousands of orders. The city, when the book has one at all, is the text
 *    AFTER the 5-digit postcode inside the address, and reading it is a
 *    DERIVATION, not a copy.
 *
 *    So the derivation is gated by the ERP's own address master
 *    (`scm.my_localities`, postcode -> city -> state, seeded by mig 0022): the
 *    book's own text is accepted ONLY when that table lists it as a city of that
 *    exact postcode, and what gets written is the master's canonical spelling.
 *    "KUALA LUMPUR." at 50000 is accepted and written "Kuala Lumpur"; "Selangor"
 *    at 40000 is REFUSED, because the master says 40000 is Shah Alam and the
 *    book wrote a state where a city goes. A postcode with no text after it is
 *    refused too — the book has no city and inventing one from the postcode
 *    alone is exactly what this gate exists to stop.
 *
 * WHY THE GATE IS NEEDED AT ALL — the bug it repairs.
 * import-ac-outstanding-so.mjs:308 already derives the city, then subtracts the
 * STATE name from it:
 *     city = after(postcode).split(",")[0].replace(new RegExp(cState), "")
 * On 9,697 book addresses that subtraction changes nothing and on 914 it
 * correctly trims a trailing state ("PADANG SERAI KEDAH" -> "PADANG SERAI").
 * On 1,935 it deletes the whole city, because the city and the state are the
 * same word — Kuala Lumpur, Melaka, Putrajaya, Penang — and on a handful it
 * leaves punctuation behind ("KUALA LUMPUR." -> ".").
 */

/** Trim to null. An all-whitespace value is absent, not present-and-empty. */
export const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Present? */
export const has = (v) => clean(v) !== null;

/**
 * A stored value that is really absent: blank, or nothing but punctuation.
 * `.` is what the state subtraction left behind on "KUALA LUMPUR." and it is
 * not a city.
 */
export const vacant = (v) => {
  const s = clean(v);
  return s === null || !/[A-Za-z0-9]/.test(s);
};

/** Compare two place names the way a human would: case and punctuation blind. */
export const sameName = (a, b) => {
  const k = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ka = k(a);
  return ka !== '' && ka === k(b);
};

/**
 * The delivery order's customer block, and the sales-order column that answers
 * each field. `[doColumn, soColumn]`, or `[doColumn, null, fn]` where the SO
 * needs assembling.
 *
 * address2: the SO has FOUR address lines and the DO has two, so lines 3 and 4
 * join into the second — the same fallback `soHeaderToDoSource` applies, kept
 * identical on purpose.
 */
export const DO_CARRY = [
  ['phone', (s) => s.phone],
  ['email', (s) => s.email],
  ['customer_type', (s) => s.customer_type],
  ['building_type', (s) => s.building_type],
  ['address1', (s) => s.address1],
  ['address2', (s) => clean(s.address2) ?? clean([s.address3, s.address4].filter(Boolean).join(', '))],
  ['city', (s) => s.city],
  ['state', (s) => s.customer_state],
  ['customer_state', (s) => s.customer_state],
  ['postcode', (s) => s.postcode],
  ['customer_country', (s) => s.customer_country],
  ['emergency_contact_name', (s) => s.emergency_contact_name],
  ['emergency_contact_phone', (s) => s.emergency_contact_phone],
  ['emergency_contact_relationship', (s) => s.emergency_contact_relationship],
];

/** The 5-digit postcode inside a joined address string, or null. */
export const postcodeOf = (addr) => {
  const m = /\b(\d{5})\b/.exec(String(addr ?? ''));
  return m ? m[1] : null;
};

/**
 * The book's own text where a city goes: everything after the 5-digit postcode
 * up to the first comma. NOT a city yet — `cityFromBook` decides that.
 */
export const cityTextOf = (addr) => {
  const s = String(addr ?? '');
  const pc = postcodeOf(s);
  if (!pc) return null;
  const raw = (s.slice(s.indexOf(pc) + 5).split(',')[0] ?? '').trim();
  return /[A-Za-z]/.test(raw) ? raw : null;
};

/**
 * The city for one book address, or null with the reason it was refused.
 *
 * @param addr    the book's InvAddr1..4 joined with ", "
 * @param cityOf  (postcode) => string[] — the address master's cities for that
 *                postcode, in its own canonical spelling
 * @returns {{ city: string|null, reason: string }}
 */
export function cityFromBook(addr, cityOf) {
  const pc = postcodeOf(addr);
  if (!pc) return { city: null, reason: 'no 5-digit postcode in the book address' };
  const text = cityTextOf(addr);
  if (!text) return { city: null, reason: 'the book writes nothing after the postcode' };
  const candidates = cityOf(pc) ?? [];
  if (candidates.length === 0) return { city: null, reason: `postcode ${pc} is not in the address master` };
  const hit = candidates.find((c) => sameName(c, text));
  if (hit) return { city: hit, reason: 'the book states it and the address master confirms it' };
  /* The book's text carries the city AND a trailing state on one line
     ("PADANG SERAI KEDAH"): accept a master city the text STARTS with, so the
     914 addresses shaped that way are not lost to a whole-string comparison. */
  const key = (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefixed = candidates.find((c) => key(c).length >= 4 && key(text).startsWith(key(c)));
  if (prefixed) return { city: prefixed, reason: 'the book states it with a trailing state; the address master confirms the city' };
  return { city: null, reason: `the book writes "${text}" where a city goes and the address master does not list it for ${pc}` };
}
