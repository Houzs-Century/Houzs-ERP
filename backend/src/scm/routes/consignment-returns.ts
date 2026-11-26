
import { yymmFor } from '../../services/documentRefs';
import { Hono } from 'hono';
import { normalizePhone } from '../shared/phone';
import { buildVariantSummary } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { defaultWarehouseId, writeMovements, resolveWarehouseLotBatches, resolveWarehouseLotCosts } from '../lib/inventory-movements';
import { nameTheShipOutsReturned } from '../lib/consignment-return-reversal';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { computeVariantKey, type VariantAttrs } from '../shared';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { resolveItemGroups } from '../lib/sku-category';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { warehouseLabel } from '../lib/warehouse-label';
import { todayMyt } from '../lib/my-time';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { escapeForOr } from '../lib/postgrest-search';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { sourceUnitCostByItemId } from '../lib/source-cost';
import { assertSourceLinesInCompany } from '../lib/ref-in-company';
import { unlinkedEditRefusal } from '../lib/unlinked-line-edit-guard';
import { foldTargetsIntoOwnBuckets, stockBucketKeyResolver } from '../lib/stock-bucket-key';

export const consignmentReturns = new Hono<{ Bindings: Env; Variables: Variables }>();
consignmentReturns.use('*', supabaseAuth);

const HEADER =
  'id, return_number, do_doc_no, consignment_do_id, ' +
  'debtor_code, debtor_name, return_date, reason, status, ' +
  'received_at, inspected_at, refunded_at, refund_sen, inspection_notes, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, sales_location, customer_state, customer_country, note, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, ' +
  'mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, ' +
  'local_total_sen, total_cost_sen, total_margin_sen, margin_pct_basis, line_count, ' +
  'currency, warehouse_id, notes, created_at, created_by, updated_at';

const ITEM =
  'id, consignment_delivery_return_id, consignment_do_item_id, item_code, item_group, description, description2, ' +
  'uom, qty_returned, condition, unit_price_sen, discount_sen, line_total_sen, ' +
  'unit_cost_sen, line_cost_sen, line_margin_sen, refund_sen, variants, notes, created_at';

const CRN_FINANCE_KEYS = [
  'mattress_sofa_sen', 'bedframe_sen', 'accessories_sen', 'others_sen',
  'mattress_sofa_cost_sen', 'bedframe_cost_sen', 'accessories_cost_sen', 'others_cost_sen',
  'total_cost_sen', 'total_margin_sen', 'margin_pct_basis',
] as const;


function gateCrnFinance(
  c: Parameters<typeof canViewScmFinance>[0],
  deliveryReturn: unknown,
  items: unknown,
): void {
  if (canViewScmFinance(c)) return;
  for (const h of (Array.isArray(deliveryReturn) ? deliveryReturn : [deliveryReturn]) as Array<unknown>) {
    if (h && typeof h === 'object') {
      for (const k of CRN_FINANCE_KEYS) delete (h as Record<string, unknown>)[k];
    }
  }
  for (const it of (Array.isArray(items) ? items : items ? [items] : []) as Array<Record<string, unknown>>) {
    for (const k of SO_ITEM_FINANCE_KEYS) delete it[k];
  }
}

const nextNum = async (sb: any, c: any): Promise<string> => {
  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'consignment_delivery_returns', 'return_number', `${p}CRN-${yymm}`);
};

async function recomputeTotals(sb: any, returnId: string) {
  const { data: items, error: itemsErr } = await sb.from('consignment_delivery_return_items')
    .select('item_group, line_total_sen, line_cost_sen')
    .eq('consignment_delivery_return_id', returnId);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[crn-recompute] item read failed — header left unchanged:', returnId, itemsErr.message);
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
  const { error: updErr } = await sb.from('consignment_delivery_returns').update({
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
    refund_sen: total,
    updated_at: new Date().toISOString(),
  }).eq('id', returnId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[crn-recompute] header update failed — totals left STALE:', returnId, updErr.message);
  }
}

