// grn-rack-sync — bridge goods-receipt into the warehouse RACK (physical
// placement) ledger. The rack module (migration 0094) is deliberately separate
// from the FIFO inventory ledger; this module syncs the two ONLY at receipt:
//   - placeGrnLinesOnRacks: on GRN post, each accepted line that carries a
//     rack_id gets a warehouse_rack_items row + a STOCK_IN movement.
//   - reverseGrnRacks: on GRN cancel, pull every rack item this GRN placed +
//     log a STOCK_OUT movement.
// Both are best-effort and idempotent (keyed on warehouse_rack_items.source_grn_id).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { todayMyt } from './my-time';

type AnySb = any;

const deriveRackStatus = (itemCount: number, reserved: boolean): 'OCCUPIED' | 'EMPTY' | 'RESERVED' =>
  reserved ? 'RESERVED' : itemCount > 0 ? 'OCCUPIED' : 'EMPTY';

async function refreshRackStatus(sb: AnySb, rackId: string): Promise<void> {
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
    .select('rack_id, material_code, material_name, qty_accepted, company_id')
    .eq('grn_id', grnId);
  const lines = (items ?? []).filter(
    (it: { rack_id: string | null; qty_accepted: number | null }) =>
      it.rack_id && (it.qty_accepted ?? 0) > 0,
  );
  if (lines.length === 0) return;
  // Multi-company (mig 0061): rack items/movements inherit the GRN's company.
  const companyId = (lines[0] as { company_id?: number | null }).company_id ?? null;
  const companyCol = companyId != null ? { company_id: companyId } : {};

  // Idempotency — already placed for this GRN?
  const { count: already } = await sb.from('warehouse_rack_items')
    .select('id', { head: true, count: 'exact' }).eq('source_grn_id', grnId);
  if ((already ?? 0) > 0) return;

  const rackIds = [...new Set(lines.map((l: { rack_id: string }) => l.rack_id))] as string[];
  const { data: racks } = await sb.from('warehouse_racks')
    .select('id, rack, warehouse_id').in('id', rackIds);
  const rackMap = new Map((racks ?? []).map((r: { id: string }) => [r.id, r]));
  const today = todayMyt();

  const itemRows = lines.map((l: { rack_id: string; material_code: string; material_name: string | null; qty_accepted: number }) => ({
    ...companyCol,
    rack_id: l.rack_id,
    product_code: l.material_code,
    product_name: l.material_name,
    source_doc_no: grnNo,
    source_grn_id: grnId,
    qty: l.qty_accepted,
    stocked_in_date: today,
    notes: 'Goods receipt',
  }));
  const { error: insErr } = await sb.from('warehouse_rack_items').insert(itemRows);
  if (insErr) return; // best-effort

  const moveRows = lines.map((l: { rack_id: string; material_code: string; material_name: string | null; qty_accepted: number }) => {
    const r = rackMap.get(l.rack_id) as { rack?: string; warehouse_id?: string } | undefined;
    return {
      ...companyCol,
      movement_type: 'STOCK_IN',
      rack_id: l.rack_id,
      rack_label: r?.rack ?? null,
      warehouse_id: r?.warehouse_id ?? null,
      product_code: l.material_code,
      product_name: l.material_name,
      source_doc_no: grnNo,
      quantity: l.qty_accepted,
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
    .select('id, rack_id, product_code, product_name, qty, company_id')
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

  const moveRows = items.map((i: { rack_id: string; product_code: string; product_name: string | null; qty: number }) => {
    const r = rackMap.get(i.rack_id) as { rack?: string; warehouse_id?: string } | undefined;
    return {
      ...companyCol,
      movement_type: 'STOCK_OUT',
      rack_id: i.rack_id,
      rack_label: r?.rack ?? null,
      warehouse_id: r?.warehouse_id ?? null,
      product_code: i.product_code,
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
