/* Rule 2 for a sofa set, the database half (owner 2026-11-23).

   A product change after the order's opening day prices on the CHANGE day. For
   a sofa set whose pieces were added, removed or changed that day:
     - a set price for the whole new combination stood that day: the set takes it;
     - none did: the unchanged pieces keep the order-date cost, the added or
       changed pieces take their own change-day cost.
   The rule is planChangedSetCost (sofa-combo-cost-spread.ts); this reads what it
   needs and writes the result. Every piece of the set is then stamped
   `set_cost_day`, so a later save (recomputeTotals) leaves the set as costed
   here instead of spreading the order-date set price over it again; a piece
   costed on a change day carries that day in `cost_day`.

   Called by the line routes (direct edit) and the amendment apply, after the
   line is written and before recomputeTotals rolls the header up. A model the
   company never had a set price for needs nothing: its pieces carry their own
   costs already. */

import { scopeToCompanyId } from './companyScope';
import { loadMaintenanceConfig, recomputeOneLine, type MfgItemForRecompute } from './mfg-pricing-recompute';
import { loadMasterSofaComboCostsOf } from './pos-sofa-combos';
import { planChangedSetCost, type ChangedSetPiece } from './sofa-combo-cost-spread';
import { splitSofaCode, type SofaPriceTier } from '../shared/sofa-combo-pricing';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped at every call site in this tree.
type Sb = any;

type PieceRow = {
  id: string;
  item_code: string;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty: number | null;
  total_sen: number | null;
  unit_cost_sen: number | null;
  line_cost_sen: number | null;
  cost_day: string | null;
};

export const sofaModelOf = (itemCode: string): string => splitSofaCode(itemCode).baseModel.toUpperCase();

export type SetChangeResult = { ok: true; written: number } | { ok: false; reason: string };

export async function costChangedSofaSets(sb: Sb, args: {
  docNo: string;
  companyId: number;
  /** The order date (YYYY-MM-DD): the day the unchanged pieces are priced on. */
  orderDay: string;
  /** Today in Malaysia: the day of the change. */
  changeDay: string;
  /** The base models whose set changed. */
  models: readonly string[];
  /** The lines this change added or changed: their cost is the change day's,
   *  already written by the caller. */
  changedLineIds: readonly string[];
}): Promise<SetChangeResult> {
  const models = new Set(args.models.map((m) => m.toUpperCase()).filter(Boolean));
  if (models.size === 0) return { ok: true, written: 0 };
  const combos = await loadMasterSofaComboCostsOf(sb, args.companyId);
  if (combos.error) return { ok: false, reason: `set prices: ${combos.error}` };
  const priced = new Set(combos.rows.map((r) => r.baseModel.toUpperCase()));
  const wanted = [...models].filter((m) => priced.has(m));
  if (wanted.length === 0) return { ok: true, written: 0 };

  const { data, error } = await scopeToCompanyId(
    sb.from('mfg_sales_order_items')
      .select('id, item_code, item_group, variants, qty, total_sen, unit_cost_sen, line_cost_sen, cost_day')
      .eq('doc_no', args.docNo).eq('cancelled', false),
    args.companyId,
  );
  if (error) return { ok: false, reason: `lines: ${error.message}` };
  const pieces = ((data ?? []) as PieceRow[])
    .filter((r) => String(r.item_group ?? '').toLowerCase() === 'sofa' && wanted.includes(sofaModelOf(r.item_code)));
  if (pieces.length === 0) return { ok: true, written: 0 };

  const fabricCodes = [...new Set(pieces.map((p) => String((p.variants ?? {}).fabricCode ?? '')).filter(Boolean))];
  const tierByFabric = new Map<string, SofaPriceTier>();
  if (fabricCodes.length > 0) {
    const { data: fabs, error: fabErr } = await scopeToCompanyId(
      sb.from('fabric_trackings').select('fabric_code, price_tier, sofa_price_tier').in('fabric_code', fabricCodes),
      args.companyId,
    );
    if (fabErr) return { ok: false, reason: `fabric tiers: ${fabErr.message}` };
    for (const f of (fabs ?? []) as Array<{ fabric_code: string; price_tier: SofaPriceTier | null; sofa_price_tier: SofaPriceTier | null }>) {
      tierByFabric.set(f.fabric_code, f.sofa_price_tier ?? f.price_tier ?? 'PRICE_2');
    }
  }

  const changed = new Set(args.changedLineIds);
  const config = await loadMaintenanceConfig(sb, args.companyId);
  const ownUnit = new Map<string, number>();
  const planned: ChangedSetPiece[] = [];
  for (const p of pieces) {
    const qty = Math.max(1, Number(p.qty) || 1);
    const changedToday = changed.has(p.id);
    let unit: number;
    if (changedToday) {
      unit = Math.max(0, Math.round(Number(p.unit_cost_sen) || 0));
    } else {
      const day = p.cost_day ? String(p.cost_day).slice(0, 10) : args.orderDay;
      const key = `${p.item_code}|${JSON.stringify(p.variants ?? null)}|${day}`;
      if (!ownUnit.has(key)) {
        const item: MfgItemForRecompute = { itemCode: p.item_code, itemGroup: 'sofa', qty, unitPriceSen: 0, variants: (p.variants as MfgItemForRecompute['variants']) ?? null };
        const rec = await recomputeOneLine(sb, item, config, args.companyId, { asOf: day });
        ownUnit.set(key, Math.max(0, Math.round(Number(rec.unit_cost_sen) || 0)));
      }
      unit = ownUnit.get(key)!;
    }
    planned.push({
      id: p.id, item_code: p.item_code, item_group: 'sofa', variants: p.variants, qty,
      line_cost_sen: Number(p.line_cost_sen) || 0, own_cost_sen: unit * qty,
      unchanged: !changedToday && !p.cost_day,
    });
  }

  const plan = planChangedSetCost(planned, combos.rows, (code) => tierByFabric.get(code) ?? 'PRICE_2', args.changeDay, args.orderDay);
  let written = 0;
  for (const p of pieces) {
    const lineCost = plan.get(p.id);
    if (lineCost === undefined) continue;
    const qty = Math.max(1, Number(p.qty) || 1);
    const patch: Record<string, unknown> = {
      line_cost_sen: lineCost,
      unit_cost_sen: Math.round(lineCost / qty),
      line_margin_sen: (Number(p.total_sen) || 0) - lineCost,
      set_cost_day: args.changeDay,
      ...(changed.has(p.id) ? { cost_day: args.changeDay } : {}),
    };
    const { error: wErr } = await sb.from('mfg_sales_order_items').update(patch)
      .eq('company_id', args.companyId).eq('id', p.id).eq('doc_no', args.docNo);
    if (wErr) {
      if (sb?.__atomicCommand === true) throw new Error(`SO set re-cost failed: ${wErr.message}`);
      return { ok: false, reason: `write ${p.id}: ${wErr.message}` };
    }
    written += 1;
  }
  return { ok: true, written };
}