async function resolveReturnLineWarehouses(
  sb: any,
  items: Array<{ id: string; consignment_do_item_id?: string | null }>,
  headerWarehouseId: string | null,
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const cnItemIds = [...new Set(items
    .map((it) => it.consignment_do_item_id ?? null)
    .filter((x): x is string => !!x))];

  const cnLineMeta = new Map<string, { soItemId: string | null; cnWarehouseId: string | null }>();
  const soItemIds = new Set<string>();
  if (cnItemIds.length > 0) {
    const { data: cnLines } = await sb.from('consignment_delivery_order_items')
      .select('id, consignment_so_item_id, consignment_delivery_order_id').in('id', cnItemIds);
    const cnRows = (cnLines ?? []) as Array<{ id: string; consignment_so_item_id: string | null; consignment_delivery_order_id: string }>;
    const cnIds = [...new Set(cnRows.map((r) => r.consignment_delivery_order_id).filter(Boolean))];
    const cnHeaderWh = new Map<string, string | null>();
    if (cnIds.length > 0) {
      const { data: cnHeaders } = await sb.from('consignment_delivery_orders')
        .select('id, warehouse_id').in('id', cnIds);
      for (const d of (cnHeaders ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
        cnHeaderWh.set(d.id, d.warehouse_id ?? null);
      }
    }
    for (const r of cnRows) {
      if (r.consignment_so_item_id) soItemIds.add(r.consignment_so_item_id);
      cnLineMeta.set(r.id, { soItemId: r.consignment_so_item_id ?? null, cnWarehouseId: cnHeaderWh.get(r.consignment_delivery_order_id) ?? null });
    }
  }

  const soWh = new Map<string, string | null>();
  if (soItemIds.size > 0) {
    const { data: soRows } = await sb.from('consignment_sales_order_items')
      .select('id, warehouse_id').in('id', [...soItemIds]);
    for (const r of (soRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      soWh.set(r.id, r.warehouse_id ?? null);
    }
  }

  const fallback = headerWarehouseId ?? (await defaultWarehouseId(sb, companyId));
  for (const it of items) {
    const meta = it.consignment_do_item_id ? cnLineMeta.get(it.consignment_do_item_id) : undefined;
    const fromSo = meta?.soItemId ? (soWh.get(meta.soItemId) ?? null) : null;
    out.set(it.id, fromSo ?? meta?.cnWarehouseId ?? fallback);
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

async function resyncReturnInventory(sb: any, returnId: string, performedBy: string | null): Promise<string[]> {
  const { data: header } = await sb.from('consignment_delivery_returns')
    .select('return_number, status, warehouse_id, company_id, consignment_do_id').eq('id', returnId).maybeSingle();
  if (!header) return [];
  const status = ((header as { status: string | null }).status ?? '').toUpperCase();
  const returnNo = (header as { return_number: string }).return_number ?? returnId;
  const cancelled = status === 'CANCELLED';

  type Bucket = { warehouse_id: string; item_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled) {
    const { data: items } = await sb.from('consignment_delivery_return_items')
      .select('id, consignment_do_item_id, item_code, description, qty_returned, unit_cost_sen, item_group, variants')
      .eq('consignment_delivery_return_id', returnId);
    const headerWarehouseId = (header as { warehouse_id: string | null }).warehouse_id ?? null;
    const lineWh = await resolveReturnLineWarehouses(
      sb,
      (items ?? []) as Array<{ id: string; consignment_do_item_id?: string | null }>,
      headerWarehouseId,
      (header as { company_id?: number | null }).company_id ?? undefined,
    );
    const distinctWh = [...new Set(((items ?? []) as Array<{ id: string }>).map((it) => lineWh.get(it.id)).filter((x): x is string => !!x))];
    const batchByWh = new Map<string, Map<string, string | null>>();
    const costByWh = new Map<string, Map<string, number>>();
    for (const wh of distinctWh) { batchByWh.set(wh, await resolveWarehouseLotBatches(sb, wh)); costByWh.set(wh, await resolveWarehouseLotCosts(sb, wh)); }
    const keyOf = await stockBucketKeyResolver(sb, (header as { company_id?: number | null }).company_id ?? null,
      ((items ?? []) as Array<{ id: string; item_code: string; item_group?: string | null; variants?: VariantAttrs | null }>).map((it) => ({ item_code: it.item_code, item_group: it.item_group ?? null, variants: it.variants ?? null, warehouse_id: lineWh.get(it.id) ?? null })));
    for (const it of ((items ?? []) as Array<{ id: string; item_code: string; description: string | null; qty_returned: number; unit_cost_sen?: number | null; item_group?: string | null; variants?: VariantAttrs | null }>)) {
      const qty = Number(it.qty_returned ?? 0);
      if (qty <= 0) continue;
      const wh = lineWh.get(it.id) ?? null;
      if (!wh) continue;
      const vk = keyOf({ item_code: it.item_code, item_group: it.item_group ?? null, variants: it.variants ?? null, warehouse_id: lineWh.get(it.id) ?? null });
      const batch = batchByWh.get(wh)?.get(`${it.item_code}::${vk}`) ?? null;
      const lineCost = Number(it.unit_cost_sen ?? 0);
      const unitCost = lineCost > 0 ? lineCost : (costByWh.get(wh)?.get(`${it.item_code}::${vk}`) ?? 0);
      const k = `${wh}::${it.item_code}::${vk}::${batch ?? ''}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: wh, item_code: it.item_code, variant_key: vk, product_name: it.description, qty, unit_cost_sen: unitCost, batch_no: batch });
    }
  }

  const { data: movs } = await sb.from('inventory_movements')
    .select('movement_type, warehouse_id, item_code, variant_key, batch_no, qty, total_cost_sen, product_name')
    .eq('source_doc_id', returnId)
    .in('source_doc_type', ['CS_DR', 'STOCK_TRANSFER']);
  type Agg = { in_qty: number; out_qty: number; in_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of (movs ?? []) as Array<{ movement_type: string; warehouse_id: string; item_code: string; variant_key: string | null; batch_no?: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>) {
    const k = `${m.warehouse_id}::${m.item_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { in_qty: 0, out_qty: 0, in_total_cost: 0, product_name: m.product_name }; aggByBucket.set(k, a); }
    if (m.movement_type === 'IN') { a.in_qty += Number(m.qty ?? 0); a.in_total_cost += Number(m.total_cost_sen ?? 0); }
    else if (m.movement_type === 'OUT') a.out_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.product_name;
  }

  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const csDrEmitted = new Set<string>();
  foldTargetsIntoOwnBuckets(targetByBucket, aggByBucket.keys(), (header as { company_id?: number | null }).company_id ?? null);
  for (const k of new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()])) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { in_qty: 0, out_qty: 0, in_total_cost: 0, product_name: null };
    const delta = (t?.qty ?? 0) - (a.in_qty - a.out_qty);
    if (delta === 0) continue;
    const [wh, pc, vk, batchSeg] = k.split('::');
    const batch_no = batchSeg || null;
    const pname = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      const neverMoved = a.in_qty === 0 && a.out_qty === 0;
      const useCsDr = neverMoved && !csDrEmitted.has(`${pc}::${vk}`);
      if (useCsDr) csDrEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: 'IN', warehouse_id: wh ?? '', item_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: delta, unit_cost_sen: t?.unit_cost_sen ?? 0,
        source_doc_type: useCsDr ? 'CS_DR' : 'STOCK_TRANSFER',
        source_doc_id: returnId, source_doc_no: returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: useCsDr ? 'Consignment Return — stock back IN' : 'Consignment Return resync: line qty increased / added.',
      });
    } else {
      writes.push({
        movement_type: 'OUT', warehouse_id: wh ?? '', item_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: -delta,
        source_doc_type: 'STOCK_TRANSFER',
        source_doc_id: returnId, source_doc_no: cancelled ? `${returnNo}-CANCEL` : returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: cancelled ? 'Consignment Return cancelled — stock out again' : 'Consignment Return resync: line qty reduced / deleted.',
      });
    }
  }

  if (writes.length === 0) return [];
  await nameTheShipOutsReturned(sb, writes, returnId, (header as { consignment_do_id?: string | null }).consignment_do_id ?? null);
  const res = await writeMovements(sb, writes, (header as { company_id?: number | null }).company_id ?? null);
  if (res.ok) await reconcileUncostedAfterIn(sb, writes, performedBy);
  try {
    const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
    await recomputeAllocationAfterSave(sb, 'consignment-return');
  } catch { }
  return res.ok ? [] : [res.reason ?? 'consignment return inventory resync failed'];
}

