
import { yymmFor } from '../../services/documentRefs';
import { Hono } from 'hono';
import { z } from 'zod';
import { normalizePhone } from '../shared/phone';
import { PAYMENT_METHOD_CODES } from '../shared/payment-methods';
import { DO_SHIPPED_STATES, DO_STATUSES } from '../shared/do-shipped-states';
import { buildVariantSummary } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { defaultWarehouseId, writeMovements, resolveWarehouseLotBatches } from '../lib/inventory-movements';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { computeVariantKey, type VariantAttrs } from '../shared';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { resolveItemGroups } from '../lib/sku-category';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { warehouseLabel } from '../lib/warehouse-label';
import { todayMyt } from '../lib/my-time';
import { changedLockedCols, identityLockedRefusal } from '../shared/header-inherited-lock';
import { CN_LOCK_COLS, CN_LOCK_LABELS } from '../shared/document-policy';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { moneySkipsCancelled, NOT_CANCELLED_OR } from '../lib/list-money-cancelled';
import { escapeForOr } from '../lib/postgrest-search';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { sourceUnitCostByItemId } from '../lib/source-cost';
import { assertSourceLinesInCompany } from '../lib/ref-in-company';
import { foldTargetsIntoOwnBuckets, stockBucketKeyResolver } from '../lib/stock-bucket-key';

export const consignmentNotes = new Hono<{ Bindings: Env; Variables: Variables }>();
consignmentNotes.use('*', supabaseAuth);

const CN_IDENTITY_LOCK_COLS = CN_LOCK_COLS;
const CN_IDENTITY_LABELS = CN_LOCK_LABELS;

async function noteHasDownstream(sb: any, noteId: string): Promise<{ error: string; message: string } | null> {
  const { count: crCount, error: crErr } = await sb.from('consignment_delivery_returns')
    .select('id', { head: true, count: 'exact' })
    .eq('consignment_do_id', noteId)
    .neq('status', 'CANCELLED');
  if (crErr) {
    return { error: 'downstream_check_failed', message: `Could not check whether this Consignment Note has a Consignment Return, so it is locked for safety — try again (${crErr.message}).` };
  }
  if ((crCount ?? 0) > 0) {
    return { error: 'note_has_downstream', message: 'Consignment Note has a Consignment Return — cancel it first to edit' };
  }
  return null;
}

const HEADER =
  'id, do_number, consignment_so_doc_no, debtor_code, debtor_name, do_date, expected_delivery_at, ' +
  'customer_delivery_date, signed_at, delivered_at, dispatched_at, ' +
  'driver_id, driver_name, vehicle, m3_total_milli, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, po_doc_no, sales_location, customer_state, customer_country, note, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, ' +
  'mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, ' +
  'local_total_sen, total_cost_sen, total_margin_sen, margin_pct_basis, line_count, ' +
  'currency, warehouse_id, ' +
  'pod_r2_key, signature_data, status, notes, created_at, created_by, updated_at';

const ITEM =
  'id, consignment_delivery_order_id, consignment_so_item_id, item_code, item_group, description, description2, ' +
  'uom, qty, m3_milli, unit_price_sen, discount_sen, line_total_sen, ' +
  'unit_cost_sen, line_cost_sen, line_margin_sen, variants, notes, ' +
  'line_delivery_date, line_delivery_date_overridden, created_at';

const PAYMENT_COLS =
  'id, consignment_delivery_order_id, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_sen, account_sheet, collected_by, note, ' +
  'created_at, created_by';

const CN_FINANCE_KEYS = [
  'mattress_sofa_sen', 'bedframe_sen', 'accessories_sen', 'others_sen',
  'mattress_sofa_cost_sen', 'bedframe_cost_sen', 'accessories_cost_sen', 'others_cost_sen',
  'total_cost_sen', 'total_margin_sen', 'margin_pct_basis',
] as const;

function gateCnFinance(
  c: Parameters<typeof canViewScmFinance>[0],
  deliveryOrder: unknown,
  items: unknown,
): void {
  if (canViewScmFinance(c)) return;
  for (const h of (Array.isArray(deliveryOrder) ? deliveryOrder : [deliveryOrder]) as Array<unknown>) {
    if (h && typeof h === 'object') {
      for (const k of CN_FINANCE_KEYS) delete (h as Record<string, unknown>)[k];
    }
  }
  for (const it of (Array.isArray(items) ? items : items ? [items] : []) as Array<Record<string, unknown>>) {
    for (const k of SO_ITEM_FINANCE_KEYS) delete it[k];
  }
}

const SHIPPED_STATES: string[] = [...DO_SHIPPED_STATES];

const nextNum = async (sb: any, c: any): Promise<string> => {
  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'consignment_delivery_orders', 'do_number', `${p}CN-${yymm}`);
};

