
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany, activeCompanyId,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
  scopeToAllowedCompanies, companyCodeMap } from '../lib/companyScope';
import { mytDayWindow, todayMyt } from '../lib/my-time';
import { buildSeedRackLabels } from '../shared/rack-labels';
import { siblingWarehouses, type WarehouseRef } from '../lib/rack-sibling-warehouses';

export const warehouse = new Hono<{ Bindings: Env; Variables: Variables }>();
warehouse.use('*', supabaseAuth);

type RackStatus = 'OCCUPIED' | 'EMPTY' | 'RESERVED';

type RackItemRow = {
  id: string;
  rack_id: string;
  item_code: string;
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
  'id, warehouse_id, rack, position, zone, status, reserved, notes, created_at, updated_at';
const ITEM_COLS =
  'id, rack_id, item_code, variant_key, product_name, size_label, customer_name, source_doc_no, qty, stocked_in_date, notes';
const MOVE_COLS =
  'id, movement_type, rack_id, rack_label, to_rack_id, to_rack_label, warehouse_id, item_code, variant_key, product_name, source_doc_no, quantity, reason, performed_by, created_at';

function deriveStatus(itemCount: number, reserved: boolean): RackStatus {
  if (itemCount > 0) return 'OCCUPIED';
  if (reserved) return 'RESERVED';
  return 'EMPTY';
}

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

warehouse.get('/', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');

  const { data: racks, error: rackErr } = await paginateAll<{ id: string; warehouse_id: string; rack: string; position: string | null; zone: string | null; reserved: boolean; notes: string | null }>((from, to) => {
    let rackQ = sb.from('warehouse_racks').select(RACK_COLS).order('rack');
    if (warehouseId) rackQ = rackQ.eq('warehouse_id', warehouseId);
    rackQ = scopeToCompany(rackQ, c);
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
    const { data: itemRows, error: itemErr } = await chunkIn<RackItemRow>(rackIds, (batch, from, to) => sb
      .from('warehouse_rack_items')
      .select(ITEM_COLS)
      .in('rack_id', batch)
      .order('stocked_in_date', { ascending: true })
      .range(from, to));
    if (itemErr) return c.json({ error: 'load_failed', reason: itemErr.message }, 500);
    items = (itemRows ?? []) as RackItemRow[];
  }

  const itemsByRack = new Map<string, RackItemRow[]>();
  for (const it of items) {
    const arr = itemsByRack.get(it.rack_id) ?? [];
    arr.push(it);
    itemsByRack.set(it.rack_id, arr);
  }

  const data = (racks ?? []).map((r: {
    id: string; warehouse_id: string; rack: string; position: string | null;
    zone: string | null; reserved: boolean; notes: string | null;
  }) => {
    const rackItems = itemsByRack.get(r.id) ?? [];
    return {
      ...r,
      status: deriveStatus(rackItems.length, r.reserved),
      items: rackItems,
    };
  });

  const total = data.length;
  const occupied = data.filter((r: { status: RackStatus }) => r.status === 'OCCUPIED').length;
  const empty = data.filter((r: { status: RackStatus }) => r.status === 'EMPTY').length;
  const reserved = data.filter((r: { status: RackStatus }) => r.status === 'RESERVED').length;
  const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;

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

warehouse.get('/cross-company', async (c) => {
  const sb = c.get('supabase');

  type CcRackRow = {
    id: string; warehouse_id: string; rack: string; position: string | null;
    zone: string | null; reserved: boolean; notes: string | null; company_id: number | null;
  };
  const { data: racks, error: rackErr } = await paginateAll<CcRackRow>((from, to) =>
    scopeToAllowedCompanies(
      sb.from('warehouse_racks').select(`${RACK_COLS}, company_id`).order('rack'),
      c,
    ).range(from, to),
  );
  if (rackErr) return c.json({ error: 'load_failed', reason: rackErr.message }, 500);

  const { data: whRows, error: whErr } = await scopeToAllowedCompanies(
    sb.from('warehouses').select('id, code, name, company_id'),
    c,
  );
  if (whErr) return c.json({ error: 'load_failed', reason: whErr.message }, 500);
  const whById = new Map<string, { code: string; name: string }>(
    (whRows ?? []).map((w: { id: string; code: string; name: string }) => [w.id, { code: w.code, name: w.name }]),
  );

  const rackIds = (racks ?? []).map((r) => r.id);
  let items: RackItemRow[] = [];
  if (rackIds.length > 0) {
    const { data: itemRows, error: itemErr } = await chunkIn<RackItemRow>(rackIds, (batch, from, to) => sb
      .from('warehouse_rack_items')
      .select(ITEM_COLS)
      .in('rack_id', batch)
      .order('stocked_in_date', { ascending: true })
      .range(from, to));
    if (itemErr) return c.json({ error: 'load_failed', reason: itemErr.message }, 500);
    items = (itemRows ?? []) as RackItemRow[];
  }
  const itemsByRack = new Map<string, RackItemRow[]>();
  for (const it of items) {
    const arr = itemsByRack.get(it.rack_id) ?? [];
    arr.push(it);
    itemsByRack.set(it.rack_id, arr);
  }

  const codes = companyCodeMap(c);
  const data = (racks ?? []).map((r) => {
    const rackItems = itemsByRack.get(r.id) ?? [];
    const wh = whById.get(r.warehouse_id);
    return {
      ...r,
      company_code: r.company_id != null ? codes.get(Number(r.company_id)) ?? null : null,
      warehouse_code: wh?.code ?? null,
      warehouse_name: wh?.name ?? null,
      status: deriveStatus(rackItems.length, r.reserved),
      items: rackItems,
    };
  });

  const total = data.length;
  const occupied = data.filter((r) => r.status === 'OCCUPIED').length;
  const empty = data.filter((r) => r.status === 'EMPTY').length;
  const reserved = data.filter((r) => r.status === 'RESERVED').length;
  const occupancyRate = total > 0 ? Math.round((occupied / total) * 100) : 0;

  const warehouseByCode = new Map<string, string>();
  for (const r of data) if (r.warehouse_code && !warehouseByCode.has(r.warehouse_code)) warehouseByCode.set(r.warehouse_code, r.warehouse_name ?? r.warehouse_code);
  const warehouses = [...warehouseByCode.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const companyById = new Map<number, string | null>();
  for (const r of data) if (r.company_id != null) companyById.set(Number(r.company_id), r.company_code);
  const companies = [...companyById.entries()]
    .map(([id, code]) => ({ id, code }))
    .sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));

  return c.json({
    racks: data,
    warehouses,
    companies,
    summary: { total, occupied, empty, reserved, occupancyRate },
  });
});

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
  let requested: string[];
  if (Array.isArray(body.warehouseIds)) {
    requested = [...new Set(
      (body.warehouseIds as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean),
    )];
  } else {
    const one = String(body.warehouseId ?? '').trim();
    requested = one ? [one] : [];
  }
  if (requested.length === 0) return [];
  const { data, error } = await scopeToCompany(sb.from('warehouses').select('id'), c)
    .in('id', requested);
  if (error) return [];
  const inCompany = new Set(((data ?? []) as Array<{ id: string }>).map((w) => w.id));
  return requested.filter((id) => inCompany.has(id));
}

type RackTarget = { warehouseId: string; companyId: number | undefined };

async function resolveSiblingTargets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any, c: Parameters<typeof activeCompanyId>[0], ownIds: string[],
): Promise<{ targets: RackTarget[] } | { error: string }> {
  const active = activeCompanyId(c);
  if (active == null || ownIds.length === 0) return { targets: [] };
  const { data: own, error: ownErr } = await scopeToCompany(sb.from('warehouses').select('id, code, company_id'), c)
    .in('id', ownIds);
  if (ownErr) return { error: ownErr.message };
  const { data: pool, error: poolErr } = await scopeToAllowedCompanies(sb.from('warehouses').select('id, code, company_id'), c)
    .eq('is_active', true);
  if (poolErr) return { error: poolErr.message };
  return {
    targets: siblingWarehouses((own ?? []) as WarehouseRef[], (pool ?? []) as WarehouseRef[], active)
      .map((w) => ({ warehouseId: w.id, companyId: w.company_id ?? undefined })),
  };
}