function buildItemRow(
  returnId: string,
  it: Record<string, unknown>,
  sourceCostByNoteItem?: Map<string, number>,
) {
  const qty = Number(it.qtyReturned ?? it.qty ?? 1);
  const unitPrice = Number(it.unitPriceSen ?? 0);
  const discount = Number(it.discountSen ?? 0);
  const noteItemId = ((it.doItemId as string | undefined) ?? (it.consignmentDoItemId as string | undefined)) ?? undefined;
  const sourceCost = noteItemId ? sourceCostByNoteItem?.get(noteItemId) : undefined;
  const unitCost = sourceCost !== undefined ? sourceCost : Number(it.unitCostSen ?? 0);
  const lineTotal = (qty * unitPrice) - discount;
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  const refund = it.refundSen !== undefined ? Number(it.refundSen) : lineTotal;
  return {
    consignment_delivery_return_id: returnId,
    consignment_do_item_id: (it.doItemId as string | undefined) ?? (it.consignmentDoItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty_returned: qty,
    condition: (it.condition as string) ?? null,
    unit_price_sen: unitPrice,
    discount_sen: discount,
    line_total_sen: lineTotal,
    unit_cost_sen: unitCost,
    line_cost_sen: lineCost,
    line_margin_sen: lineTotal - lineCost,
    refund_sen: refund,
    variants,
    notes: (it.notes as string | undefined) ?? null,
  };
}

consignmentReturns.get('/', async (c) => {
  const sb = c.get('supabase');
  const status = c.req.query('status');

  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  if (!paginate) {
    let q = sb.from('consignment_delivery_returns').select(HEADER).order('return_date', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    q = scopeToCompany(q, c);
    const { data, error } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    gateCrnFinance(c, data ?? [], null);
    return c.json({ deliveryReturns: data ?? [] });
  }

  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(200, Math.max(1, Math.trunc(psRaw))) : 50;

  const SORT_COLS = new Set(['return_date', 'return_number', 'debtor_name', 'status', 'local_total_sen']);
  const [rawCol, rawDir] = (c.req.query('sort') ?? 'return_date:desc').split(':');
  const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'return_date';
  const sortAsc = rawDir === 'asc';
  let q = sb.from('consignment_delivery_returns').select(HEADER, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
  if (sortCol !== 'id') q = q.order('id', { ascending: true });
  if (status) q = q.eq('status', status);
  const qText = c.req.query('q');
  if (qText) { const s = escapeForOr(qText); if (s) q = q.or(`return_number.ilike.%${s}%,debtor_name.ilike.%${s}%`); }
  q = scopeToCompany(q, c);
  q = q.range(page * pageSize, page * pageSize + pageSize - 1);
  const { data, error, count } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const moneyRes = await paginateAll<{ local_total_sen: number | null; total_cost_sen: number | null; total_margin_sen: number | null }>((mfrom, mto) => {
    let mq = sb.from('consignment_delivery_returns').select('local_total_sen, total_cost_sen, total_margin_sen');
    if (status) mq = mq.eq('status', status);
    if (qText) { const s = escapeForOr(qText); if (s) mq = mq.or(`return_number.ilike.%${s}%,debtor_name.ilike.%${s}%`); }
    mq = scopeToCompany(mq, c);
    return mq.range(mfrom, mto);
  });
  if (moneyRes.error) return c.json({ error: 'load_failed', reason: moneyRes.error.message }, 500);
  let revenueSen = 0, costSen = 0, marginSen = 0;
  for (const m of (moneyRes.data ?? [])) {
    revenueSen += m.local_total_sen ?? 0;
    costSen += m.total_cost_sen ?? 0;
    marginSen += m.total_margin_sen ?? 0;
  }
  gateCrnFinance(c, data ?? [], null);
  const aggregates = canViewScmFinance(c)
    ? { revenueSen, costSen, marginSen }
    : { revenueSen };
  return c.json({ deliveryReturns: data ?? [], total: count ?? (data?.length ?? 0), page, pageSize, aggregates });
});

consignmentReturns.get('/returnable-note-lines', async (c) => {
  const sb = c.get('supabase');
  // Company scope (owner 2026-08-10 audit): sibling GET / was scoped, this
  // picker was not — it listed every company's consignment notes.
  /* STATUS-FILTERED (owner 2026-08-13). This claimed to "mirror the DO→DR
     /returnable-do-lines endpoint" and did not: that one skips CANCELLED and
     DRAFT (lib/do-line-remaining.ts:106) and this one took every note. A
     cancelled consignment note has ALREADY had its stock driven back to zero
     (consignment-notes.ts:269), yet its lines still showed remaining > 0 — so
     the same units could be booked IN a second time. A DRAFT note has shipped
     nothing at all. */
  const { data: notes, error: nErr } = await paginateAll<{ id: string; do_number: string; debtor_code: string | null; debtor_name: string | null }>((from, to) => scopeToCompany(sb
    .from('consignment_delivery_orders')
    .select('id, do_number, debtor_code, debtor_name')
    .neq('status', 'CANCELLED')
    .neq('status', 'DRAFT'), c)
    .order('do_number', { ascending: false })
    .range(from, to));
  if (nErr) return c.json({ error: 'load_failed', reason: nErr.message }, 500);
  const noteList = (notes ?? []) as Array<{ id: string; do_number: string; debtor_code: string | null; debtor_name: string | null }>;
  if (noteList.length === 0) return c.json({ lines: [] });
  const noteById = new Map(noteList.map((n) => [n.id, n]));
  const noteIds = noteList.map((n) => n.id);

  const { data: items, error: iErr } = await chunkIn<Record<string, unknown>>(noteIds, (batch, from, to) => sb
    .from('consignment_delivery_order_items')
    .select('id, consignment_delivery_order_id, item_code, item_group, description, description2, uom, qty, unit_price_sen, discount_sen, unit_cost_sen, variants')
    .in('consignment_delivery_order_id', batch)
    .range(from, to));
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  const itemList = (items ?? []) as Array<Record<string, unknown>>;
  if (itemList.length === 0) return c.json({ lines: [] });
  const itemIds = itemList.map((it) => it.id as string);

  const { data: relRows, error: relErr } = await paginateAll<{ id: string }>((from, to) => scopeToCompany(sb
    .from('consignment_delivery_returns')
    .select('id, status')
    .neq('status', 'CANCELLED'), c)
    .order('id', { ascending: true })
    .range(from, to));
  if (relErr) return c.json({ error: 'load_failed', reason: relErr.message }, 500);
  const liveReturnIds = new Set(((relRows ?? []) as Array<{ id: string }>).map((r) => r.id));
  const { data: retItems } = await chunkIn<{ consignment_delivery_return_id: string; consignment_do_item_id: string | null; qty_returned: number }>(itemIds, (batch, from, to) => sb
    .from('consignment_delivery_return_items')
    .select('consignment_delivery_return_id, consignment_do_item_id, qty_returned')
    .in('consignment_do_item_id', batch)
    .range(from, to));
  const returnedByItem = new Map<string, number>();
  for (const r of ((retItems ?? []) as Array<{ consignment_delivery_return_id: string; consignment_do_item_id: string | null; qty_returned: number }>)) {
    if (!r.consignment_do_item_id || !liveReturnIds.has(r.consignment_delivery_return_id)) continue;
    returnedByItem.set(r.consignment_do_item_id, (returnedByItem.get(r.consignment_do_item_id) ?? 0) + Number(r.qty_returned ?? 0));
  }

  const lines = itemList.map((it) => {
    const note = noteById.get(it.consignment_delivery_order_id as string);
    const delivered = Number(it.qty ?? 0);
    const returned = returnedByItem.get(it.id as string) ?? 0;
    return {
      noteItemId: it.id as string,
      consignmentDoId: it.consignment_delivery_order_id as string,
      noteNumber: note?.do_number ?? '',
      debtorCode: note?.debtor_code ?? null,
      debtorName: note?.debtor_name ?? null,
      itemCode: it.item_code as string,
      itemGroup: (it.item_group as string | null) ?? null,
      description: (it.description as string | null) ?? null,
      description2: (it.description2 as string | null) ?? null,
      uom: (it.uom as string | null) ?? null,
      delivered,
      returned,
      remaining: delivered - returned,
      unitPriceSen: Number(it.unit_price_sen ?? 0),
      discountSen: Number(it.discount_sen ?? 0),
      unitCostSen: Number(it.unit_cost_sen ?? 0),
      variants: it.variants ?? null,
    };
  }).filter((l) => l.remaining > 0);

  if (!canViewScmFinance(c)) {
    for (const l of lines) delete (l as unknown as Record<string, unknown>).unitCostSen;
  }
  return c.json({ lines });
});

consignmentReturns.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('consignment_delivery_returns').select(HEADER).eq('id', id), c).maybeSingle(),
    sb.from('consignment_delivery_return_items').select(ITEM).eq('consignment_delivery_return_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  const rawItems = (i.data ?? []) as unknown as Array<{ id: string; consignment_do_item_id?: string | null } & Record<string, unknown>>;
  const headerWh = (h.data as { warehouse_id?: string | null }).warehouse_id ?? null;
  const lineWh = await resolveReturnLineWarehouses(sb, rawItems, headerWh, activeCompanyId(c));
  const codeMap = await warehouseCodeMap(sb, [...lineWh.values()]);
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    return { ...it, warehouse_id: wid, warehouse_code: wid ? (codeMap.get(wid) ?? null) : null };
  });
  gateCrnFinance(c, h.data, items);
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ deliveryReturn: h.data, items });
});