async function recomputeTotals(sb: any, noteId: string) {
  const { data: items, error: itemsErr } = await sb.from('consignment_delivery_order_items')
    .select('item_group, line_total_sen, line_cost_sen')
    .eq('consignment_delivery_order_id', noteId);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[cn-recompute] item read failed — header left unchanged:', noteId, itemsErr.message);
    return;
  }
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of (items ?? []) as Array<{ item_group: string | null; line_total_sen: number | null; line_cost_sen: number | null }>) {
    const lineTotal = Number(it.line_total_sen ?? 0);
    const lineCost  = Number(it.line_cost_sen ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  const { error: updErr } = await sb.from('consignment_delivery_orders').update({
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen: bedframeCost,
    accessories_cost_sen: accessoriesCost,
    others_cost_sen: othersCost,
    local_total_sen: total,
    total_cost_sen: totalCost,
    total_margin_sen: margin,
    margin_pct_basis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    updated_at: new Date().toISOString(),
  }).eq('id', noteId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[cn-recompute] header update failed — totals left STALE:', noteId, updErr.message);
  }
}

async function resolveNoteLineWarehouses(
  sb: any,
  items: Array<{ id: string; consignment_so_item_id?: string | null }>,
  headerWarehouseId: string | null,
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const soItemIds = [...new Set(items
    .map((it) => it.consignment_so_item_id ?? null)
    .filter((x): x is string => !!x))];
  const soWh = new Map<string, string | null>();
  if (soItemIds.length > 0) {
    const { data: soRows, error: soErr } = await sb.from('consignment_sales_order_items')
      .select('id, warehouse_id').in('id', soItemIds)
      .eq('company_id', companyId ?? -1);
    if (soErr) {
      // eslint-disable-next-line no-console
      console.error('[consignment-notes] CO-line warehouse read failed — lines fall back to the header/default warehouse:', soErr.message);
    }
    for (const r of (soRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      soWh.set(r.id, r.warehouse_id ?? null);
    }
  }
  const fallback = headerWarehouseId ?? (await defaultWarehouseId(sb, companyId));
  for (const it of items) {
    const fromSo = it.consignment_so_item_id ? (soWh.get(it.consignment_so_item_id) ?? null) : null;
    out.set(it.id, fromSo ?? fallback);
  }
  return out;
}

async function warehouseCodeMap(
  sb: any,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniq.length === 0) return out;
  const { data } = await sb.from('warehouses').select('id, code, name').in('id', uniq);
  for (const w of (data ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
    out.set(w.id, warehouseLabel(w) ?? '');
  }
  return out;
}

async function resyncNoteInventory(sb: any, noteId: string, performedBy: string | null): Promise<string[]> {
  const { data: header } = await sb.from('consignment_delivery_orders')
    .select('do_number, status, warehouse_id, company_id').eq('id', noteId).maybeSingle();
  if (!header) return [];
  const status = ((header as { status: string | null }).status ?? '').toUpperCase();
  const noteNo = (header as { do_number: string }).do_number ?? noteId;
  const cancelled = status === 'CANCELLED';
  if (!cancelled && !SHIPPED_STATES.includes(status)) return [];

  type Bucket = { warehouse_id: string; item_code: string; variant_key: string; product_name: string | null; qty: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled) {
    const { data: items } = await sb.from('consignment_delivery_order_items')
      .select('id, consignment_so_item_id, item_code, description, qty, item_group, variants')
      .eq('consignment_delivery_order_id', noteId);
    const lineWh = await resolveNoteLineWarehouses(
      sb,
      (items ?? []) as Array<{ id: string; consignment_so_item_id?: string | null }>,
      (header as { warehouse_id: string | null }).warehouse_id ?? null,
      (header as { company_id?: number | null }).company_id ?? undefined,
    );
    const distinctWh = [...new Set(((items ?? []) as Array<{ id: string }>).map((it) => lineWh.get(it.id)).filter((x): x is string => !!x))];
    const batchByWh = new Map<string, Map<string, string | null>>();
    for (const wh of distinctWh) batchByWh.set(wh, await resolveWarehouseLotBatches(sb, wh));
    const keyOf = await stockBucketKeyResolver(sb, (header as { company_id?: number | null }).company_id ?? null,
      ((items ?? []) as Array<{ id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }>).map((it) => ({ item_code: it.item_code, item_group: it.item_group ?? null, variants: it.variants ?? null, warehouse_id: lineWh.get(it.id) ?? null })));
    for (const it of ((items ?? []) as Array<{ id: string; item_code: string; description: string | null; qty: number; item_group?: string | null; variants?: VariantAttrs | null }>)) {
      const qty = Number(it.qty ?? 0);
      if (qty <= 0) continue;
      const wh = lineWh.get(it.id) ?? null;
      if (!wh) continue;
      const vk = keyOf({ item_code: it.item_code, item_group: it.item_group ?? null, variants: it.variants ?? null, warehouse_id: lineWh.get(it.id) ?? null });
      const batch = batchByWh.get(wh)?.get(`${it.item_code}::${vk}`) ?? null;
      const k = `${wh}::${it.item_code}::${vk}::${batch ?? ''}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: wh, item_code: it.item_code, variant_key: vk, product_name: it.description, qty, batch_no: batch });
    }
  }

  const { data: movs } = await sb.from('inventory_movements')
    .select('movement_type, warehouse_id, item_code, variant_key, batch_no, qty, total_cost_sen, product_name')
    .eq('source_doc_id', noteId)
    .in('source_doc_type', ['CS_DO', 'STOCK_TRANSFER']);
  type Agg = { out_qty: number; in_qty: number; out_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of (movs ?? []) as Array<{ movement_type: string; warehouse_id: string; item_code: string; variant_key: string | null; batch_no?: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>) {
    const k = `${m.warehouse_id}::${m.item_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: m.product_name }; aggByBucket.set(k, a); }
    if (m.movement_type === 'OUT') { a.out_qty += Number(m.qty ?? 0); a.out_total_cost += Number(m.total_cost_sen ?? 0); }
    else if (m.movement_type === 'IN') a.in_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.product_name;
  }

  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const csDoEmitted = new Set<string>();
  foldTargetsIntoOwnBuckets(targetByBucket, aggByBucket.keys(), (header as { company_id?: number | null }).company_id ?? null);
  for (const k of new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()])) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: null };
    const delta = (t?.qty ?? 0) - (a.out_qty - a.in_qty);
    if (delta === 0) continue;
    const [wh, pc, vk, batchSeg] = k.split('::');
    const batch_no = batchSeg || null;
    const pname = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      const neverMoved = a.out_qty === 0 && a.in_qty === 0;
      const useCsDo = neverMoved && !csDoEmitted.has(`${pc}::${vk}`);
      if (useCsDo) csDoEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: 'OUT', warehouse_id: wh ?? '', item_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: delta,
        source_doc_type: useCsDo ? 'CS_DO' : 'STOCK_TRANSFER',
        source_doc_id: noteId, source_doc_no: noteNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: useCsDo ? 'Consignment Note ship-out (goods to showroom)' : 'Consignment Note resync: line qty increased / added.',
      });
    } else {
      const unitCost = a.out_qty > 0 ? Math.round(a.out_total_cost / a.out_qty) : 0;
      writes.push({
        movement_type: 'IN', warehouse_id: wh ?? '', item_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: -delta, unit_cost_sen: unitCost,
        source_doc_type: 'STOCK_TRANSFER',
        source_doc_id: noteId, source_doc_no: cancelled ? `${noteNo}-CANCEL` : noteNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: cancelled ? 'Consignment Note cancelled — stock returned' : 'Consignment Note resync: line qty reduced / deleted.',
      });
    }
  }

  if (writes.length === 0) return [];
  const res = await writeMovements(sb, writes, (header as { company_id?: number | null }).company_id ?? null);
  if (res.ok) await reconcileUncostedAfterIn(sb, writes, performedBy);
  try {
    const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
    await recomputeAllocationAfterSave(sb, 'consignment-note');
  } catch { }
  return res.ok ? [] : [res.reason ?? 'consignment note inventory resync failed'];
}

