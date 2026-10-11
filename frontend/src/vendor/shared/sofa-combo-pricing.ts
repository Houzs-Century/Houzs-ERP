// ----------------------------------------------------------------------------
// sofa-combo-pricing — pure lookup function for Sofa Combo Pricing.
//
// Given a SO/POS line about to be priced — (baseModel, modules array,
// customerId, fabricTier, height) — pick the best-matching combo row from
// a pre-fetched list and return the height-tier price, or null when no
// combo applies (caller should fall through to per-Model compartment
// pricing).
//
// OR-set per slot + SUBSET coverage (Commander 2026-05-28, Hookka-style 1:1):
// A combo is an ORDERED list of SLOTS; each SLOT is a SET of alternative
// module codes joined by OR. e.g. combo "2+L" =
//   [ ['2A(LHF)','2A(RHF)'], ['L(LHF)','L(RHF)'] ]
// A built sofa MATCHES the combo iff every SLOT can be COVERED by a DISTINCT
// built module whose code is in that slot's OR-set (one built module consumed
// per slot). The built module count may EXCEED the slot count — extra modules
// beyond the matched subset are allowed and stay at full master price; they
// do NOT get folded into the combo. This mirrors HOOKKA's `findComboSubset`
// (src/pages/sales/create.tsx ~L1296): greedy first-match per slot, extras
// ride at à-la-carte. Order-independent: matching ignores layout order.
//
// Pricing application (HOOKKA parity): the matched SUBSET's à-la-carte sum
// (subsetSum) is compared to the combo's pricesByHeight[height] (comboTotal);
// the combo price replaces the subset's à-la-carte ONLY when it is strictly
// cheaper (subsetSum − comboTotal > 0). Extras always price at full. The
// caller owns the à-la-carte numbers, so the cheaper-guard lives caller-side
// (groupPrice); this module returns the matched subset + comboTotal.
//
// Scope precedence (high → low):
//   1. customer-specific row matching (baseModel, slot-set, tier)
//   2. customer = null row matching the same
// Within a scope, the row with the LATEST effective_from on/before today
// wins; equal effective_from falls to newest created_at, then id (both
// descending) so duplicates resolve identically everywhere.
// Soft-deleted rows (deleted_at != null) never match.
//
// Tier match: row.tier === null matches any input tier (commander rarely
// uses this — most combos are tier-specific).
// ----------------------------------------------------------------------------

import { todayMY } from './format';

export type SofaPriceTier = 'PRICE_1' | 'PRICE_2' | 'PRICE_3';

/** A combo's ordered slots. Each slot is an OR-set of module codes. */
export type ComboSlots = string[][];

export interface SofaComboRow {
  id: string;
  baseModel: string;
  /** Ordered slots; each slot = OR-set of alternative module codes. */
  modules: ComboSlots;
  tier: SofaPriceTier | null;
  customerId: string | null;
  pricesByHeight: Record<string, number | null>;
  /** PWP (换购) selling price per height (Phase 2). When a build matches this
   *  combo AND the line redeems a valid PWP code, the engine charges this
   *  instead of `pricesByHeight`. Optional: only the selling path carries it. */
  pwpPricesByHeight?: Record<string, number | null>;
  label?: string | null;
  effectiveFrom: string;        // ISO date 'YYYY-MM-DD'
  /** Row creation timestamp (ISO). Tie-break when two rows share the same
   *  scope AND effectiveFrom: the newest row wins — the same rule the admin
   *  list (GET /sofa-combos) uses to decide which duplicate it displays, so
   *  the engine always charges the price the admin sees. Optional: legacy
   *  snapshots without it lose ties to rows that carry one. */
  createdAt?: string;
  deletedAt?: string | null;
  /** Default Free Gift (migration 0170, D9) — raw jsonb [{giftProductId, qty,
   *  campaignName?}]. When a cart's sofa build matches this combo, the combo is a
   *  trigger granting these accessory gifts. SELECTING/passthrough only — the
   *  pricing engine never reads it; the SO-create handler parses it via
   *  parseDefaultFreeGifts to build the free-gift trigger map. Optional: most
   *  combos / legacy snapshots carry none. */
  defaultFreeGifts?: unknown;
}