async function insertHeader(sb: any, userId: string, body: Record<string, unknown>, c: any) {
  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;
  return insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('consignment_delivery_returns').insert({
    company_id: activeCompanyId(c),
    return_number: returnNumber,
    do_doc_no: (body.doDocNo as string) ?? (body.cnDocNo as string) ?? null,
    consignment_do_id: (body.consignmentDoId as string) ?? (body.deliveryOrderId as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: (body.debtorName ?? body.customerName) as string,
    return_date: dateOrNull(body.returnDate) ?? todayMyt(),
    reason: (body.reason as string) ?? null,
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
    sales_location: (body.salesLocation as string) ?? null,
    note: (body.note as string) ?? null,
    emergency_contact_name: (body.emergencyContactName as string) ?? null,
    emergency_contact_phone: emPhoneRaw ? (normalizePhone(emPhoneRaw) ?? emPhoneRaw) : null,
    emergency_contact_relationship: (body.emergencyContactRelationship as string) ?? null,
    warehouse_id: (body.warehouseId as string) ?? null,
    currency: (body.currency as string) ?? 'MYR',
    status: 'RECEIVED',
    received_at: new Date().toISOString(),
    notes: (body.notes as string) ?? null,
    created_by: userId,
    }).select(HEADER).single(),
  );
}

