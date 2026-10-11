// ----------------------------------------------------------------------------
// /warehouse — rack/bin management (ported from Hookka ERP).
//
// A physical-location layer on top of the trading-company warehouses table:
// each warehouse is split into racks, each rack holds zero-to-many stored
// items, and every stock-in / stock-out / transfer is recorded as a rack
// movement for an audit trail (Movement History tab).
//
// Rack status (OCCUPIED / RESERVED / EMPTY) is derived from items + the
// reserved flag and re-persisted on every write so the rack-grid list query
// stays a single SELECT.
//
// Endpoints:
//   GET   /warehouse                 — rack list (with items) + KPI summary
//                                       ?warehouseId=… narrows to one warehouse
//   POST  /warehouse/racks           — create a rack (or seed N racks)
//   PATCH /warehouse/racks/:id       — toggle reserved / edit label/notes
//   DELETE /warehouse/racks/:id      — delete an empty rack
//   POST  /warehouse/stock-in        — add an item to a rack + log STOCK_IN
//   POST  /warehouse/stock-out       — remove an item from a rack + log STOCK_OUT
//   GET   /warehouse/movements       — movement ledger (filter type/from/to)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany, activeCompanyId,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';

export const warehouse = new Hono<{ Bindings: Env; Variables: Variables }>();
warehouse.use('*', supabaseAuth);

type RackStatus = 'OCCUPIED' | 'EMPTY' | 'RESERVED';

type RackItemRow = {
  id: string;
  rack_id: string;
  product_code: string;
  variant_key?: string;
  product_name: string | null;
  size_label: string | null;
  customer_name: string | null;
  source_doc_no: string | null;
  qty: number;
  stocked_in_date: string;
  notes: string | null;
};

const RACK_COLS =
  'id, warehouse_id, rack, position, status, reserved, notes, created_at, updated_at';
const ITEM_COLS =
  'id, rack_id, product_code, variant_key, product_name, size_label, customer_name, source_doc_no, qty, stocked_in_date, notes';
const MOVE_COLS =
  'id, movement_type, rack_id, rack_label, to_rack_id, to_rack_label, warehouse_id, product_code, variant_key, product_name, source_doc_no, quantity, reason, performed_by, created_at';

// Derive rack status from its items + reserved flag. Items always win:
// a reserved rack that has items is still OCCUPIED (matches the source system).
function deriveStatus(itemCount: number, reserved: boolean): RackStatus {
  if (itemCount > 0) return 'OCCUPIED';
  if (reserved) return 'RESERVED';
  return 'EMPTY';
}

// Recompute + persist a rack's status from its current item rows.
// `sb` is the request-scoped Supabase client (same `any` shape used across the
// other inventory routes — see stock-transfers.ts nextTransferNo()).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function refreshRackStatus(sb: any, rackId: string): Promise<RackStatus> {
  const { data: rack } = await sb
    .from('warehouse_racks')
    .select('reserved')
    .eq('id', rackId)
    .single();
  const { count } = await sb
    .from('warehouse_rack_items')
    .select('id', { head: true, count: 'exact' })
    .eq('rack_id', rackId);
  const status = deriveStatus(count ?? 0, rack?.reserved ?? false);
  await sb
    .from('warehouse_racks')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', rackId);
  return status;
}

