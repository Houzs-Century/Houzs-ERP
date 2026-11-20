/* The master sofa-combo COST spread (Commander 2026-05-29), as one pure rule.

   A sofa is a set of per-module lines. When the lines of one base model match
   a MASTER combo (sofa_combo_pricing, supplier_id NULL), the set's cost is the
   combo's cost, spread across the matched lines in proportion to their own
   cost. Lines outside the match keep their own cost.

   Three rules the 2026-11-17 check of 17 over-costed 2990 orders added:
     - the combo that covers the most pieces wins (pickCostComboMatch);
     - a one-slot, several-code combo never prices cost (isOnePieceSetCombo);
     - the lines are taken in a fixed order (by id), so a re-price on another
       day matches the same lines. Read in database order, two saves of
       2990-SO-2610-046 put a set price on each seat in turn and the order
       carried the set twice.
   The combos passed in must be cost-priced (loadMasterSofaComboCosts) and
   standing on the day priced (combosStandingOn). */

import { mytDateOf } from './my-time';
import {
  pickCostComboMatch,
  sofaHeightKey,
  splitSofaCode,
  spreadComboTotal,
  type SofaComboRow,
  type SofaPriceTier,
} from '../shared/sofa-combo-pricing';

export interface ComboCostLine {
  id: string;
  item_code: string;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  line_cost_sen: number;
}

/** The day whose set prices cost an order: its order date, YYYY-MM-DD. Owner
 *  2026-11-19: a set price created after the order never re-costs it, on any
 *  edit or approved amendment. Null (today's prices) only for an order with no
 *  readable date. */
export function comboCostAsOf(soDate: string | null): string | null {
  return soDate != null && /^\d{4}-\d{2}-\d{2}/.test(soDate) ? soDate.slice(0, 10) : null;
}

/** The master set prices that stood on `day` (YYYY-MM-DD, Malaysia): created by
 *  then, and not deleted by then. Owner 2026-11-20: a set price that stood on
 *  the order date counts even if it was deleted since, and one created later
 *  never counts, whatever start date it was given (2990 has rows created in
 *  August that start on 31 May). A row created and deleted on one day never
 *  stood. The start date (effectiveFrom) is still checked by the matcher. */
export function combosStandingOn(rows: readonly SofaComboRow[], day: string): SofaComboRow[] {
  return rows
    .filter((r) => !r.createdAt || mytDateOf(r.createdAt) <= day)
    .filter((r) => !r.deletedAt || mytDateOf(r.deletedAt) > day)
    .map((r) => ({ ...r, deletedAt: null }));
}

/** The new line cost (sen) of every line the spread re-prices, by line id.
 *  A line absent from the map keeps its cost. */
export function planComboCostSpread(
  lines: readonly ComboCostLine[],
  combos: readonly SofaComboRow[],
  tierOfFabric: (fabricCode: string) => SofaPriceTier,
  asOf: string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  if (combos.length === 0) return out;
  const groups = new Map<string, ComboCostLine[]>();
  const sofa = lines
    .filter((l) => (l.item_group ?? '').toLowerCase() === 'sofa')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const l of sofa) {
    const { baseModel, sizeCode } = splitSofaCode(l.item_code);
    if (!sizeCode) continue; // bare model code: nothing to match
    const key = baseModel.toUpperCase();
    const arr = groups.get(key) ?? [];
    arr.push(l);
    groups.set(key, arr);
  }
  for (const [bm, members] of groups) {
    const tierOf = (m: ComboCostLine) => tierOfFabric(String((m.variants ?? {}).fabricCode ?? ''));
    const tiers = new Set(members.map(tierOf));
    if (tiers.size !== 1) continue;
    const tier = [...tiers][0]!;
    const heights = new Set(members.map((m) => sofaHeightKey(m.variants)));
    if (heights.size !== 1) continue;
    const height = [...heights][0]!;
    if (!height) continue;
    // Same base model only (Audit 2026-06-11 I2): module codes are a shared
    // vocabulary, so another Model's combo must never price this set.
    const pool = combos.filter((cmb) => cmb.baseModel.toUpperCase() === bm);
    if (pool.length === 0) continue;
    const match = pickCostComboMatch(
      {
        baseModel: '', modules: members.map((m) => splitSofaCode(m.item_code).sizeCode),
        customerId: null, tier, height, ...(asOf ? { asOf } : {}),
      },
      pool,
    );
    if (!match) continue;
    const matched = match.matchedIndices.flatMap((i) => members.slice(i, i + 1));
    if (matched.length === 0) continue;
    // The combo price is ONE set and line_cost_sen is a LINE total: a uniform
    // qty q books q sets; mixed qtys have no clean set count, so the combo is
    // skipped and the per-module costs stand (never under-book).
    const qtySet = new Set(matched.map((m) => Math.max(1, m.qty || 1)));
    if (qtySet.size !== 1) continue;
    const comboTotal = match.comboPriceSen * [...qtySet][0]!;
    if (comboTotal <= 0) continue;
    const spread = spreadComboTotal(matched.map((m) => m.line_cost_sen || 0), comboTotal);
    matched.forEach((m, i) => out.set(m.id, spread[i] ?? 0));
  }
  return out;
}
