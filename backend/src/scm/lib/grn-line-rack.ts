// grn-line-rack — set / change / clear the destination rack of ONE GRN line
// after the GRN exists (PATCH /grns/:id/items/:itemId/rack).
//
// The rack used to be pickable only on the New GRN form, so a receipt saved
// without one (or with the wrong one) could never get it. Rack is physical
// placement only — it moves no FIFO stock and no money — so this path is kept
// apart from the line PATCH: no PI/PR child-lock, no re-cost, no PO recount.
//
// On a POSTED GRN the rack ledger (grn-rack-sync) already reflects the line,
// so the change is mirrored there: none->rack places the line, rack->rack
// moves the placed row (keeping source_grn_id so a later cancel still reverses
// it), rack->none pulls it. If the placed row is no longer where the GRN says
// (moved or picked on the rack board since), the rack board is the truth and
// the change is refused rather than placing the goods twice.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from './companyScope';
import { isMigratedNoStock } from './migrated-no-stock';
import { recordEntityAudit, fieldChange, compactChanges } from './entity-audit';
import { todayMyt } from './my-time';

export type PlacedRow = { id: string; qty: number };

export type RackPlan =
  | { kind: 'refuse'; status: number; body: { error: string; message: string } }
  | { kind: 'noop' }
  | { kind: 'row_only' }
  | { kind: 'place' }
  | { kind: 'move'; rowId: string }
  | { kind: 'pull'; rowId: string };

/** Pure decision: what a rack change on one line must do to the rack ledger. */
export function planGrnLineRackChange(args: {
  grnStatus: string;
  migratedNoStock: boolean;
  fromRackId: string | null;
  toRackId: string | null;
  qtyAccepted: number;
  placedRows: PlacedRow[];
}): RackPlan {
  const status = args.grnStatus.toUpperCase();
  if (status === 'CANCELLED' || status === 'CLOSED') {
    return { kind: 'refuse', status: 409, body: { error: 'grn_locked',
      message: `This GRN is ${status} — its rack can no longer be changed.` } };
  }
  if ((args.fromRackId ?? null) === (args.toRackId ?? null)) return { kind: 'noop' };
  // Nothing was ever placed for these: DRAFT places at confirm, a migrated
  // receipt and a zero-accepted line have no goods on a shelf from this GRN.
  if (status === 'DRAFT' || args.migratedNoStock || args.qtyAccepted <= 0) return { kind: 'row_only' };
  if (!args.fromRackId) return { kind: 'place' };
  const row = args.placedRows.find((r) => r.qty === args.qtyAccepted);
  if (!row) {
    return { kind: 'refuse', status: 409, body: { error: 'rack_already_moved',
      message: 'These goods were already moved on the rack board. Move them there instead.' } };
  }
  return args.toRackId ? { kind: 'move', rowId: row.id } : { kind: 'pull', rowId: row.id };
}

type RackRow = { id: string; rack: string; warehouse_id: string; reserved?: boolean | null };

async function refreshRackStatus(sb: any, rack: RackRow): Promise<void> {
  const { count } = await sb.from('warehouse_rack_items')
    .select('id', { head: true, count: 'exact' }).eq('rack_id', rack.id);
  const status = rack.reserved ? 'RESERVED' : (count ?? 0) > 0 ? 'OCCUPIED' : 'EMPTY';
  await sb.from('warehouse_racks').update({ status }).eq('id', rack.id);
}

