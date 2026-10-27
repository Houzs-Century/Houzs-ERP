/* From-scratch PO: a sofa SET is costed at the supplier's combo price, the same
   rule as a PO converted from a sales order (backend mfg-purchase-orders.ts,
   "Combo redistribution"). The combo in force is the one effective on the PO
   date (pickComboMatch's asOf). Pure. */

import {
  pickComboMatch, spreadComboTotal, splitSofaCode, sofaHeightKey,
  type SofaComboRow, type SofaPriceTier,
} from '../../vendor/shared/sofa-combo-pricing';

export type ComboLine = {
  rid: string;
  itemCode: string;
  category?: string;
  qty: number;
  /** Per-unit cost from the supplier's price table, before any combo. */
  unitPriceSen: number;
  priceTouched?: boolean;
  tier: SofaPriceTier | null;
  variants: Record<string, unknown>;
};

/** rid -> per-unit cost for every line a combo re-prices; other lines absent. */
export function applySupplierCombos(
  lines: readonly ComboLine[],
  combos: readonly SofaComboRow[],
  asOf: string,
): Map<string, number> {
  const out = new Map<string, number>();
  if (combos.length === 0) return out;
  const groups = new Map<string, ComboLine[]>();
  for (const l of lines) {
    if (l.category?.toLowerCase() !== 'sofa' || l.priceTouched) continue;
    const { baseModel, sizeCode } = splitSofaCode(l.itemCode);
    if (!sizeCode) continue;
    const key = baseModel.toUpperCase();
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  for (const [baseModelU, members] of groups) {
    const tiers = new Set(members.map((m) => m.tier));
    const heights = new Set(members.map((m) => sofaHeightKey(m.variants)));
    const tier = [...tiers][0];
    const height = [...heights][0];
    if (tiers.size !== 1 || !tier || heights.size !== 1 || !height) continue;
    const rows = combos.filter((r) => r.baseModel.toUpperCase() === baseModelU);
    const match = pickComboMatch(
      { baseModel: '', modules: members.map((m) => splitSofaCode(m.itemCode).sizeCode), customerId: null, tier, height, asOf },
      rows,
    );
    if (!match || match.comboPriceSen <= 0) continue;
    const matched = match.matchedIndices.map((i) => members[i]).filter((m): m is ComboLine => !!m);
    // Mixed quantities have no clean set count: skip rather than under-book.
    if (matched.length === 0 || new Set(matched.map((m) => Math.max(1, m.qty))).size !== 1) continue;
    const spread = spreadComboTotal(matched.map((m) => m.unitPriceSen), match.comboPriceSen);
    matched.forEach((m, i) => out.set(m.rid, spread[i] ?? 0));
  }
  return out;
}