/* OVER-RETURN GUARD — owner decision 2026-08-13, asked directly: "加上限,和兄弟
   单据一致".

   This module shipped WITHOUT one and said so: the comments below read "DROPPED
   vs DR: ... the over-return remaining guard". Every sibling has it —
   delivery-returns.ts:653 checkDrOverRemaining, purchase-returns.ts:587,
   purchase-consignment-returns.ts:451 — so a consignment note was the one
   document you could return more units from than were ever delivered, as many
   times as you liked, each one booking stock back IN.

   The arithmetic is the picker's own (/returnable-note-lines): delivered minus
   the sum of qty_returned across NON-CANCELLED returns. Reusing that definition
   is the point — a guard that computes "remaining" differently from the list the
   operator picked from is a guard that rejects legitimate work.

   Returns a 409 body naming every offending line, or null to allow. EVERY load
   here fails CLOSED. This paragraph used to say the opposite — "a load failure
   returns null rather than blocking: the insert will surface real errors" — and
   both halves of that were wrong. The insert surfaces nothing: no constraint
   stops an over-return, which is the entire reason this guard exists. And a
   discarded read does not merely skip the check, it INVERTS it: empty rows make
   `remaining` collapse to `delivered`, so a line already fully returned looks
   untouched and books stock IN a second time. Refusing a retryable operation is
   the cheaper error. */
