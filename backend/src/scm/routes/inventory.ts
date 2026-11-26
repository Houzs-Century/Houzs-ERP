
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { reconcileLedger } from '../lib/reconcile-ledger';
import { inventoryValuationHandler } from './inventory-valuation';
import {
  activeCompanyId, scopeToCompany,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
} from '../lib/companyScope';
import { canonicalizeMyState } from '../lib/canonical-state';
import { enrichVariantKeyRowsWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import {
  isConsignmentLotSource, isMakeToOrderCategory, distributeAssignedToLots,
} from '../lib/inventory-movements';
import { computeVariantKey, effectiveDelivery, effectiveSoDelivery, isServiceLine, type VariantAttrs } from '../shared';
import { warehouseLabel } from '../lib/warehouse-label';
import { deadStockQty, isDeadStockLot, isNonSellingWarehouseType } from '../lib/non-selling-warehouse';
import { computeMrp, mrpStockAssignment, stockAssignmentKey } from './mrp';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import type { Env, Variables } from '../env';
import { canViewScmFinance } from '../lib/houzs-perms';
import { pgrestIn } from '../lib/pgrest-in-list';
import { isStockBucket } from '../lib/stock-bucket';
import { mytDayWindow } from '../lib/my-time';
import { NETTING_EMBED, deliveredReturnedBySoItem, nettingFromEmbedded, type EmbeddedDemandLine } from '../lib/inventory-netting';
import { masterPostcodeError } from '../shared/master-postcode-rule';

/* FINANCE GATE — owner decision 2026-08-13, asked directly: "加财务门,仓管看
   不到成本".

   This router imported nothing from houzs-perms. Its only gate was
   scmAreaGuard("scm.warehouse.inventory") at VIEW level, and Storekeeper /
   Storekeeper Supervisor hold exactly that (services/positionPolicy.ts) — while
   the same policy sets `canSeeMargin: false` for them. That flag was WRITTEN and
   nothing enforced it, which is the "a written level sitting inert" trap this
   repo documents twice.

   Every sibling surface over the same numbers already gates: reports.ts:512 and
   entity-audit-log.ts:97 on canViewScmFinance, mfg-products on
   canViewScmProductCost, and /sofa-combos was deliberately denied openRead for
   precisely this reason.

   Quantity, location, batch and movement history stay visible to everyone with
   the area — only cost, value, margin and supplier pricing are withheld. */
const INVENTORY_FINANCE_KEYS = [
  'unit_cost_sen', 'total_cost_sen', 'value_sen', 'cost_sen', 'avg_cost_sen',
  // eslint-disable-next-line no-restricted-syntax -- per-document subset; see the note above the declaration
  'main_supplier_price_sen', 'margin_sen', 'unit_cost_sen',
] as const;

function stripInventoryFinance<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((r) => {
    const out = { ...r } as Record<string, unknown>;
    for (const k of INVENTORY_FINANCE_KEYS) delete out[k];
    return out as T;
  });
}

export const inventory = new Hono<{ Bindings: Env; Variables: Variables }>();
inventory.use('*', supabaseAuth);

/* Warehouse types whose stock is NOT part of the sell-through question. A
   display piece standing in a showroom is doing its job, and a unit sent back to
   the supplier for service is not idle — neither is a slow seller, and flagging
   them buries the ones that are. Owner, 2026-08-05: "我的 dead stock 里面怎么会有
   dead stock 呢？因为它明明是 showroom 的 display 啊".
   `warehouses.type` already carries this (mig 0171 keeps is_showroom in step with
   `type = 'showroom'`), so nothing new is stored — the axis was there and dead
   stock simply never read it. Shared by the ANALYTICS dead-stock list and the
   LIST's per-SKU Dead/Spare badge: the 2026-08-05 fix reached only the first, so
   the screen the owner actually looks at kept tagging display pieces DEAD.

   THE SET ITSELF MOVED OUT on 2026-09-08 (lib/non-selling-warehouse.ts). The
   owner's ruling that day put the same axis in front of the SO ALLOCATOR, so
   the same three type names now decide two things — what counts as dead stock,
   and what may be promised to a customer. Two copies of one business question
   is the duplicated-decision gate's whole subject; the local copy here was the
   second home and it is gone. This file keeps its own COMPANY-SCOPED loader,
   because a report is scoped to the active company while the allocator sweeps
   every company at once. */
async function loadNonSellingWarehouseIds(
  sb: any,
  c: Parameters<typeof scopeToCompany>[1],
): Promise<Set<string>> {
  const ids = new Set<string>();
  const { data } = await scopeToCompany(sb.from('warehouses').select('id, type'), c);
  for (const w of (data ?? []) as Array<{ id: string; type: string | null }>) {
    if (isNonSellingWarehouseType(w.type)) ids.add(w.id);
  }
  return ids;
}

inventory.get('/warehouses', async (c) => {
  const sb = c.get('supabase');
  const includeInactive = c.req.query('includeInactive') === 'true';
  let q = scopeToCompany(
    sb.from('warehouses').select('id, code, name, location, country, state, postcode, city, is_active, is_default, is_showroom, venue_name, type, stock_bucket'),
    c,
  ).order('code');
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ warehouses: data ?? [] });
});

inventory.post('/warehouses', async (c) => {
  const sb = c.get('supabase');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const code = String(body.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  if (!code) return c.json({ error: 'code_required' }, 400);
  if (!name) return c.json({ error: 'name_required' }, 400);

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const rawType = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
  const ALLOWED_TYPES = ['warehouse', 'showroom', 'display', 'service', 'others'] as const;
  const wantType: (typeof ALLOWED_TYPES)[number] | null =
    (ALLOWED_TYPES as readonly string[]).includes(rawType) ? (rawType as (typeof ALLOWED_TYPES)[number]) : null;
  const finalType: (typeof ALLOWED_TYPES)[number] =
    wantType ?? (body.isShowroom === true ? 'showroom' : 'warehouse');
  const finalIsShowroom = finalType === 'showroom' || body.isShowroom === true;

  const country = typeof body.country === 'string' && body.country.trim()
    ? body.country.trim() : null;
  const state = canonicalizeMyState((body.state as string | null | undefined) ?? null);
  const postcode = typeof body.postcode === 'string' && body.postcode.trim()
    ? body.postcode.trim() : null;
  const city = typeof body.city === 'string' && body.city.trim()
    ? body.city.trim() : null;
  /* A warehouse in Malaysia / Singapore needs a postcode (owner 2026-11-19). */
  const pcErr = masterPostcodeError(country, postcode);
  if (pcErr) return c.json({ error: 'postcode_required', message: pcErr }, 400);

  const { data, error } = await sb.from('warehouses').insert({
    company_id: co.companyId,
    code, name,
    location: (body.location as string) ?? null,
    country, state, postcode, city,
    is_active: body.isActive === false ? false : true,
    is_default: body.isDefault === true,
    is_showroom: finalIsShowroom,
    venue_name: typeof body.venueName === 'string' && body.venueName.trim()
      ? body.venueName.trim() : null,
    type: finalType,
    /* The closing-stock bucket (owner 2026-09-21): one of the three, or null = by type. */
    stock_bucket: isStockBucket(body.stockBucket) ? body.stockBucket : null,
  }).select('id, code, name, location, country, state, postcode, city, is_active, is_default, is_showroom, venue_name, type, stock_bucket').single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code' }, 409);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  if (body.isDefault === true) {
    await scopeToCompanyId(
      sb.from('warehouses').update({ is_default: false })
        .eq('is_default', true).neq('id', (data as { id: string }).id),
      co.companyId,
    );
  }
  return c.json({ warehouse: data }, 201);
});