// ── GET /warehouse — rack grid + KPI summary ───────────────────────────────
warehouse.get('/', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');

  // Page through so PostgREST's default 1000-row cap can't silently truncate the
  // rack grid (a large warehouse can exceed 1000 racks).
  const { data: racks, error: rackErr } = await paginateAll<{ id: string; warehouse_id: string; rack: string; position: string | null; reserved: boolean; notes: string | null }>((from, to) => {
    let rackQ = sb.from('warehouse_racks').select(RACK_COLS).order('rack');
    if (warehouseId) rackQ = rackQ.eq('warehouse_id', warehouseId);
    rackQ = scopeToCompany(rackQ, c); // multi-company: isolate to the active company
    return rackQ.range(from, to);
  });
  if (rackErr) {
    if (/relation .* does not exist/i.test(rackErr.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migration 0094 against Supabase.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: rackErr.message }, 500);
  }

  const rackIds = (racks ?? []).map((r: { id: string }) => r.id);
  let items: RackItemRow[] = [];
  if (rackIds.length > 0) {
    // chunkIn — rackIds can exceed 1000 (un-truncated grid) and rack items
    // across all racks can exceed the 1000-row cap; batch + page so no stock
    // sitting on racks is hidden by truncation.
    const { data: itemRows, error: itemErr } = await chunkIn<RackItemRow>(rackIds, (batch, from, to) => sb
      .from('warehouse_rack_items')
      .select(ITEM_COLS)
      .in('rack_id', batch)
      .order('stocked_in_date', { ascending: true })
      .range(from, to));
    if (itemErr) return c.json({ error: 'load_failed', reason: itemErr.message }, 500);
    items = (itemRows ?? []) as RackItemRow[];
  }

  // Group items under their rack so the grid renders without N round-trips.
  const itemsByRack = new Map<string, RackItemRow[]>();
  for (const it of items) {
    const arr = itemsByRack.get(it.rack_id) ?? [];
    arr.push(it);
    itemsByRack.set(it.rack_id, arr);
  }

  const data = (racks ?? []).map((r: {
    id: string; warehouse_id: string; rack: string; position: string | null;
    reserved: boolean; notes: string | null;
  }) => {
    const rackItems = itemsByRack.get(r.id) ?? [];
    return {
      ...r,
      // Re-derive status on read so a stale persisted value never lies to the UI.
      status: deriveStatus(rackItems.length, r.reserved),
      items: rackItems,
    };
  });

  const total = data.length;
  const occupied = data.filter((r: { status: RackStatus }) => r.status === 'OCCUPIED').length;
  const empty = data.filter((r: { status: RackStatus }) => r.status === 'EMPTY').length;
  const reserved = data.filter((r: { status: RackStatus }) => r.status === 'RESERVED').length;
  const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;

  // Warehouse picker options (mirrors /inventory's pattern).
  const { data: warehouses } = await scopeToCompany(
    sb.from('warehouses').select('id, code, name'),
    c,
  )
    .eq('is_active', true)
    .order('code');

  return c.json({
    racks: data,
    warehouses: warehouses ?? [],
    summary: { total, occupied, empty, reserved, occupancyRate },
  });
});

// ── Resolve the SCOPE of a rack create: which warehouse RECORDS the rack(s)
// should be created into. A rack "shared across warehouses" is materialised as
// one rack row per target warehouse (fan-out on create) — this keeps every
// downstream consumer (GRN placement, DO stock-out, stock-in) keyed on the
// existing per-warehouse warehouse_id with ZERO query changes. Owner's split
// warehouse RECORDS (Display / KL goods / ice-city) that share rack numbers
// simply get the same label created into each.
//   body.allWarehouses === true      → every active warehouse in the company
//   body.warehouseIds: string[]      → those warehouses (multi-select)
//   body.warehouseId: string         → single warehouse (back-compat)
async function resolveRackTargets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any, c: Parameters<typeof activeCompanyId>[0], body: Record<string, unknown>,
): Promise<string[]> {
  if (body.allWarehouses === true) {
    const { data } = await scopeToCompany(sb.from('warehouses').select('id'), c)
      .eq('is_active', true);
    const ids = ((data ?? []) as Array<{ id: string }>).map((w) => w.id);
    return [...new Set(ids)];
  }
  if (Array.isArray(body.warehouseIds)) {
    return [...new Set(
      (body.warehouseIds as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean),
    )];
  }
  const one = String(body.warehouseId ?? '').trim();
  return one ? [one] : [];
}