const OVER_REMAINING_UNPROVEN = {
  error: 'over_remaining_uncheckable',
  message: 'Could not verify the remaining returnable quantity — the check could not read prior returns. Nothing was changed; please retry.',
  lines: [] as Array<{ noteItemId: string; requested: number; remaining: number }>,
};

async function checkCrOverRemaining(
  sb: any,
  c: any,
  items: Array<Record<string, unknown>>,
  excludeReturnItemId?: string,
): Promise<{ error: string; message: string; lines: Array<{ noteItemId: string; requested: number; remaining: number }> } | null> {
  const wanted = new Map<string, number>();
  for (const it of items) {
    const noteItemId = ((it.noteItemId ?? it.consignmentDoItemId) as string | undefined) ?? null;
    if (!noteItemId) continue;
    wanted.set(noteItemId, (wanted.get(noteItemId) ?? 0) + Number(it.qtyReturned ?? it.qty ?? 0));
  }
  if (wanted.size === 0) return null;
  const ids = [...wanted.keys()];

  const { data: srcRows, error: srcErr } = await sb
    .from('consignment_delivery_order_items')
    .select('id, qty')
    .in('id', ids);
  if (srcErr) return OVER_REMAINING_UNPROVEN;
  const deliveredById = new Map(
    ((srcRows ?? []) as Array<{ id: string; qty: number }>).map((r) => [r.id, Number(r.qty ?? 0)]),
  );

  const { data: liveRows, error: liveErr } = await paginateAll<{ id: string }>((from, to) => scopeToCompany(sb
    .from('consignment_delivery_returns')
    .select('id, status')
    .neq('status', 'CANCELLED'), c)
    .order('id', { ascending: true })
    .range(from, to));
  if (liveErr) return OVER_REMAINING_UNPROVEN;
  const liveIds = new Set(((liveRows ?? []) as Array<{ id: string }>).map((r) => r.id));

  const { data: retRows, error: retErr } = await chunkIn<{
    id: string; consignment_delivery_return_id: string; consignment_do_item_id: string | null; qty_returned: number;
  }>(ids, (batch, from, to) => sb
    .from('consignment_delivery_return_items')
    .select('id, consignment_delivery_return_id, consignment_do_item_id, qty_returned')
    .in('consignment_do_item_id', batch)
    .range(from, to));
  if (retErr) return OVER_REMAINING_UNPROVEN;
  const returnedById = new Map<string, number>();
  for (const r of ((retRows ?? []) as Array<{
    id: string; consignment_delivery_return_id: string; consignment_do_item_id: string | null; qty_returned: number;
  }>)) {
    if (!r.consignment_do_item_id) continue;
    if (!liveIds.has(r.consignment_delivery_return_id)) continue;
    if (excludeReturnItemId && r.id === excludeReturnItemId) continue;
    returnedById.set(
      r.consignment_do_item_id,
      (returnedById.get(r.consignment_do_item_id) ?? 0) + Number(r.qty_returned ?? 0),
    );
  }

  const offenders: Array<{ noteItemId: string; requested: number; remaining: number }> = [];
  for (const [noteItemId, requested] of wanted) {
    const remaining = (deliveredById.get(noteItemId) ?? 0) - (returnedById.get(noteItemId) ?? 0);
    if (requested > remaining) offenders.push({ noteItemId, requested, remaining: Math.max(0, remaining) });
  }
  if (offenders.length === 0) return null;
  return {
    error: 'over_remaining',
    message: 'One or more lines return more than the remaining (delivered − already returned) quantity on the consignment note.',
    lines: offenders,
  };
}

const noteLineOf = (it: Record<string, unknown>): string | null =>
  ((it.doItemId ?? it.consignmentDoItemId ?? it.noteItemId) as string | undefined) || null;
const NOTE_LINK_REQUIRED = {
  error: 'note_link_required',
  message: 'Every return line must be picked from a Consignment Note line. Start the return from the note (Consignment Returns > From Consignment Note).',
};

