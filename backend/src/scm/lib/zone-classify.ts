// ---------------------------------------------------------------------------
// zone-classify.ts — DETERMINISTIC Malaysian postcode -> delivery AREA ZONE.
// PURE, unit-tested. Fleet Module A1.
//
// The owner clusters same-region deliveries into 14 AREA ZONES. Which zone an
// order belongs to is derived from its Malaysian POSTCODE (deterministic — the
// first two digits pin the state/locality), NOT from the owner's hand-coloured
// sheet, which was proven noisy. A postcode maps to a zone through a company-
// editable map (scm.delivery_zone_postcodes, migration 0205); this module is the
// PURE derivation over that map, plus the DEFAULT Malaysian map the seed script
// installs (backend/scripts/seed-delivery-zones.mjs).
//
// Nothing here touches the DB or geocodes — the caller loads the map rows and
// passes them in, so the whole rule set is deterministic and testable. When an
// order has no parseable postcode the caller degrades to a geocode fallback
// (geocode.ts) or leaves the order UNZONED for the dispatcher, never guessing.
// ---------------------------------------------------------------------------

/** The 14 area zones the owner clusters deliveries into. Free-text on the wire
 *  (the map table stores a TEXT zone so the owner can add more), but a write is
 *  validated against this canonical set so a typo can't create a phantom zone. */
export const ZONES = [
  // Klang Valley (mix freely on one trip)
  'KL', 'PJ', 'KLANG', 'KAJANG', 'RAWANG', 'PUCHONG',
  // Southern corridor
  'NS', 'MELAKA', 'JOHOR',
  // Northern
  'PENANG', 'KEDAH', 'PERAK',
  // Outer
  'PAHANG', 'EAST',
] as const;

export type Zone = (typeof ZONES)[number];

export const ZONE_SET: ReadonlySet<string> = new Set(ZONES);

/** The Klang Valley zones — these MIX FREELY on one trip (owner rule). Every
 *  other zone runs DEDICATED trips (see capacity-pack.ts). */
export const KLANG_VALLEY_ZONES: readonly Zone[] = ['KL', 'PJ', 'KLANG', 'KAJANG', 'RAWANG', 'PUCHONG'];
const KV_SET: ReadonlySet<string> = new Set(KLANG_VALLEY_ZONES);

export function isKlangValleyZone(zone: string | null | undefined): boolean {
  return zone != null && KV_SET.has(zone);
}

/** One postcode-prefix -> zone rule. `prefixStart`..`prefixEnd` are the FIRST TWO
 *  digits of a Malaysian 5-digit postcode (00..99, inclusive). A single-prefix
 *  rule sets start === end (e.g. 68 = Ampang). */
export interface ZonePrefixRule {
  zone: string;
  prefixStart: number;
  prefixEnd: number;
}

/** The DEFAULT Malaysian postcode -> zone map, as DATA (not baked into SQL).
 *  Reused by the idempotent seed script AND as an in-code fallback when the
 *  company has not customised its map yet. The ranges are the deterministic
 *  first-two-digit rules from the module brief. PUCHONG is intentionally NOT in
 *  the default (Puchong postcodes sit inside the 47 = PJ range); the owner splits
 *  it out in the editor when they want Puchong as its own trip cluster. */
export const DEFAULT_ZONE_PREFIX_MAP: readonly ZonePrefixRule[] = [
  // Northern
  { zone: 'KEDAH', prefixStart: 5, prefixEnd: 9 },   // 05xxx–09xxx Kedah/Perlis
  { zone: 'PENANG', prefixStart: 10, prefixEnd: 14 }, // 10xxx–14xxx Pulau Pinang
  { zone: 'PERAK', prefixStart: 30, prefixEnd: 36 },  // 30xxx–36xxx Perak
  // East coast
  { zone: 'EAST', prefixStart: 15, prefixEnd: 24 },   // 15–18 Kelantan, 20–24 Terengganu
  { zone: 'PAHANG', prefixStart: 25, prefixEnd: 28 }, // 25xxx–28xxx Pahang
  { zone: 'PAHANG', prefixStart: 39, prefixEnd: 39 }, // 39xxx Cameron Highlands
  { zone: 'PAHANG', prefixStart: 49, prefixEnd: 49 }, // 49xxx Genting
  { zone: 'PAHANG', prefixStart: 69, prefixEnd: 69 }, // 69xxx Genting/Bentong fringe
  // Klang Valley
  { zone: 'PJ', prefixStart: 40, prefixEnd: 40 },     // 40xxx Shah Alam (Petaling district)
  { zone: 'KLANG', prefixStart: 41, prefixEnd: 42 },  // 41–42 Klang
  { zone: 'KAJANG', prefixStart: 43, prefixEnd: 43 }, // 43xxx Kajang/Semenyih
  { zone: 'PJ', prefixStart: 46, prefixEnd: 47 },     // 46–47 PJ / Subang / (Puchong lives here until split out)
  { zone: 'RAWANG', prefixStart: 48, prefixEnd: 48 }, // 48xxx Rawang
  { zone: 'KL', prefixStart: 50, prefixEnd: 60 },     // 50–60 Kuala Lumpur
  { zone: 'KL', prefixStart: 68, prefixEnd: 68 },     // 68xxx Ampang / Batu Caves
  // Southern
  { zone: 'NS', prefixStart: 70, prefixEnd: 73 },     // 70–73 Negeri Sembilan / Seremban
  { zone: 'MELAKA', prefixStart: 75, prefixEnd: 78 }, // 75–78 Melaka
  { zone: 'JOHOR', prefixStart: 79, prefixEnd: 86 },  // 79–86 Johor
];

