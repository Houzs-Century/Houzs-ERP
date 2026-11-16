import { computeTotalHeight } from '../shared/total-height';

export interface ScanVariantPools {
  sofaSizes: string[];
  sofaLegHeights: string[];
  legHeights: string[];
  divanHeights: string[];
  gaps: string[];
}

export interface ScanLineVariantInput {
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  noLeg: boolean;
  seatHeightInches: number | null;
  fabricMatch?: { code?: string | null } | null;
  specialsMatch?: Array<{ code: string }> | null;
}

/* The sofa Leg Height "Default" option (RM 0.00) from the maintenance
   sofaLegHeights pool, matched case-insensitively by name (owner 2026-07-13).
   Used to seed a drafted sofa line's Leg Height when the slip named no specific
   leg, so it is never an empty required field. null when the pool has none. */
const DEFAULT_SOFA_LEG_RE = /^\s*default\s*$/i;
function resolveDefaultSofaLeg(pools: ScanVariantPools): string | null {
  return pools.sofaLegHeights.find((v) => DEFAULT_SOFA_LEG_RE.test(v)) ?? null;
}

/* The pool's "No Leg" option, matched by NAME (same posture as
   resolveDefaultSofaLeg). The maintenance value is the words "No Leg", NOT a
   0" measurement — resolving it from the pool keeps a genuine no-leg read
   instead of inventing an option that was never configured. */
const NO_LEG_RE = /^\s*no\s*-?\s*leg\s*$/i;
function resolveNoLeg(pool: string[]): string | null {
  return pool.find((v) => NO_LEG_RE.test(v)) ?? null;
}

/* Snap an OCR-derived variant value to the live Maintenance pool.
   Owner rule (2026-07-16, the "8\" leg" report): the handwritten slip is a
   HINT, not authority. The OCR reads these axes as bare inch NUMBERS, so a
   misread (or a number belonging to another axis) trivially produces a value
   that was never configured — the reported draft carried legHeight 8" when the
   BEDFRAME Leg Heights pool only holds No Leg / 1" / 2" / 4" / 5" / 6" / 7".

   Returns the pool's CANONICAL value on a hit (trim + case-insensitive, so a
   pool value carrying data-entry whitespace still matches — same defensive
   posture as the specials gate in allowed-options-check), or null when the pool
   has no such option. null means the caller LEAVES THE AXIS UNSET so the
   operator picks it against the slip photo. Deliberately NO nearest-value
   coercion: silently rounding 8" to 7" would invent a price and a spec nobody
   wrote.

   An EMPTY pool means the config never configured that axis at all — not "allow
   anything". Return null there too, matching the "never invent" rule the SKU /
   fabric / specials matches already follow. */
function snapToMaintPool(value: string, pool: string[]): string | null {
  const v = value.trim();
  if (v === '' || pool.length === 0) return null;
  const exact = pool.find((o) => o.trim() === v);
  if (exact) return exact;
  const ci = pool.find((o) => o.trim().toLowerCase() === v.toLowerCase());
  return ci ?? null;
}

/* Snap an OCR inch NUMBER to its pool value. The pools are not spelled
   consistently — legHeights / divanHeights / gaps carry the inch mark (`4"`)
   while sofaSizes carries the bare number (`28`) — so try BOTH spellings and
   return whichever the pool actually holds. This is a spelling reconciliation,
   never a value change: only an exact member of the pool is ever returned, and
   a number the pool doesn't hold still yields null (axis left unset). */
function snapInchesToMaintPool(inches: number, pool: string[]): string | null {
  return snapToMaintPool(`${inches}"`, pool) ?? snapToMaintPool(`${inches}`, pool);
}

/* The variants blob of a drafted scan line. See buildDraftSoBodyFromSlip for the
   owner rules behind each axis; `category` is the matched SKU's lowercase
   category ('others' for an unmatched line). */
export function buildScanLineVariants(
  line: ScanLineVariantInput,
  category: string,
  hasSku: boolean,
  pools: ScanVariantPools,
): Record<string, unknown> {
  const variants: Record<string, unknown> = {};
  const cat = category;
  // The sofa leg picker renders sofaLegHeights while the bedframe one renders
  // legHeights, but BOTH write the same `legHeight` key (SoLineCard) — so the
  // pool is chosen by the line's category, not by the key.
  if (hasSku) {
    const legPool = cat === 'sofa' ? pools.sofaLegHeights : pools.legHeights;
    if (line.divanHeightInches != null) {
      const snapped = snapInchesToMaintPool(line.divanHeightInches, pools.divanHeights);
      if (snapped) variants.divanHeight = snapped;
    }
    if (line.noLeg) {
      // "No Leg" is a configured pool WORD, not a 0" measurement. The old
      // literal '0"' was itself an un-configured value on every pool.
      const noLeg = resolveNoLeg(legPool);
      if (noLeg) variants.legHeight = noLeg;
    } else if (line.legHeightInches != null) {
      const snapped = snapInchesToMaintPool(line.legHeightInches, legPool);
      if (snapped) variants.legHeight = snapped;
    }
    if (line.gapInches != null) {
      const snapped = snapInchesToMaintPool(line.gapInches, pools.gaps);
      if (snapped) variants.gap = snapped;
    }
  }
  if (cat === 'bedframe' || cat === 'sofa') {
    if (line.fabricMatch?.code) variants.fabricCode = line.fabricMatch.code;
    const specialCodes = (line.specialsMatch ?? []).map((s) => s.code).filter(Boolean);
    if (specialCodes.length > 0) variants.specials = specialCodes;
  }
  // The create core reprices itemGroup='sofa' from the seat height, so this OCR
  // figure MOVES the sofa price — an unconfigured read must never reach the
  // line. Snapping also fixes the SPELLING: sofaSizes is seeded as bare numbers.
  if (cat === 'sofa' && line.seatHeightInches != null) {
    const snapped = snapInchesToMaintPool(line.seatHeightInches, pools.sofaSizes);
    if (snapped) variants.seatHeight = snapped;
  }
  // Owner 2026-07-13: a sofa whose slip named no leg gets the standing
  // "Default" leg option so the drafted line is never an empty leg field.
  if (cat === 'sofa' && variants.legHeight == null) {
    const defLeg = resolveDefaultSofaLeg(pools);
    if (defLeg) variants.legHeight = defLeg;
  }
  // Bedframe Total Height (HC-0190): the editor derives it from divan + leg +
  // gap, so a scanned line carries it too and is priced with its surcharge at
  // create time. Empty (no axis set) and non-bedframe lines get no key.
  const totalHeight = computeTotalHeight(cat, variants);
  if (totalHeight) variants.totalHeight = totalHeight;
  return variants;
}
