// Folding an address into two lines + Postcode / City / State (owner
// 2026-11-18: every address form shows Address line 1, Address line 2, then
// Postcode / City / State). Pure: the decision for ONE row.
// backend/scripts/fold-address-lines.mjs reads the rows and writes.
//
// LINES 3 / 4. Their text is split at commas into parts. A part is
//   - a POSTCODE + TOWN ("11900 Bayan Lepas") when the postcode is in
//     my_localities and the town is one of that postcode's cities (or a state);
//   - a STATE ("Penang") when canonicalizeMyState names one of the 16;
//   - a CITY ("Bayan Lepas") when my_localities knows the name;
//   - otherwise FREE TEXT.
// Postcode / city / state found that way fill the record's own fields ONLY when
// those are empty; one that disagrees with a filled field is a CONFLICT and the
// whole row is left alone for a person. A part that only repeats the record's
// own fields is dropped (it is already said there). Free text is appended to
// line 2 (", " joined) so nothing is lost; then lines 3 / 4 are cleared.
//
// A STREET IN THE STATE FIELD (production, suppliers: "1831-B JALAN KPB1,
// KAWASAN PERIN..."). A State that is not one of the 16 Malaysian states and
// carries a digit or a comma is address text, not a state — a foreign state
// ("Guangdong") has neither and is left alone. The text moves into the address
// lines (line 1 when empty, else appended to line 2) unless the lines already
// hold it, and the State is cleared.
//
// THEN, an empty City / State is filled from the postcode by the SAME rule
// complete-postcode-fields.mjs uses (postcode-completion.mjs planSide: only
// empty fields, one state, one city, else left empty).
//
// `maxLine` (40 for a sales order, whose lines are the account book's 40-char
// columns) refuses a row whose line 1 / 2 would grow past it: that order's
// 3 / 4 are the save fit's spill of a long street, the form already shows them
// in line 2, and folding them would only be re-spilled on the next save.
import { canonicalizeMyState, isCanonicalMyState } from '../../src/scm/lib/canonical-state.ts';
import { repeatsTown } from '../../src/scm/shared/address-two-lines.ts';
import { completionIndex, planSide, stateKey } from './postcode-completion.mjs';

const tidy = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const key = (s) => tidy(s).toLowerCase();
const flat = (s) => key(s).replace(/[^a-z0-9]+/g, '');

/** my_localities rows -> the lookups the fold needs. */
export function indexLocalities(rows) {
  const idx = completionIndex(rows);
  const byCity = new Map();
  for (const r of rows) {
    const city = tidy(r.city);
    if (city && !byCity.has(key(city))) byCity.set(key(city), city);
  }
  return { idx, byCity };
}

const asState = (s) => {
  const c = canonicalizeMyState(tidy(s));
  return isCanonicalMyState(c) ? c : null;
};

/** A State value that is really address text: not a Malaysian state, and a digit or a comma in it. */
export const isStreetInState = (s) => tidy(s) !== '' && asState(s) == null && /[0-9,]/.test(tidy(s));

/** One part of line 3 / 4 -> what it says. */
export function readPart(part, loc) {
  const bare = part.match(/^(\d{5})$/);
  if (bare && loc.idx.has(bare[1])) return { postcode: bare[1] };
  const m = part.match(/^(\d{5})\s+(.+)$/) ?? part.match(/^(.+?)\s+(\d{5})$/);
  if (m) {
    const [postcode, rest] = /^\d{5}$/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    const at = loc.idx.get(postcode);
    if (at) {
      const city = at.cities.find((c) => key(c) === key(rest));
      if (city) return { postcode, city };
      const state = asState(rest);
      if (state) return { postcode, state };
    }
    return { free: part };
  }
  const state = asState(part);
  if (state) return { state };
  const city = loc.byCity.get(key(part));
  if (city) return { city };
  return { free: part };
}

const same = (field, a, b) => (field === 'state' ? stateKey(a) === stateKey(b) : key(a) === key(b));
const TOWN = ['postcode', 'city', 'state'];