export const patchWarehouseHandler = async (c: any) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const updates: Record<string, unknown> = {};
  if (typeof body.code === 'string')      updates.code = body.code.trim().toUpperCase();
  if (typeof body.name === 'string')      updates.name = body.name.trim();
  if (typeof body.location === 'string')  updates.location = body.location;
  if (body.country !== undefined) {
    const cn = typeof body.country === 'string' ? body.country.trim() : '';
    updates.country = cn || null;
  }
  if (body.state !== undefined) {
    updates.state = canonicalizeMyState((body.state as string | null | undefined) ?? null);
  }
  if (body.postcode !== undefined) {
    const p = typeof body.postcode === 'string' ? body.postcode.trim() : '';
    const pcErr = masterPostcodeError(typeof body.country === 'string' ? body.country : null, p);
    if (pcErr) return c.json({ error: 'postcode_required', message: pcErr }, 400);
    updates.postcode = p || null;
  }
  if (body.city !== undefined) {
    const cc = typeof body.city === 'string' ? body.city.trim() : '';
    updates.city = cc || null;
  }
  if (typeof body.isActive === 'boolean') updates.is_active = body.isActive;
  if (typeof body.isDefault === 'boolean') updates.is_default = body.isDefault;
  const ALLOWED_TYPES = ['warehouse', 'showroom', 'display', 'service', 'others'] as const;
  const rawType = typeof body.type === 'string' ? body.type.trim().toLowerCase() : null;
  const typedType = rawType && (ALLOWED_TYPES as readonly string[]).includes(rawType)
    ? (rawType as (typeof ALLOWED_TYPES)[number]) : null;
  if (typedType) {
    updates.type = typedType;
    updates.is_showroom = typedType === 'showroom';
  } else if (typeof body.isShowroom === 'boolean') {
    updates.is_showroom = body.isShowroom;
    updates.type = body.isShowroom ? 'showroom' : 'warehouse';
  }
  if (body.venueName !== undefined) {
    const v = typeof body.venueName === 'string' ? body.venueName.trim() : '';
    updates.venue_name = v || null;
  }
  /* The closing-stock bucket (owner 2026-09-21): one of the three, or null = by type. */
  if (body.stockBucket !== undefined) {
    if (body.stockBucket !== null && !isStockBucket(body.stockBucket)) {
      return c.json({ error: 'bad_stock_bucket', message: 'stockBucket must be customer, display, service, showroom, others or null (by type).' }, 400);
    }
    updates.stock_bucket = body.stockBucket;
  }
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data, error } = await scopeToCompanyId(
    sb.from('warehouses').update(updates).eq('id', id),
    co.companyId,
  ).select('id, code, name, location, country, state, postcode, city, is_active, is_default, is_showroom, venue_name, type, stock_bucket').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  if (updates.is_default === true) {
    await scopeToCompanyId(
      sb.from('warehouses').update({ is_default: false })
        .eq('is_default', true).neq('id', id),
      co.companyId,
    );
  }
  return c.json({ warehouse: data });
};

inventory.patch('/warehouses/:id', patchWarehouseHandler);

inventory.delete('/warehouses/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { error } = await scopeToCompanyId(
    sb.from('warehouses').delete().eq('id', id),
    co.companyId,
  );
  if (error) {
    if (error.code === '23503') return c.json({ error: 'in_use', reason: error.message }, 409);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true });
});

export const listInventoryHandler = async (c: any) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const search = c.req.query('search');
  const category = c.req.query('category');
  const showAll = c.req.query('showAll') === 'true';

  const tableName = showAll ? 'v_inventory_all_skus' : 'inventory_balances';
  const cols = showAll
    ? 'warehouse_id, warehouse_code, warehouse_name, item_code, product_name, category, size_label, qty, last_movement_at, value_sen, main_supplier_code, main_supplier_name'
    : 'warehouse_id, item_code, variant_key, product_name, qty, last_movement_at';

  const s = search ? escapeForOr(search) : '';
  const { data, error } = await paginateAll((from, to) => {
    let q = sb.from(tableName).select(cols);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    if (s) q = q.or(`item_code.ilike.%${s}%,product_name.ilike.%${s}%`);
    if (showAll && category && category !== 'all') q = q.eq('category', category);
    q = scopeToCompany(q, c);
    q = q.order('item_code').order('warehouse_id');
    if (!showAll) q = q.order('variant_key');
    return q.order('company_id').range(from, to);
  });
  if (error) {
    if (/relation .* does not exist/i.test(error.message) || /column .* does not exist/i.test(error.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run the SCM inventory view migrations (including 0154, which adds company_id to v_inventory_all_skus) against Supabase.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: error.message }, 500);
  }

  const { data: whs } = await scopeToCompany(sb.from('warehouses')
    .select('id, code, name, is_consignment')
    .or('is_active.eq.true,is_consignment.eq.true'), c);
  return c.json({ balances: data ?? [], warehouses: whs ?? [] });
};

inventory.get('/', listInventoryHandler);
inventory.get('/valuation', inventoryValuationHandler);

