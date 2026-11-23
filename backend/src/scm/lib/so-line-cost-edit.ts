/* What a sales-order line edit does to the cost the line carries.

   Owner 2026-11-20: an order costs the prices of its ORDER DATE, piece price
   and set price alike (rule 1). Owner 2026-11-23 (rule 2): a later change to
   the PRODUCT is costed on the CHANGE day; nothing else moves the cost.

   Not a product change, so the line keeps its cost: a new colour or fabric,
   the other side (LHF / RHF), a new selling price or discount, a remark, a
   label. A quantity change whose selling amount stays the same is a typo fix:
   the units keep their order-date cost (unit cost x the new quantity).

   A product change: another piece or model, a leg, a paid option, and a seat
   height when the two heights cost differently (`height`: the caller compares
   them on the change day and keeps the cost when they are equal). A quantity
   change that moves the selling amount is one too: the extra units take the
   change day's cost (qtyChangeLineCostSen). A line carrying no cost is never
   "kept": it takes a cost like any new line.

   Both sides are compared after canonicalizeVariants, so `depth` and
   `seatHeight` for one height are the same thing. */

/** A variant key that never moves the cost: colour and fabric picks, the
 *  labels and summaries written beside a value, the remark, the POS layout,
 *  the gift markers. Everything else is part of the product. */
export function isCostNeutralVariantKey(key: string): boolean {
  if (/^(fabric|colou?r)/i.test(key)) return true;
  if (/Label$/.test(key) || key === 'specialLabels') return true;
  return COST_NEUTRAL_KEYS.has(key);
}

const COST_NEUTRAL_KEYS = new Set([
  'remark', 'summary', 'totalHeight', 'extraAddonNote', 'specialsRecorded',
  'cellIndex', 'rot', 'x', 'y', 'buildKey',
  'freeGift', 'freeItem', 'pwp', 'pwpCode',
]);

/** The seat height keys, after canonicalizeVariants. */
const HEIGHT_KEYS = new Set(['seatHeight']);

/** LHF and RHF are the two sides of one piece at one price. */
export const sidelessCode = (code: string): string => code.trim().toUpperCase().replace(/LHF|RHF/g, 'SIDE');

const canon = (v: unknown): string => {
  if (v == null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort()
    .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
};

/** The cost-relevant variant keys whose values differ between two lines. */
export function changedSpecKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !isCostNeutralVariantKey(key) && canon(before[key]) !== canon(after[key])).sort();
}

export interface CostedLineShape {
  itemCode: string;
  /** canonicalizeVariants output */
  variants: Record<string, unknown>;
  unitCostSen: number;
}

/** What an edit is to the line's cost:
 *  - `keep`: not a product change (colour, fabric, side, price, discount, quantity, remark);
 *  - `height`: the seat height alone changed; it is a product change only when
 *    the two heights cost differently on the change day (the caller compares);
 *  - `product`: another piece or model, a leg, a paid option, or a line that
 *    carries no cost yet. */
export type LineEditCostKind = 'keep' | 'height' | 'product';

export function lineEditCostKind(before: CostedLineShape, after: Omit<CostedLineShape, 'unitCostSen'>): LineEditCostKind {
  if (!(Number(before.unitCostSen) > 0)) return 'product';
  if (sidelessCode(before.itemCode) !== sidelessCode(after.itemCode)) return 'product';
  const changed = changedSpecKeys(before.variants, after.variants);
  if (changed.length === 0) return 'keep';
  return changed.every((k) => HEIGHT_KEYS.has(k)) ? 'height' : 'product';
}

export function lineEditKeepsCost(before: CostedLineShape, after: Omit<CostedLineShape, 'unitCostSen'>): boolean {
  return lineEditCostKind(before, after) === 'keep';
}

/** A quantity change on a line whose product stays (rule 2, owner 2026-11-23).
 *  Returns the new LINE cost (sen):
 *    - the selling amount did not change: a typo fix, every unit keeps its
 *      order-date cost (the line's unit cost x the new quantity);
 *    - more units and a new selling amount: the units it had keep their cost,
 *      the extra ones take `changeDayUnitCostSen`;
 *    - fewer units: the units left keep their cost.
 *  `changeDayUnitCostSen` is null when the change is not a rule-2 change (the
 *  order's opening day), and then every unit keeps the line's unit cost. */
export function qtyChangeLineCostSen(args: {
  qtyBefore: number;
  qtyAfter: number;
  lineCostBeforeSen: number;
  sellingChanged: boolean;
  changeDayUnitCostSen: number | null;
}): number {
  const before = Math.max(1, Number(args.qtyBefore) || 1);
  const after = Math.max(1, Number(args.qtyAfter) || 1);
  const held = Math.max(0, Math.round(Number(args.lineCostBeforeSen) || 0));
  if (after > before && args.sellingChanged && args.changeDayUnitCostSen != null) {
    return held + Math.max(0, Math.round(args.changeDayUnitCostSen)) * (after - before);
  }
  return Math.round((held * after) / before);
}