function buildItemRow(
  noteId: string,
  it: Record<string, unknown>,
  sourceCostByOrderItem?: Map<string, number>,
) {
  const qty = Number(it.qty ?? 1);
  const unitPrice = Number(it.unitPriceSen ?? 0);
  const discount = Number(it.discountSen ?? 0);
  const orderItemId = ((it.soItemId as string | undefined) ?? (it.consignmentSoItemId as string | undefined)) ?? undefined;
  const sourceCost = orderItemId ? sourceCostByOrderItem?.get(orderItemId) : undefined;
  const unitCost = sourceCost !== undefined ? sourceCost : Number(it.unitCostSen ?? 0);
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  return {
    consignment_delivery_order_id: noteId,
    consignment_so_item_id: (it.soItemId as string | undefined) ?? (it.consignmentSoItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty,
    m3_milli: Number(it.m3Milli ?? 0),
    unit_price_sen: unitPrice,
    discount_sen: discount,
    line_total_sen: lineTotal,
    unit_cost_sen: unitCost,
    line_cost_sen: lineCost,
    line_margin_sen: lineTotal - lineCost,
    variants,
    notes: (it.notes as string) ?? null,
    line_delivery_date: dateOrNull(it.lineDeliveryDate),
    line_delivery_date_overridden: Boolean(it.lineDeliveryDateOverridden ?? false),
  };
}

consignmentNotes.get('/', async (c) => {
  const sb = c.get('supabase');
  const status = c.req.query('status');

  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';
  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(200, Math.max(1, Math.trunc(psRaw))) : 50;

  let data: unknown[] | null;
  let count: number | null = null;
  let aggregates: { revenueSen: number; costSen: number; marginSen: number } | undefined;
  if (!paginate) {
    let q = sb.from('consignment_delivery_orders').select(HEADER).order('do_date', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    q = scopeToCompany(q, c);
    const res = await q;
    if (res.error) return c.json({ error: 'load_failed', reason: res.error.message }, 500);
    data = res.data ?? [];
  } else {
    const SORT_COLS = new Set(['do_date', 'do_number', 'debtor_name', 'status', 'local_total_sen']);
    const [rawCol, rawDir] = (c.req.query('sort') ?? 'do_date:desc').split(':');
    const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'do_date';
    const sortAsc = rawDir === 'asc';
    let q = sb.from('consignment_delivery_orders').select(HEADER, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
    if (sortCol !== 'id') q = q.order('id', { ascending: true });
    if (status) q = q.eq('status', status);
    const qText = c.req.query('q');
    if (qText) { const s = escapeForOr(qText); if (s) q = q.or(`do_number.ilike.%${s}%,debtor_name.ilike.%${s}%`); }
    q = scopeToCompany(q, c);
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);
    const res = await q;
    if (res.error) return c.json({ error: 'load_failed', reason: res.error.message }, 500);
    data = res.data ?? [];
    count = res.count ?? (res.data?.length ?? 0);

    const moneyRes = await paginateAll<{ local_total_sen: number | null; total_cost_sen: number | null; total_margin_sen: number | null }>((mfrom, mto) => {
      let mq = sb.from('consignment_delivery_orders').select('local_total_sen, total_cost_sen, total_margin_sen');
      if (status) mq = mq.eq('status', status);
      if (moneySkipsCancelled(status)) mq = mq.or(NOT_CANCELLED_OR);
      if (qText) { const s = escapeForOr(qText); if (s) mq = mq.or(`do_number.ilike.%${s}%,debtor_name.ilike.%${s}%`); }
      mq = scopeToCompany(mq, c);
      return mq.order('id').range(mfrom, mto);
    });
    if (moneyRes.error) return c.json({ error: 'load_failed', reason: moneyRes.error.message }, 500);
    let revenueSen = 0, costSen = 0, marginSen = 0;
    for (const m of (moneyRes.data ?? [])) {
      revenueSen += m.local_total_sen ?? 0;
      costSen += m.total_cost_sen ?? 0;
      marginSen += m.total_margin_sen ?? 0;
    }
    aggregates = { revenueSen, costSen, marginSen };
  }

  const rows = (data ?? []) as unknown as Array<{ id: string } & Record<string, unknown>>;
  const childIds = new Set<string>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const { data: crRes } = await chunkIn<{ consignment_do_id: string | null }>(ids, (batch, from, to) => sb.from('consignment_delivery_returns')
      .select('consignment_do_id').in('consignment_do_id', batch).neq('status', 'CANCELLED').range(from, to));
    for (const r of ((crRes ?? []) as Array<{ consignment_do_id: string | null }>)) {
      if (r.consignment_do_id) childIds.add(r.consignment_do_id);
    }
  }
  const consignmentNotesOut = rows.map((r) => ({ ...r, has_children: childIds.has(r.id) }));
  gateCnFinance(c, consignmentNotesOut, null);
  const aggregatesOut = canViewScmFinance(c)
    ? aggregates
    : (aggregates ? { revenueSen: aggregates.revenueSen } : undefined);
  if (paginate) return c.json({ deliveryOrders: consignmentNotesOut, total: count ?? consignmentNotesOut.length, page, pageSize, aggregates: aggregatesOut });
  return c.json({ deliveryOrders: consignmentNotesOut });
});

consignmentNotes.get('/deliverable-order-lines', async (c) => {
  const sb = c.get('supabase');
  // Company scope (owner 2026-08-10 audit): this picker enumerated EVERY
  // company's consignment orders while the sibling GET / was scoped.
  const { data: orders, error: oErr } = await paginateAll<{ doc_no: string; debtor_code: string | null; debtor_name: string | null }>((from, to) => scopeToCompany(sb
    .from('consignment_sales_orders')
    .select('doc_no, debtor_code, debtor_name'), c)
    .order('so_date', { ascending: false })
    .range(from, to));
  if (oErr) return c.json({ error: 'load_failed', reason: oErr.message }, 500);
  const orderList = (orders ?? []) as Array<{ doc_no: string; debtor_code: string | null; debtor_name: string | null }>;
  if (orderList.length === 0) return c.json({ lines: [] });
  const orderByDoc = new Map(orderList.map((o) => [o.doc_no, o]));
  const docNos = orderList.map((o) => o.doc_no);

  const { data: items, error: iErr } = await chunkIn<Record<string, unknown>>(docNos, (batch, from, to) => sb
    .from('consignment_sales_order_items')
    .select('id, doc_no, item_code, item_group, description, description2, uom, qty, unit_price_sen, discount_sen, unit_cost_sen, variants, cancelled')
    .in('doc_no', batch)
    .range(from, to));
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  const itemList = (items ?? []).filter((it: Record<string, unknown>) => !it.cancelled) as Array<Record<string, unknown>>;
  if (itemList.length === 0) return c.json({ lines: [] });
  const itemIds = itemList.map((it) => it.id as string);

  const { data: noteRows, error: noteErr } = await paginateAll<{ id: string }>((from, to) => scopeToCompany(sb
    .from('consignment_delivery_orders')
    .select('id, status')
    .neq('status', 'CANCELLED'), c)
    .order('id', { ascending: true })
    .range(from, to));
  if (noteErr) return c.json({ error: 'load_failed', reason: noteErr.message }, 500);
  const liveNoteIds = new Set(((noteRows ?? []) as Array<{ id: string }>).map((r) => r.id));
  const { data: noteItems } = await chunkIn<{ consignment_delivery_order_id: string; consignment_so_item_id: string | null; qty: number }>(itemIds, (batch, from, to) => sb
    .from('consignment_delivery_order_items')
    .select('consignment_delivery_order_id, consignment_so_item_id, qty')
    .in('consignment_so_item_id', batch)
    .range(from, to));
  const deliveredByItem = new Map<string, number>();
  for (const r of ((noteItems ?? []) as Array<{ consignment_delivery_order_id: string; consignment_so_item_id: string | null; qty: number }>)) {
    if (!r.consignment_so_item_id || !liveNoteIds.has(r.consignment_delivery_order_id)) continue;
    deliveredByItem.set(r.consignment_so_item_id, (deliveredByItem.get(r.consignment_so_item_id) ?? 0) + Number(r.qty ?? 0));
  }

  const lines = itemList.map((it) => {
    const o = orderByDoc.get(it.doc_no as string);
    const ordered = Number(it.qty ?? 0);
    const delivered = deliveredByItem.get(it.id as string) ?? 0;
    return {
      orderItemId: it.id as string,
      orderDocNo: it.doc_no as string,
      debtorCode: o?.debtor_code ?? null,
      debtorName: o?.debtor_name ?? null,
      itemCode: it.item_code as string,
      itemGroup: (it.item_group as string | null) ?? null,
      description: (it.description as string | null) ?? null,
      description2: (it.description2 as string | null) ?? null,
      uom: (it.uom as string | null) ?? null,
      ordered,
      delivered,
      outstanding: ordered - delivered,
      unitPriceSen: Number(it.unit_price_sen ?? 0),
      discountSen: Number(it.discount_sen ?? 0),
      unitCostSen: Number(it.unit_cost_sen ?? 0),
      variants: it.variants ?? null,
    };
  }).filter((l) => l.outstanding > 0);

  if (!canViewScmFinance(c)) {
    for (const l of lines) delete (l as unknown as Record<string, unknown>).unitCostSen;
  }
  return c.json({ lines });
});

consignmentNotes.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('consignment_delivery_orders').select(HEADER).eq('id', id), c).maybeSingle(),
    sb.from('consignment_delivery_order_items').select(ITEM).eq('consignment_delivery_order_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  const { count: crCount } = await sb.from('consignment_delivery_returns')
    .select('id', { head: true, count: 'exact' })
    .eq('consignment_do_id', id).neq('status', 'CANCELLED');
  const consignmentNote = {
    ...(h.data as unknown as Record<string, unknown>),
    has_children: (crCount ?? 0) > 0,
  };
  const rawItems = (i.data ?? []) as unknown as Array<{ id: string; consignment_so_item_id?: string | null } & Record<string, unknown>>;
  const headerWh = (h.data as { warehouse_id?: string | null }).warehouse_id ?? null;
  const lineWh = await resolveNoteLineWarehouses(sb, rawItems, headerWh, activeCompanyId(c));
  const codeMap = await warehouseCodeMap(sb, [...lineWh.values()]);
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    return { ...it, warehouse_id: wid, warehouse_code: wid ? (codeMap.get(wid) ?? null) : null };
  });
  gateCnFinance(c, consignmentNote, items);
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ deliveryOrder: consignmentNote, items });
});

