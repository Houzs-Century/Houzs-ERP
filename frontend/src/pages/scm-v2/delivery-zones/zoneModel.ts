// Delivery Zones page logic, kept pure so it is tested. Mirrors the backend
// classifier (backend/src/scm/lib/zone-classify.ts zoneForPostcode + the route's
// toPrefixMap): the ACTIVE company rules are the map, the built-in default map
// applies only while no rule is active, and when ranges overlap the narrowest
// range wins (ties go to the earlier rule).

export type ZoneRange = { zone: string; prefixStart: number; prefixEnd: number };
export type RuleLike = ZoneRange & { id: string; isActive: boolean; label: string | null };

export const ZONE_NAME: Record<string, string> = {
  KL: 'Kuala Lumpur', PJ: 'Petaling Jaya', KLANG: 'Klang', KAJANG: 'Kajang', RAWANG: 'Rawang', PUCHONG: 'Puchong',
  NS: 'Negeri Sembilan', MELAKA: 'Melaka', JOHOR: 'Johor',
  PENANG: 'Penang', KEDAH: 'Kedah and Perlis', PERAK: 'Perak',
  PAHANG: 'Pahang', EAST: 'Kelantan and Terengganu',
  SABAH: 'Sabah', SARAWAK: 'Sarawak', LABUAN: 'Labuan',
};
export const zoneName = (zone: string): string => ZONE_NAME[zone] ?? zone;

/** Klang Valley zones share trips; every other zone runs its own trip. */
export const KLANG_VALLEY = ['KL', 'PJ', 'KLANG', 'KAJANG', 'RAWANG', 'PUCHONG'] as const;
export const isKlangValley = (zone: string) => (KLANG_VALLEY as readonly string[]).includes(zone);

/** East Malaysia: zones for the 3PL rate cards only, never planned on the own
 *  lorries (owner 2026-11-11; backend THREEPL_ONLY_ZONES). */
export const EAST_MALAYSIA_ZONES = ['SABAH', 'SARAWAK', 'LABUAN'] as const;
export const isThreePlOnly = (zone: string) => (EAST_MALAYSIA_ZONES as readonly string[]).includes(zone);

/** Tile background / text per zone: green for the Klang Valley, blue south,
 *  violet north, sand for the east coast and Pahang, rose for East Malaysia. */
const ZONE_COLOUR: Record<string, [string, string]> = {
  KL: ['#cfe6df', '#0b4740'], PJ: ['#d9ece6', '#0b4740'], KLANG: ['#e3f0eb', '#0b4740'], KAJANG: ['#c4dfd6', '#0b4740'],
  RAWANG: ['#e9f3ef', '#0b4740'], PUCHONG: ['#dbebe5', '#0b4740'],
  NS: ['#e0e9f2', '#1f4f75'], MELAKA: ['#d7e3ef', '#1f4f75'], JOHOR: ['#cddcea', '#1f4f75'],
  PENANG: ['#ebe4f1', '#4b2f6b'], KEDAH: ['#e5ddef', '#4b2f6b'], PERAK: ['#dfd5ea', '#4b2f6b'],
  PAHANG: ['#f3eadb', '#6b3f0e'], EAST: ['#f0e3cf', '#6b3f0e'],
  SABAH: ['#f3dfe2', '#7a2f3b'], SARAWAK: ['#efd6da', '#7a2f3b'], LABUAN: ['#f6e7e9', '#7a2f3b'],
};
export const zoneColour = (zone: string): [string, string] => ZONE_COLOUR[zone] ?? ['#eef0ec', '#414539'];

/** Outstation tiles laid out roughly as the peninsula sits (grid col / row). */
export const OUTSTATION_TILES: { zone: string; col: string; row: string }[] = [
  { zone: 'KEDAH', col: '2 / 4', row: '1 / 2' },
  { zone: 'PENANG', col: '1 / 2', row: '2 / 3' },
  { zone: 'EAST', col: '4 / 7', row: '1 / 3' },
  { zone: 'PERAK', col: '2 / 4', row: '2 / 4' },
  { zone: 'PAHANG', col: '4 / 7', row: '3 / 5' },
  { zone: 'NS', col: '3 / 5', row: '6 / 7' },
  { zone: 'MELAKA', col: '2 / 4', row: '7 / 8' },
  { zone: 'JOHOR', col: '4 / 7', row: '7 / 9' },
];

export const pad2 = (n: number) => String(n).padStart(2, '0');
/** "43000 – 43999" */
export const rangeText = (a: number, b: number) => `${pad2(a)}000 – ${pad2(b)}999`;
/** "43" or "46–47" */
export const prefixText = (a: number, b: number) => (a === b ? pad2(a) : `${pad2(a)}–${pad2(b)}`);

/** The map the classifier actually uses, and whether it is the built-in one. */
export function effectiveMap(rules: readonly RuleLike[], defaultMap: readonly ZoneRange[]): { map: ZoneRange[]; usingDefault: boolean } {
  const active = rules.filter((r) => r.isActive);
  if (active.length === 0) return { map: defaultMap.map((d) => ({ ...d })), usingDefault: true };
  return { map: active.map(({ zone, prefixStart, prefixEnd }) => ({ zone, prefixStart, prefixEnd })), usingDefault: false };
}

