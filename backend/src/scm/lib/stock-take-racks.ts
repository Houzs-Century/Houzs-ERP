// stock-take-racks — at POST, the goods go on the racks the counter found them
// on (owner 2026-10-06: 过账时真的搬到那个 rack). The rack ledger
// (warehouse_rack_items / _movements) is separate from FIFO stock, carries no
// variant, and is placement only — so this is best-effort like the GRN sync
// (lib/grn-rack-sync.ts), never a reason to fail a post.
//
// The rule, per item code at the take's warehouse:
//   - every counted line of the code (counted > 0) names a rack → the code's
//     old placements in this warehouse are taken off (STOCK_OUT) and the counted
//     quantity is placed on the named rack(s) (STOCK_IN);
//   - any counted line of the code has no rack → the code is left alone: a
//     partial answer would wipe placements nobody re-stated.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { todayMyt } from './my-time';
import { refreshRackStatus } from './grn-rack-sync';

export type RackCountLine = { item_code: string; variant_key: string | null; product_name: string | null; counted_qty: number | null; rack_id: string | null };
export type RackPlacement = { id: string; rack_id: string; item_code: string; product_name: string | null; qty: number };

export type RackMovePlan = {
  remove: RackPlacement[];
  place: Array<{ rack_id: string; item_code: string; variant_key: string; product_name: string | null; qty: number }>;
  skippedCodes: string[];
};

/** Pure: what to take off and what to put on. `existing` = this warehouse's placements of the counted codes. */
export const planStockTakeRackMoves = (lines: readonly RackCountLine[], existing: readonly RackPlacement[]): RackMovePlan => {
  const byCode = new Map<string, RackCountLine[]>();
  for (const l of lines) {
    if ((l.counted_qty ?? 0) <= 0) continue;
    byCode.set(l.item_code, [...(byCode.get(l.item_code) ?? []), l]);
  }
  const plan: RackMovePlan = { remove: [], place: [], skippedCodes: [] };
  for (const [code, ls] of byCode) {
    if (!ls.some((l) => l.rack_id)) continue; // nobody wrote a rack: nothing to say
    if (ls.some((l) => !l.rack_id)) { plan.skippedCodes.push(code); continue; }
    /* Off by CODE, on by (rack, variant): a GRN placement carries no variant
       (variant_key ''), so clearing per variant would leave those behind and
       count the goods twice. */
    plan.remove.push(...existing.filter((p) => p.item_code === code));
    const perSpot = new Map<string, { rack_id: string; variant_key: string; qty: number }>();
    for (const l of ls) {
      const vk = l.variant_key ?? '';
      const k = `${l.rack_id!} ${vk}`;
      const cur = perSpot.get(k) ?? { rack_id: l.rack_id!, variant_key: vk, qty: 0 };
      cur.qty += l.counted_qty ?? 0;
      perSpot.set(k, cur);
    }
    for (const spot of perSpot.values()) {
      plan.place.push({ ...spot, item_code: code, product_name: ls[0]!.product_name });
    }
  }
  return plan;
};

/** Apply the plan for one posted take. Best-effort; returns what it did. */
export async function applyStockTakeRacks(
  sb: any,
  args: { takeId: string; takeNo: string; warehouseId: string; companyId: number; performedBy: string },
): Promise<{ moved: number; skippedCodes: string[]; error: string | null }> {
  const { data: lines, error: lErr } = await sb.from('stock_take_lines')
    .select('item_code, variant_key, product_name, counted_qty, rack_id')
    .eq('stock_take_id', args.takeId).eq('company_id', args.companyId);
  if (lErr) return { moved: 0, skippedCodes: [], error: lErr.message };
  const counted = ((lines ?? []) as RackCountLine[]).filter((l) => (l.counted_qty ?? 0) > 0 && l.rack_id);
  if (counted.length === 0) return { moved: 0, skippedCodes: [], error: null };

  const { data: racks, error: rErr } = await sb.from('warehouse_racks')
    .select('id, rack').eq('warehouse_id', args.warehouseId).eq('company_id', args.companyId);
  if (rErr) return { moved: 0, skippedCodes: [], error: rErr.message };
  const rackRows = (racks ?? []) as Array<{ id: string; rack: string }>;
  const label = new Map(rackRows.map((r) => [r.id, r.rack]));
  const codes = [...new Set(counted.map((l) => l.item_code))];
  const { data: existing, error: eErr } = rackRows.length === 0
    ? { data: [], error: null }
    : await sb.from('warehouse_rack_items')
      .select('id, rack_id, item_code, product_name, qty')
      .eq('company_id', args.companyId)
      .in('rack_id', rackRows.map((r) => r.id))
      .in('item_code', codes);
  if (eErr) return { moved: 0, skippedCodes: [], error: eErr.message };

  const plan = planStockTakeRackMoves((lines ?? []) as RackCountLine[], (existing ?? []) as RackPlacement[]);
  if (plan.place.length === 0) return { moved: 0, skippedCodes: plan.skippedCodes, error: null };

  const base = { company_id: args.companyId, warehouse_id: args.warehouseId, source_doc_no: args.takeNo, performed_by: args.performedBy };
  if (plan.remove.length > 0) {
    const { error: dErr } = await sb.from('warehouse_rack_items').delete().in('id', plan.remove.map((p) => p.id));
    if (dErr) return { moved: 0, skippedCodes: plan.skippedCodes, error: dErr.message };
    await sb.from('warehouse_rack_movements').insert(plan.remove.map((p) => ({
      ...base, movement_type: 'STOCK_OUT', rack_id: p.rack_id, rack_label: label.get(p.rack_id) ?? null,
      item_code: p.item_code, product_name: p.product_name, quantity: p.qty, reason: 'Stock take — moved to counted rack',
    })));
  }
  const today = todayMyt();
  const { error: iErr } = await sb.from('warehouse_rack_items').insert(plan.place.map((p) => ({
    company_id: args.companyId, rack_id: p.rack_id, item_code: p.item_code, variant_key: p.variant_key, product_name: p.product_name,
    qty: p.qty, source_doc_no: args.takeNo, stocked_in_date: today, notes: 'Stock take',
  })));
  if (iErr) return { moved: 0, skippedCodes: plan.skippedCodes, error: iErr.message };
  await sb.from('warehouse_rack_movements').insert(plan.place.map((p) => ({
    ...base, movement_type: 'STOCK_IN', rack_id: p.rack_id, rack_label: label.get(p.rack_id) ?? null,
    item_code: p.item_code, variant_key: p.variant_key, product_name: p.product_name, quantity: p.qty, reason: 'Stock take — counted on this rack',
  })));
  for (const rid of new Set([...plan.remove.map((p) => p.rack_id), ...plan.place.map((p) => p.rack_id)])) {
    await refreshRackStatus(sb, rid);
  }
  return { moved: plan.place.length, skippedCodes: plan.skippedCodes, error: null };
}
