
/** The 14 area zones the owner clusters deliveries into, and East Malaysia
 *  (owner 2026-11-11: the 3PL rate cards use these zones, 做) — priced on the
 *  carriers' cards, never planned on the own lorries (THREEPL_ONLY_ZONES).
 *  Free-text on the wire (the map table stores a TEXT zone so the owner can add
 *  more), but a write is validated against this canonical set so a typo can't
 *  create a phantom zone. */
export const ZONES = [
  'KL', 'PJ', 'KLANG', 'KAJANG', 'RAWANG', 'PUCHONG',
  'NS', 'MELAKA', 'JOHOR',
  'PENANG', 'KEDAH', 'PERAK',
  'PAHANG', 'EAST',
  'SABAH', 'SARAWAK', 'LABUAN',
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

/** East Malaysia: a 3PL carries it, priced on its rate card by these zones. The
 *  auto-propose never packs these orders onto the own lorries; it leaves them
 *  for the dispatcher, as it did when they had no zone. */
export const THREEPL_ONLY_ZONES: readonly Zone[] = ['SABAH', 'SARAWAK', 'LABUAN'];
const THREEPL_ONLY_SET: ReadonlySet<string> = new Set(THREEPL_ONLY_ZONES);

export function isThreePlOnlyZone(zone: string | null | undefined): boolean {
  return zone != null && THREEPL_ONLY_SET.has(zone);
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
  { zone: 'KEDAH', prefixStart: 1, prefixEnd: 2 },
  { zone: 'KEDAH', prefixStart: 5, prefixEnd: 9 },
  { zone: 'PENANG', prefixStart: 10, prefixEnd: 14 },
  { zone: 'PERAK', prefixStart: 30, prefixEnd: 36 },
  { zone: 'EAST', prefixStart: 15, prefixEnd: 24 },
  { zone: 'PAHANG', prefixStart: 25, prefixEnd: 28 },
  { zone: 'PAHANG', prefixStart: 39, prefixEnd: 39 },
  { zone: 'PAHANG', prefixStart: 49, prefixEnd: 49 },
  { zone: 'PAHANG', prefixStart: 69, prefixEnd: 69 },
  { zone: 'PJ', prefixStart: 40, prefixEnd: 40 },
  { zone: 'KLANG', prefixStart: 41, prefixEnd: 42 },
  { zone: 'KAJANG', prefixStart: 43, prefixEnd: 43 },
  { zone: 'KLANG', prefixStart: 45, prefixEnd: 45 },
  { zone: 'KAJANG', prefixStart: 64, prefixEnd: 64 },
  { zone: 'PJ', prefixStart: 46, prefixEnd: 47 },
  { zone: 'RAWANG', prefixStart: 48, prefixEnd: 48 },
  { zone: 'KL', prefixStart: 50, prefixEnd: 60 },
  { zone: 'KL', prefixStart: 68, prefixEnd: 68 },
  { zone: 'NS', prefixStart: 70, prefixEnd: 73 },
  { zone: 'MELAKA', prefixStart: 75, prefixEnd: 78 },
  { zone: 'JOHOR', prefixStart: 79, prefixEnd: 86 },
  { zone: 'LABUAN', prefixStart: 87, prefixEnd: 87 },
  { zone: 'SABAH', prefixStart: 88, prefixEnd: 91 },
  { zone: 'SARAWAK', prefixStart: 93, prefixEnd: 98 },
];

/** Pull a 5-digit Malaysian postcode out of a free-text value or address. PURE.
 *  Returns the postcode string (5 digits) or null. Accepts a bare postcode, a
 *  postcode with surrounding text ("43000 Kajang, Selangor"), or null. */
export function parsePostcode(raw: string | null | undefined): string | null {
  const s = String(raw ?? '');
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
  method: 'postcode' | 'none';
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

/** The range a rule ends up with after a PATCH that may send only one end; the
 *  other end comes from the stored row. Null when start would pass end (the
 *  table CHECK would otherwise turn that into a 500). PURE. */
export function patchedPrefixRange(
  stored: { prefixStart: number; prefixEnd: number },
  patch: { prefixStart?: number; prefixEnd?: number },
): { prefixStart: number; prefixEnd: number } | null {
  const prefixStart = patch.prefixStart ?? stored.prefixStart;
  const prefixEnd = patch.prefixEnd ?? stored.prefixEnd;
  return prefixStart <= prefixEnd ? { prefixStart, prefixEnd } : null;
}