/**
 * The decision for one row.
 *
 * @param row  { line1, line2, line3, line4, postcode, city, state, haystack? } (strings or null);
 *             `haystack`: other text the address already lives in (a supplier's
 *             billing `address`), checked before a street is moved out of State
 * @param loc  indexLocalities(my_localities rows)
 * @param maxLine  40 for a table whose lines are account-book columns, else null
 * @returns { action: 'none' | 'fold' | 'conflict' | 'too_long', next?, changed: string[], notes: string[], why: string | null }
 *          next = { line1, line2, line3, line4, postcode, city, state } when action is 'fold';
 *          `changed` names the fields to write (line1..line4, postcode, city, state)
 */
export function foldAddressRow(row, loc, maxLine) {
  const notes = [];
  const out = { postcode: tidy(row.postcode) || null, city: tidy(row.city) || null, state: tidy(row.state) || null };
  let line1 = tidy(row.line1) || null;
  const extraLine2 = [];
  let streetMoved = false;

  /* 1. A street stored in the State field. */
  if (isStreetInState(out.state)) {
    const street = out.state;
    const said = flat([row.line1, row.line2, row.line3, row.line4, row.haystack].map(tidy).join(' '));
    if (!said.includes(flat(street))) {
      if (!line1) line1 = street;
      else extraLine2.push(street);
      notes.push('street text moved from State into the address lines');
    } else {
      notes.push('street text in State already in the address lines; State cleared');
    }
    out.state = null;
    streetMoved = true;
  }

  /* 2. Lines 3 / 4. */
  const parts = [row.line3, row.line4].flatMap((l) => tidy(l).split(',')).map(tidy).filter((p) => p !== '');
  const found = { postcode: null, city: null, state: null };
  for (const part of parts) {
    if (repeatsTown(part, out)) continue;
    const said = readPart(part, loc);
    if (said.free) { extraLine2.push(said.free); continue; }
    for (const field of TOWN) {
      const v = said[field];
      if (!v) continue;
      if (found[field] && !same(field, found[field], v)) {
        return { action: 'conflict', changed: [], notes, why: `lines 3 / 4 name two different ${field} values` };
      }
      found[field] = v;
    }
  }
  for (const field of TOWN) {
    const v = found[field];
    if (!v) continue;
    if (out[field] == null) { out[field] = v; continue; }
    if (!same(field, out[field], v)) {
      return { action: 'conflict', changed: [], notes, why: `line 3 / 4 ${field} differs from the record's ${field}` };
    }
  }
  if (found.city && out.postcode && loc.idx.has(out.postcode)
      && !loc.idx.get(out.postcode).cities.some((c) => key(c) === key(out.city))) {
    return { action: 'conflict', changed: [], notes, why: 'line 3 / 4 city is not a city of the record\'s postcode' };
  }

  /* 3. Empty City / State from the postcode (the completion rule). */
  const filled = planSide({ side: 'main', postcode: 'postcode', city: 'city', states: ['state'], lines: [], detect: false },
    { postcode: out.postcode, city: out.city, state: out.state }, loc.idx);
  if (filled.flags.length) {
    return { action: 'conflict', changed: [], notes, why: filled.flags.map((f) => f.code).join('; ') };
  }
  Object.assign(out, filled.changes);
  if (streetMoved && !out.state) notes.push('State left empty: the postcode does not name one state');

  const line2 = [tidy(row.line2), ...extraLine2].filter((p) => p !== '').join(', ') || null;
  if (maxLine != null && ((extraLine2.length > 0 && (line2 ?? '').length > maxLine)
      || (line1 !== (tidy(row.line1) || null) && (line1 ?? '').length > maxLine))) {
    return { action: 'too_long', changed: [], notes, why: `the address lines would be over ${maxLine} characters` };
  }

  const next = { line1, line2, line3: null, line4: null, ...out };
  const before = { line1: row.line1, line2: row.line2, line3: row.line3, line4: row.line4, postcode: row.postcode, city: row.city, state: row.state };
  const changed = Object.keys(next).filter((f) => {
    const was = before[f] == null ? null : String(before[f]);
    const now = next[f];
    if (f === 'line3' || f === 'line4') return was != null;
    if (f === 'line1' || f === 'line2') return extraLine2.length > 0 || streetMoved ? tidy(was) !== tidy(now) : false;
    if (f === 'state' && streetMoved) return true;
    return tidy(was) === '' && tidy(now) !== '';
  });
  if (changed.length === 0) return { action: 'none', changed: [], notes, why: null };
  return { action: 'fold', changed, notes, why: null, next };
}
