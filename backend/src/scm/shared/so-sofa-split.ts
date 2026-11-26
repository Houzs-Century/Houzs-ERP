
import { normalizeCompartmentCode, orderSofaCellsForNewLines, type Rot } from './sofa-build';

export interface SofaSplitCell {
  moduleId: string;
  x?: number | null;
  y?: number | null;
  rot?: number | null;
}

export interface SofaModuleLineSpec {
  cellIndex: number;
  moduleCode: string;
  itemCode: string;
  description: string;
  unitPriceSen: number;
  unitCostSen: number;
  x: number | null;
  y: number | null;
  rot: number | null;
}

/**
 * Split a BUILD-level line discount across the build's module rows.
 *
 * WHY THIS IS NOT JUST distributeProportionally. A sofa line's discount is
 * validated against the WHOLE BUILD's unit price, then the build is written as
 * one row per module. Putting the whole discount on module 0 drove that row's
 * total negative, and every downstream document clamps with
 * `Math.max(0, qty * unit - discount)` — so the discount was silently DELETED
 * and the customer was invoiced MORE than the order (see
 * tests/sofaBuildDiscountSplit.test.ts for the traced case).
 *
 * Proportional shares fix that, ALMOST. distributeProportionally floors every
 * share and drops the rounding residue on the LAST entry, so at the very top of
 * the allowed discount range that last share can exceed its own module's
 * capacity by a few sen — which puts the row negative again, by 1 sen instead of
 * by RM1,000. A test caught exactly that; this function is the repair.
 *
 * Guarantees, both asserted in the test:
 *   · Σ shares === the discount (so the header total, computed BEFORE the split,
 *     still equals the sum of the module rows)
 *   · shares[i] <= qty * unitPricesSen[i] for every i — the same invariant the
 *     SO's item PATCH enforces on edit, so a created row can also be edited
 *
 * If the discount genuinely exceeds the whole build (the caller's gate should
 * have refused it), the shares are capped at capacity and the remainder is
 * DROPPED rather than pushed negative: a discount that cannot be represented is
 * not silently turned into a negative line.
 */
export function distributeBuildDiscount(
  discountSen: number,
  qty: number,
  unitPricesSen: number[],
): number[] {
  const n = unitPricesSen.length;
  if (n === 0) return [];
  const cap = unitPricesSen.map((u) => Math.max(0, Math.floor(qty * (Number.isFinite(u) ? u : 0))));
  const want = Number.isFinite(discountSen) ? Math.max(0, Math.floor(discountSen)) : 0;

  const shares = distributeProportionally(want, cap.slice());

  let excess = 0;
  for (let i = 0; i < n; i++) {
    const over = shares[i]! - cap[i]!;
    if (over > 0) { shares[i] = cap[i]!; excess += over; }
  }
  for (let i = 0; i < n && excess > 0; i++) {
    const room = cap[i]! - shares[i]!;
    if (room <= 0) continue;
    const take = Math.min(room, excess);
    shares[i] = shares[i]! + take;
    excess -= take;
  }
  return shares;
}

/** Distribute `totalSen` across `weights` proportionally; floor each share and
 *  put the rounding residue on the LAST entry (D3), so the sum is exact.
 *  All-zero weights → equal split. Negative totals distribute symmetrically. */
export function distributeProportionally(totalSen: number, weights: number[]): number[] {
  const total = Number.isFinite(totalSen) ? totalSen : 0;
  if (weights.length === 0) return [];
  if (weights.length === 1) return [total];
  const positive = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = positive.reduce((s, w) => s + w, 0);
  const effective = sum > 0 ? positive : weights.map(() => 1);
  const effSum = sum > 0 ? sum : weights.length;
  const out: number[] = [];
  let allocated = 0;
  for (let i = 0; i < effective.length - 1; i++) {
    const share = Math.floor((total * effective[i]!) / effSum);
    out.push(share);
    allocated += share;
  }
  out.push(total - allocated);
  return out;
}

/**
 * Split a sofa build into per-module line specs, or return null when the item
 * is not a splittable build (no cells / no base model) — the caller keeps the
 * legacy single line then.
 */
export function splitSofaBuildIntoModuleLines(args: {
  baseModel: string | null | undefined;
  cells: unknown;
  buildUnitPriceSen: number;
  buildUnitCostSen: number;
  modulePrices: Record<string, number> | null;
  moduleCostsSen: Record<string, number> | null;
  evenSplitPrice?: boolean;
  depth?: string | null;
}): SofaModuleLineSpec[] | null {
  const baseModel = (args.baseModel ?? '').trim().toUpperCase();
  if (!baseModel) return null;
  if (!Array.isArray(args.cells) || args.cells.length === 0) return null;

  const parsed: SofaSplitCell[] = [];
  for (const raw of args.cells) {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    const moduleId = typeof c.moduleId === 'string' ? c.moduleId.trim() : '';
    if (!moduleId) return null;
    parsed.push({
      moduleId,
      x: typeof c.x === 'number' ? c.x : null,
      y: typeof c.y === 'number' ? c.y : null,
      rot: typeof c.rot === 'number' ? c.rot : null,
    });
  }

  const wrapped = parsed.map((src) => ({
    src,
    moduleId: src.moduleId,
    x: src.x ?? Number.NaN,
    y: src.y ?? Number.NaN,
    rot: ((((src.rot ?? 0) % 360) + 360) % 360) as Rot,
  }));
  /* CREATION-TIME ORDER. A sofa built in the ERP has no x/y, and the geometry
     sorter deliberately keeps the stored order rather than guess — which left a
     purchase order listing `L(RHF)` before `2A(LHF)` and a plan with the
     right-hand chaise on the left. This variant falls back to the handedness the
     codes carry. Owner 2026-08-28: 「我们只需要 control SKU 的顺序」, and
     「只针对新的order生效 旧的就不理了」 — which is exactly why it is used HERE,
     where lines are born, and not in the display path. */
  const cells = orderSofaCellsForNewLines(wrapped, args.depth ?? '24')
    .map((w) => (w as (typeof wrapped)[number]).src);

  const codes = cells.map((c) => normalizeCompartmentCode(c.moduleId));
  const weights = codes.map((code) => {
    const w = args.modulePrices?.[code];
    return typeof w === 'number' && w > 0 ? w : 0;
  });
  const priceWeights = args.evenSplitPrice ? codes.map(() => 1) : weights;
  const priceShares = distributeProportionally(args.buildUnitPriceSen, priceWeights);
  const costWeights = codes.map((code) => {
    const w = args.moduleCostsSen?.[code];
    return typeof w === 'number' && w > 0 ? w : 0;
  });
  const costShares = distributeProportionally(args.buildUnitCostSen, costWeights.some((w) => w > 0) ? costWeights : weights);

  return cells.map((cell, i) => ({
    cellIndex: i,
    moduleCode: codes[i]!,
    itemCode: `${baseModel}-${codes[i]!}`,
    description: `SOFA ${baseModel} ${codes[i]!}`,
    unitPriceSen: priceShares[i]!,
    unitCostSen: costShares[i]!,
    x: cell.x ?? null,
    y: cell.y ?? null,
    rot: cell.rot ?? null,
  }));
}