export interface PickComboArgs {
  baseModel: string;
  /** The BUILT sofa's flat list of module codes (one per laid-out cell). */
  modules: string[];
  customerId: string | null;
  tier: SofaPriceTier;
  height: string;               // '24' | '28' | '30' | '32' | '35'
  asOf?: string;                // ISO date; defaults to today
}

/** Merge a combo's SELLING prices over its COST prices, per height. The result
 *  is what the app charges (the engine's `pricesByHeight`): a set selling entry
 *  wins; a missing/null selling entry falls back to the cost entry for that
 *  height. Pure — POS and server both call it so the engine input is identical.
 *  (Mirrors the module `sell_price_sen ?? base_price_sen` repoint — combos were
 *  the cost-sell-split's one exception; Chairman 2026-05-31.) */
export const comboChargedPrices = (
  selling: Record<string, number | null> | null | undefined,
  cost: Record<string, number | null> | null | undefined,
): Record<string, number | null> => {
  const out: Record<string, number | null> = { ...(cost ?? {}) };
  for (const [height, v] of Object.entries(selling ?? {})) {
    if (v !== null && v !== undefined) out[height] = v;
  }
  return out;
};

/**
 * Coerce raw combo `modules` into the canonical `string[][]` slot shape.
 *
 * Accepts:
 *   · `string[][]` — already slots; trims + sorts codes within each slot,
 *     drops empty slots.
 *   · `string[]`   — LEGACY flat form (pre-OR-set). Each code becomes its
 *     own singleton slot `['X'] → [['X']]`. This lets pre-migration data and
 *     old callers keep working.
 *
 * Codes within a slot are sorted so two equivalent OR-sets compare equal.
 * Slots are NOT reordered here — slot order is positional/display only;
 * matching is order-independent regardless. For stable storage + tuple
 * equality (the history drawer), use `comboSlotsKey`.
 */
export function normalizeComboModules(
  raw: readonly (string | readonly string[])[] | readonly string[],
): ComboSlots {
  const out: ComboSlots = [];
  for (const entry of raw as readonly (string | readonly string[])[]) {
    if (Array.isArray(entry)) {
      const slot = [...entry]
        .map((s) => String(s).trim())
        .filter(Boolean)
        .sort();
      if (slot.length > 0) out.push(slot);
    } else {
      const code = String(entry).trim();
      if (code) out.push([code]);
    }
  }
  return out;
}

/**
 * Storage canonical form (mirrors HOOKKA's `canonicalSizes` in
 * src/api/routes/sofa-combos.ts). Applied on SAVE (API) so two equivalent
 * combos persist byte-identical `modules` JSON and therefore hash to the same
 * scope key:
 *   · accepts legacy flat `string[]` (each code → its own singleton slot),
 *   · trims + de-dupes codes within each slot, drops empty slots,
 *   · SORTS codes within each slot,
 *   · SORTS the slots by their first element.
 *
 * Returns `null` when nothing usable remains (empty input → no combo), so the
 * API can reject the payload exactly like HOOKKA does.
 *
 * NOTE: this DOES reorder slots (unlike `normalizeComboModules`, which keeps
 * slot order positional). HOOKKA stores the sorted form and renders from it;
 * matching is order-independent regardless, so sorting only affects the stable
 * on-disk JSON used for de-dupe + hashing.
 */
export function canonicalizeComboModulesForStorage(
  input: unknown,
): ComboSlots | null {
  if (!Array.isArray(input)) return null;
  // Detect the legacy flat shape (string[]) and wrap each code to a 1-slot.
  const groups: unknown[] =
    input.length > 0 && typeof input[0] === 'string'
      ? input.map((v) => [v])
      : input;
  const cleaned: ComboSlots = [];
  for (const g of groups) {
    if (!Array.isArray(g)) return null;
    const inner: string[] = [];
    for (const v of g) {
      if (typeof v !== 'string') return null;
      const t = v.trim();
      if (!t) continue;
      if (!inner.includes(t)) inner.push(t);
    }
    if (inner.length === 0) continue;
    cleaned.push(inner.slice().sort());
  }
  if (cleaned.length === 0) return null;
  cleaned.sort((a, b) => a[0]!.localeCompare(b[0]!));
  return cleaned;
}