export const createConsignmentReturnHandler = async (c: any) => {
  /* company-scope: the only by-id write here is the ROLLBACK — the header this
     handler inserted moments earlier is deleted when the child insert fails.
     insertHeader / insertWithDocNoRetry stamp the active company on that row, so
     the id is not caller-supplied and cannot name another company's document.
     Verified 2026-08-13 by reading the handler end to end. */
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  let items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: 'items_required' }, 400);
  {
    const free = items.filter((it) => !noteLineOf(it));
    if (free.length > 0) {
      return c.json({ ...NOTE_LINK_REQUIRED, lines: free.map((it) => ({ itemCode: (it.itemCode as string) ?? null })) }, 409);
    }
  }

  const sb = c.get('supabase'); const user = c.get('user');

  {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined), activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* THE GROUP IS THE SKU'S, AND IT IS DECIDED ONCE — docs/bugs/0524.
     `item_group` is not a label, it is the input to the stock bucket
     (shared/variant-key.ts): the IN that brings the loaned goods back is keyed from the group
     STORED on the line, so a client that sends a blank or wrong one picks the
     bucket. Rewritten here, above every reader, so the value written and the
     value later keyed from cannot differ. #2660 closed the inbound half. */
  items = await resolveItemGroups(sb, items, activeCompanyId(c) ?? null);

  {
    const xl = await assertSourceLinesInCompany(sb, c, 'consignment_delivery_order_items',
      items.map((it) => (it.doItemId ?? it.consignmentDoItemId ?? it.noteItemId) as string | undefined));
    if (!xl.ok) return c.json(xl.body, xl.status);
  }

  /* Every line is note-linked (note_link_required above); the over-return guard bounds each one
     against what the note line has left to return (owner 2026-08-13). */
  {
    const over = await checkCrOverRemaining(sb, c, items);
    if (over) return c.json(over, 409);
  }

  const { data: header, error: hErr } = await insertHeader(sb, user.id, body, c);
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const sourceCostByNoteItem = await sourceUnitCostByItemId(
    sb, 'consignment_delivery_order_items',
    items.map((it: Record<string, unknown>) => (it.doItemId ?? it.consignmentDoItemId) as string | undefined),
    activeCompanyId(c) ?? null);
  const rows = items.map((it) => buildItemRow(h.id, it, sourceCostByNoteItem));
  const { error: iErr } = await sb.from('consignment_delivery_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('consignment_delivery_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
  await recomputeTotals(sb, h.id);

  const movementErrors = await resyncReturnInventory(sb, h.id, user.id);

  return c.json({ id: h.id, returnNumber: h.return_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
consignmentReturns.post('/', createConsignmentReturnHandler);

consignmentReturns.patch('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const map: Array<[string, string]> = [
    ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
    ['salesLocation', 'sales_location'], ['ref', 'ref'],
    ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
    ['address1', 'address1'], ['address2', 'address2'],
    ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
    ['note', 'note'], ['notes', 'notes'], ['reason', 'reason'],
    ['returnDate', 'return_date'], ['currency', 'currency'],
    ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
    ['customerSoNo', 'customer_so_no'],
    ['email', 'email'], ['customerType', 'customer_type'],
    ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
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

  const { data, error } = await scopeToCompanyId(sb.from('consignment_delivery_returns').update(updates).eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true, id });
});

async function returnLineLock(sb: any, id: string): Promise<{ error: string; message: string } | null> {
  const { data, error } = await sb.from('consignment_delivery_returns').select('status').eq('id', id).maybeSingle();
  if (error) {
    return {
      error: 'return_status_unavailable',
      message: 'The return\'s status could not be read just now, so its lines are locked until it can be. Please try again in a moment.',
    };
  }
  const st = (data as { status: string } | null)?.status;
  if (st === 'CANCELLED') return { error: 'return_cancelled', message: 'This consignment return is cancelled — its lines can no longer be changed.' };
  if (st === 'REFUNDED') return { error: 'return_refunded', message: 'This consignment return is refunded — its lines can no longer be changed.' };
  if (st === 'CREDIT_NOTED') return { error: 'return_credit_noted', message: 'This consignment return is credit-noted — its lines can no longer be changed.' };
  return null;
}

export const addConsignmentReturnItemHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  if (!noteLineOf(it)) return c.json(NOTE_LINK_REQUIRED, 409);
  { const lock = await returnLineLock(sb, id); if (lock) return c.json(lock, 409); }

  {
    const over = await checkCrOverRemaining(sb, c, [it]);
    if (over) return c.json(over, 409);
  }

  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* SKU wins, decided once — docs/bugs/0524. Same rule as the create path: the
     stored group is what the stock movement is keyed from. */
  it = (await resolveItemGroups(sb, [it], activeCompanyId(c) ?? null))[0]!;

  const { data: header } = await scopeToCompanyId(sb.from('consignment_delivery_returns').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!header) return c.json(NOT_THIS_COMPANY, 404);

  {
    const xl = await assertSourceLinesInCompany(sb, c, 'consignment_delivery_order_items',
      [(it.doItemId ?? it.consignmentDoItemId ?? it.noteItemId) as string | undefined]);
    if (!xl.ok) return c.json(xl.body, xl.status);
  }

  const row = buildItemRow(id, it, await sourceUnitCostByItemId(
    sb, 'consignment_delivery_order_items', [(it.doItemId ?? it.consignmentDoItemId) as string | undefined],
    activeCompanyId(c) ?? null));
  const { data, error } = await sb.from('consignment_delivery_return_items').insert({ ...row, company_id: activeCompanyId(c) }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  gateCrnFinance(c, null, data);
  await recomputeTotals(sb, id);
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncReturnInventory(sb, id, user?.id ?? null); }
  catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  return c.json({ item: data, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) }, 201);
};
consignmentReturns.post('/:id/items', addConsignmentReturnItemHandler);