// ── POST /warehouse/racks — create one rack, or seed `count` racks ─────────
// Scope may be a single warehouse (back-compat), a chosen set (warehouseIds),
// or every warehouse (allWarehouses). Fan-out inserts the label into each
// target, skipping any warehouse where it already exists so one collision never
// aborts the whole batch (the unique (warehouse_id, rack) still guards dupes).
warehouse.post('/racks', async (c) => {
  const sb = c.get('supabase');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const targets = await resolveRackTargets(sb, c, body);
  if (targets.length === 0) return c.json({ error: 'warehouse_required' }, 400);
  const multi = targets.length > 1;

  // Seed mode: { count, prefix } creates "Rack 1".."Rack N" in every target,
  // skipping labels that already exist (unique (warehouse_id, rack)).
  const count = Number(body.count ?? 0);
  if (Number.isFinite(count) && count > 0) {
    const prefix = String(body.prefix ?? 'Rack').trim() || 'Rack';
    const rows: Array<Record<string, unknown>> = [];
    for (const warehouseId of targets) {
      const { data: existing } = await sb
        .from('warehouse_racks').select('rack').eq('warehouse_id', warehouseId);
      const taken = new Set((existing ?? []).map((r: { rack: string }) => r.rack));
      for (let i = 1; i <= Math.min(count, 200); i++) {
        const label = `${prefix} ${i}`;
        // multi-company: stamp the active company on every seeded rack
        if (!taken.has(label)) rows.push({ company_id: activeCompanyId(c), warehouse_id: warehouseId, rack: label, status: 'EMPTY' });
      }
    }
    if (rows.length === 0) return c.json({ racks: [], created: 0 });
    const { data, error } = await sb.from('warehouse_racks').insert(rows).select(RACK_COLS);
    if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
    return c.json({ racks: data ?? [], created: data?.length ?? 0 }, 201);
  }

  // Single-rack mode (one label, fanned out to every target warehouse).
  const rack = String(body.rack ?? '').trim();
  if (!rack) return c.json({ error: 'rack_required' }, 400);

  // Skip targets that already carry this label so a partial collision doesn't
  // 23505 the whole fan-out — only genuinely-new (warehouse, label) pairs insert.
  const { data: existing } = await sb
    .from('warehouse_racks').select('warehouse_id').eq('rack', rack).in('warehouse_id', targets);
  const alreadyHas = new Set((existing ?? []).map((r: { warehouse_id: string }) => r.warehouse_id));
  const rows = targets
    .filter((warehouseId) => !alreadyHas.has(warehouseId))
    .map((warehouseId) => ({
      company_id: activeCompanyId(c), // multi-company: stamp the active company
      warehouse_id: warehouseId,
      rack,
      position: (body.position as string) ?? null,
      reserved: body.reserved === true,
      status: body.reserved === true ? 'RESERVED' : 'EMPTY',
      notes: (body.notes as string) ?? null,
    }));

  // Single warehouse that already had the label → the old duplicate_rack 409.
  if (rows.length === 0) {
    if (!multi) return c.json({ error: 'duplicate_rack' }, 409);
    return c.json({ racks: [], created: 0 });
  }

  const { data, error } = await sb.from('warehouse_racks').insert(rows).select(RACK_COLS);
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_rack' }, 409);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  // Back-compat: a single-warehouse single-rack create still returns { rack }.
  if (!multi) return c.json({ rack: (data ?? [])[0] ?? null }, 201);
  return c.json({ racks: data ?? [], created: data?.length ?? 0 }, 201);
});

// ── PATCH /warehouse/racks/:id — toggle reserved / edit label/notes ────────
warehouse.patch('/racks/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.rack === 'string')     updates.rack = body.rack.trim();
  if (typeof body.position === 'string') updates.position = body.position;
  if (typeof body.notes === 'string')    updates.notes = body.notes;
  if (typeof body.reserved === 'boolean') updates.reserved = body.reserved;

  // Multi-company: scope the write (and the read-back) to the active company so
  // a blind rack id from another company matches nothing.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: updated, error } = await scopeToCompanyId(sb.from('warehouse_racks').update(updates).eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_rack' }, 409);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!updated) return c.json(NOT_THIS_COMPANY, 404);

  // reserved flag affects derived status — recompute.
  const status = await refreshRackStatus(sb, id);
  const { data } = await scopeToCompanyId(sb.from('warehouse_racks').select(RACK_COLS).eq('id', id), co.companyId).single();
  return c.json({ rack: data, status });
});