/**
 * Like `canonicalizeComboModulesForStorage`, but PRESERVES slot ORDER.
 *
 * A Quick Pick is a spatial LAYOUT — the slot order IS the left-to-right
 * on-screen position the staff built, and the client re-lays it in that order
 * (`cellsFromComboModules`). The combo form alphabetically SORTS the slots (fine
 * for a Combo, whose matching is order-independent), which would move e.g. a
 * middle Console to the end — so the saved pick renders differently from what
 * was built. Same validation + flat→slot wrap + per-slot trim/de-dupe as the
 * combo form; just no slot sort.
 */
export function canonicalizeLayoutModulesForStorage(
  input: unknown,
): ComboSlots | null {
  if (!Array.isArray(input)) return null;
  const groups: unknown[] =
    input.length > 0 && typeof input[0] === 'string'
      ? input.map((v) => [v])
      : input;
  const cleaned: ComboSlots = [];
  for (const g of groups) {
    if (!Array.isArray(g)) return null;
    const inner: string[] = [];
    for (const v of g) {
      if (typeof v !== 'string') return null;
      const t = v.trim();
      if (!t) continue;
      if (!inner.includes(t)) inner.push(t);
    }
    if (inner.length === 0) continue;
    cleaned.push(inner);
  }
  if (cleaned.length === 0) return null;
  return cleaned; // ← no slot sort: slot order = built layout position
}

/**
 * Order-independent canonical key for a combo's slot-set. Sorts the codes in
 * each slot, then sorts the slots themselves, then JSON-stringifies. Two
 * combos with the same slots in any order produce the same key — used to
 * group history rows + dedupe active rows.
 */
export function comboSlotsKey(raw: readonly (string | readonly string[])[]): string {
  const slots = normalizeComboModules(raw)
    .map((slot) => [...slot].sort())
    .sort((a, b) => (a.join('') < b.join('') ? -1 : a.join('') > b.join('') ? 1 : 0));
  return JSON.stringify(slots);
}

/** True iff two slot-sets are equal ignoring slot order + intra-slot order. */
function slotsEqual(
  a: readonly (string | readonly string[])[],
  b: readonly (string | readonly string[])[],
): boolean {
  return comboSlotsKey(a) === comboSlotsKey(b);
}

/**
 * Find an existing combo whose (baseModel, slot-set) matches `slots`, ignoring
 * slot + intra-slot order (comboSlotsKey). Soft-deleted rows are skipped.
 *
 * Used by BOTH POS create paths (Combo Pricing "New combo" + the in-configurator
 * "Create Combo") to BLOCK adding a duplicate: the combo table is append-only, so
 * re-adding the same module-set silently makes a new effective ROW (a version),
 * which reads as a confusing "duplicate". This lets the UI warn + stop instead,
 * and steer the user to edit the existing combo. Returns the first match or null.
 *
 * Tier is intentionally NOT part of the identity here — every combo runs at the
 * single base tier (Chairman 2026-06-02), so (baseModel, slots) is the key.
 */
export function findDuplicateCombo<
  T extends {
    baseModel: string;
    modules: readonly (string | readonly string[])[];
    deletedAt?: string | null;
  },
>(
  baseModel: string,
  slots: readonly (string | readonly string[])[],
  existing: readonly T[],
): T | null {
  const target = comboSlotsKey(slots);
  for (const c of existing) {
    if (c.deletedAt) continue;
    if (c.baseModel !== baseModel) continue;
    if (comboSlotsKey(c.modules) === target) return c;
  }
  return null;
}

/**
 * SUBSET / group-coverage match (HOOKKA `findComboSubset` 1:1): can every
 * combo SLOT be covered by a DISTINCT built module whose code is in that
 * slot's OR-set?
 *
 * Returns the matched SUBSET as the sorted list of BUILT-module indices that
 * were consumed (one per slot), or `null` when at least one slot can't be
 * filled. The returned subset has exactly `slots.length` entries; any built
 * module NOT in the subset is an "extra" that the caller prices at full
 * master price — the combo never bleeds into extras. The built module count
 * may exceed the slot count.
 *
 * Implementation note: HOOKKA's reference uses a simple greedy first-match
 * (one slot at a time, consuming the first remaining line in the slot's set).
 * Greedy is correct when slots are processed in increasing order of how many
 * built modules can fill them, but overlapping OR-sets can defeat a naive
 * left-to-right greedy (e.g. slots [{X,Y},{X}] against built [X,Y] — grabbing
 * X for the first slot strands the second). To guarantee the observable
 * HOOKKA result (a slot is coverable ⇒ it gets covered) we use Kuhn's
 * augmenting-path bipartite matching, which finds a maximum assignment and
 * therefore covers every slot whenever any assignment exists. n ≤ ~8 slots in
 * practice, so the O(V·E) cost is trivial. Allowing extras is the only change
 * from the old exact-count matcher: we no longer require
 * built.length === slots.length.
 */