export const createWarehouseRacksHandler = async (c: any) => {
  const sb = c.get('supabase');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const ownIds = await resolveRackTargets(sb, c, body);
  if (ownIds.length === 0) return c.json({ error: 'warehouse_required' }, 400);
  const targets: RackTarget[] = ownIds.map((warehouseId) => ({ warehouseId, companyId: activeCompanyId(c) }));
  if (body.alsoSiblingCompanies === true) {
    const siblings = await resolveSiblingTargets(sb, c, ownIds);
    if ('error' in siblings) return c.json({ error: 'lookup_failed', reason: siblings.error }, 500);
    targets.push(...siblings.targets);
  }
  const targetIds = targets.map((t) => t.warehouseId);
  const multi = targets.length > 1;

  const count = Number(body.count ?? 0);
  if (Number.isFinite(count) && count > 0) {
    const prefix = String(body.prefix ?? 'Rack').trim() || 'Rack';
    const labels = buildSeedRackLabels({
      prefix,
      series: typeof body.series === 'string' ? body.series : null,
      count,
      levels: body.levels == null ? 1 : Number(body.levels),
    });
    const rows: Array<Record<string, unknown>> = [];
    for (const { warehouseId, companyId } of targets) {
      const { data: existing } = await sb
        .from('warehouse_racks').select('rack').eq('warehouse_id', warehouseId);
      const taken = new Set((existing ?? []).map((r: { rack: string }) => r.rack));
      for (const label of labels) {
        if (!taken.has(label)) rows.push({ company_id: companyId, warehouse_id: warehouseId, rack: label, status: 'EMPTY' });
      }
    }
    if (rows.length === 0) return c.json({ racks: [], created: 0 });
    const { data, error } = await sb.from('warehouse_racks').insert(rows).select(RACK_COLS);
    if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
    return c.json({ racks: data ?? [], created: data?.length ?? 0 }, 201);
  }

  const rack = String(body.rack ?? '').trim();
  if (!rack) return c.json({ error: 'rack_required' }, 400);

  const { data: existing } = await sb
    .from('warehouse_racks').select('warehouse_id').eq('rack', rack).in('warehouse_id', targetIds);
  const alreadyHas = new Set((existing ?? []).map((r: { warehouse_id: string }) => r.warehouse_id));
  const rows = targets
    .filter(({ warehouseId }) => !alreadyHas.has(warehouseId))
    .map(({ warehouseId, companyId }) => ({
      company_id: companyId,
      warehouse_id: warehouseId,
      rack,
      position: (body.position as string) ?? null,
      zone: typeof body.zone === 'string' && body.zone.trim() ? body.zone.trim() : null,
      reserved: body.reserved === true,
      status: body.reserved === true ? 'RESERVED' : 'EMPTY',
      notes: (body.notes as string) ?? null,
    }));

  if (rows.length === 0) {
    if (!multi) return c.json({ error: 'duplicate_rack' }, 409);
    return c.json({ racks: [], created: 0 });
  }

  const { data, error } = await sb.from('warehouse_racks').insert(rows).select(RACK_COLS);
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_rack' }, 409);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  if (!multi) return c.json({ rack: (data ?? [])[0] ?? null }, 201);
  return c.json({ racks: data ?? [], created: data?.length ?? 0 }, 201);
};
warehouse.post('/racks', createWarehouseRacksHandler);

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
  if ('zone' in body) updates.zone = typeof body.zone === 'string' && body.zone.trim() ? body.zone.trim() : null;

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: updated, error } = await scopeToCompanyId(sb.from('warehouse_racks').update(updates).eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_rack' }, 409);
    return c.json({ error: 'update_failed', reason: error.message }, 500);
  }
  if (!updated) return c.json(NOT_THIS_COMPANY, 404);

  const status = await refreshRackStatus(sb, id);
  const { data } = await scopeToCompanyId(sb.from('warehouse_racks').select(RACK_COLS).eq('id', id), co.companyId).single();
  return c.json({ rack: data, status });
});