consignmentNotes.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  let items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];

  const sb = c.get('supabase'); const user = c.get('user');

  if (items.length > 0) {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined), activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* THE GROUP IS THE SKU'S, AND IT IS DECIDED ONCE — docs/bugs/0524.
     `item_group` is not a label, it is the input to the stock bucket
     (shared/variant-key.ts): the OUT that sends the goods to the showroom floor is keyed from the group
     STORED on the line, so a client that sends a blank or wrong one picks the
     bucket. Rewritten here, above every reader, so the value written and the
     value later keyed from cannot differ. #2660 closed the inbound half. */
  items = await resolveItemGroups(sb, items, activeCompanyId(c) ?? null);

  {
    const xl = await assertSourceLinesInCompany(sb, c, 'consignment_sales_order_items',
      items.map((it) => (it.soItemId ?? it.consignmentSoItemId) as string | undefined));
    if (!xl.ok) return c.json(xl.body, xl.status);
    const soDocNo = (body.consignmentSoDocNo as string) ?? (body.soDocNo as string) ?? null;
    if (soDocNo) {
      const { data: co, error: coErr } = await scopeToCompany(
        sb.from('consignment_sales_orders').select('doc_no').eq('doc_no', soDocNo), c).maybeSingle();
      if (coErr) return c.json({ error: 'source_check_failed', reason: coErr.message }, 500);
      if (!co) return c.json({ error: 'consignment_order_not_found', docNo: soDocNo }, 404);
    }
  }


  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; do_number: string }>(
    () => nextNum(sb, c),
    (doNumber) => sb.from('consignment_delivery_orders').insert({
    company_id: activeCompanyId(c),
    do_number: doNumber,
    consignment_so_doc_no: (body.consignmentSoDocNo as string) ?? (body.soDocNo as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: debtorName,
    do_date: dateOrNull(body.doDate) ?? todayMyt(),
    expected_delivery_at: dateOrNull(body.expectedDeliveryAt) ?? dateOrNull(body.customerDeliveryDate),
    customer_delivery_date: dateOrNull(body.customerDeliveryDate),
    driver_id: (body.driverId as string) ?? null,
    driver_name: (body.driverName as string) ?? null,
    vehicle: (body.vehicle as string) ?? null,
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    city: (body.city as string) ?? null,
    state: (body.state as string) ?? (body.customerState as string) ?? null,
    customer_state: (body.customerState as string) ?? (body.state as string) ?? null,
    customer_country: (body.customerCountry as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    phone: phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null,
    salesperson_id: (body.salespersonId as string) ?? null,
    agent: (body.agent as string) ?? null,
    email: (body.email as string) ?? null,
    customer_type: (body.customerType as string) ?? null,
    building_type: (body.buildingType as string) ?? null,
    branding: (body.branding as string) ?? null,
    venue: (body.venue as string) ?? null,
    venue_id: (body.venueId as string) ?? null,
    ref: (body.ref as string) ?? null,
    customer_so_no: (body.customerSoNo as string) ?? null,
    po_doc_no: (body.poDocNo as string) ?? null,
    sales_location: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    warehouse_id: (body.warehouseId as string) ?? null,
    currency: (body.currency as string) ?? 'MYR',
    status: 'DISPATCHED',
    notes: (body.notes as string) ?? null,
    created_by: user.id,
    }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; do_number: string };

  if (items.length > 0) {
    const sourceCostByOrderItem = await sourceUnitCostByItemId(
      sb, 'consignment_sales_order_items',
      items.map((it: Record<string, unknown>) => (it.soItemId ?? it.consignmentSoItemId) as string | undefined),
    activeCompanyId(c) ?? null);
    const rows = items.map((it) => buildItemRow(h.id, it, sourceCostByOrderItem));
    const { error: iErr } = await sb.from('consignment_delivery_order_items').insert(stampCompany(rows, c));
    if (iErr) { await sb.from('consignment_delivery_orders').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
    await recomputeTotals(sb, h.id);
  }

  const movementErrors = await resyncNoteInventory(sb, h.id, user.id);

  return c.json({ id: h.id, doNumber: h.do_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

consignmentNotes.patch('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
    ['address1', 'address1'], ['address2', 'address2'],
    ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
    ['note', 'note'], ['notes', 'notes'],
    ['soDate', 'do_date'], ['doDate', 'do_date'], ['currency', 'currency'],
    ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
    ['customerSoNo', 'customer_so_no'],
    ['customerDeliveryDate', 'customer_delivery_date'],
    ['expectedDeliveryAt', 'expected_delivery_at'],
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
    ['driverId', 'driver_id'], ['driverName', 'driver_name'], ['vehicle', 'vehicle'],
    ['emergencyContactName', 'emergency_contact_name'],
    ['emergencyContactPhone', 'emergency_contact_phone'],
    ['emergencyContactRelationship', 'emergency_contact_relationship'],
  ];
  const PHONE_FIELDS = new Set(['phone', 'emergencyContactPhone']);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of map) {
    if (body[from] === undefined) continue;
    if (PHONE_FIELDS.has(from) && typeof body[from] === 'string') {
      const raw = body[from] as string;
      updates[to] = normalizePhone(raw) ?? raw;
    } else {
      updates[to] = body[from];
    }
  }
  coerceEmptyDates(updates);
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  /* Header lock — FIELD-LEVEL (owner 2026-08-20, §8 GAP-1): once a Consignment
     Return exists only the columns it inherits (customer + currency + location +
     branding) freeze; the Note's own delivery dates, dispatch and notes stay
     editable. Mirrors the DO. */
  {
    const { data: before, error: bErr } = await scopeToCompanyId(sb.from('consignment_delivery_orders')
      .select('debtor_code, debtor_name, currency, sales_location, branding').eq('id', id), co.companyId).maybeSingle();
    if (bErr) return c.json({ error: 'update_failed', reason: bErr.message }, 500);
    const locked = before ? changedLockedCols(CN_IDENTITY_LOCK_COLS, updates, before as Record<string, unknown>) : [];
    if (locked.length > 0 && (await noteHasDownstream(sb, id))) {
      return c.json(identityLockedRefusal({
        error: 'cn_identity_locked', fields: locked, labels: CN_IDENTITY_LABELS,
        what: 'Consignment Note', child: 'Consignment Return', ownFields: 'delivery dates, dispatch details and notes',
      }), 409);
    }
  }

  const { data, error } = await scopeToCompanyId(sb.from('consignment_delivery_orders').update(updates).eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true, id });
});

consignmentNotes.post('/:id/items', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);

  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* SKU wins, decided once — docs/bugs/0524. Same rule as the create path: the
     stored group is what the stock movement is keyed from. */
  it = (await resolveItemGroups(sb, [it], activeCompanyId(c) ?? null))[0]!;

  const childLock = await noteHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  const { data: header } = await scopeToCompanyId(sb.from('consignment_delivery_orders').select('id, status, warehouse_id').eq('id', id), co.companyId).maybeSingle();
  if (!header) return c.json(NOT_THIS_COMPANY, 404);

  {
    const xl = await assertSourceLinesInCompany(sb, c, 'consignment_sales_order_items',
      [(it.soItemId ?? it.consignmentSoItemId) as string | undefined]);
    if (!xl.ok) return c.json(xl.body, xl.status);
  }

  const row = buildItemRow(id, it, await sourceUnitCostByItemId(
    sb, 'consignment_sales_order_items', [(it.soItemId ?? it.consignmentSoItemId) as string | undefined],
    activeCompanyId(c) ?? null));
  const { data, error } = await sb.from('consignment_delivery_order_items').insert({ company_id: activeCompanyId(c), ...row }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  gateCnFinance(c, null, data);
  await recomputeTotals(sb, id);
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncNoteInventory(sb, id, user?.id ?? null); }
  catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  return c.json({ item: data, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) }, 201);
});