/** The winning range for a two-digit prefix: narrowest, ties to the earlier one. */
export function rangeForPrefix<T extends ZoneRange>(prefix: number, map: readonly T[]): T | null {
  let best: T | null = null;
  let width = Number.POSITIVE_INFINITY;
  for (const r of map) {
    if (prefix < r.prefixStart || prefix > r.prefixEnd) continue;
    const w = r.prefixEnd - r.prefixStart;
    if (w < width) { best = r; width = w; }
  }
  return best;
}

/** Zone per prefix 00..99 (null = no zone). */
export const zoneByPrefix = (map: readonly ZoneRange[]): (string | null)[] =>
  Array.from({ length: 100 }, (_, p) => rangeForPrefix(p, map)?.zone ?? null);

/** A full 5-digit postcode -> its prefix, or null while incomplete. */
export function postcodePrefix(text: string): number | null {
  const t = text.trim();
  return /^\d{5}$/.test(t) ? Number(t.slice(0, 2)) : null;
}

/** Consecutive prefixes that share a value, as [from, to, value] runs. */
export function runs<V>(values: readonly V[], keep: (v: V, i: number) => boolean): { from: number; to: number; value: V }[] {
  const out: { from: number; to: number; value: V }[] = [];
  values.forEach((v, i) => {
    if (!keep(v, i)) return;
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last && last.to === i - 1 && last.value === v) last.to = i;
    else out.push({ from: i, to: i, value: v });
  });
  return out;
}

/** Short summary for a zone tile: "46–47, 40" or "No postcodes". */
export function zoneSummary(zone: string, byPrefix: readonly (string | null)[]): string {
  const rs = runs(byPrefix, (v) => v === zone).map((r) => prefixText(r.from, r.to));
  if (rs.length === 0) return 'No postcodes';
  return rs.length > 2 ? `${rs.slice(0, 2).join(', ')} +${rs.length - 2}` : rs.join(', ');
}

export type RuleForm = { zone: string; from: string; to: string; label: string };
export type RuleFormResult =
  | { ok: true; value: { zone: string; prefixStart: number; prefixEnd: number; label: string | null } }
  | { ok: false; field: 'zone' | 'from' | 'to'; message: string };

/** Validate the drawer form. "Prefix to" blank means the same as "Prefix from". */
export function parseRuleForm(f: RuleForm): RuleFormResult {
  if (!f.zone.trim()) return { ok: false, field: 'zone', message: 'Choose a zone.' };
  const a = f.from.trim();
  const b = f.to.trim() === '' ? a : f.to.trim();
  if (!/^\d{1,2}$/.test(a)) return { ok: false, field: 'from', message: 'Prefix must be 0–99 (the first two digits of a postcode).' };
  if (!/^\d{1,2}$/.test(b)) return { ok: false, field: 'to', message: 'Prefix to must be 0–99.' };
  if (Number(b) < Number(a)) return { ok: false, field: 'to', message: 'Prefix to must be the same as or after Prefix from.' };
  return { ok: true, value: { zone: f.zone.trim().toUpperCase(), prefixStart: Number(a), prefixEnd: Number(b), label: f.label.trim() || null } };
}

export type CoverageChange = { from: number; to: number; before: string | null; after: string | null };

/** The rule list with `next` saved: an edit stays where the rule was (order
 *  breaks ties), a new rule goes last. */
export function withRule(rules: readonly RuleLike[], next: ZoneRange & { isActive: boolean }, editingId: string | null): RuleLike[] {
  const rec: RuleLike = { ...next, id: editingId ?? '__next__', label: null };
  return editingId && rules.some((r) => r.id === editingId) ? rules.map((r) => (r.id === editingId ? rec : r)) : [...rules, rec];
}

/**
 * What saving a rule would do to the live map: the prefix runs whose zone
 * changes. Includes the side effect of the first active rule switching the
 * built-in map off, which turns every other postcode into "no zone".
 */
export function coverageChanges(
  rules: readonly RuleLike[],
  defaultMap: readonly ZoneRange[],
  next: ZoneRange & { isActive: boolean },
  editingId: string | null,
): CoverageChange[] {
  const before = zoneByPrefix(effectiveMap(rules, defaultMap).map);
  const after = zoneByPrefix(effectiveMap(withRule(rules, next, editingId), defaultMap).map);
  const pairs = before.map((b, i) => `${b ?? ''}>${after[i] ?? ''}`);
  return runs(pairs, (_, i) => before[i] !== after[i]).map((r) => ({ from: r.from, to: r.to, before: before[r.from], after: after[r.from] }));
}

/** Prefixes of `next` where another active rule of the SAME width overlaps it
 *  with a different zone: the classifier then picks by row order, which the
 *  owner cannot see, so the page asks for a narrower range instead. */
export function tiedPrefixes(rules: readonly RuleLike[], next: ZoneRange, editingId: string | null): number[] {
  const width = next.prefixEnd - next.prefixStart;
  const out: number[] = [];
  for (let p = next.prefixStart; p <= next.prefixEnd; p += 1) {
    if (rules.some((r) => r.isActive && r.id !== editingId && r.zone !== next.zone
      && r.prefixEnd - r.prefixStart === width && p >= r.prefixStart && p <= r.prefixEnd)) out.push(p);
  }
  return out;
}