export const productTotalsHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const sb = c.get('supabase');
  const search = c.req.query('search');
  const category = c.req.query('category');
  // Ask A (owner 2026-07-24) — optional single-warehouse scope. When set, Stock,
  // Value, Committed / Unscheduled demand and Incoming all narrow to THIS
  // warehouse (SO lines carry warehouse_id since mig 0118; PO lines fall back to
  // the PO header's purchase_location_id). Omitted → company-wide totals as before.
  const warehouseIds = (c.req.query('warehouseIds') ?? c.req.query('warehouseId') ?? '').split(',').filter(Boolean);
  const scopedToWarehouses = warehouseIds.length > 0;

  const s = search ? escapeForOr(search) : '';
  const { data, error } = await paginateAll((from, to) => {
    let q = sb.from('v_inventory_product_totals').select('*');
    q = scopeToCompany(q, c);
    if (s) q = q.or(`item_code.ilike.%${s}%,product_name.ilike.%${s}%,barcode.ilike.%${s}%`);
    if (category && category !== 'all') q = q.eq('category', category);
    return q.order('item_code').order('company_id').range(from, to);
  });
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migrations 0050/0053/0054.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: error.message }, 500);
  }

  /* Owner 2026-07-24 six-column planning model (supersedes the reserve-7d/14d
     picture). Each SKU row (one per item_code, across variants) carries:
       stock             = on-hand now (warehouse-scoped when warehouseId set)
       incoming_qty      = outstanding PO qty ARRIVING WITHIN ~30 DAYS (effective ETA)
       incoming_pos      = the covering PO(s) + ETA for that incoming qty (drill)
       committed_scheduled = open SO demand that HAS a delivery date (ships soon)
       unscheduled_qty   = open SO demand with NO delivery date (future/uncertain)
       available_qty     = stock + incoming_qty − committed_scheduled
       surplus_qty       = available_qty − unscheduled_qty  (dead-stock signal)
       oldest_lot_at     = oldest open FIFO lot → "age" of the stock
     committed_scheduled + unscheduled_qty == the whole open, net-of-delivered SO
     demand (reserved_total) — this is a pure re-bucketing of the SAME demand set,
     so the DELIVERED-exclusion logic (deliveredReturnedBySoItem, below) is
     unchanged. */
  const products = (data ?? []) as Array<Record<string, unknown>>;
  const codes = products.map((p) => String(p.item_code));
  const SO_DONE = new Set(['DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED']);
  const PO_LIVE = new Set(['SUBMITTED', 'PARTIALLY_RECEIVED']);
  const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const plus = (n: number): string => {
    const d = new Date(`${todayMY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const d30 = plus(30);

  const committedScheduled = new Map<string, number>();
  const unscheduled = new Map<string, number>();
  /* The SO(s) behind Scheduled / Unscheduled, so a planner can see WHICH orders
     make up the figure without re-running AutoCount's SO detail listing (HC-0115). */
  type DemandSo = { doc_no: string; debtor_name: string | null; so_date: string | null; delivery_date: string | null; qty: number };
  const demandSos = new Map<string, DemandSo[]>();
  const incoming = new Map<string, number>();
  type IncPo = { po_number: string; eta: string | null; qty: number };
  const incomingPos = new Map<string, IncPo[]>();
  const oldestLot = new Map<string, string>();
  /* HC-0206 (Sim): with "All warehouses" the row summed every location, so the
     only way to find WHERE a SKU sits was to pick each warehouse in turn. On-hand
     per warehouse, from the same open lots as the Stock + Consignment columns. */
  const lotsByWh = new Map<string, Map<string, { qty: number; held: number }>>();
  const whStock = new Map<string, number>();
  // OWNED value per item_code, summed from the open FIFO lots below (excluding
  // consignment-sourced lots). This OVERRIDES the value column in BOTH the
  // company-wide and warehouse-scoped cases so the list value never counts
  // consignment stock — matching the Stock Breakdown drawer's owned subtotal and
  // the Analytics figures (owner rule, BUG-HISTORY 2026-07-25).
  const ownedValueSen = new Map<string, number>();
  // OWNED qty per item_code (consignment lots excluded), so the list's avg
  // unit cost divides owned value by OWNED qty — not total_qty (which still
  // counts consignment units and would dilute the average) (owner 2026-07-25).
  const ownedQty = new Map<string, number>();
  const heldQty = new Map<string, number>();
  /* HELD (consignment) value — reported SEPARATELY, never inside inventory
     value. Owner, 2026-08-06: "分成两个 value：一个是 inventory value,一个是
     consignment value". */
  const heldValueSen = new Map<string, number>();
  const nonSellingQty = new Map<string, number>();

  if (codes.length > 0) {
    if (scopedToWarehouses) {
      const { data: bal, error: balErr } = await chunkIn(codes, (batch, from, to) => pgrestIn(scopeToCompany(sb
        .from('inventory_balances').select('item_code, qty'), c)
        .in('warehouse_id', warehouseIds), 'item_code', batch).order('item_code').order('warehouse_id').order('variant_key').order('company_id').range(from, to));
      if (balErr) {
        // eslint-disable-next-line no-console
        console.error('[inventory] warehouse balances read failed:', (balErr as { message?: unknown }).message ?? balErr);
      }
      for (const r of (bal ?? []) as Array<{ item_code: string; qty: number }>) {
        whStock.set(r.item_code, (whStock.get(r.item_code) ?? 0) + Number(r.qty ?? 0));
      }
    }

    const nonSellingIds = await loadNonSellingWarehouseIds(sb, c);
    const scopedNonSelling = scopedToWarehouses
      ? warehouseIds.filter((id) => nonSellingIds.has(id))
      : [...nonSellingIds];
    if (scopedNonSelling.length > 0) {
      const { data: nsBal, error: nsErr } = await chunkIn(codes, (batch, from, to) => pgrestIn(scopeToCompany(sb
        .from('inventory_balances').select('item_code, qty'), c)
        .in('warehouse_id', scopedNonSelling), 'item_code', batch).order('item_code').order('warehouse_id').order('variant_key').order('company_id').range(from, to));
      if (nsErr) {
        // eslint-disable-next-line no-console
        console.error('[inventory] non-selling balances read failed:', (nsErr as { message?: unknown }).message ?? nsErr);
      }
      for (const r of (nsBal ?? []) as Array<{ item_code: string; qty: number }>) {
        nonSellingQty.set(r.item_code, (nonSellingQty.get(r.item_code) ?? 0) + Number(r.qty ?? 0));
      }
    }

    /* HC-0002 (prod 2026-10-22: the netting below took 13.6 s, four serial
       uuid-chunked reads over thousands of open lines). The read now drops
       finished orders in the database — the same not.in filter on the !inner
       `so` embed MRP's demand read uses; SO_DONE below stays the gate — and
       brings each line's DO lines and returns with it (NETTING_EMBED), so
       netting costs no extra round trip. If that read is refused it is read
       the old way and netted by the old four reads. */
    const SO_DONE_SQL = `(${[...SO_DONE].map((st) => `"${st}"`).join(',')})`;
    const readDemand = (embedNetting: boolean) => chunkIn(codes, (batch, from, to) => {
      let dq = pgrestIn(scopeToCompany(sb
        .from('mfg_sales_order_items')
        .select(`id, doc_no, item_code, qty, warehouse_id, line_delivery_date, cancelled, so:mfg_sales_orders!inner(status, customer_delivery_date, debtor_name, so_date)${embedNetting ? `, ${NETTING_EMBED}` : ''}`), c), 'item_code', batch)
        .eq('cancelled', false);
      if (embedNetting) dq = dq.not('so.status', 'in', SO_DONE_SQL);
      if (scopedToWarehouses) dq = dq.in('warehouse_id', warehouseIds);
      return dq.order('id').range(from, to);
    });
    let nettingEmbedded = true;
    let { data: demand, error: demandErr } = await readDemand(true);
    if (demandErr) {
      // eslint-disable-next-line no-console
      console.warn('[inventory] embedded SO demand read refused, reading it the old way:', (demandErr as { message?: unknown }).message ?? demandErr);
      nettingEmbedded = false;
      ({ data: demand, error: demandErr } = await readDemand(false));
    }
    if (demandErr) {
      // eslint-disable-next-line no-console
      console.error('[inventory] SO demand read failed:', (demandErr as { message?: unknown }).message ?? demandErr);
    }
    type DemandSoHead = { status: string; customer_delivery_date: string | null; debtor_name: string | null; so_date: string | null };
    const openDemand = ((demand ?? []) as unknown as Array<EmbeddedDemandLine & { doc_no: string; item_code: string; qty: number; line_delivery_date: string | null; so: DemandSoHead | DemandSoHead[] | null }>)
      .map((r) => ({ ...r, qty: Number(r.qty ?? 0), so: Array.isArray(r.so) ? r.so[0] : r.so }))
      .filter((r) => r.so != null && !SO_DONE.has(r.so.status) && r.qty > 0);
    const demandRows = openDemand.map((r) => ({ id: r.id, doc_no: r.doc_no, item_code: r.item_code, qty: r.qty, line_delivery_date: r.line_delivery_date, so: r.so }));

    const { deliveredBySoItem, returnedBySoItem } = nettingEmbedded
      ? nettingFromEmbedded(openDemand)
      : await deliveredReturnedBySoItem(sb, demandRows.map((r) => r.id));

    for (const r of demandRows) {
      const so = r.so!;
      const net = Math.max(0, r.qty - (deliveredBySoItem.get(r.id) ?? 0) + (returnedBySoItem.get(r.id) ?? 0));
      if (net <= 0) continue;
      const code = r.item_code;
      const dd = (r.line_delivery_date ?? so.customer_delivery_date)?.slice(0, 10);
      if (dd) committedScheduled.set(code, (committedScheduled.get(code) ?? 0) + net);
      else    unscheduled.set(code, (unscheduled.get(code) ?? 0) + net);
      const sos = demandSos.get(code) ?? [];
      const same = sos.find((x) => x.doc_no === r.doc_no && x.delivery_date === (dd ?? null));
      if (same) same.qty += net;
      else sos.push({ doc_no: r.doc_no, debtor_name: so.debtor_name, so_date: so.so_date?.slice(0, 10) ?? null, delivery_date: dd ?? null, qty: net });
      demandSos.set(code, sos);
    }

    const { data: poItems, error: poErr } = await chunkIn(codes, (batch, from, to) => pgrestIn(scopeToCompany(sb
      .from('purchase_order_items')
      .select('item_code, qty, received_qty, delivery_date, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, warehouse_id, po:purchase_orders!inner(po_number, status, expected_at, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, purchase_location_id)'), c), 'item_code', batch).order('id').range(from, to));
    if (poErr) {
      // eslint-disable-next-line no-console
      console.error('[inventory] incoming PO lines read failed:', (poErr as { message?: unknown }).message ?? poErr);
    }
    for (const r of (poItems ?? []) as Array<{ item_code: string; qty: number; received_qty: number | null; delivery_date: string | null; supplier_delivery_date_2: string | null; supplier_delivery_date_3: string | null; supplier_delivery_date_4: string | null; warehouse_id: string | null; po: { po_number: string; status: string; expected_at: string | null; supplier_delivery_date_2: string | null; supplier_delivery_date_3: string | null; supplier_delivery_date_4: string | null; purchase_location_id: string | null } | Array<{ po_number: string; status: string; expected_at: string | null; supplier_delivery_date_2: string | null; supplier_delivery_date_3: string | null; supplier_delivery_date_4: string | null; purchase_location_id: string | null }> | null }>) {
      const po = Array.isArray(r.po) ? r.po[0] : r.po;
      if (!po || !PO_LIVE.has(po.status)) continue;
      const left = Number(r.qty ?? 0) - Number(r.received_qty ?? 0);
      if (left <= 0) continue;
      const poWh = r.warehouse_id ?? po.purchase_location_id ?? null;
      if (scopedToWarehouses && !warehouseIds.includes(String(poWh))) continue;
      const rawEta = effectiveDelivery(r.delivery_date, r.supplier_delivery_date_2, r.supplier_delivery_date_3, r.supplier_delivery_date_4)
        ?? effectiveDelivery(po.expected_at, po.supplier_delivery_date_2, po.supplier_delivery_date_3, po.supplier_delivery_date_4)
        ?? null;
      const eta = rawEta ? rawEta.slice(0, 10) : null;
      if (!eta || eta > d30) continue;
      incoming.set(r.item_code, (incoming.get(r.item_code) ?? 0) + left);
      const arr = incomingPos.get(r.item_code) ?? [];
      const existing = arr.find((x) => x.po_number === po.po_number);
      if (existing) {
        existing.qty += left;
        if (eta && (!existing.eta || eta < existing.eta)) existing.eta = eta;
      } else {
        arr.push({ po_number: po.po_number, eta, qty: left });
      }
      incomingPos.set(r.item_code, arr);
    }

    const { data: lots, error: lotsErr } = await chunkIn(codes, (batch, from, to) => {
      let lq = pgrestIn(scopeToCompany(sb
        .from('v_inventory_lots_open')
        .select('item_code, warehouse_id, received_at, qty_remaining, remaining_value_sen, source_doc_type, source_doc_no'), c), 'item_code', batch);
      if (scopedToWarehouses) lq = lq.in('warehouse_id', warehouseIds);
      return lq.order('received_at').order('id').range(from, to);
    });
    if (lotsErr) {
      // eslint-disable-next-line no-console
      console.error('[inventory] open lots read failed:', (lotsErr as { message?: unknown }).message ?? lotsErr);
    }
    for (const r of (lots ?? []) as Array<{ item_code: string; warehouse_id: string | null; received_at: string | null; qty_remaining: number | null; remaining_value_sen: number | null; source_doc_type: string | null; source_doc_no: string | null }>) {
      if (r.warehouse_id) {
        const byWh = lotsByWh.get(r.item_code) ?? new Map<string, { qty: number; held: number }>();
        const cur = byWh.get(r.warehouse_id) ?? { qty: 0, held: 0 };
        cur.qty += Number(r.qty_remaining ?? 0);
        if (isConsignmentLotSource(r.source_doc_type, r.source_doc_no)) cur.held += Number(r.qty_remaining ?? 0);
        byWh.set(r.warehouse_id, cur);
        lotsByWh.set(r.item_code, byWh);
      }
      // Owner rule (BUG-HISTORY 2026-07-25): consignment stock shows QUANTITY but
      // is EXCLUDED from inventory VALUE. Classify by the lot SOURCE (never the
      // warehouse flag) and sum OWNED value only, so the list value column matches
      // the Stock Breakdown drawer's owned subtotal and the Analytics figures.
      if (!isConsignmentLotSource(r.source_doc_type, r.source_doc_no)) {
        ownedValueSen.set(r.item_code, (ownedValueSen.get(r.item_code) ?? 0) + Number(r.remaining_value_sen ?? 0));
        ownedQty.set(r.item_code, (ownedQty.get(r.item_code) ?? 0) + Number(r.qty_remaining ?? 0));
        /* AGE from OWNED lots only. It used to read every open lot, so a row
           with zero owned stock aged by somebody else's consignment pieces —
           sorting by Age then buried the goods that had really sat longest.
           Owner, 2026-08-06: "age 的计算为什么不是根据库存？当我 sort 的时候…
           我就看不到到底是哪一个东西放得最久". No owned lot → no age. */
        if (r.received_at) {
          const cur = oldestLot.get(r.item_code);
          if (!cur || r.received_at < cur) oldestLot.set(r.item_code, r.received_at);
        }
      } else {
        heldQty.set(r.item_code, (heldQty.get(r.item_code) ?? 0) + Number(r.qty_remaining ?? 0));
        heldValueSen.set(r.item_code, (heldValueSen.get(r.item_code) ?? 0) + Number(r.remaining_value_sen ?? 0));
      }
    }
  }

  const whIds = [...new Set([...lotsByWh.values()].flatMap((m) => [...m.keys()]))];
  const whCode = new Map<string, { code: string; name: string | null }>();
  if (whIds.length > 0) {
    const { data: whRows, error: whErr } = await scopeToCompany(sb.from('warehouses').select('id, code, name'), c).in('id', whIds);
    if (whErr) {
      // eslint-disable-next-line no-console
      console.error('[inventory] warehouse codes read failed:', (whErr as { message?: unknown }).message ?? whErr);
    }
    for (const w of (whRows ?? []) as Array<{ id: string; code: string; name: string | null }>) whCode.set(w.id, { code: w.code, name: w.name });
  }
  const stockByWarehouse = (code: string) => [...(lotsByWh.get(code) ?? new Map<string, { qty: number; held: number }>()).entries()]
    .map(([id, v]) => ({ warehouse_id: id, code: whCode.get(id)?.code ?? '?', name: whCode.get(id)?.name ?? null, qty: Math.round(v.qty), held_qty: Math.round(v.held) }))
    .filter((w) => w.qty !== 0)
    .sort((a, b) => b.qty - a.qty || a.code.localeCompare(b.code));

  const enriched = products.map((p) => {
    const code = String(p.item_code);
    /* SERVICE SKUs hold no stock — a delivery fee is not a thing on a shelf.
       They were nonetheless getting the SO-demand aggregates summed onto them,
       so SVC-DELIVERY read "Scheduled −18 · Unscheduled 20 · Spare −38" as if
       the warehouse were 38 delivery fees short. Owner, 2026-08-05:
       "这种 service 都不需要计算 qty 啊".
       The ROW stays — the list has a SERVICE category chip and removing it would
       empty that filter — but every quantity on it is reported as zero, because
       zero is the truth. Classified through the SHARED isServiceLine (item group
       / category / SVC- code prefix), never a category string compared inline,
       so this agrees with the DO, GRN and return paths that already exclude
       service from stock movement. */
    if (isServiceLine({ itemGroup: (p as { item_group?: string | null }).item_group ?? null,
                        category: (p as { category?: string | null }).category ?? null,
                        itemCode: code })) {
      return {
        ...p,
        total_qty: 0, total_value_sen: 0, owned_qty: 0, held_qty: 0,
        committed_scheduled: 0, unscheduled_qty: 0, reserved_total: 0,
        available_qty: 0, surplus_qty: 0,
        sellable_surplus_qty: 0, non_selling_qty: 0,
        incoming_qty: 0, incoming_pos: [], demand_sos: [], stock_by_warehouse: [],
        oldest_lot_at: null,
      };
    }
    /* ONE stock number, used by the column AND by the arithmetic below.
       ------------------------------------------------------------------
       These were two different numbers until 2026-08-05, and the row
       contradicted itself in public: the Stock column showed the LOT ledger
       (owned open lots) while `available` was computed from the MOVEMENT
       rollup, so a row could read "1 stock, +1 incoming, −2 scheduled → −1
       available". Owner: "明明一加一减二等于零,可是它却呈现出来是减一".

       Which ledger to stand on was settled with EVIDENCE, not preference.
       `reconcile-sku.mjs` walks the actual GRN receipts, DO shipments and
       returns for a SKU and states what the documents require. Run against the
       five drifting sofas on 2026-08-05, every one came back the same way:

         XAMMAR-1A(LHF)  documents 0   movement −1 WRONG   lots 0 matches
         XAMMAR-2A(RHF)  documents 1   movement  0 WRONG   lots 1 matches
         OMMBUC-1A(LHF)  documents 0   movement −1 WRONG   lots 0 matches
         OMMBUC-2A(RHF)  documents 0   movement −1 WRONG   lots 0 matches

       So the column was already reading the right side and the arithmetic the
       wrong one. Both now read the lots.

       THIS IS A COHERENCE FIX, NOT A RULING ON WHICH LEDGER IS RIGHT, and the
       distinction matters because the repo holds a direct counterexample.
       `plan-phantom-lots.mjs` opens by stating that for ITS three SKUs "the
       MOVEMENT ledger — the number the Inventory screen shows and MRP allocates
       from — is CORRECT on all of them, proven against the documents. The LOT
       ledger carries units that are not there." That was 2026-08-04, and it was
       equally evidence-backed.

       So neither ledger is universally correct, and no line of code here can
       decide which one is. What a row CAN do is stop contradicting itself: one
       number, shown and computed from. The Stock column already stood on the
       lots, so the arithmetic follows it there.

       `ledger_mismatch` below is the part that carries the uncertainty to the
       screen — it marks exactly the rows where either side may be wrong, so a
       planner reconciles instead of trusting. Hiding the disagreement behind
       whichever side we picked is how it survived this long. */
    const lotOwned = Math.round(ownedQty.get(code) ?? 0);
    const lotHeld = Math.round(heldQty.get(code) ?? 0);
    const stock = lotOwned + lotHeld;
    const movementStock = scopedToWarehouses ? (whStock.get(code) ?? 0) : Number(p.total_qty ?? 0);
    const value = Math.round(ownedValueSen.get(code) ?? 0);
    const committed = committedScheduled.get(code) ?? 0;
    const unsched = unscheduled.get(code) ?? 0;
    const inc = incoming.get(code) ?? 0;
    /* Arithmetic stands on OWNED only. `stock` (owned + held) is what the row
       DISPLAYS — the held suffix keeps consignment findable — but a held unit is
       somebody else's goods and must not read as available or spare. Owner,
       2026-07-25 and again 2026-08-05 when the one-number unification briefly
       let held leak into Available/Spare: "consignment 的东西怎么可以放进 my
       stocks 里面 … 你这样子我会以为我有货" / "好像显得我们还有过量". */
    const available = lotOwned + inc - committed;
    const pos = (incomingPos.get(code) ?? []).slice().sort((a, b) => byDateAsc(a.eta, b.eta));
    return {
      ...p,
      total_qty:           stock,
      total_value_sen:     value,
      owned_qty:           lotOwned,
      /* HELD, NOT OWNED. total_qty carried consignment units with no way to say
         so, which is how 12 of the 14 pieces standing in PJ SHOWROOM read as the
         owner's stock. Owner, 2026-08-05: "consignment 的东西怎么可以放进 my
         stocks 里面 … 你这样子我会以为我有货". The Stock Breakdown drawer already
         speaks this language ("CONSIGNMENT — HELD, NOT OWNED").
         Summed from the consignment lots directly. It used to be derived as
         (movement stock − owned lots), which mixed the two ledgers so that any
         disagreement between them was silently reported as consignment stock. */
      held_qty:            lotHeld,
      held_value_sen:      Math.round(heldValueSen.get(code) ?? 0),
      movement_qty:        movementStock,
      ledger_mismatch:     movementStock !== stock,
      committed_scheduled: committed,
      unscheduled_qty:     unsched,
      reserved_total:      committed + unsched,
      available_qty:       available,
      surplus_qty:         available - unsched,
      /* Held is already out of `available`, and the non-selling balance COUNTS
         those held units (they stand in the showroom), so subtract only the
         OWNED portion parked in non-selling warehouses — else held would be
         removed twice and a real dead-stock candidate could hide. Incoming is
         NOT counted: dead stock is on-hand only (owner 2026-10-15). */
      sellable_surplus_qty: deadStockQty(lotOwned, committed + unsched, Math.max(0, (nonSellingQty.get(code) ?? 0) - lotHeld)),
      non_selling_qty:     nonSellingQty.get(code) ?? 0,
      incoming_qty:        inc,
      incoming_pos:        pos,
      demand_sos:          (demandSos.get(code) ?? []).slice().sort((a, b) =>
        byDateAsc(a.delivery_date, b.delivery_date) || byDateAsc(a.so_date, b.so_date) || a.doc_no.localeCompare(b.doc_no)),
      oldest_lot_at:       oldestLot.get(code) ?? null,
      stock_by_warehouse:  stockByWarehouse(code),
    };
  });
  const out = scopedToWarehouses
    ? enriched.filter((r) => (r.total_qty as number) !== 0 || r.incoming_qty > 0 || r.reserved_total > 0)
    : enriched;
  return c.json({ products: out });
};
inventory.get('/products', productTotalsHandler);

function byDateAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
}

inventory.get('/breakdown/:itemCode', async (c) => {
  const sb = c.get('supabase');
  const itemCode = c.req.param('itemCode');

  const { data: bal, error: balErr } = await sb.from('inventory_balances')
    .select('warehouse_id, variant_key, qty, last_movement_at')
    .eq('item_code', itemCode)
    .eq('company_id', activeCompanyId(c));
  if (balErr) {
    if (/relation .* does not exist/i.test(balErr.message) || /column .* does not exist/i.test(balErr.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migration 0095 against Supabase.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: balErr.message }, 500);
  }
  // OWNED value per (warehouse, variant) from the OPEN LOTS, excluding consignment-
  // sourced lots (owner rule, BUG-HISTORY 2026-07-25) — NOT the raw v_inventory_value,
  // which sums every lot including consignment. This keeps a variant row's value in
  // the list expansion / Stock Card consistent with the SKU-row total and the drawer:
  // the ONE classifier isConsignmentLotSource + the ONE basis remaining_value_sen
  // (= qty_remaining * unit_cost_sen). Bounded — single product, one query.
  const { data: lots } = await scopeToCompany(sb.from('v_inventory_lots_open')
    .select('warehouse_id, variant_key, remaining_value_sen, source_doc_type, source_doc_no')
    .eq('item_code', itemCode), c);
  const { data: whs } = await sb.from('warehouses').select('id, code, name, is_consignment');

  const whMap = new Map((whs ?? []).map((w: { id: string; code: string; name: string; is_consignment: boolean | null }) => [w.id, w]));
  const valMap = new Map<string, number>();
  for (const l of (lots ?? []) as Array<{ warehouse_id: string; variant_key: string | null; remaining_value_sen: number | null; source_doc_type: string | null; source_doc_no: string | null }>) {
    if (isConsignmentLotSource(l.source_doc_type, l.source_doc_no)) continue;
    const k = `${l.warehouse_id}|${l.variant_key ?? ''}`;
    valMap.set(k, (valMap.get(k) ?? 0) + Number(l.remaining_value_sen ?? 0));
  }
  const balances = ((bal ?? []) as Array<{ warehouse_id: string; variant_key: string | null; qty: number; last_movement_at: string | null }>)
    .map((b) => {
      const vk = b.variant_key ?? '';
      const w = whMap.get(b.warehouse_id) as { code: string; name: string; is_consignment: boolean | null } | undefined;
      return {
        warehouse_id: b.warehouse_id,
        warehouse_code: w?.code ?? null,
        warehouse_name: w?.name ?? null,
        is_consignment: !!w?.is_consignment,
        variant_key: vk,
        item_code: itemCode,
        qty: Number(b.qty ?? 0),
        value_sen: valMap.get(`${b.warehouse_id}|${vk}`) ?? 0,
        last_movement_at: b.last_movement_at ?? null,
      };
    });
  // Stamp fabric_supplier_code per bucket so the Attributes cell can render the
  // shared final fabric format — "EZ-002 (KN390-2) / SEAT 28" (owner 2026-07-24,
  // "全部包裹 stocks 你也是要看到 supplier 的 fabric code"). Batched; fail-soft.
  await enrichVariantKeyRowsWithFabricSupplierCode(sb, c, balances);
  return c.json({ balances });
});

inventory.get('/movements', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const itemCode = c.req.query('itemCode');
  const docType = c.req.query('docType');
  const dateFrom = c.req.query('dateFrom');
  const dateTo = c.req.query('dateTo');
  const limit = Math.min(500, Number(c.req.query('limit') ?? 200));
  const win = mytDayWindow(dateFrom, dateTo);
  if (!win) return c.json({ error: 'invalid_date', message: 'Dates must be YYYY-MM-DD.' }, 400);

  let q = sb.from('inventory_movements')
    .select('id, movement_type, warehouse_id, item_code, product_name, qty, unit_cost_sen, total_cost_sen, source_doc_type, source_doc_id, source_doc_no, reason_code, notes, performed_by, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (itemCode) q = q.eq('item_code', itemCode);
  if (docType) q = q.eq('source_doc_type', docType);
  if (win.startUtc) q = q.gte('created_at', win.startUtc);
  if (win.endUtc) q = q.lt('created_at', win.endUtc);
  q = scopeToCompany(q, c);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const movements = (data ?? []) as Array<Record<string, unknown>>;
  return c.json({ movements: canViewScmFinance(c) ? movements : stripInventoryFinance(movements) });
});

export const inventoryLotsHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const sb = c.get('supabase');
  const itemCode = c.req.param('itemCode');
  const warehouseId = c.req.query('warehouseId');
  const includeClosed = c.req.query('includeClosed') === 'true';

  const tbl = includeClosed ? 'inventory_lots' : 'v_inventory_lots_open';
  let q = sb.from(tbl).select('*').eq('item_code', itemCode);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  q = scopeToCompany(q, c);
  const { data, error } = await q.order('received_at', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const lots = (data ?? []).map((l: Record<string, unknown>) => ({
    ...l,
    is_consignment: isConsignmentLotSource(
      l.source_doc_type as string | null, l.source_doc_no as string | null,
    ),
  })) as Array<Record<string, unknown>>;
  return c.json({ lots: canViewScmFinance(c) ? lots : stripInventoryFinance(lots) });
};
inventory.get('/lots/:itemCode', inventoryLotsHandler);

inventory.get('/batches', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const itemCode = c.req.query('itemCode');

  let q = sb.from('v_inventory_lots_open')
    .select('warehouse_id, batch_no, item_code, variant_key, product_name, qty_remaining, unit_cost_sen, received_at')
    .not('batch_no', 'is', null)
    .gt('qty_remaining', 0);
  q = scopeToCompany(q, c);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  const { data: lots, error } = await q.order('received_at', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Lot = {
    warehouse_id: string; batch_no: string; item_code: string;
    variant_key: string | null; product_name: string | null;
    qty_remaining: number; unit_cost_sen: number | null; received_at: string | null;
  };
  const rows = (lots ?? []) as Lot[];

  const { data: whs } = await sb.from('warehouses').select('id, code, name');
  const whName = new Map<string, string>();
  for (const w of (whs ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
    const label = warehouseLabel(w);
    if (label) whName.set(w.id, label);
  }

  const batchNos = [...new Set(rows.map((r) => r.batch_no))];
  const supplierByPo = new Map<string, { id: string | null; name: string | null }>();
  if (batchNos.length > 0) {
    const { data: pos } = await sb.from('purchase_orders')
      .select('po_number, supplier_id, suppliers(name)')
      .in('po_number', batchNos);
    for (const p of (pos ?? []) as unknown as Array<{ po_number: string; supplier_id: string | null; suppliers: { name: string | null } | { name: string | null }[] | null }>) {
      const sup = Array.isArray(p.suppliers) ? (p.suppliers[0] ?? null) : p.suppliers;
      supplierByPo.set(p.po_number, { id: p.supplier_id ?? null, name: sup?.name ?? null });
    }
  }

  type Component = {
    itemCode: string; variantKey: string | null; productName: string | null;
    qtyRemaining: number; unitCostSen: number; receivedAt: string | null;
  };
  type Batch = {
    warehouseId: string; warehouseName: string | null; batchNo: string;
    supplierId: string | null; supplierName: string | null;
    receivedAt: string | null; totalRemaining: number; components: Component[];
  };
  const byBatch = new Map<string, Batch>();
  for (const r of rows) {
    const key = `${r.warehouse_id}|${r.batch_no}`;
    let b = byBatch.get(key);
    if (!b) {
      const sup = supplierByPo.get(r.batch_no) ?? { id: null, name: null };
      b = {
        warehouseId: r.warehouse_id,
        warehouseName: whName.get(r.warehouse_id) ?? null,
        batchNo: r.batch_no,
        supplierId: sup.id,
        supplierName: sup.name,
        receivedAt: r.received_at,
        totalRemaining: 0,
        components: [],
      };
      byBatch.set(key, b);
    }
    const existing = b.components.find((c2) => c2.itemCode === r.item_code && (c2.variantKey ?? '') === (r.variant_key ?? ''));
    if (existing) {
      existing.qtyRemaining += r.qty_remaining;
    } else {
      b.components.push({
        itemCode: r.item_code,
        variantKey: r.variant_key,
        productName: r.product_name,
        qtyRemaining: r.qty_remaining,
        unitCostSen: Number(r.unit_cost_sen ?? 0),
        receivedAt: r.received_at,
      });
    }
    b.totalRemaining += r.qty_remaining;
    if (r.received_at && (!b.receivedAt || r.received_at < b.receivedAt)) b.receivedAt = r.received_at;
  }

  let batches = [...byBatch.values()];
  if (itemCode) batches = batches.filter((b) => b.components.some((c2) => c2.itemCode === itemCode));
  batches.sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''));

  const allComponents = batches.flatMap((b) => b.components as unknown as Array<Record<string, unknown>>);
  await enrichVariantKeyRowsWithFabricSupplierCode(sb, c, allComponents, 'variantKey');

  return c.json({ batches });
});

inventory.get('/cogs', async (c) => {
  if (!canViewScmFinance(c)) {
    return c.json({ error: 'forbidden', message: "You don't have permission to see cost of goods sold." }, 403);
  }
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const itemCode = c.req.query('itemCode');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const win = mytDayWindow(from, to);
  if (!win) return c.json({ error: 'invalid_date', message: 'Dates must be YYYY-MM-DD.' }, 400);

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb.from('v_cogs_entries').select('*');
    q = scopeToCompany(q, c);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    if (itemCode) q = q.eq('item_code', itemCode);
    if (win.startUtc) q = q.gte('consumed_at', win.startUtc);
    if (win.endUtc) q = q.lt('consumed_at', win.endUtc);
    return q.order('consumed_at', { ascending: false }).order('id').range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ cogs: data ?? [] });
});

inventory.get('/value', async (c) => {
  if (!canViewScmFinance(c)) {
    return c.json({ error: 'forbidden', message: "You don't have permission to see inventory valuation." }, 403);
  }
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const { data, error } = await paginateAll((from, to) => {
    let q = sb.from('v_inventory_value').select('*');
    q = scopeToCompany(q, c);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    return q.order('item_code').order('warehouse_id').order('variant_key').order('product_name').order('company_id').range(from, to);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ value: data ?? [] });
});

inventory.get('/analytics', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const days = Math.max(1, Math.min(365, Math.round(Number(c.req.query('days') ?? 90)) || 90));
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - days * 86_400_000).toISOString();

  const { data: lots, error: lotsErr } = await paginateAll((from, to) => {
    let lotsQ = sb.from('v_inventory_lots_open')
      // source_doc_type/no ride along so consignment-sourced lots can be excluded
      // from every VALUE figure below (owner rule, BUG-HISTORY 2026-07-25) — the
      // same classification the list value column and the Stock Breakdown drawer use.
      .select('item_code, product_name, qty_remaining, remaining_value_sen, received_at, warehouse_id, source_doc_type, source_doc_no');
    lotsQ = scopeToCompany(lotsQ, c);
    if (warehouseId) lotsQ = lotsQ.eq('warehouse_id', warehouseId);
    return lotsQ.order('received_at').order('id').range(from, to);
  });
  if (lotsErr) return c.json({ error: 'load_failed', reason: lotsErr.message }, 500);

  const { data: cogs, error: cogsErr } = await paginateAll((from, to) => {
    let cogsQ = sb.from('v_cogs_entries')
      .select('item_code, total_cost_sen, consumed_at, warehouse_id');
    cogsQ = scopeToCompany(cogsQ, c);
    if (warehouseId) cogsQ = cogsQ.eq('warehouse_id', warehouseId);
    return cogsQ.order('id').range(from, to);
  });
  if (cogsErr) return c.json({ error: 'load_failed', reason: cogsErr.message }, 500);

  const lotRows = lots ?? [];
  const cogsRows = cogs ?? [];

  /* WHERE the stock is standing decides whether "no sale" means anything.
     Owner, 2026-08-05: "我的 dead stock 里面怎么会有 dead stock 呢？因为它明明是
     showroom 的 display 啊".
     Dead stock is defined below as "has on-hand value but no sale in the window",
     which a display piece satisfies FOREVER — standing there IS its job. Same for
     a unit sent back to the supplier for service. Neither is a slow seller, and
     flagging them buries the ones that are.
     `warehouses.type` already carries this (mig 0171 keeps is_showroom in step
     with `type = 'showroom'`), so nothing new is stored — the axis was there and
     dead stock simply never read it. */
  const nonSellingWh = await loadNonSellingWarehouseIds(sb, c);

  const BUCKETS = [
    { key: '0-30', label: '0–30 days', max: 30 },
    { key: '31-60', label: '31–60 days', max: 60 },
    { key: '61-90', label: '61–90 days', max: 90 },
    { key: '91-180', label: '91–180 days', max: 180 },
    { key: '180+', label: '180+ days', max: Infinity },
  ];
  const aging = BUCKETS.map((b) => ({ key: b.key, label: b.label, qty: 0, valueSen: 0 }));
  const prod = new Map<string, { name: string; qty: number; valueSen: number }>();
  const sellable = new Map<string, { name: string; qty: number; valueSen: number }>();
  let totalValueSen = 0;
  for (const l of lotRows) {
    // Consignment stock is held, not owned — it shows QUANTITY on the drawer/list
    // but must not sit in any inventory VALUE figure (total value, aging value,
    // dead-stock value, ABC on-hand value). Classify by the lot SOURCE, never the
    // warehouse flag (owner rule, BUG-HISTORY 2026-07-25).
    if (isConsignmentLotSource(l.source_doc_type as string | null, l.source_doc_no as string | null)) continue;
    const ageDays = (nowMs - new Date(l.received_at as string).getTime()) / 86_400_000;
    const idx = BUCKETS.findIndex((b) => ageDays <= b.max);
    const bucket = aging[idx < 0 ? aging.length - 1 : idx];
    const qty = Number(l.qty_remaining ?? 0);
    const val = Number(l.remaining_value_sen ?? 0);
    if (bucket) { bucket.qty += qty; bucket.valueSen += val; }
    totalValueSen += val;
    const code = String(l.item_code ?? '');
    const p = prod.get(code) ?? { name: String(l.product_name ?? code), qty: 0, valueSen: 0 };
    p.qty += qty; p.valueSen += val;
    prod.set(code, p);

    if (!nonSellingWh.has(String(l.warehouse_id ?? ''))) {
      const s = sellable.get(code) ?? { name: String(l.product_name ?? code), qty: 0, valueSen: 0 };
      s.qty += qty; s.valueSen += val;
      sellable.set(code, s);
    }
  }

  const trailingCogs = new Map<string, number>();
  const lastSold = new Map<string, string>();
  let trailingCogsTotal = 0;
  for (const e of cogsRows) {
    const code = String(e.item_code ?? '');
    const at = String(e.consumed_at ?? '');
    const prev = lastSold.get(code);
    if (!prev || at > prev) lastSold.set(code, at);
    if (at >= cutoffIso) {
      const v = Number(e.total_cost_sen ?? 0);
      trailingCogs.set(code, (trailingCogs.get(code) ?? 0) + v);
      trailingCogsTotal += v;
    }
  }

  const annualizedCogs = trailingCogsTotal * (365 / days);
  const turns = totalValueSen > 0 ? annualizedCogs / totalValueSen : 0;
  const daysOnHand = trailingCogsTotal > 0 ? (totalValueSen * days) / trailingCogsTotal : null;

  const deadStock = [...sellable.entries()]
    .filter(([code]) => !(trailingCogs.get(code) ?? 0))
    .map(([code, p]) => ({
      item_code: code, product_name: p.name, qty: p.qty, valueSen: p.valueSen,
      lastSoldAt: lastSold.get(code) ?? null,
    }))
    .sort((a, b) => b.valueSen - a.valueSen);

  const codes = new Set<string>([...prod.keys(), ...trailingCogs.keys()]);
  const ranked = [...codes]
    .map((code) => ({
      item_code: code,
      product_name: prod.get(code)?.name ?? code,
      cogsSen: trailingCogs.get(code) ?? 0,
      onHandValueSen: prod.get(code)?.valueSen ?? 0,
    }))
    .sort((a, b) => b.cogsSen - a.cogsSen);
  const summary = { A: { count: 0, valueSen: 0 }, B: { count: 0, valueSen: 0 }, C: { count: 0, valueSen: 0 } };
  let cum = 0;
  const abcItems = ranked.map((r) => {
    cum += r.cogsSen;
    const cumPct = trailingCogsTotal > 0 ? (cum / trailingCogsTotal) * 100 : 100;
    const cls: 'A' | 'B' | 'C' = cumPct <= 80 ? 'A' : cumPct <= 95 ? 'B' : 'C';
    summary[cls].count += 1;
    summary[cls].valueSen += r.onHandValueSen;
    return { ...r, cumPct, class: cls };
  });

  return c.json({
    asOf: new Date(nowMs).toISOString(),
    windowDays: days,
    totalValueSen,
    distinctSkus: prod.size,
    aging,
    turnover: { trailingCogsSen: trailingCogsTotal, annualizedTurns: turns, daysOnHand },
    deadStock,
    abc: { items: abcItems, summary },
  });
});

inventory.get('/reconcile', async (c) => {
  const sb = c.get('supabase');
  try {
    return c.json(await reconcileLedger(sb, activeCompanyId(c)));
  } catch (e: any) {
    return c.json({ error: 'load_failed', reason: e?.message ?? 'reconcile failed' }, 500);
  }
});


inventory.get('/buckets/:itemCode', async (c) => {
  const sb = c.get('supabase');
  const itemCode = c.req.param('itemCode');
  const warehouseId = c.req.query('warehouseId');

  let q = sb.from('v_inventory_lots_open')
    .select('warehouse_id, variant_key, batch_no, product_name, qty_remaining')
    .eq('item_code', itemCode);
  q = scopeToCompany(q, c);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Lot = {
    warehouse_id: string; variant_key: string | null; batch_no: string | null;
    product_name: string | null; qty_remaining: number | null;
  };
  const byBucket = new Map<string, {
    warehouse_id: string; variant_key: string; batch_no: string | null;
    product_name: string | null; qty: number;
  }>();
  for (const l of (data ?? []) as Lot[]) {
    const vk = l.variant_key ?? '';
    const bn = l.batch_no ?? null;
    const key = `${l.warehouse_id}|${vk}|${bn ?? ''}`;
    const cur = byBucket.get(key);
    if (cur) cur.qty += Number(l.qty_remaining ?? 0);
    else byBucket.set(key, { warehouse_id: l.warehouse_id, variant_key: vk, batch_no: bn, product_name: l.product_name, qty: Number(l.qty_remaining ?? 0) });
  }
  const buckets = [...byBucket.values()]
    .filter((b) => b.qty > 0)
    .sort((a, b) => (a.batch_no ?? '').localeCompare(b.batch_no ?? '') || a.variant_key.localeCompare(b.variant_key));
  return c.json({ buckets });
});

/* ── Reserved-but-unshipped visibility ───────────────────────────────────
   Every OPEN FIFO lot (qty_remaining > 0) alongside the READY sales-order
   demand that claims it — so the owner can see, for a lot sitting unshipped,
   WHICH SO reserved it vs which stock is free (no order). Read-only; no
   schema change.

   Owner 2026-07-25 (dead-stock view): the hard READY reservation is only ONE
   signal. The response ALSO carries the FLOATING MRP allocation (assigned_qty /
   free_qty / mrp_assigned_to per lot, derived from the SAME computeMrp engine —
   see block 3c below): a lot is ASSIGNED iff MRP allocates on-hand stock to an
   SO, so genuinely-unallocated stock is FREE = a dead-stock candidate
   (is_dead_stock, emphasised for make-to-order SOFA/BEDFRAME). The drawer +
   Reservations tab render the MRP split; the hard status/reserved_by stay for
   continuity.

   Matching mirrors the allocator (so-stock-allocation.ts):
     • BATCHED lot (batch_no present, e.g. sofa) — a READY line claims it only
       when its allocated_batch_no equals the lot's batch_no and the item_code
       matches. This is a TRUE lot-level pin.
     • UN-BATCHED lot — allocation is bucket-level (warehouse + item_code +
       variant_key), never lot-pinned, so every READY line on that bucket is
       listed as a claimant of every open lot in it. Faithful to how the
       allocator actually reserves: the bucket is the unit, not the lot.

   No allocation timestamp exists in the schema, so "reserved since" is the
   reserving SO's created_at — an honest proxy for the age of the claim, not a
   fabricated allocation time. ?warehouseId / ?itemCode narrow the scan. */
inventory.get('/reservations', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const itemCode = c.req.query('itemCode');

  const { data: lotRows, error: lotErr } = await paginateAll<{
    id: string; item_code: string; product_name: string | null; variant_key: string | null;
    warehouse_id: string; batch_no: string | null; qty_remaining: number | null;
    unit_cost_sen: number | null; received_at: string | null;
    source_doc_type: string | null; source_doc_no: string | null;
  }>((from, to) => {
    let q = sb.from('v_inventory_lots_open')
      .select('id, item_code, product_name, variant_key, warehouse_id, batch_no, qty_remaining, unit_cost_sen, received_at, source_doc_type, source_doc_no')
      .gt('qty_remaining', 0);
    q = scopeToCompany(q, c);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    if (itemCode) q = q.eq('item_code', itemCode);
    return q.order('received_at', { ascending: true }).order('id').range(from, to);
  });
  if (lotErr) return c.json({ error: 'load_failed', reason: lotErr.message }, 500);
  const lots = lotRows ?? [];

  const grnNos = [...new Set(
    lots
      .filter((l) => (l.source_doc_type ?? '').toUpperCase() === 'GRN')
      .map((l) => l.source_doc_no)
      .filter((n): n is string => !!n),
  )];
  const grnToPoNo = new Map<string, string>();
  if (grnNos.length > 0) {
    const { data: grnRows } = await chunkIn<{ grn_number: string; purchase_order_id: string | null }>(
      grnNos,
      (batch, from, to) => scopeToCompany(sb
        .from('grns').select('grn_number, purchase_order_id'), c)
        .in('grn_number', batch).order('id').range(from, to),
    );
    const poIds = [...new Set(
      (grnRows ?? [])
        .map((g) => g.purchase_order_id)
        .filter((x): x is string => !!x),
    )];
    const poNoById = new Map<string, string>();
    if (poIds.length > 0) {
      const { data: poRows } = await chunkIn<{ id: string; po_number: string | null }>(
        poIds,
        (batch, from, to) => scopeToCompany(sb
          .from('purchase_orders').select('id, po_number'), c)
          .in('id', batch).order('id').range(from, to),
      );
      for (const p of poRows ?? []) {
        if (p.po_number) poNoById.set(p.id, p.po_number);
      }
    }
    for (const g of grnRows ?? []) {
      const po = g.purchase_order_id ? poNoById.get(g.purchase_order_id) : undefined;
      if (po) grnToPoNo.set(g.grn_number, po);
    }
  }

  const SO_DONE = new Set(['DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED', 'SHIPPED']);
  type SoJoin = {
    created_at: string | null; status: string | null;
    customer_delivery_date?: string | null; amended_delivery_date?: string | null;
  };
  type ReadyLine = {
    id: string; doc_no: string; item_code: string; item_group: string | null;
    variants: VariantAttrs | null; warehouse_id: string | null;
    stock_qty_ready: number | null; allocated_batch_no?: string | null;
    so: SoJoin | SoJoin[] | null;
  };
  const READY_SELECT = 'id, doc_no, item_code, item_group, variants, warehouse_id, stock_qty_ready, allocated_batch_no, so:mfg_sales_orders!inner(created_at, status, customer_delivery_date, amended_delivery_date)';
  const READY_SELECT_NOBATCH = 'id, doc_no, item_code, item_group, variants, warehouse_id, stock_qty_ready, so:mfg_sales_orders!inner(created_at, status, customer_delivery_date, amended_delivery_date)';
  let readyRows: ReadyLine[] = [];
  {
    const pull = (select: string) => paginateAll<ReadyLine>((from, to) => scopeToCompany(sb
      .from('mfg_sales_order_items')
      .select(select)
      .eq('stock_status', 'READY')
      .eq('cancelled', false), c)
      .order('id').range(from, to) as unknown as PromiseLike<{ data: ReadyLine[] | null; error: { message: string; code?: string } | null }>);
    let res = await pull(READY_SELECT);
    if (res.error && /allocated_batch_no|column .* does not exist/i.test(res.error.message ?? '')) {
      res = await pull(READY_SELECT_NOBATCH);
    }
    if (res.error) return c.json({ error: 'load_failed', reason: res.error.message }, 500);
    readyRows = (res.data ?? []).filter((r) => {
      const so = Array.isArray(r.so) ? r.so[0] : r.so;
      return so != null && !SO_DONE.has((so.status ?? '').toUpperCase());
    });
  }

  type Claim = { docNo: string; soCreatedAt: string | null; qtyReady: number; deliveryDate: string | null; viaBatch: boolean };
  const byBatch = new Map<string, Claim[]>();
  const byBucket = new Map<string, Claim[]>();
  for (const r of readyRows) {
    const so = Array.isArray(r.so) ? r.so[0] : r.so;
    const deliveryDate = so ? effectiveSoDelivery(so) : null;
    const bn = r.allocated_batch_no ?? null;
    const claim: Claim = { docNo: r.doc_no, soCreatedAt: so?.created_at ?? null, qtyReady: Number(r.stock_qty_ready ?? 0), deliveryDate, viaBatch: Boolean(bn) };
    if (bn) {
      const k = `${bn}|${r.item_code}`;
      (byBatch.get(k) ?? byBatch.set(k, []).get(k)!).push(claim);
    }
    const vk = computeVariantKey(r.item_group ?? null, r.variants ?? null);
    const bk = `${r.warehouse_id ?? ''}|${r.item_code}|${vk}`;
    (byBucket.get(bk) ?? byBucket.set(bk, []).get(bk)!).push(claim);
  }

  const { data: whs } = await sb.from('warehouses').select('id, code, name, type');
  const whMap = new Map((whs ?? []).map((w: { id: string; code: string; name: string; type: string | null }) => [w.id, w]));

  const lotCodes = [...new Set(lots.map((l) => l.item_code).filter(Boolean))];
  const categoryByCode = new Map<string, string | null>();
  if (lotCodes.length > 0) {
    const { data: prods, error: prodErr } = await chunkIn(lotCodes, (batch, from, to) => pgrestIn(scopeToCompany(sb
      .from('mfg_products').select('code, category'), c), 'code', batch).order('id').range(from, to));
    if (prodErr) {
      // eslint-disable-next-line no-console
      console.error('[inventory] lot-code category read failed:', (prodErr as { message?: unknown }).message ?? prodErr);
    }
    for (const p of (prods ?? []) as Array<{ code: string; category: string | null }>) {
      categoryByCode.set(p.code, p.category ?? null);
    }
  }

  // 3c. MRP-derived ASSIGNED vs FREE (owner 2026-07-25, dead-stock view) ──────
  //     The hard READY reservations above answer "which lot is HARD-reserved".
  //     The owner's dead-stock model needs the FLOATING truth instead: a lot is
  //     ASSIGNED iff the ONE MRP engine allocates ON-HAND stock to an SO's demand
  //     (MrpLine/SofaSet.stockQty), so only genuinely-unallocated stock is FREE =
  //     a dead-stock candidate. Right now the drawer reflects only HARD
  //     reservations, so stock MRP would allocate wrongly shows as "FREE".
  //
  //     computeMrp runs ONCE per request (never per-SKU in a loop — the LIST
  //     crash guard; this is the same single-call cost /po-so-coverage already
  //     pays), inverted to the stock side by mrpStockAssignment, then each
  //     bucket's assigned qty is spread across its open lots FIFO (oldest first —
  //     the order the next DO consumes them). Fail-soft: if MRP throws, every lot
  //     degrades to assigned=0 / free=all, never a 500.
  const assignedByLotId = new Map<string, {
    assigned: number; free: number;
    claims: Array<{ doc_no: string; delivery_date: string | null; qty: number }>;
  }>();
  try {
    const mrp = await computeMrp(sb, {
      catFilter: null,
      whFilter: warehouseId ?? null,
      includeUndated: true,
      companyId: activeCompanyId(c),
      leadBuffers: await loadLeadBuffers(c.env.DB),
    });
    const stockAsg = mrpStockAssignment(mrp);
    const lotsByBucket = new Map<string, typeof lots>();
    for (const l of lots) {
      const k = stockAssignmentKey(l.warehouse_id, l.item_code, l.variant_key ?? '');
      (lotsByBucket.get(k) ?? lotsByBucket.set(k, []).get(k)!).push(l);
    }
    for (const [k, bucketLots] of lotsByBucket.entries()) {
      const asg = stockAsg.get(k);
      const splits = distributeAssignedToLots(
        bucketLots.map((l) => Number(l.qty_remaining ?? 0)),
        asg?.assigned ?? 0,
        (asg?.claims ?? []).map((cl) => ({ soDocNo: cl.soDocNo, deliveryDate: cl.deliveryDate, qty: cl.qty })),
      );
      bucketLots.forEach((l, i) => {
        const s = splits[i];
        if (!s) return;
        assignedByLotId.set(l.id, {
          assigned: s.assignedQty,
          free: s.freeQty,
          claims: s.assignedTo.map((a) => ({ doc_no: a.soDocNo, delivery_date: a.deliveryDate, qty: a.qty })),
        });
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[inventory] reservations MRP assignment failed (degraded to all-free):', e instanceof Error ? e.message : e);
  }

  const reservations = lots.map((l) => {
    const vk = l.variant_key ?? '';
    const bucketClaims = byBucket.get(`${l.warehouse_id}|${l.item_code}|${vk}`) ?? [];
    const claims = l.batch_no
      ? [...(byBatch.get(`${l.batch_no}|${l.item_code}`) ?? []), ...bucketClaims.filter((cl) => !cl.viaBatch)]
      : bucketClaims;
    const byDoc = new Map<string, Claim>();
    for (const cl of claims) {
      const cur = byDoc.get(cl.docNo);
      if (cur) cur.qtyReady += cl.qtyReady;
      else byDoc.set(cl.docNo, { ...cl });
    }
    const reservedBy = [...byDoc.values()].sort((a, b) => (a.soCreatedAt ?? '').localeCompare(b.soCreatedAt ?? ''));
    const reservedSince = reservedBy.length > 0 ? reservedBy[0].soCreatedAt : null;
    const w = whMap.get(l.warehouse_id);
    const isConsignment = isConsignmentLotSource(l.source_doc_type, l.source_doc_no);
    const qtyRemaining = Number(l.qty_remaining ?? 0);
    const mrpAsg = assignedByLotId.get(l.id);
    const assignedQty = mrpAsg?.assigned ?? 0;
    const freeQty = mrpAsg ? mrpAsg.free : qtyRemaining;
    const category = categoryByCode.get(l.item_code) ?? null;
    return {
      id: l.id,
      warehouse_id: l.warehouse_id,
      warehouse_code: w?.code ?? null,
      warehouse_name: w?.name ?? null,
      item_code: l.item_code,
      product_name: l.product_name,
      variant_key: vk,
      batch_no: l.batch_no,
      qty_remaining: Number(l.qty_remaining ?? 0),
      unit_cost_sen: Number(l.unit_cost_sen ?? 0),
      received_at: l.received_at,
      source_doc_type: l.source_doc_type ?? null,
      source_doc_no: l.source_doc_no ?? null,
      source_po_no: (l.source_doc_type ?? '').toUpperCase() === 'GRN' && l.source_doc_no
        ? (grnToPoNo.get(l.source_doc_no) ?? null)
        : null,
      is_consignment: isConsignment,
      status: reservedBy.length > 0 || assignedQty > 0 ? 'RESERVED' : 'FREE',
      reserved_by: reservedBy.map((x) => ({
        doc_no: x.docNo, so_created_at: x.soCreatedAt, qty_ready: x.qtyReady, delivery_date: x.deliveryDate,
      })),
      reserved_since: reservedSince,
      // ── MRP-derived assigned-vs-free split (owner 2026-07-25, dead-stock view).
      //    assigned_qty + free_qty == qty_remaining. mrp_assigned_to names the
      //    SO(s) this lot's assigned units belong to (FIFO-spread from the
      //    bucket's MRP allocation). category / make_to_order drive the
      //    dead-stock emphasis. is_dead_stock: this lot carries FREE (un-assigned)
      //    OWNED units outside a non-selling warehouse — consignment is
      //    held-not-owned, and showroom / service stock is doing its job.
      category,
      make_to_order: isMakeToOrderCategory(category),
      assigned_qty: assignedQty,
      free_qty: freeQty,
      mrp_assigned_to: mrpAsg?.claims ?? [],
      is_dead_stock: isDeadStockLot(isConsignment, freeQty, w?.type ?? null),
    };
  });

  await enrichVariantKeyRowsWithFabricSupplierCode(sb, c, reservations);

  return c.json({ reservations });
});