export function matchComboSubset(
  built: readonly string[],
  rawSlots: readonly (string | readonly string[])[],
): number[] | null {
  const slots = normalizeComboModules(rawSlots);
  const mods = built.map((m) => m.trim());
  if (slots.length === 0) return null;            // empty combo never applies
  if (mods.length < slots.length) return null;    // not enough modules to cover

  // adjacency: for each SLOT, which built-module indices can fill it.
  const slotSets = slots.map((s) => new Set(s));
  const slotCanTake: number[][] = slots.map((_, j) =>
    mods.map((_m, i) => i).filter((i) => mods[i] !== '' && slotSets[j]!.has(mods[i]!)),
  );

  // Quick reject: every slot must have at least one candidate built module.
  if (slotCanTake.some((opts) => opts.length === 0)) return null;

  // Kuhn's algorithm, oriented slot → built module. modToSlot[i] = slot the
  // built module at index i is assigned to (-1 = free).
  const modToSlot = new Array<number>(mods.length).fill(-1);
  const assignSlot = (j: number, seen: boolean[]): boolean => {
    for (const i of slotCanTake[j]!) {
      if (seen[i]) continue;
      seen[i] = true;
      if (modToSlot[i] === -1 || assignSlot(modToSlot[i]!, seen)) {
        modToSlot[i] = j;
        return true;
      }
    }
    return false;
  };

  for (let j = 0; j < slots.length; j++) {
    if (!assignSlot(j, new Array<boolean>(mods.length).fill(false))) {
      return null; // a slot couldn't be covered → combo doesn't apply
    }
  }

  // Collect the built-module indices that ended up assigned to a slot.
  const subset: number[] = [];
  for (let i = 0; i < mods.length; i++) if (modToSlot[i] !== -1) subset.push(i);
  subset.sort((a, b) => a - b);
  return subset;
}

// Malaysian "today" — matches the backend copy (scm/shared/sofa-combo-pricing.ts
// uses todayMyt). Was `new Date().toISOString()` (UTC): before 08:00 MYT it
// resolved effective-dated combo pricing against YESTERDAY, so the SPA priced a
// sofa differently from the backend for eight hours every morning. Fixed to the
// package's canonical MYT helper.
const todayIso = (): string => todayMY();

/** Result of a successful subset combo match. */
export interface ComboMatch {
  /** The winning combo row. */
  row: SofaComboRow;
  /** Combo total (centi) for the requested height. Always a finite number. */
  comboPriceCenti: number;
  /** Sorted BUILT-module indices the combo consumed (one per slot). Built
   *  modules NOT in this list are extras priced at full master price. */
  matchedIndices: number[];
}

/**
 * Pick the best-matching combo for the given (built modules, baseModel, tier,
 * customer, height) tuple AND return the matched subset, mirroring HOOKKA's
 * `comboMatches` memo + scope ranking (src/pages/sales/create.tsx ~L1328).
 *
 * Ranking (high → low), exactly like HOOKKA's `priorityOf`:
 *   customer+tier > customer+ANY(null) > company+tier > company+ANY(null),
 *   newest effectiveFrom, then newest createdAt, then id as tie-breaks.
 *
 * Returns `null` when no combo's slots can be covered by the built modules or
 * the winner has no price for `height`. Does NOT apply the cheaper-only guard
 * (`subsetSum − comboTotal > 0`) — that needs the caller's per-module
 * à-la-carte prices, so the caller (groupPrice) decides whether to actually
 * use the combo. Extras (built modules outside `matchedIndices`) always price
 * at full master price.
 *
 * @param rows  Pre-fetched combo rows. Caller should filter by baseModel
 *              server-side for performance; this function re-filters
 *              defensively.
 */