warehouse.delete('/racks/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
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

warehouse.post('/stock-in', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const rackId = String(body.rackId ?? '').trim();
  const itemCode = String(body.itemCode ?? '').trim();
  if (!rackId) return c.json({ error: 'rack_required' }, 400);
  if (!itemCode) return c.json({ error: 'item_code_required' }, 400);
  const qty = Math.max(1, Number(body.qty ?? 1) || 1);

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

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
    company_id: activeCompanyId(c),
    rack_id: rackId,
    item_code: itemCode,
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
    company_id: activeCompanyId(c),
    movement_type: 'STOCK_IN',
    rack_id: rackId,
    rack_label: rack.rack,
    warehouse_id: rack.warehouse_id,
    item_code: itemCode,
    product_name: productName,
    source_doc_no: sourceDocNo,
    quantity: qty,
    reason: (body.reason as string) ?? 'Stock in',
    performed_by: user.id,
  });

  return c.json({ item, status }, 201);
});

warehouse.post('/stock-out', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const itemId = String(body.itemId ?? '').trim();
  if (!itemId) return c.json({ error: 'item_required' }, 400);

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: item, error: itemErr } = await scopeToCompanyId(sb
    .from('warehouse_rack_items')
    .select(`${ITEM_COLS}, rack:warehouse_racks(id, rack, warehouse_id)`)
    .eq('id', itemId), co.companyId)
    .single();
  if (itemErr || !item) return c.json({ error: 'item_not_found' }, 404);

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
    company_id: activeCompanyId(c),
    movement_type: 'STOCK_OUT',
    rack_id: rack?.id ?? null,
    rack_label: rack?.rack ?? null,
    warehouse_id: rack?.warehouse_id ?? null,
    item_code: itemRow.item_code,
    product_name: itemRow.product_name,
    source_doc_no: itemRow.source_doc_no,
    quantity: itemRow.qty,
    reason: (body.reason as string) ?? 'Stock out',
    performed_by: user.id,
  });

  return c.json({ ok: true, status });
});