/** Pull a 5-digit Malaysian postcode out of a free-text value or address. PURE.
 *  Returns the postcode string (5 digits) or null. Accepts a bare postcode, a
 *  postcode with surrounding text ("43000 Kajang, Selangor"), or null. */
export function parsePostcode(raw: string | null | undefined): string | null {
  const s = String(raw ?? '');
  // A Malaysian postcode is exactly 5 digits. Match a 5-digit run not glued to
  // more digits (so a phone number or a long id is not mistaken for one).
  const m = /(?<!\d)(\d{5})(?!\d)/.exec(s);
  return m ? m[1] : null;
}

/** The first-two-digit prefix (0..99) of a postcode, or null. PURE. */
export function postcodePrefix(postcode: string | null | undefined): number | null {
  const pc = parsePostcode(postcode) ?? (postcode && /^\d{5}$/.test(String(postcode).trim()) ? String(postcode).trim() : null);
  if (!pc) return null;
  return Number(pc.slice(0, 2));
}

/**
 * Resolve a postcode to a zone against a prefix map. PURE.
 *
 * When several rules match the same prefix the MOST SPECIFIC (narrowest range)
 * wins — so an owner-added single-prefix rule (e.g. 58 = PUCHONG carved out of
 * the 46–47 PJ block) overrides the broad default without the owner having to
 * delete the broad one. Ties break to the first rule in input order.
 *
 * Returns the zone string, or null when nothing matches (caller falls back).
 */
export function zoneForPostcode(
  postcode: string | null | undefined,
  map: readonly ZonePrefixRule[],
): string | null {
  const prefix = postcodePrefix(postcode);
  if (prefix == null || !Number.isFinite(prefix)) return null;
  let best: ZonePrefixRule | null = null;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (const rule of map) {
    if (prefix < rule.prefixStart || prefix > rule.prefixEnd) continue;
    const width = rule.prefixEnd - rule.prefixStart;
    if (width < bestWidth) {
      best = rule;
      bestWidth = width;
    }
  }
  return best ? best.zone : null;
}

export interface ZonedAddress {
  postcode?: string | null;
  address1?: string | null;
  address2?: string | null;
}

export interface ZoneResult {
  zone: string | null;
  /** How the zone was derived. 'none' => the dispatcher must place it (or the
   *  caller may geocode-fallback). */
  method: 'postcode' | 'none';
  /** The 5-digit postcode that was used (for display / debugging). */
  postcode: string | null;
}

/**
 * Derive an order's zone from its address parts against a prefix map. PURE.
 *
 * Tries the explicit postcode field first, then any 5-digit run inside the
 * address lines (POS free-text often carries the postcode only in the address).
 * No postcode => { zone: null, method: 'none' } and the caller decides (geocode
 * fallback or leave for the dispatcher). Never guesses a zone from a state name.
 */
export function zoneForAddress(
  parts: ZonedAddress,
  map: readonly ZonePrefixRule[],
): ZoneResult {
  const pc =
    parsePostcode(parts.postcode) ??
    parsePostcode(parts.address2) ??
    parsePostcode(parts.address1);
  if (!pc) return { zone: null, method: 'none', postcode: null };
  return { zone: zoneForPostcode(pc, map), method: 'postcode', postcode: pc };
}