export function pickComboMatch(
  args: PickComboArgs,
  rows: readonly SofaComboRow[],
): ComboMatch | null {
  const asOf = args.asOf ?? todayIso();
  const built = args.modules.map((m) => m.trim());

  // 1. Filter to candidate rows + compute each one's matched subset. Same
  //    base model (empty args.baseModel = wildcard, used by POS until the
  //    retail↔mfg base_model bridge surfaces), tier matches (or row tier
  //    null), effective on/before asOf, not soft-deleted, AND the row's slots
  //    can be covered by a subset of the built modules (extras allowed).
  const wildcardBaseModel = !args.baseModel;
  const candidates: Array<{ row: SofaComboRow; subset: number[] }> = [];
  for (const r of rows) {
    if (r.deletedAt) continue;
    if (!wildcardBaseModel && r.baseModel !== args.baseModel) continue;
    if (r.tier !== null && r.tier !== args.tier) continue;
    if (r.effectiveFrom > asOf) continue;
    const subset = matchComboSubset(built, r.modules);
    if (!subset) continue;
    const centi = r.pricesByHeight?.[args.height];
    if (typeof centi !== 'number') continue;
    candidates.push({ row: r, subset });
  }
  if (candidates.length === 0) return null;

  // 2. Rank by scope priority then newest effectiveFrom (HOOKKA priorityOf).
  const priorityOf = (r: SofaComboRow): number => {
    const isCustomer = !!args.customerId && r.customerId === args.customerId;
    const tierMatch = r.tier === args.tier;
    if (isCustomer && tierMatch) return 4;
    if (isCustomer && r.tier === null) return 3;
    if (r.customerId === null && tierMatch) return 2;
    if (r.customerId === null && r.tier === null) return 1;
    return 0; // customer-mismatched rows can't win (shouldn't appear post-filter)
  };
  // Newest-first string compare; '' (unknown createdAt) loses to any value.
  const desc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);
  const ranked = candidates
    .map((c) => ({ ...c, p: priorityOf(c.row) }))
    .filter((c) => c.p > 0)
    .sort((a, b) =>
      b.p - a.p ||
      desc(a.row.effectiveFrom, b.row.effectiveFrom) ||
      // Same scope + same effectiveFrom (duplicate rows): newest createdAt
      // wins — identical to the GET /sofa-combos "currently active" reducer,
      // so the engine and the admin UI agree on which duplicate is live.
      // Final id compare makes the pick deterministic even for exact twins,
      // instead of depending on DB/cache row order (the 2026-07-12 drift).
      desc(a.row.createdAt ?? '', b.row.createdAt ?? '') ||
      desc(a.row.id, b.row.id),
    );
  const winner = ranked[0];
  if (!winner) return null;

  const comboPriceCenti = winner.row.pricesByHeight[args.height];
  if (typeof comboPriceCenti !== 'number') return null;
  return { row: winner.row, comboPriceCenti, matchedIndices: winner.subset };
}

/**
 * Back-compat thin wrapper around {@link pickComboMatch}: returns just the
 * winning combo's centi price for the height (or null). Subset-unaware callers
 * (e.g. server anti-tamper decision) use this to learn the combo total; the
 * cheaper-only guard + extras pricing is applied by the caller.
 */
export function pickComboPrice(
  args: PickComboArgs,
  rows: readonly SofaComboRow[],
): number | null {
  return pickComboMatch(args, rows)?.comboPriceCenti ?? null;
}

/** Split a sofa product code into its base model + module size code. A
 *  sectional module's code is `<MODEL>-<MODULE>(<ORIENT>)`, e.g.
 *  `BOOQIT-1A(LHF)` → base `BOOQIT`, size `1A(LHF)` — the parens form IS the
 *  one canonical compartment vocabulary combos are stored in (2026-06-04).
 *  A simple seat-count sofa like `BLATT-2S` → base `BLATT`, size `2S` (no
 *  orientation → never matches a combo slot).
 *  Shared by the PO cost path (mfg-purchase-orders) + the SO cost rollup. */