consignmentReturns.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  { const lock = await returnLineLock(sb, id); if (lock) return c.json(lock, 409); }

  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  const { data: prev } = await scopeToCompanyId(sb.from('consignment_delivery_return_items')
    .select('qty_returned, unit_price_sen, discount_sen, unit_cost_sen, item_code, item_group, description, uom, variants, notes, condition, consignment_do_item_id')
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

  const qty = (it.qtyReturned ?? it.qty) !== undefined ? Number(it.qtyReturned ?? it.qty) : Number(prev.qty_returned);

  {
    const noteItemId = (prev as { consignment_do_item_id?: string | null }).consignment_do_item_id ?? null;
    if (noteItemId) {
      const over = await checkCrOverRemaining(sb, c, [{ noteItemId, qtyReturned: qty }], itemId);
      if (over) return c.json(over, 409);
    }
  }
  const unitPrice = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : Number(prev.unit_price_sen);
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : Number(prev.discount_sen);
  const unitCost = (canViewScmFinance(c) && it.unitCostSen !== undefined)
    ? Number(it.unitCostSen)
    : Number(prev.unit_cost_sen);
  const lineTotal = (qty * unitPrice) - discount;
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = {
    qty_returned: qty, unit_price_sen: unitPrice, discount_sen: discount, unit_cost_sen: unitCost,
    line_total_sen: lineTotal, line_cost_sen: lineCost, line_margin_sen: lineTotal - lineCost,
    refund_sen: lineTotal,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'], ['condition', 'condition'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  {
    const repoint = await unlinkedEditRefusal(sb, 'consignment-return', {
      parent: { table: 'consignment_delivery_returns', column: 'consignment_do_id', id, companyId: co.companyId },
      storedLink: (prev as { consignment_do_item_id?: string | null }).consignment_do_item_id ?? null,
      storedCode: (prev as { item_code: string | null }).item_code,
      patchCode: it.itemCode,
    });
    if (repoint) return c.json(repoint, 409);
  }

  const { error } = await scopeToCompanyId(sb.from('consignment_delivery_return_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncReturnInventory(sb, id, c.get('user')?.id ?? null); }
  catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  return c.json({ ok: true, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) });
});

consignmentReturns.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  { const lock = await returnLineLock(sb, id); if (lock) return c.json(lock, 409); }
  const { data: del, error } = await scopeToCompanyId(sb.from('consignment_delivery_return_items').delete().eq('id', itemId), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!del) return c.json(NOT_THIS_COMPANY, 404);
  await recomputeTotals(sb, id);
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncReturnInventory(sb, id, c.get('user')?.id ?? null); }
  catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  return c.json({ ok: true, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) });
});

export const patchConsignmentReturnStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { status?: string; inspectionNotes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  const toStatus = String(body.status).trim().toUpperCase();

  const { data: cur } = await scopeToCompanyId(sb.from('consignment_delivery_returns').select('status').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const prevStatus = (cur as { status: string }).status;
  if (toStatus === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ consignmentReturn: { id, status: 'CANCELLED' } });
  }
  if (prevStatus === 'CANCELLED') {
    return c.json({ error: 'return_cancelled_final', message: 'A cancelled Consignment Return cannot be reactivated — create a new return.' }, 409);
  }

  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now, status: toStatus };
  if (toStatus === 'RECEIVED') ts.received_at = now;
  if (toStatus === 'INSPECTED') { ts.inspected_at = now; if (body.inspectionNotes) ts.inspection_notes = body.inspectionNotes; }
  if (toStatus === 'REFUNDED') ts.refunded_at = now;

  let data: { id: string; status: string } | null;
  if (toStatus === 'CANCELLED') {
    const { data: updated, error } = await scopeToCompanyId(sb.from('consignment_delivery_returns')
      .update(ts).eq('id', id).neq('status', 'CANCELLED'), co.companyId)
      .select('id, status').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) return c.json({ consignmentReturn: { id, status: 'CANCELLED' } });
    data = updated as { id: string; status: string };
  } else {
    const { data: updated, error } = await scopeToCompanyId(sb.from('consignment_delivery_returns')
      .update(ts).eq('id', id), co.companyId).select('id, status').single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    data = updated as { id: string; status: string };
  }

  let resyncErrs: string[] = [];
  if (toStatus === 'CANCELLED') {
    resyncErrs = [];
    try { resyncErrs = await resyncReturnInventory(sb, id, user.id); }
    catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  }

    return c.json({ consignmentReturn: data, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) });
};
consignmentReturns.patch('/:id/status', patchConsignmentReturnStatusHandler);