consignmentNotes.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const childLock = await noteHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  const { data: prev } = await scopeToCompanyId(sb.from('consignment_delivery_order_items')
    .select('qty, unit_price_sen, discount_sen, unit_cost_sen, item_code, item_group, description, uom, variants, notes, consignment_so_item_id')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);

  /* SKU wins on the EDIT half too — docs/bugs/0524. An edit that names a group,
     or re-points the code, decides which bucket this line's stock resync moves;
     the group stored is the SKU's. Every reader below takes
     `it.itemGroup ?? prev.item_group`, so one assignment settles the stored
     column, description2 and the resync's key together.
     ONLY when the request touches identity. An edit that changes neither is
     left exactly as it was: repairing rows this request did not touch is a
     different, write-shaped job that needs the probe's count first (#2671). */
  if (it.itemGroup !== undefined || it.itemCode !== undefined) {
    const [resolved] = await resolveItemGroups(sb, [{
      itemCode: (it.itemCode ?? prev.item_code) as string | null,
      itemGroup: (it.itemGroup ?? prev.item_group) as string | null,
    }], activeCompanyId(c) ?? null);
    it.itemGroup = resolved?.itemGroup ?? null;
  }

  const qty = it.qty !== undefined ? Number(it.qty) : Number(prev.qty);
  const unitPrice = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : Number(prev.unit_price_sen);
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : Number(prev.discount_sen);
  const unitCost = (canViewScmFinance(c) && it.unitCostSen !== undefined)
    ? Number(it.unitCostSen)
    : Number(prev.unit_cost_sen);
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = {
    qty, unit_price_sen: unitPrice, discount_sen: discount, unit_cost_sen: unitCost,
    line_total_sen: lineTotal, line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'],
    ['lineDeliveryDate', 'line_delivery_date'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  coerceEmptyDates(updates);
  if (it.lineDeliveryDate !== undefined) updates['line_delivery_date_overridden'] = true;
  if (it.lineDeliveryDateOverridden !== undefined) updates['line_delivery_date_overridden'] = Boolean(it.lineDeliveryDateOverridden);
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const { error } = await scopeToCompanyId(sb.from('consignment_delivery_order_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncNoteInventory(sb, id, c.get('user')?.id ?? null); }
  catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  return c.json({ ok: true, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) });
});

consignmentNotes.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const childLock = await noteHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  const { data: del, error } = await scopeToCompanyId(sb.from('consignment_delivery_order_items').delete().eq('id', itemId), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!del) return c.json(NOT_THIS_COMPANY, 404);
  await recomputeTotals(sb, id);
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncNoteInventory(sb, id, c.get('user')?.id ?? null); }
  catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  return c.json({ ok: true, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) });
});

