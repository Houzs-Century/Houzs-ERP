
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
    if (!sizeCode) continue;
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
    const qtySet = new Set(matched.map((m) => Math.max(1, m.qty || 1)));
    if (qtySet.size !== 1) continue;
    const comboTotal = match.comboPriceSen * [...qtySet][0]!;
    if (comboTotal <= 0) continue;
    const spread = spreadComboTotal(matched.map((m) => m.line_cost_sen || 0), comboTotal);
    matched.forEach((m, i) => out.set(m.id, spread[i] ?? 0));
  }
  return out;
}

/** A sofa piece of a set that changed after its order date (rule 2). */
export interface ChangedSetPiece extends ComboCostLine {
  own_cost_sen: number;
  unchanged: boolean;
}

/** Rule 2 (owner 2026-11-23) for a sofa set whose pieces changed after the
 *  order date, the line cost of every piece by id:
 *    - a set price for the WHOLE new combination stood on the change day: the
 *      set takes it, shared by each piece's own cost;
 *    - none did: the unchanged pieces keep the order-date cost (a set price of
 *      the order date still covering them, else each its own order-date cost),
 *      and the added or changed pieces take their own change-day cost.
 *  `combos`: the master cost rows, deleted ones included (combosStandingOn
 *  picks the ones that stood). One base model or several. */
export function planChangedSetCost(
  pieces: readonly ChangedSetPiece[],
  combos: readonly SofaComboRow[],
  tierOfFabric: (fabricCode: string) => SofaPriceTier,
  changeDay: string,
  orderDay: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const byModel = new Map<string, ChangedSetPiece[]>();
  for (const p of pieces) {
    out.set(p.id, p.own_cost_sen);
    const key = splitSofaCode(p.item_code).baseModel.toUpperCase();
    byModel.set(key, [...(byModel.get(key) ?? []), p]);
  }
  for (const members of byModel.values()) {
    const asOwn = members.map((p) => ({ ...p, line_cost_sen: p.own_cost_sen }));
    const whole = planComboCostSpread(asOwn, combosStandingOn(combos, changeDay), tierOfFabric, changeDay);
    if (members.every((p) => whole.has(p.id))) {
      for (const p of members) out.set(p.id, whole.get(p.id)!);
      continue;
    }
    const kept = planComboCostSpread(asOwn.filter((p) => p.unchanged), combosStandingOn(combos, orderDay), tierOfFabric, orderDay);
    for (const [id, cost] of kept) out.set(id, cost);
  }
  return out;
}