export function splitSofaCode(itemCode: string): { baseModel: string; sizeCode: string } {
  const i = itemCode.indexOf('-');
  if (i < 0) return { baseModel: itemCode, sizeCode: '' };
  return {
    baseModel: itemCode.slice(0, i),
    sizeCode: itemCode.slice(i + 1),
  };
}

/** A sofa line's seat-height key for combo lookup (combos are priced per
 *  height). Mirrors the sales-side `v.depth ?? v.seatHeight`. */
export function sofaHeightKey(variants: unknown): string {
  if (!variants || typeof variants !== 'object') return '';
  const v = variants as Record<string, unknown>;
  return String(v.depth ?? v.seatHeight ?? '');
}

/**
 * Spread a combo's negotiated total across the matched lines, proportional to
 * each line's own base cost, rebalancing the rounding residual into the
 * highest-cost line so the returned values sum to EXACTLY `comboTotalCenti`.
 *
 * This is the cost-side mirror of HOOKKA's sales-order combo redistribution
 * (src/pages/sales/create.tsx — `ratio = comboTotal / groupSum` per line, then
 * push the rounding residual into the highest line). A sofa is bought as a set
 * of per-module lines; when those modules match a supplier combo we don't flat-
 * replace, we re-spread the combo total back across the matched lines so every
 * PO line keeps a sensible per-unit cost and the set still sums to the combo
 * price. Lines OUTSIDE the matched subset ("extras") are not passed in here —
 * they keep their full per-module cost.
 *
 * @param baseCostsCenti  per-line base cost (already × qty if you spread totals,
 *                        or per-unit if per-unit — the function is unit-agnostic;
 *                        it preserves whatever scale you pass and the sum lands
 *                        on comboTotalCenti). Pass LINE TOTALS for parity with
 *                        HOOKKA.
 * @returns new per-line values, same length/order, summing to comboTotalCenti.
 *          When the base costs sum to 0 (no signal to weight by) the total is
 *          split as evenly as possible. Pure — safe in Workers + React.
 */
export function spreadComboTotal(
  baseCostsCenti: readonly number[],
  comboTotalCenti: number,
): number[] {
  const n = baseCostsCenti.length;
  if (n === 0) return [];
  const total = Math.max(0, Math.round(comboTotalCenti));
  const sum = baseCostsCenti.reduce((s, c) => s + Math.max(0, c), 0);

  let out: number[];
  if (sum <= 0) {
    // No base-cost signal → split as evenly as possible.
    const each = Math.floor(total / n);
    out = baseCostsCenti.map(() => each);
  } else {
    const ratio = total / sum;
    out = baseCostsCenti.map((c) => Math.max(0, Math.floor(Math.max(0, c) * ratio)));
  }

  // Rebalance the rounding residual into the highest base-cost line so the sum
  // is exactly comboTotalCenti (HOOKKA pushes the residual into the dearest line).
  const newSum = out.reduce((s, c) => s + c, 0);
  const residual = total - newSum;
  if (residual !== 0) {
    let target = 0;
    for (let i = 1; i < n; i++) {
      if ((baseCostsCenti[i] ?? 0) > (baseCostsCenti[target] ?? 0)) target = i;
    }
    out[target] = Math.max(0, (out[target] ?? 0) + residual);
  }
  return out;
}

/**
 * Auto-build a human-readable combo label from a slot-set, matching HOOKKA's
 * renderer 1:1 (src/pages/maintenance/sofa-combos.tsx `renderComponentSizes`):
 * OR-alternatives within a slot are joined with `" / "`, slots are joined with
 * `" + "`. Module codes render verbatim — they already ARE the canonical
 * parens form. Example:
 *   [ ['2A(LHF)','2A(RHF)'], ['L(LHF)','L(RHF)'] ]
 *   → "2A(LHF) / 2A(RHF) + L(LHF) / L(RHF)"
 * A singleton slot is just the bare code:
 *   [ ['2NA'] ] → "2NA"
 *
 * Also accepts the legacy flat `string[]` (each code = singleton slot).
 */
export function buildComboLabel(
  raw: readonly (string | readonly string[])[],
): string {
  const slots = normalizeComboModules(raw);
  return slots
    .map((slot) => slot.join(' / '))
    .join(' + ');
}