// ── DELETE /warehouse/racks/:id — only when empty ──────────────────────────
warehouse.delete('/racks/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  // Multi-company: confirm the rack is THIS company's before the empty-check
  // (so another company's rack can't even be probed) and scope the delete.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: rackRow } = await scopeToCompanyId(sb.from('warehouse_racks').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!rackRow) return c.json(NOT_THIS_COMPANY, 404);
  const { count } = await sb
    .from('warehouse_rack_items')
    .select('id', { head: true, count: 'exact' })
    .eq('rack_id', id);
  if ((count ?? 0) > 0) return c.json({ error: 'rack_not_empty' }, 409);
  const { error } = await scopeToCompanyId(sb.from('warehouse_racks').delete().eq('id', id), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

// ── POST /warehouse/stock-in — add an item to a rack + log the movement ────
warehouse.post('/stock-in', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const rackId = String(body.rackId ?? '').trim();
  const productCode = String(body.productCode ?? '').trim();
  if (!rackId) return c.json({ error: 'rack_required' }, 400);
  if (!productCode) return c.json({ error: 'product_code_required' }, 400);
  const qty = Math.max(1, Number(body.qty ?? 1) || 1);

  // Multi-company: resolve strictly, then scope the rack load so stock can only
  // be placed onto THIS company's rack (a blind rack id from another company is
  // not found).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Verify the rack exists (and grab its label + warehouse for the movement
  // snapshot). A reserved rack can still be stocked into — items win.
  const { data: rack, error: rackErr } = await scopeToCompanyId(sb
    .from('warehouse_racks')
    .select('id, rack, warehouse_id')
    .eq('id', rackId), co.companyId)
    .single();
  if (rackErr || !rack) return c.json({ error: 'rack_not_found' }, 404);

  const productName = (body.productName as string) ?? null;
  const sizeLabel = (body.sizeLabel as string) ?? null;
  const customerName = (body.customerName as string) ?? null;
  const sourceDocNo = (body.sourceDocNo as string) ?? null;
  const notes = (body.notes as string) ?? null;

  const { data: item, error: itemErr } = await sb.from('warehouse_rack_items').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    rack_id: rackId,
    product_code: productCode,
    product_name: productName,
    size_label: sizeLabel,
    customer_name: customerName,
    source_doc_no: sourceDocNo,
    qty,
    stocked_in_date: todayMyt(),
    notes,
  }).select(ITEM_COLS).single();
  if (itemErr) return c.json({ error: 'insert_failed', reason: itemErr.message }, 500);

  const status = await refreshRackStatus(sb, rackId);

  await sb.from('warehouse_rack_movements').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    movement_type: 'STOCK_IN',
    rack_id: rackId,
    rack_label: rack.rack,
    warehouse_id: rack.warehouse_id,
    product_code: productCode,
    product_name: productName,
    source_doc_no: sourceDocNo,
    quantity: qty,
    reason: (body.reason as string) ?? 'Stock in',
    performed_by: user.id,
  });

  return c.json({ item, status }, 201);
});

// ── POST /warehouse/stock-out — remove an item from a rack + log it ────────
warehouse.post('/stock-out', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const itemId = String(body.itemId ?? '').trim();
  if (!itemId) return c.json({ error: 'item_required' }, 400);

  // Multi-company: resolve strictly and scope the load + delete so a blind rack
  // item id from another company can't be stocked out.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Load the item (and its rack snapshot) before we delete it so the movement
  // record captures what left.
  const { data: item, error: itemErr } = await scopeToCompanyId(sb
    .from('warehouse_rack_items')
    .select(`${ITEM_COLS}, rack:warehouse_racks(id, rack, warehouse_id)`)
    .eq('id', itemId), co.companyId)
    .single();
  if (itemErr || !item) return c.json({ error: 'item_not_found' }, 404);

  // PostgREST embeds a to-one relation as either an object or a single-element
  // array depending on FK introspection — normalize to a plain object|null.
  const itemRow = item as unknown as RackItemRow & {
    rack: { id: string; rack: string; warehouse_id: string }
      | { id: string; rack: string; warehouse_id: string }[]
      | null;
  };
  const rack = Array.isArray(itemRow.rack) ? (itemRow.rack[0] ?? null) : itemRow.rack;

  const { error: delErr } = await scopeToCompanyId(sb
    .from('warehouse_rack_items')
    .delete()
    .eq('id', itemId), co.companyId);
  if (delErr) return c.json({ error: 'delete_failed', reason: delErr.message }, 500);

  let status: RackStatus | null = null;
  if (rack) status = await refreshRackStatus(sb, rack.id);

  await sb.from('warehouse_rack_movements').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    movement_type: 'STOCK_OUT',
    rack_id: rack?.id ?? null,
    rack_label: rack?.rack ?? null,
    warehouse_id: rack?.warehouse_id ?? null,
    product_code: itemRow.product_code,
    product_name: itemRow.product_name,
    source_doc_no: itemRow.source_doc_no,
    quantity: itemRow.qty,
    reason: (body.reason as string) ?? 'Stock out',
    performed_by: user.id,
  });

  return c.json({ ok: true, status });
});