warehouse.post('/transfer', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const fromItemId = String(body.fromItemId ?? '').trim();
  const toRackId = String(body.toRackId ?? '').trim();
  if (!fromItemId) return c.json({ error: 'from_item_required' }, 400);
  if (!toRackId) return c.json({ error: 'to_rack_required' }, 400);

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

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

  const { data: toRack, error: toErr } = await scopeToCompanyId(sb
    .from('warehouse_racks').select('id, rack, warehouse_id').eq('id', toRackId), co.companyId).single();
  if (toErr || !toRack) return c.json({ error: 'to_rack_not_found' }, 404);
  if (toRack.warehouse_id !== fromRack.warehouse_id) {
    return c.json({ error: 'cross_warehouse_not_allowed' }, 400);
  }

  const moveQty = Math.min(Math.max(1, Number(body.qty ?? itemRow.qty) || itemRow.qty), itemRow.qty);
  const vk = itemRow.variant_key ?? '';

  if (moveQty >= itemRow.qty) {
    await scopeToCompanyId(sb.from('warehouse_rack_items').delete().eq('id', fromItemId), co.companyId);
  } else {
    await scopeToCompanyId(sb.from('warehouse_rack_items').update({ qty: itemRow.qty - moveQty }).eq('id', fromItemId), co.companyId);
  }

  const { data: dstExisting } = await scopeToCompanyId(sb.from('warehouse_rack_items')
    .select('id, qty')
    .eq('rack_id', toRackId)
    .eq('item_code', itemRow.item_code)
    .eq('variant_key', vk), co.companyId)
    .limit(1)
    .maybeSingle();
  if (dstExisting) {
    await scopeToCompanyId(sb.from('warehouse_rack_items')
      .update({ qty: (dstExisting as { qty: number }).qty + moveQty })
      .eq('id', (dstExisting as { id: string }).id), co.companyId);
  } else {
    await sb.from('warehouse_rack_items').insert({
      company_id: activeCompanyId(c),
      rack_id: toRackId,
      item_code: itemRow.item_code,
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
    company_id: activeCompanyId(c),
    movement_type: 'TRANSFER',
    rack_id: fromRack.id,
    rack_label: fromRack.rack,
    to_rack_id: toRack.id,
    to_rack_label: toRack.rack,
    warehouse_id: fromRack.warehouse_id,
    item_code: itemRow.item_code,
    variant_key: vk,
    product_name: itemRow.product_name,
    source_doc_no: itemRow.source_doc_no ?? null,
    quantity: moveQty,
    reason: (body.reason as string) ?? 'Rack transfer',
    performed_by: user.id,
  });

  return c.json({ ok: true, fromStatus, toStatus });
});

warehouse.get('/movements', async (c) => {
  const sb = c.get('supabase');
  const type = c.req.query('type');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const warehouseId = c.req.query('warehouseId');
  const limit = Math.min(1000, Number(c.req.query('limit') ?? 500));
  const win = mytDayWindow(from, to);
  if (!win) return c.json({ error: 'invalid_date', message: 'Dates must be YYYY-MM-DD.' }, 400);

  let q = scopeToCompany(
    sb.from('warehouse_rack_movements').select(MOVE_COLS),
    c,
  )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (type) q = q.eq('movement_type', type);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (win.startUtc) q = q.gte('created_at', win.startUtc);
  if (win.endUtc) q = q.lt('created_at', win.endUtc);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ movements: data ?? [] });
});