export async function setGrnLineRackHandler(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const grnId = c.req.param('id') as string;
  const itemId = c.req.param('itemId') as string;
  let body: { rackId?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const toRackId = typeof body.rackId === 'string' && body.rackId ? body.rackId : null;

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase') as any;
  const user = c.get('user');

  const { data: grn, error: grnErr } = await scopeToCompanyId(sb.from('grns')
    .select('id, grn_number, status, warehouse_id, migrated_no_stock').eq('id', grnId), co.companyId).maybeSingle();
  if (grnErr) return c.json({ error: 'lookup_failed', reason: grnErr.message }, 500);
  if (!grn) return c.json(NOT_THIS_COMPANY, 404);
  const { data: line, error: lineErr } = await scopeToCompanyId(sb.from('grn_items')
    .select('id, rack_id, item_code, material_name, qty_accepted')
    .eq('id', itemId).eq('grn_id', grnId), co.companyId).maybeSingle();
  if (lineErr) return c.json({ error: 'lookup_failed', reason: lineErr.message }, 500);
  if (!line) return c.json({ error: 'not_found' }, 404);

  /* A line split over several racks (grn-line-racks.ts): on a DRAFT, one rack
     picked here replaces the split; once posted its goods sit on several racks,
     which this one-row move cannot follow — the rack board can. */
  const { count: splitCount, error: splitErr } = await scopeToCompanyId(sb.from('grn_item_racks')
    .select('id', { head: true, count: 'exact' }).eq('grn_item_id', itemId), co.companyId);
  if (splitErr) return c.json({ error: 'lookup_failed', reason: splitErr.message }, 500);
  const isDraft = String(grn.status ?? '').toUpperCase() === 'DRAFT';
  if ((splitCount ?? 0) > 0 && !isDraft) {
    return c.json({ error: 'rack_split_posted',
      message: 'This line is on several racks. Move its goods on the rack board.' }, 409);
  }

  const rackIds = [line.rack_id, toRackId].filter(Boolean) as string[];
  const { data: rackList, error: rackErr } = rackIds.length
    ? await scopeToCompanyId(sb.from('warehouse_racks').select('id, rack, warehouse_id, reserved').in('id', rackIds), co.companyId)
    : { data: [], error: null };
  if (rackErr) return c.json({ error: 'lookup_failed', reason: rackErr.message }, 500);
  const racks = new Map<string, RackRow>((rackList ?? []).map((r: RackRow) => [r.id, r]));
  const toRack = toRackId ? racks.get(toRackId) ?? null : null;
  if (toRackId && !toRack) return c.json({ error: 'rack_not_found', message: 'That rack does not exist.' }, 404);
  if (toRack && grn.warehouse_id && toRack.warehouse_id !== grn.warehouse_id) {
    return c.json({ error: 'rack_wrong_warehouse',
      message: 'That rack is not in this GRN\'s receive-into warehouse.' }, 400);
  }

  const { data: placed, error: placedErr } = line.rack_id
    ? await scopeToCompanyId(sb.from('warehouse_rack_items').select('id, qty')
      .eq('source_grn_id', grnId).eq('rack_id', line.rack_id).eq('item_code', line.item_code), co.companyId)
    : { data: [], error: null };
  if (placedErr) return c.json({ error: 'lookup_failed', reason: placedErr.message }, 500);
  const plan = planGrnLineRackChange({
    grnStatus: String(grn.status ?? ''),
    migratedNoStock: isMigratedNoStock(grn),
    fromRackId: line.rack_id ?? null,
    toRackId,
    qtyAccepted: Number(line.qty_accepted ?? 0),
    placedRows: (placed ?? []) as PlacedRow[],
  });
  if (plan.kind === 'refuse') return c.json(plan.body, plan.status as 409);
  if (plan.kind === 'noop' && !((splitCount ?? 0) > 0)) return c.json({ ok: true });

  if ((splitCount ?? 0) > 0) {
    const { error: clearErr } = await scopeToCompanyId(sb.from('grn_item_racks')
      .delete().eq('grn_item_id', itemId), co.companyId);
    if (clearErr) return c.json({ error: 'update_failed', reason: clearErr.message }, 500);
  }
  const { error: upErr } = await scopeToCompanyId(sb.from('grn_items')
    .update({ rack_id: toRackId }).eq('id', itemId), co.companyId);
  if (upErr) return c.json({ error: 'update_failed', reason: upErr.message }, 500);

  const fromRack = line.rack_id ? racks.get(line.rack_id) ?? null : null;
  const qty = Number(line.qty_accepted ?? 0);
  const base = {
    company_id: co.companyId,
    item_code: line.item_code,
    product_name: line.material_name,
    source_doc_no: grn.grn_number,
    quantity: qty,
    performed_by: user.id,
  };
  if (plan.kind === 'place' && toRack) {
    await sb.from('warehouse_rack_items').insert({
      company_id: co.companyId, rack_id: toRack.id, item_code: line.item_code,
      product_name: line.material_name, source_doc_no: grn.grn_number, source_grn_id: grnId,
      qty, stocked_in_date: todayMyt(), notes: 'Goods receipt',
    });
    await sb.from('warehouse_rack_movements').insert({ ...base, movement_type: 'STOCK_IN',
      rack_id: toRack.id, rack_label: toRack.rack, warehouse_id: toRack.warehouse_id,
      reason: 'Goods receipt (rack set on the GRN)' });
    await refreshRackStatus(sb, toRack);
  } else if (plan.kind === 'move' && toRack) {
    await scopeToCompanyId(sb.from('warehouse_rack_items').update({ rack_id: toRack.id }).eq('id', plan.rowId), co.companyId);
    await sb.from('warehouse_rack_movements').insert({ ...base, movement_type: 'TRANSFER',
      rack_id: line.rack_id, rack_label: fromRack?.rack ?? null,
      to_rack_id: toRack.id, to_rack_label: toRack.rack,
      warehouse_id: toRack.warehouse_id, reason: 'GRN line rack changed' });
    if (fromRack) await refreshRackStatus(sb, fromRack);
    await refreshRackStatus(sb, toRack);
  } else if (plan.kind === 'pull') {
    await scopeToCompanyId(sb.from('warehouse_rack_items').delete().eq('id', plan.rowId), co.companyId);
    await sb.from('warehouse_rack_movements').insert({ ...base, movement_type: 'STOCK_OUT',
      rack_id: line.rack_id, rack_label: fromRack?.rack ?? null,
      warehouse_id: fromRack?.warehouse_id ?? null, reason: 'GRN line rack cleared' });
    if (fromRack) await refreshRackStatus(sb, fromRack);
  }

  await recordEntityAudit(sb, {
    entityType: 'GRN',
    entityId: grnId,
    entityDocNo: grn.grn_number,
    action: 'UPDATE',
    actor: c.get('houzsUser'),
    companyId: co.companyId,
    statusSnapshot: grn.status,
    note: `Line rack changed: ${line.item_code}`,
    fieldChanges: compactChanges([fieldChange('rack', fromRack?.rack ?? null, toRack?.rack ?? null)]),
  });
  return c.json({ ok: true });
}