consignmentNotes.get('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data, error } = await scopeToCompany(sb
    .from('consignment_delivery_order_payments')
    .select(`${PAYMENT_COLS}, staff:collected_by ( name )`)
    .eq('consignment_delivery_order_id', id), c)
    .order('paid_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const payments = (data ?? []).map((r: unknown) => {
    const row = r as Record<string, unknown> & { staff: { name: string } | null };
    const { staff, ...rest } = row;
    return { ...rest, collected_by_name: staff?.name ?? null };
  });
  return c.json({ payments });
});

const paymentCreateSchema = z.object({
  paidAt:             z.string().min(1),
  method:             z.enum(PAYMENT_METHOD_CODES),
  merchantProvider:   z.string().trim().min(1).optional().nullable(),
  installmentMonths:  z.number().int().min(0).max(60).optional().nullable(),
  onlineType:         z.string().trim().min(1).optional().nullable(),
  approvalCode:       z.string().optional().nullable(),
  amountSen:        z.number().int().nonnegative(),
  accountSheet:       z.string().optional().nullable(),
  collectedBy:        z.string().uuid().optional().nullable(),
  note:               z.string().optional().nullable(),
});

consignmentNotes.post('/:id/payments', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: doc } = await scopeToCompanyId(sb.from('consignment_delivery_orders').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!doc) return c.json(NOT_THIS_COMPANY, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const merchantLike      = p.method === 'merchant' || p.method === 'installment';
  const merchantProvider  = merchantLike ? (p.merchantProvider ?? null) : null;
  const installmentMonths = merchantLike
    ? (typeof p.installmentMonths === 'number' && p.installmentMonths > 0 ? p.installmentMonths : null)
    : null;
  const onlineType        = p.method === 'transfer' ? (p.onlineType ?? null) : null;

  const { data, error } = await sb.from('consignment_delivery_order_payments').insert({
    company_id:         activeCompanyId(c),
    consignment_delivery_order_id: id,
    paid_at:            p.paidAt,
    method:             p.method,
    merchant_provider:  merchantProvider,
    installment_months: installmentMonths,
    online_type:        onlineType,
    approval_code:      p.approvalCode ?? null,
    amount_sen:       p.amountSen,
    account_sheet:      p.accountSheet ?? null,
    collected_by:       p.collectedBy ?? null,
    note:               p.note ?? null,
    created_by:         user.id,
  }).select(PAYMENT_COLS).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  return c.json({ payment: data }, 201);
});

