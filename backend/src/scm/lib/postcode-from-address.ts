// ---------------------------------------------------------------------------
// postcode-from-address.ts — find the postcode written inside an address and
// take its state / city from scm.my_localities.
//
// A supplier like HOOKKA MANUFACTURING keeps "..., 47000 SUNGAI BULOH." in the
// address text with the postcode / state columns empty, so every job built from
// it showed Postcode and State as a dash and could not be put in a region.
//
// A five-digit number counts only when my_localities knows it as a postcode (a
// lot number like "12345 Jalan ..." is not one), and two known candidates in one
// address is ambiguous, so nothing is filled. my_localities is a GLOBAL address
// master with no company_id, so its reads carry no company predicate.
// ---------------------------------------------------------------------------

import { chunkIn } from './paginate-all';

export interface LocalityParts {
  city: string | null;
  state: string | null;
}

export interface KnownPostcode {
  postcode: string;
  locality: LocalityParts;
}

const blank = (v: unknown): boolean => v == null || String(v).trim() === '';
const text = (v: unknown): string | null => (blank(v) ? null : String(v).trim());

/** Every distinct standalone five-digit number in the texts, in order. */
export function postcodeCandidates(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').match(/(?<!\d)\d{5}(?!\d)/g) ?? []) out.add(m);
  return [...out];
}

/** The one known postcode in the address, or null when there is none or more than one. */
export async function knownPostcodeInAddress(
  address: string | null,
  findLocality: (postcode: string) => Promise<LocalityParts | null>,
): Promise<KnownPostcode | null> {
  const known: KnownPostcode[] = [];
  for (const postcode of postcodeCandidates(address)) {
    const locality = await findLocality(postcode);
    if (locality) known.push({ postcode, locality });
  }
  return known.length === 1 ? known[0] : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped scm supabase client, as across scm/lib
type Sb = any;

/** One postcode's city + state. Fail-soft: unknown or a read error is null. */
export async function localityForPostcode(sb: Sb, postcode: string | null | undefined): Promise<LocalityParts | null> {
  const pc = (postcode ?? '').replace(/[^\d]/g, '');
  if (pc.length !== 5) return null;
  try {
    const { data, error } = await sb.from('my_localities').select('city, state').eq('postcode', pc).limit(1).maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    const city = text(row.city);
    const state = text(row.state);
    if (!city && !state) return null;
    return { city, state };
  } catch {
    return null;
  }
}

/**
 * Many postcodes at once (the board / day view read path). A postcode whose
 * rows disagree on the state keeps state null; one that spans several cities
 * keeps city null. Fail-soft: a read error yields an empty map, so the caller
 * shows the stored values instead of failing.
 */
export async function localitiesForPostcodes(sb: Sb, postcodes: readonly string[]): Promise<Map<string, LocalityParts>> {
  const out = new Map<string, LocalityParts>();
  const want = [...new Set(postcodes.filter((p) => /^\d{5}$/.test(p)))];
  if (want.length === 0) return out;
  try {
    const { data, error } = await chunkIn<Record<string, unknown>>(want, (batch, from, to) =>
      sb.from('my_localities').select('postcode, city, state').in('postcode', batch).order('postcode').range(from, to));
    if (error) return out;
    const seen = new Map<string, { cities: Set<string>; states: Set<string> }>();
    for (const r of data) {
      const pc = text(r.postcode);
      if (!pc) continue;
      const s = seen.get(pc) ?? { cities: new Set<string>(), states: new Set<string>() };
      const city = text(r.city); const state = text(r.state);
      if (city) s.cities.add(city);
      if (state) s.states.add(state);
      seen.set(pc, s);
    }
    for (const [pc, s] of seen) {
      out.set(pc, {
        city: s.cities.size === 1 ? [...s.cities][0] : null,
        state: s.states.size === 1 ? [...s.states][0] : null,
      });
    }
  } catch {
    return out;
  }
  return out;
}

export interface PostcodeFields {
  /** The address lines (and anything else the postcode may be written in). */
  lines: ReadonlyArray<string | null | undefined>;
  city: string | null | undefined;
  postcode: string | null | undefined;
  state: string | null | undefined;
}

export interface PostcodeFill {
  postcode: string | null;
  state: string | null;
  city: string | null;
}

/** The postcodes worth looking up for these fields: none when nothing is missing. */
export function postcodesToLookUp(f: PostcodeFields): string[] {
  if (!blank(f.postcode)) return blank(f.state) || blank(f.city) ? postcodeCandidates(f.postcode) : [];
  return postcodeCandidates(...f.lines, f.city);
}

/**
 * PURE. Fill an empty postcode from the one known postcode written in the
 * address, and an empty state / city from that postcode's locality. A value
 * already stored is never overwritten.
 */
export function fillPostcodeFields(f: PostcodeFields, known: ReadonlyMap<string, LocalityParts>): PostcodeFill {
  const cur: PostcodeFill = { postcode: text(f.postcode), state: text(f.state), city: text(f.city) };
  let postcode = cur.postcode;
  if (!postcode) {
    const hits = postcodeCandidates(...f.lines, f.city).filter((p) => known.has(p));
    if (hits.length !== 1) return cur;
    postcode = hits[0];
  }
  const loc = known.get(postcode.replace(/[^\d]/g, ''));
  return {
    postcode,
    state: cur.state ?? loc?.state ?? null,
    city: cur.city ?? loc?.city ?? null,
  };
}

/** The destination fields of a dp_orders row. */
export const dpDestFields = (r: Record<string, unknown>): PostcodeFields => ({
  lines: [r.address1, r.address2, r.address3, r.address4].map((v) => (v == null ? null : String(v))),
  city: r.city as string | null, postcode: r.postcode as string | null, state: r.state as string | null,
});

/** The TRANSFER origin ("from") fields of a dp_orders row. */
export const dpFromFields = (r: Record<string, unknown>): PostcodeFields => ({
  lines: [r.from_address1, r.from_address2].map((v) => (v == null ? null : String(v))),
  city: r.from_city as string | null, postcode: r.from_postcode as string | null, state: r.from_state as string | null,
});

/**
 * READ-TIME fallback for dp_orders rows that were saved before the postcode was
 * detected: fills postcode / state / city (and the from_* trio) on the rows in
 * place, from one batched my_localities read. Writes nothing to the database.
 */
export async function fillDpRowsPostcode(sb: Sb, rows: Array<Record<string, unknown>>): Promise<void> {
  const lookups = rows.flatMap((r) => [...postcodesToLookUp(dpDestFields(r)), ...postcodesToLookUp(dpFromFields(r))]);
  if (lookups.length === 0) return;
  const known = await localitiesForPostcodes(sb, lookups);
  if (known.size === 0) return;
  for (const r of rows) {
    const d = fillPostcodeFields(dpDestFields(r), known);
    r.postcode = d.postcode; r.state = d.state; r.city = d.city;
    if ('from_address1' in r) {
      const f = fillPostcodeFields(dpFromFields(r), known);
      r.from_postcode = f.postcode; r.from_state = f.state; r.from_city = f.city;
    }
  }
}