// ── POST /warehouse/transfer — move qty from one rack to another ───────────
// Same-warehouse Rack → Rack move (commander 2026-05-28). Inventory totals do
// NOT change — this only relocates physical placement. Body:
//   { fromItemId, toRackId, qty? }   (qty defaults to the whole item)
warehouse.post('/transfer', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const fromItemId = String(body.fromItemId ?? '').trim();
  const toRackId = String(body.toRackId ?? '').trim();
  if (!fromItemId) return c.json({ error: 'from_item_required' }, 400);
  if (!toRackId) return c.json({ error: 'to_rack_required' }, 400);

  // Multi-company: every load AND write below is scoped to the active company so
  // a physical relocation can never move another company's stock (both the
  // source item and the destination rack must be this company's).
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Source item + its rack (for warehouse match + label snapshot).
  const { data: item, error: itemErr } = await scopeToCompanyId(sb
    .from('warehouse_rack_items')
    .select(`${ITEM_COLS}, rack:warehouse_racks(id, rack, warehouse_id)`)
    .eq('id', fromItemId), co.companyId)
    .single();
  if (itemErr || !item) return c.json({ error: 'item_not_found' }, 404);
  const itemRow = item as unknown as RackItemRow & {
    rack: { id: string; rack: string; warehouse_id: string } | { id: string; rack: string; warehouse_id: string }[] | null;
  };
  const fromRack = Array.isArray(itemRow.rack) ? (itemRow.rack[0] ?? null) : itemRow.rack;
  if (!fromRack) return c.json({ error: 'source_rack_not_found' }, 404);
  if (fromRack.id === toRackId) return c.json({ error: 'same_rack' }, 400);

  // Destination rack must exist AND be in the same warehouse.
  const { data: toRack, error: toErr } = await scopeToCompanyId(sb
    .from('warehouse_racks').select('id, rack, warehouse_id').eq('id', toRackId), co.companyId).single();
  if (toErr || !toRack) return c.json({ error: 'to_rack_not_found' }, 404);
  if (toRack.warehouse_id !== fromRack.warehouse_id) {
    return c.json({ error: 'cross_warehouse_not_allowed' }, 400);
  }

  const moveQty = Math.min(Math.max(1, Number(body.qty ?? itemRow.qty) || itemRow.qty), itemRow.qty);
  const vk = itemRow.variant_key ?? '';

  // Decrement (or delete) the source item.
  if (moveQty >= itemRow.qty) {
    await scopeToCompanyId(sb.from('warehouse_rack_items').delete().eq('id', fromItemId), co.companyId);
  } else {
    await scopeToCompanyId(sb.from('warehouse_rack_items').update({ qty: itemRow.qty - moveQty }).eq('id', fromItemId), co.companyId);
  }

  // Merge into an existing same (product, variant) item on the destination
  // rack, else create a new placement row there.
  const { data: dstExisting } = await scopeToCompanyId(sb.from('warehouse_rack_items')
    .select('id, qty')
    .eq('rack_id', toRackId)
    .eq('product_code', itemRow.product_code)
    .eq('variant_key', vk), co.companyId)
    .limit(1)
    .maybeSingle();
  if (dstExisting) {
    await scopeToCompanyId(sb.from('warehouse_rack_items')
      .update({ qty: (dstExisting as { qty: number }).qty + moveQty })
      .eq('id', (dstExisting as { id: string }).id), co.companyId);
  } else {
    await sb.from('warehouse_rack_items').insert({
      company_id: activeCompanyId(c), // multi-company: stamp the active company
      rack_id: toRackId,
      product_code: itemRow.product_code,
      variant_key: vk,
      product_name: itemRow.product_name,
      size_label: itemRow.size_label ?? null,
      customer_name: itemRow.customer_name ?? null,
      source_doc_no: itemRow.source_doc_no ?? null,
      qty: moveQty,
      stocked_in_date: itemRow.stocked_in_date,
    });
  }

  const fromStatus = await refreshRackStatus(sb, fromRack.id);
  const toStatus = await refreshRackStatus(sb, toRackId);

  await sb.from('warehouse_rack_movements').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    movement_type: 'TRANSFER',
    rack_id: fromRack.id,
    rack_label: fromRack.rack,
    to_rack_id: toRack.id,
    to_rack_label: toRack.rack,
    warehouse_id: fromRack.warehouse_id,
    product_code: itemRow.product_code,
    variant_key: vk,
    product_name: itemRow.product_name,
    source_doc_no: itemRow.source_doc_no ?? null,
    quantity: moveQty,
    reason: (body.reason as string) ?? 'Rack transfer',
    performed_by: user.id,
  });

  return c.json({ ok: true, fromStatus, toStatus });
});

// ── GET /warehouse/movements — append-only ledger ──────────────────────────
warehouse.get('/movements', async (c) => {
  const sb = c.get('supabase');
  const type = c.req.query('type');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const warehouseId = c.req.query('warehouseId');
  const limit = Math.min(1000, Number(c.req.query('limit') ?? 500));

  let q = scopeToCompany(
    sb.from('warehouse_rack_movements').select(MOVE_COLS),
    c,
  )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (type) q = q.eq('movement_type', type);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (from) q = q.gte('created_at', from);
  if (to)   q = q.lte('created_at', `${to}T23:59:59Z`);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ movements: data ?? [] });
});