consignmentNotes.delete('/:id/payments/:paymentId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const paymentId = c.req.param('paymentId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: row } = await scopeToCompanyId(sb.from('consignment_delivery_order_payments').select('consignment_delivery_order_id').eq('id', paymentId), co.companyId).maybeSingle();
  if (!row) return c.json(NOT_THIS_COMPANY, 404);
  if ((row as { consignment_delivery_order_id: string }).consignment_delivery_order_id !== id) return c.json({ error: 'payment_doc_mismatch' }, 400);
  const { error } = await scopeToCompanyId(sb.from('consignment_delivery_order_payments').delete().eq('id', paymentId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

export const patchConsignmentNoteStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { status?: string }; try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  const toStatus = String(body.status).trim().toUpperCase();
  if (!(DO_STATUSES as readonly string[]).includes(toStatus)) {
    return c.json({ error: 'invalid_status', message: `"${String(body.status)}" is not a consignment note status. Use one of: ${DO_STATUSES.join(', ')}.` }, 400);
  }

  const { data: cur } = await scopeToCompanyId(sb.from('consignment_delivery_orders').select('status').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const prevStatus = (cur as { status: string }).status;
  if (toStatus === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ consignmentNote: { id, status: 'CANCELLED' } });
  }

  if (prevStatus === 'CANCELLED') {
    return c.json({ error: 'note_cancelled_final', message: 'A cancelled Consignment Note cannot be reactivated — its ship-out was already reversed. Create a new note.' }, 409);
  }

  if (toStatus === 'CANCELLED') {
    const childLock = await noteHasDownstream(sb, id);
    if (childLock) return c.json(childLock, 409);
  }

  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now };
  if (toStatus === 'DISPATCHED') ts.dispatched_at = now;
  if (toStatus === 'SIGNED')     ts.signed_at = now;
  if (toStatus === 'DELIVERED')  ts.delivered_at = now;

  let data: { id: string; status: string } | null;
  if (toStatus === 'CANCELLED') {
    const { data: updated, error } = await scopeToCompanyId(sb.from('consignment_delivery_orders')
      .update({ status: toStatus, ...ts })
      .eq('id', id).neq('status', 'CANCELLED'), co.companyId)
      .select('id, status').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) return c.json({ consignmentNote: { id, status: 'CANCELLED' } });
    data = updated as { id: string; status: string };
  } else {
    const { data: updated, error } = await scopeToCompanyId(sb.from('consignment_delivery_orders')
      .update({ status: toStatus, ...ts }).eq('id', id), co.companyId)
      .eq('status', prevStatus).select('id, status').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) return c.json({ error: 'status_changed', message: 'This consignment note just changed. Reload it and try again.' }, 409);
    data = updated as { id: string; status: string };
  }

  let resyncErrs: string[] = [];
  if (SHIPPED_STATES.includes(toStatus) || toStatus === 'CANCELLED') {
    resyncErrs = [];
    try { resyncErrs = await resyncNoteInventory(sb, id, user.id); }
    catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  }

    return c.json({ consignmentNote: data, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) });
};
consignmentNotes.patch('/:id/status', patchConsignmentNoteStatusHandler);
