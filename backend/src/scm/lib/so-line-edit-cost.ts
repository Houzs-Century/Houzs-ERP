/* What a direct line edit (PATCH /:docNo/items/:itemId) costs the line.

   Commander 2026-05-28, the order of precedence:
     1. the client sent unitCostSen > 0: that (an explicit override);
     2. a recompute ran (variants / item code / price touched) and produced a
        cost > 0: the server-computed cost (base + backend priceSen surcharges,
        computeMfgLineCost), the source of truth;
     3. the item code changed but the recompute had no cost: the product's cost
        under the new code;
     4. otherwise the line's own unit cost (a legacy row never stamped reads 0).
   Owner 2026-11-20 (so-line-cost-edit.ts): a new colour, fabric, side, price,
   discount or quantity keeps the line's cost before step 2: the order costs the
   prices of its order date, not today's.
   Owner 2026-11-23 (rule 2): after the order's opening day a PRODUCT change is
   costed today, the change day (cost_day), and so are the extra units of a
   quantity change that moves the selling amount; a seat height whose two heights
   cost the same today is not a product change. On the opening day (`later` null)
   every rule above stands as it was. Opening the day's change record here, right
   before the write, is what keeps a refused request off the database. */

import { canonicalizeVariants } from '../shared/so-variant-rule';
import { activeCompanyId } from './companyScope';
import { recomputeOneLine, type MfgItemForRecompute, type RecomputedLine } from './mfg-pricing-recompute';
import { todayMyt } from './my-time';
import { senOrZero, snapshotUnitCostSen } from './sales-doc-derive';
import { lineEditCostKind, qtyChangeLineCostSen } from './so-line-cost-edit';
import { openDirectChangeWindow, type OrderDays } from './so-product-change-record';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped at every call site in this tree.
type Sb = any;

export type LineEditPrice = {
  unitCost: number;
  lineCost: number;
  costDay: string | null;
  later: OrderDays | null;
  changeDay: string;
};

export async function priceLineEdit(sb: Sb, c: Parameters<typeof openDirectChangeWindow>[0], docNo: string, a: {
  prev: { item_code: string | null; item_group: string | null; variants: unknown; qty: number | null; unit_cost_sen: number | null; total_sen?: number | null };
  explicitUnitCostSen: number;
  newItemCode: string | null;
  qty: number;
  unit: number;
  discount: number;
  itemCodeAfter: string;
  itemGroupAfter: string;
  variantsAfter: MfgItemForRecompute['variants'];
  recomputed: RecomputedLine | null;
}): Promise<LineEditPrice> {
  const later = await openDirectChangeWindow(c, sb, docNo);
  const changeDay = todayMyt();
  const { prev, qty, unit } = a;
  const prevUnitCost = senOrZero(prev.unit_cost_sen);
  const prevQty = Math.max(1, Number(prev.qty) || 1);
  const shape = lineEditCostKind(
    { itemCode: String(prev.item_code ?? ''), variants: canonicalizeVariants(prev.item_group, prev.variants as Record<string, unknown> | null), unitCostSen: 1 },
    { itemCode: a.itemCodeAfter, variants: canonicalizeVariants(a.itemGroupAfter, a.variantsAfter as Record<string, unknown> | null) },
  );
  const sellingMoved = senOrZero((qty * unit) - a.discount) !== senOrZero(prev.total_sen);
  const companyId = activeCompanyId(c);
  const todaysUnitCost = async (spec: { code: string; group: string; variants: MfgItemForRecompute['variants'] }, useRecomputed: boolean): Promise<number> => (
    useRecomputed && a.recomputed && a.recomputed.unit_cost_sen > 0
      ? a.recomputed.unit_cost_sen
      : senOrZero((await recomputeOneLine(sb, { itemCode: spec.code, itemGroup: spec.group, qty, unitPriceSen: unit, variants: spec.variants }, null, companyId)).unit_cost_sen)
  );
  const after = { code: a.itemCodeAfter, group: a.itemGroupAfter, variants: a.variantsAfter };
  let sameCostHeight = false;
  if (shape === 'height' && later && prevUnitCost > 0) {
    const was = await todaysUnitCost({ code: String(prev.item_code ?? ''), group: String(prev.item_group ?? a.itemGroupAfter), variants: (prev.variants as MfgItemForRecompute['variants']) ?? null }, false);
    sameCostHeight = was === await todaysUnitCost(after, true);
  }
  if (a.explicitUnitCostSen > 0) {
    return { unitCost: a.explicitUnitCostSen, lineCost: senOrZero(a.explicitUnitCostSen * qty), costDay: null, later, changeDay };
  }
  if ((shape === 'keep' || sameCostHeight) && prevUnitCost > 0) {
    const extraUnitsToday = later != null && sellingMoved && qty > prevQty;
    const lineCost = qtyChangeLineCostSen({
      qtyBefore: prevQty, qtyAfter: qty, lineCostBeforeSen: prevUnitCost * prevQty,
      sellingChanged: sellingMoved, changeDayUnitCostSen: extraUnitsToday ? await todaysUnitCost(after, true) : null,
    });
    const unitCost = qty === prevQty ? prevUnitCost : Math.round(lineCost / Math.max(1, qty));
    return { unitCost, lineCost, costDay: extraUnitsToday ? changeDay : null, later, changeDay };
  }
  const unitCost = a.recomputed && a.recomputed.unit_cost_sen > 0
    ? a.recomputed.unit_cost_sen
    : a.newItemCode != null && a.newItemCode !== prev.item_code
      ? await snapshotUnitCostSen(sb, a.newItemCode, 0, c)
      : prevUnitCost;
  return { unitCost, lineCost: senOrZero(unitCost * qty), costDay: later && shape !== 'keep' ? changeDay : null, later, changeDay };
}
