// grn-rack-sync — bridge goods-receipt into the warehouse RACK (physical
// placement) ledger. The rack module (migration 0094) is deliberately separate
// from the FIFO inventory ledger; this module syncs the two ONLY at receipt:
//   - placeGrnLinesOnRacks: on GRN post, each accepted line gets one
//     warehouse_rack_items row + STOCK_IN movement per rack it goes on — its
//     split (scm.grn_item_racks) when it has one, else its single rack_id.
//   - reverseGrnRacks: on GRN cancel, pull every rack item this GRN placed +
//     log a STOCK_OUT movement.
// Both are best-effort and idempotent (keyed on warehouse_rack_items.source_grn_id).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { todayMyt } from './my-time';
import { planGrnPlacements, type PlacementLine, type SplitRow } from './grn-line-racks';

type AnySb = any;

const deriveRackStatus = (itemCount: number, reserved: boolean): 'OCCUPIED' | 'EMPTY' | 'RESERVED' =>
  reserved ? 'RESERVED' : itemCount > 0 ? 'OCCUPIED' : 'EMPTY';

export async function refreshRackStatus(sb: AnySb, rackId: string): Promise<void> {
  const { count } = await sb.from('warehouse_rack_items')
    .select('id', { head: true, count: 'exact' }).eq('rack_id', rackId);
  const { data: rack } = await sb.from('warehouse_racks')
    .select('reserved').eq('id', rackId).maybeSingle();
  await sb.from('warehouse_racks')
    .update({ status: deriveRackStatus(count ?? 0, rack?.reserved ?? false) })
    .eq('id', rackId);
}

/** Place each accepted GRN line that chose a rack onto that rack. Idempotent:
 *  skips if this GRN already has rack items (so a double-post won't duplicate). */
export async function placeGrnLinesOnRacks(
  sb: AnySb, grnId: string, grnNo: string, userId: string,
): Promise<void> {
  const { data: items } = await sb.from('grn_items')
    .select('id, rack_id, item_code, material_name, qty_accepted, company_id')
    .eq('grn_id', grnId);
  const all = (items ?? []) as Array<PlacementLine & { company_id?: number | null }>;
  if (all.length === 0) return;
  const { data: splitRows, error: splitErr } = await sb.from('grn_item_racks')
    .select('grn_item_id, rack_id, qty').in('grn_item_id', all.map((l) => l.id));
  if (splitErr) return; // best-effort, like the inserts below; the post check already read it
  const lines = planGrnPlacements(all, (splitRows ?? []) as SplitRow[]);
  if (lines.length === 0) return;
  // Multi-company (mig 0061): rack items/movements inherit the GRN's company.
  const companyId = all[0].company_id ?? null;
  const companyCol = companyId != null ? { company_id: companyId } : {};

  // Idempotency — already placed for this GRN?
  const { count: already } = await sb.from('warehouse_rack_items')
    .select('id', { head: true, count: 'exact' }).eq('source_grn_id', grnId);
  if ((already ?? 0) > 0) return;

  const rackIds = [...new Set(lines.map((l) => l.rack_id))];
  const { data: racks } = await sb.from('warehouse_racks')
    .select('id, rack, warehouse_id').in('id', rackIds);
  const rackMap = new Map((racks ?? []).map((r: { id: string }) => [r.id, r]));
  const today = todayMyt();

  const itemRows = lines.map((l) => ({
    ...companyCol,
    rack_id: l.rack_id,
    item_code: l.item_code,
    product_name: l.material_name,
    source_doc_no: grnNo,
    source_grn_id: grnId,
    qty: l.qty,
    stocked_in_date: today,
    notes: 'Goods receipt',
  }));
  const { error: insErr } = await sb.from('warehouse_rack_items').insert(itemRows);
  if (insErr) return; // best-effort

  const moveRows = lines.map((l) => {
    const r = rackMap.get(l.rack_id) as { rack?: string; warehouse_id?: string } | undefined;
    return {
      ...companyCol,
      movement_type: 'STOCK_IN',
      rack_id: l.rack_id,
      rack_label: r?.rack ?? null,
      warehouse_id: r?.warehouse_id ?? null,
      item_code: l.item_code,
      product_name: l.material_name,
      source_doc_no: grnNo,
      quantity: l.qty,
      reason: 'Goods receipt',
      performed_by: userId,
    };
  });
  await sb.from('warehouse_rack_movements').insert(moveRows);
  for (const id of rackIds) await refreshRackStatus(sb, id);
}

/** Reverse every rack item a GRN placed (on cancel). Logs a STOCK_OUT each. */
export async function reverseGrnRacks(
  sb: AnySb, grnId: string, grnNo: string, userId: string,
): Promise<void> {
  const { data: items } = await sb.from('warehouse_rack_items')
    .select('id, rack_id, item_code, product_name, qty, company_id')
    .eq('source_grn_id', grnId);
  if (!items || items.length === 0) return;
  // Multi-company (mig 0061): STOCK_OUT movements inherit the placed items' company.
  const companyId = (items[0] as { company_id?: number | null }).company_id ?? null;
  const companyCol = companyId != null ? { company_id: companyId } : {};

  const rackIds = [...new Set(items.map((i: { rack_id: string }) => i.rack_id))] as string[];
  const { data: racks } = await sb.from('warehouse_racks')
    .select('id, rack, warehouse_id').in('id', rackIds);
  const rackMap = new Map((racks ?? []).map((r: { id: string }) => [r.id, r]));

  await sb.from('warehouse_rack_items').delete().eq('source_grn_id', grnId);

  const moveRows = items.map((i: { rack_id: string; item_code: string; product_name: string | null; qty: number }) => {
    const r = rackMap.get(i.rack_id) as { rack?: string; warehouse_id?: string } | undefined;
    return {
      ...companyCol,
      movement_type: 'STOCK_OUT',
      rack_id: i.rack_id,
      rack_label: r?.rack ?? null,
      warehouse_id: r?.warehouse_id ?? null,
      item_code: i.item_code,
      product_name: i.product_name,
      source_doc_no: grnNo,
      quantity: i.qty,
      reason: 'GRN cancelled',
      performed_by: userId,
    };
  });
  await sb.from('warehouse_rack_movements').insert(moveRows);
  for (const id of rackIds) await refreshRackStatus(sb, id);
}
