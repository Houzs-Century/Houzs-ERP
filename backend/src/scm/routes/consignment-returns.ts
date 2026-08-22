// /consignment-returns — Consignment Return (CRN): consignment goods come back.
// A faithful clone of the Delivery Return API
// (apps/api/src/routes/delivery-returns.ts).
//
// UNIFIED inventory model (Wei Siang 2026-06-06): a Consignment Return now books
// a plain IN to the destination warehouse exactly like a Delivery Return — goods
// physically re-enter inventory at the return line's snapshot cost, recorded as a
// plain IN tagged CS_DR in the same stock ledger. Cancelling writes a balancing
// OUT. (Superseded the earlier value-neutral transfer-from-hidden-warehouse model.)
//
// Tables: consignment_delivery_returns / _items (migration 0153). The DR's
// delivery_order_id / do_item_id become consignment_do_id /
// consignment_do_item_id (→ consignment_delivery_orders / _items).
//
// DROPPED vs the DR clone:
//   • the "no DO, no return" hard requirement — RELAXED: a consignment return may
//     reference a Consignment Note OR be free-entry (the loaner can come back
//     without a linked note).
//   • /from-do, /from-dos pickers + the over-return remaining guard (DO-pipeline).
//   • reopenSoFromReturn (SO-specific) + COGS / margin recognition.
//
// Mounted at '/consignment-returns' in apps/api/src/index.ts. Numbering CRN-YYMM-NNN.

import { Hono } from 'hono';
import { normalizePhone } from '../shared/phone';
import { buildVariantSummary } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { defaultWarehouseId, writeMovements, resolveWarehouseLotBatches, resolveWarehouseLotCosts } from '../lib/inventory-movements';
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

/* FINANCE-GATED header keys — cost / margin / per-category revenue+cost
   subtotals. All are in HEADER (so they travel in the return LIST and DETAIL
   payloads) but must reach ONLY a finance-viewer
   (lib/houzs-perms.canViewScmFinance). The refund/totals everyone is meant to
   see (local_total_sen / refund_sen / line_total_sen) are deliberately NOT
   listed — the same line #625 (SO) and #632 (DR) drew.

   Consignment got the SCOPE fix (#417) but never the FINANCE fix:
   canViewScmFinance appeared ZERO times in this file, so it declared no finance
   keys at all while HEADER + ITEM selected cost and margin for every caller.
   Same class as #600 (DO/SI detail), #625 (SO detail), #632 (DR detail). */
const CRN_FINANCE_KEYS = [
  'mattress_sofa_sen', 'bedframe_sen', 'accessories_sen', 'others_sen',
  'mattress_sofa_cost_sen', 'bedframe_cost_sen', 'accessories_cost_sen', 'others_cost_sen',
  'total_cost_sen', 'total_margin_sen', 'margin_pct_basis',
] as const;

/* KEPT LOCAL, deliberately — do NOT "converge" CRN_FINANCE_KEYS onto
   SO_FINANCE_KEYS. It is the finance-shaped subset of THIS file's HEADER select,
   and the consignment return speaks a narrower money vocabulary than the SO: no
   service_sen / service_cost_sen and no deposit_sen (a return takes no
   deposit). refund_sen is in HEADER and deliberately NOT here — the refund is
   what the customer is owed and everyone who passes the access gate may see it,
   the same line #625 (SO) and #632 (DR) drew. The per-LINE keys ARE shared —
   see the SO_ITEM_FINANCE_KEYS import. */

/** Strip header + line cost/margin in place for a non-finance caller. Accepts a
 *  single header or an array (the list passes rows). */
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
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'consignment_delivery_returns', 'return_number', `${p}CRN-${yymm}`);
};

/* Re-derive the return header's per-category totals + grand total from its line
   items. Plain per-category rollup, copied from the DR.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale: a
   read it cannot vouch for must not become a written total, and it aborts by
   LOGGING because this roll-up only runs AFTER its triggering line write has
   committed (a throw becomes a 500 the client retries into a duplicate line).
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputeTotals(sb: any, returnId: string) {
  const { data: items, error: itemsErr } = await sb.from('consignment_delivery_return_items')
    .select('item_group, line_total_sen, line_cost_sen')
    .eq('consignment_delivery_return_id', returnId);
  /* A failed READ is not an empty return, and `?? []` cannot tell them apart —
     it folded a transient blip into a ZERO header AND a ZERO refund_sen on a
     return whose lines were intact, i.e. a refund owed to a customer silently
     became no refund. The ERROR is the signal, never the emptiness: a genuinely
     empty return resolves error === null with data === [] and MUST still zero. */
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
  /* The write's own result was discarded until 2026-07-17: a rejected UPDATE left
     the header STALE with nothing logged and every caller reporting success. */
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[crn-recompute] header update failed — totals left STALE:', returnId, updErr.message);
  }
}

/* ── resolveReturnLineWarehouses ──────────────────────────────────────────────
   Per-line DESTINATION warehouse for the loaner coming back. A returned line
   re-enters the warehouse its Consignment Note line shipped FROM:
     1. linked CN line → consignment_so_item_id → consignment_sales_order_items.warehouse_id
     2. linked CN header's warehouse_id
     3. the return header's warehouse_id (free-entry lines — allowed here, since
        "no DO, no return" is RELAXED for consignment)
     4. the return's OWN company's default warehouse
   Returns map of item id → warehouse_id (null when even the fallbacks are
   absent — the caller skips that line). */
async function resolveReturnLineWarehouses(
  sb: any,
  items: Array<{ id: string; consignment_do_item_id?: string | null }>,
  headerWarehouseId: string | null,
  /* The return's company (2026-08-03) — step 4 is per company. It used to be a
     company-blind draw decided by alphabetical `code` order across every
     company's is_default rows. */
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const cnItemIds = [...new Set(items
    .map((it) => it.consignment_do_item_id ?? null)
    .filter((x): x is string => !!x))];

  // CN line id → { consignment_so_item_id, CN header warehouse }
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

/* warehouse_id → display CODE for the per-line Warehouse column on detail GET. */
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

/* ── resyncReturnInventory — self-healing IN ledger for a Consignment Return ───
   ONE function for the whole lifecycle (receive / add-line / edit-qty /
   delete-line / cancel), mirroring resyncNoteInventory but IN-primary (a return
   books stock back IN). It reconciles the return's CURRENT lines (the TARGET net
   IN per warehouse/product/variant/batch bucket) against what inventory_movements
   already record for this return, and writes only the DELTA:
     • first-ever IN for a bucket   → CS_DR  (carries the "stock back IN" label +
       the CS_DR partial-unique-index idempotency backstop)
     • any later increase           → STOCK_TRANSFER IN (no unique index → no
       collision with the CS_DR row)
     • any decrease / give-back     → STOCK_TRANSFER OUT
     • cancel → status CANCELLED → TARGET is empty → every bucket's net is driven
       back to 0 via STOCK_TRANSFER OUT.
   A return posts immediately on create — there is no SHIPPED_STATES gate; it is
   "active" (books IN) whenever status !== 'CANCELLED'. Idempotent: a re-run finds
   delta 0 everywhere and writes nothing. Best-effort. */
async function resyncReturnInventory(sb: any, returnId: string, performedBy: string | null): Promise<string[]> {
  const { data: header } = await sb.from('consignment_delivery_returns')
    .select('return_number, status, warehouse_id, company_id').eq('id', returnId).maybeSingle();
  if (!header) return [];
  const status = ((header as { status: string | null }).status ?? '').toUpperCase();
  const returnNo = (header as { return_number: string }).return_number ?? returnId;
  const cancelled = status === 'CANCELLED';

  // 1. TARGET net IN per bucket = sum of current lines (empty if cancelled).
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
    for (const it of ((items ?? []) as Array<{ id: string; item_code: string; description: string | null; qty_returned: number; unit_cost_sen?: number | null; item_group?: string | null; variants?: VariantAttrs | null }>)) {
      const qty = Number(it.qty_returned ?? 0);
      if (qty <= 0) continue;
      const wh = lineWh.get(it.id) ?? null;
      if (!wh) continue;
      const vk = computeVariantKey(it.item_group ?? null, it.variants ?? null);
      const batch = batchByWh.get(wh)?.get(`${it.item_code}::${vk}`) ?? null;
      // Cost = the return line's snapshot; if it's 0 (free-entry return with no
      // cost), fall back to the SKU's current on-hand avg cost so we don't open a
      // 0-cost lot that a later FIFO sale would eat and under-state its COGS.
      const lineCost = Number(it.unit_cost_sen ?? 0);
      const unitCost = lineCost > 0 ? lineCost : (costByWh.get(wh)?.get(`${it.item_code}::${vk}`) ?? 0);
      const k = `${wh}::${it.item_code}::${vk}::${batch ?? ''}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: wh, item_code: it.item_code, variant_key: vk, product_name: it.description, qty, unit_cost_sen: unitCost, batch_no: batch });
    }
  }

  // 2. CURRENT net IN per bucket from ALL this return's movements (CS_DR IN +
  //    any prior STOCK_TRANSFER resync/cancel deltas).
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

  // 3. delta = target − current_net_in. >0 → book more IN; <0 → give stock back OUT.
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const csDrEmitted = new Set<string>(); // product::variant given a CS_DR this run (avoid 2nd-warehouse collision)
  for (const k of new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()])) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { in_qty: 0, out_qty: 0, in_total_cost: 0, product_name: null };
    const delta = (t?.qty ?? 0) - (a.in_qty - a.out_qty);
    if (delta === 0) continue;
    const [wh, pc, vk, batchSeg] = k.split('::');
    const batch_no = batchSeg || null;
    const pname = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      // First IN for this product+variant → CS_DR (label + strict index guard);
      // any later increase (or a 2nd warehouse for the same SKU) → STOCK_TRANSFER.
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
  // Multi-company: resync movements inherit the return's company.
  const res = await writeMovements(sb, writes, (header as { company_id?: number | null }).company_id ?? null);
  /* Oversell retro-cost (0154) — a consignment return books goods back onto the
     shelf (IN), so a prior "ship anyway" DO that went out at RM0 in this
     warehouse can now be costed from the re-opened lots. Wired 2026-07-29;
     before that only a GRN reconciled (COE §2). Best-effort. */
  if (res.ok) await reconcileUncostedAfterIn(sb, writes, performedBy);
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch { /* best-effort */ }
  return res.ok ? [] : [res.reason ?? 'consignment return inventory resync failed'];
}

/* Build one consignment_delivery_return_items insert row from a client line
   payload. Shared by POST / (bulk create) and POST /:id/items (single add).

   `sourceCostByNoteItem` (lib/source-cost) is the server's own read of the
   SOURCE consignment-note line's unit_cost_sen. When the line is note-linked it
   WINS over the client's `unitCostSen` unconditionally — the return must be
   booked at the cost the note shipped at, which is history, not a catalog lookup.
   Ignoring the client is what makes stripping the cost off /returnable-note-lines
   safe (the #632 trap, disarmed at its root). A free-hand line has no source row
   and keeps the client value. */
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

// ── List ────────────────────────────────────────────────────────────────
consignmentReturns.get('/', async (c) => {
  const sb = c.get('supabase');
  const status = c.req.query('status');

  /* Opt-in server-side pagination + search + sort (mirrors useSuppliersPaged).
     The PRESENCE of `page` switches paging on; when absent/empty the query is
     BYTE-IDENTICAL to the historical behavior (return_date desc, limit 500,
     status + company scope, `{ deliveryReturns }` shape) — so every existing
     full-list caller is UNAFFECTED. */
  const pageRaw = c.req.query('page');
  const paginate = pageRaw !== undefined && pageRaw !== '';

  if (!paginate) {
    /* --- LEGACY PATH (unchanged) --- */
    let q = sb.from('consignment_delivery_returns').select(HEADER).order('return_date', { ascending: false }).limit(500);
    if (status) q = q.eq('status', status);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    const { data, error } = await q;
    if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
    gateCrnFinance(c, data ?? [], null);
    return c.json({ deliveryReturns: data ?? [] });
  }

  /* --- PAGINATED PATH (opt-in via `page`) --- */
  const page = Math.max(0, Math.trunc(Number(pageRaw)) || 0);
  const psRaw = Number(c.req.query('pageSize'));
  const pageSize = Number.isFinite(psRaw) && psRaw > 0 ? Math.min(200, Math.max(1, Math.trunc(psRaw))) : 50;

  /* Deterministic order + unique tiebreaker (id, in HEADER). Sort columns are
     all already in the HEADER select (schema-drift safe). */
  const SORT_COLS = new Set(['return_date', 'return_number', 'debtor_name', 'status', 'local_total_sen']);
  const [rawCol, rawDir] = (c.req.query('sort') ?? 'return_date:desc').split(':');
  const sortCol = SORT_COLS.has(rawCol) ? rawCol : 'return_date';
  const sortAsc = rawDir === 'asc';
  let q = sb.from('consignment_delivery_returns').select(HEADER, { count: 'exact' }).order(sortCol, { ascending: sortAsc });
  if (sortCol !== 'id') q = q.order('id', { ascending: true }); // unique tiebreaker
  if (status) q = q.eq('status', status);
  /* Free-text search over the SAME columns already in HEADER + that the FE list
     searches: return_number + debtor_name. */
  const qText = c.req.query('q');
  if (qText) { const s = escapeForOr(qText); if (s) q = q.or(`return_number.ilike.%${s}%,debtor_name.ilike.%${s}%`); }
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  q = q.range(page * pageSize, page * pageSize + pageSize - 1);
  const { data, error, count } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  /* Full-set money KPIs — sum local_total_sen (Returned Value) / total_cost_sen
     (Cost) / total_margin_sen (Margin) over the SAME status + search filters as
     the page query, WITHOUT .range(). Mirrors the pre-pagination client KPI.
     paginateAll pages past the 1000-row cap. All three columns are in HEADER. */
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
  /* Strip the header finance keys for a non-finance caller (list half) AND drop
     the full-set Cost / Margin KPIs — `aggregates` is derived from
     total_cost_sen / total_margin_sen, so shipping it would hand back over
     the whole filtered set exactly what the row strip just removed. Returned
     Value (local_total_sen) stays: it is the refund total everyone may see. */
  gateCrnFinance(c, data ?? [], null);
  const aggregates = canViewScmFinance(c)
    ? { revenueSen, costSen, marginSen }
    : { revenueSen };
  return c.json({ deliveryReturns: data ?? [], total: count ?? (data?.length ?? 0), page, pageSize, aggregates });
});

// ── Returnable Consignment Note lines (From-Note multi-picker) ────────────
// Every consignment_delivery_order_item, with remaining = delivered (qty) −
// already-returned (sum of qty_returned across non-cancelled Consignment Returns
// linked to that note line via consignment_do_item_id). Only remaining > 0 lines
// are pickable. Mirrors the DO→DR /returnable-do-lines endpoint. MUST be
// registered before /:id so 'returnable-note-lines' isn't read as an id.
//
// FINANCE-GATED (was not — see below). Each descriptor carries the source note
// line's unitCostSen, so this picker shipped every delivered line's unit cost
// to any caller who could reach it. It was left open deliberately, because
// ConsignmentReturnFromNote / ConsignmentReturnNew fed the value straight back
// into the create payload and buildItemRow trusted it — a strip alone would have
// booked every converted return at cost 0. That echo is now dead: buildItemRow
// re-reads the cost from the source consignment_delivery_order_items row and
// ignores the client, so the strip is safe. camelCase is why no existing list
// matched this — SO_ITEM_FINANCE_KEYS is snake_case PostgREST vocabulary, and
// lib/finance-keys warns that a camelCasing surface must strip in its own.
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

  // Already-returned per note line — only count non-cancelled returns.
  // Paged + company-scoped + error bound (2026-08-21, audit A6): un-paged, the
  // picker re-offered fully-returned lines once live returns passed 1000.
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

// ── Detail ──────────────────────────────────────────────────────────────
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

/* Insert the return header from a client body. Shared by POST /. */
async function insertHeader(sb: any, userId: string, body: Record<string, unknown>, c: any) {
  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;
  return insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('consignment_delivery_returns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
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
    /* A return = the loaner is RECEIVED back the moment it's created. Start at
       RECEIVED and transfer it back to the shipping warehouse right after the
       items insert. */
    status: 'RECEIVED',
    received_at: new Date().toISOString(),
    notes: (body.notes as string) ?? null,
    created_by: userId,
    }).select(HEADER).single(),
  );
}

// ── Create ──────────────────────────────────────────────────────────────
// Accepts the full header + line items. A return is RECEIVED on creation → the
// loaner is transferred back to the shipping warehouse immediately (idempotent).
// "no DO, no return" is RELAXED — lines may reference a Consignment Note line
// (consignmentDoItemId) OR be free-entry.
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
/* The refusal used when the guard could not be COMPUTED, as opposed to when it
   was computed and failed. `lines: []` because there are no offending lines to
   name — the check itself did not run. */
const OVER_REMAINING_UNPROVEN = {
  error: 'over_remaining_uncheckable',
  message: 'Could not verify the remaining returnable quantity — the check could not read prior returns. Nothing was changed; please retry.',
  lines: [] as Array<{ noteItemId: string; requested: number; remaining: number }>,
};

async function checkCrOverRemaining(
  sb: any,
  /* The Hono context, for scopeToCompany — added 2026-08-21 (audit A6): the
     live-returns read below used to be company-blind, so the OTHER tenant's
     returns consumed the 1000-row response budget and pushed this company's
     rows past the truncation point. */
  c: any,
  items: Array<Record<string, unknown>>,
  excludeReturnItemId?: string,
): Promise<{ error: string; message: string; lines: Array<{ noteItemId: string; requested: number; remaining: number }> } | null> {
  const wanted = new Map<string, number>();
  for (const it of items) {
    const noteItemId = ((it.noteItemId ?? it.consignmentDoItemId) as string | undefined) ?? null;
    if (!noteItemId) continue; // free-entry line, nothing to bound it against
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

  /* Already-returned, counting NON-CANCELLED returns only — the same filter the
     picker uses, so the two never disagree. */
  /* FAIL CLOSED on these two, and the header above is wrong about them. An empty
     result here is not "nothing has been returned yet" — it makes `liveIds` and
     `returnedById` empty, so `remaining` collapses to `delivered` and a line that
     is ALREADY fully returned passes the guard and books stock IN a second time.
     Returning null does not avoid that; it permits the same double-return, just
     without an error. Same call as returnLineLock in this file: a read failure is
     transient and the operator retries, a duplicated stock-in is not. */
  /* paginateAll + scopeToCompany (2026-08-21, audit A6): this read was a bare
     .neq() — one un-paged response, capped at 1000 rows by PostgREST, with the
     other company's returns spending the same budget. A return whose id fell
     past the cap was treated as CANCELLED, its quantity dropped out of
     returnedById, and the guard passed a SECOND full return of the same note
     line. A truncated page is error-free, so the fail-closed arm below never
     saw it — paging is the only fix. */
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
    // An EDIT must not count its own current quantity against itself.
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

consignmentReturns.post('/', async (c) => {
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

  const sb = c.get('supabase'); const user = c.get('user');

  /* itemCode catalog guard. */
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

  /* CROSS-COMPANY SOURCE (2026-08-21, audit A3) — the note-line ids are
     caller-supplied and resolve the stored cost (and feed the over-return
     bound); a foreign id booked the other tenant's line onto this company's
     return unchecked. Same guard the GRN/DR/DO trio always had. */
  {
    const xl = await assertSourceLinesInCompany(sb, c, 'consignment_delivery_order_items',
      items.map((it) => (it.doItemId ?? it.consignmentDoItemId ?? it.noteItemId) as string | undefined));
    if (!xl.ok) return c.json(xl.body, xl.status);
  }

  /* The "no DO, no Return" hard requirement is still DROPPED vs DR — a
     consignment return may be free-entry. The over-return guard is NOT: it now
     bounds every NOTE-LINKED line (owner 2026-08-13). Free-entry lines carry no
     source to bound them against and pass through, exactly as before. */
  {
    const over = await checkCrOverRemaining(sb, c, items);
    if (over) return c.json(over, 409);
  }

  const { data: header, error: hErr } = await insertHeader(sb, user.id, body, c);
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  /* Re-derive every note-linked line's cost from the SOURCE note line,
     server-side — the New-Return form seeds its drafts off
     /returnable-note-lines and posts the cost back, and trusting that echo is
     what a finance strip would have turned into "book at cost 0" (#632). */
  const sourceCostByNoteItem = await sourceUnitCostByItemId(
    sb, 'consignment_delivery_order_items',
    items.map((it: Record<string, unknown>) => (it.doItemId ?? it.consignmentDoItemId) as string | undefined),
    activeCompanyId(c) ?? null);
  const rows = items.map((it) => buildItemRow(h.id, it, sourceCostByNoteItem));
  const { error: iErr } = await sb.from('consignment_delivery_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('consignment_delivery_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
  await recomputeTotals(sb, h.id);

  /* The loaner comes back → book a plain IN to the destination warehouse.
     Self-healing resync (idempotent + best-effort). */
  const movementErrors = await resyncReturnInventory(sb, h.id, user.id);

  return c.json({ id: h.id, returnNumber: h.return_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

// ── Header PATCH (editable fields) ─────────────────────────────────────────
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
  /* A cleared date input posts "" and this loop wrote it through to a date
     column, which Postgres rejects and 500s the save. */
  coerceEmptyDates(updates);
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  const { data, error } = await scopeToCompanyId(sb.from('consignment_delivery_returns').update(updates).eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true, id });
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
/* A REFUNDED / CREDIT_NOTED / CANCELLED return is terminal — lock line edits to
   ACTIVE returns (mirrors pcReturnLineLock on the purchase side). Editing a
   terminal return re-runs recomputeTotals + resyncReturnInventory, which would
   rewrite settled totals and (for non-cancelled terminal states) re-book stock. */
async function returnLineLock(sb: any, id: string): Promise<{ error: string; message: string } | null> {
  /* FAILS CLOSED. `error` was not destructured at all, so a failed read gave
     data = null, st = undefined, every check fell through, and the guard
     RETURNED NULL — i.e. it PASSED. A lock whose own comment says editing a
     terminal return "would rewrite settled totals and re-book stock" opened
     itself whenever the database hiccupped.

     Closed rather than open because of what is on the other side: this is not a
     visibility filter, it is the only thing standing between a settled return
     and a re-run of recomputeTotals + resyncReturnInventory. A read failure is
     transient and the operator retries; a wrongly-permitted edit is not. */
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

consignmentReturns.post('/:id/items', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  { const lock = await returnLineLock(sb, id); if (lock) return c.json(lock, 409); }

  /* "no DO, no Return" stays dropped; the over-return bound does not. */
  {
    const over = await checkCrOverRemaining(sb, c, [it]);
    if (over) return c.json(over, 409);
  }

  /* itemCode catalog guard. */
  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* SKU wins, decided once — docs/bugs/0524. Same rule as the create path: the
     stored group is what the stock movement is keyed from. */
  it = (await resolveItemGroups(sb, [it], activeCompanyId(c) ?? null))[0]!;

  const { data: header } = await scopeToCompanyId(sb.from('consignment_delivery_returns').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!header) return c.json(NOT_THIS_COMPANY, 404);

  /* Same cross-company line guard as the create path (2026-08-21, audit A3). */
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
  /* The ITEM select echoes the stored line back — cost/margin included. A
     non-finance caller must not read it off the create response either. */
  gateCrnFinance(c, null, data);
  await recomputeTotals(sb, id);
  /* Adding a return line books its IN too (self-healing resync). Best-effort. */
  /* REPORTED, not discarded. The CREATE path returns this exact string[] as
  movementErrors; these mutations threw it away, so a resync that failed to
  book or drain stock returned a clean 200. writeMovements never throws, so
  the catch caught nothing either. */
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncReturnInventory(sb, id, user?.id ?? null); }
  catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  return c.json({ item: data, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) }, 201);
});

consignmentReturns.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  { const lock = await returnLineLock(sb, id); if (lock) return c.json(lock, 409); }

  /* itemCode catalog guard (only when caller is changing it). */
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

  /* Bound the EDIT too — raising a line's qty is the same over-return by another
     door. `excludeReturnItemId` keeps this row's own current quantity out of the
     already-returned tally, or every edit would measure the line against itself
     and refuse to stay put. The source link comes from the STORED row: a client
     cannot re-point a line at a different note line to widen its own ceiling. */
  {
    const noteItemId = (prev as { consignment_do_item_id?: string | null }).consignment_do_item_id ?? null;
    if (noteItemId) {
      const over = await checkCrOverRemaining(sb, c, [{ noteItemId, qtyReturned: qty }], itemId);
      if (over) return c.json(over, 409);
    }
  }
  const unitPrice = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : Number(prev.unit_price_sen);
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : Number(prev.discount_sen);
  /* A caller who cannot READ the cost must not WRITE it. The detail GET now
     strips unit_cost_sen for a non-finance caller, and ConsignmentReturnDetail
     seeds each line draft straight off that payload (`unit_cost_sen ?? 0`) and
     posts the value back here on save — so trusting the client would let the
     stripped field round-trip as a genuine 0 and wipe the line's cost basis
     (recomputeTotals would then roll the return's cost to 0 and its margin to
     the full refund). This route accepted ANY defined value, exactly like the DR
     line PATCH did (#632) and unlike the SO / Consignment ORDER PATCH, whose
     `explicitCost > 0` precedence makes a 0 fall through to the stored cost —
     which is why the same strip was safe there (#625). Keep the stored cost for
     a non-finance caller; a finance caller is unaffected. */
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

  /* The EDIT half of the same back door: the over-return cap above and the
     resync below both key on consignment_do_item_id, so an unlinked line whose
     code is re-typed to one the Consignment Note carries counts against no note
     line and the same goods return again. See unlinked-line-edit-guard. */
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
  /* Adjust inventory by the qty/variant delta (self-healing resync). Best-effort. */
  /* REPORTED, not discarded. The CREATE path returns this exact string[] as
  movementErrors; these mutations threw it away, so a resync that failed to
  book or drain stock returned a clean 200. writeMovements never throws, so
  the catch caught nothing either. */
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
  /* Give the deleted line's stock back OUT (self-healing resync). Best-effort. */
  /* REPORTED, not discarded. The CREATE path returns this exact string[] as
  movementErrors; these mutations threw it away, so a resync that failed to
  book or drain stock returned a clean 200. writeMovements never throws, so
  the catch caught nothing either. */
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncReturnInventory(sb, id, c.get('user')?.id ?? null); }
  catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  return c.json({ ok: true, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) });
});

// ── Status transition ──────────────────────────────────────────────────────
// A return is RECEIVED on create (the loaner was transferred back already);
// CANCELLED reverses that transfer (shipping warehouse → consignment warehouse).
// Other statuses (INSPECTED / REFUNDED / …) stamp their timestamp.
export const patchConsignmentReturnStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { status?: string; inspectionNotes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  /* NORMALISE FIRST — same fix, same reason, as the sibling
     patchConsignmentNoteStatusHandler (consignment-notes.ts), and as the Sales
     Order / Delivery Order / Sales Invoice handlers that already did it. The
     asymmetry was inside this file: `resyncReturnInventory` uppercases the
     PERSISTED status before deciding `cancelled` (:278), while every gate below
     compared the INCOMING status raw.

     A lowercase 'cancelled' missed the already-cancelled echo, missed the atomic
     `.neq('status','CANCELLED')` single-flight, fell into the plain `else`
     write, and never called `resyncReturnInventory` — so the CS_DR inventory IN
     was NEVER reversed while the return read as cancelled everywhere. Same
     mechanism as the Sales Invoice revenue-reversal bug that produced
     SI_STATUS_CANON, with stock in place of revenue.

     No status whitelist here either: this document's vocabulary is not declared
     in one place, and a guessed one would refuse a legitimate status. Written up
     as a recommendation instead. */
  const toStatus = String(body.status).trim().toUpperCase();

  const { data: cur } = await scopeToCompanyId(sb.from('consignment_delivery_returns').select('status').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const prevStatus = (cur as { status: string }).status;
  if (toStatus === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ consignmentReturn: { id, status: 'CANCELLED' } });
  }
  /* Audit 2026-06-20 — a CANCELLED Consignment Return is FINAL (mirrors
     delivery-returns.ts dr_cancelled_final). The cancel already reversed the
     return IN; reactivating to RECEIVED/INSPECTED/REFUNDED would re-arm a
     double-IN on the next line edit (resyncReturnInventory then runs with a
     non-cancelled status). Create a new return instead. */
  if (prevStatus === 'CANCELLED') {
    return c.json({ error: 'return_cancelled_final', message: 'A cancelled Consignment Return cannot be reactivated — create a new return.' }, 409);
  }

  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now, status: toStatus };
  if (toStatus === 'RECEIVED') ts.received_at = now;
  if (toStatus === 'INSPECTED') { ts.inspected_at = now; if (body.inspectionNotes) ts.inspection_notes = body.inspectionNotes; }
  if (toStatus === 'REFUNDED') ts.refunded_at = now;

  /* ATOMIC cancel guard — the CANCELLED write is conditional on the row still
     being non-cancelled so two concurrent cancels can't double-reverse. */
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

  /* Cancelling a Consignment Return REVERSES the return IN: target net is now 0
     so the resync writes a balancing OUT per bucket. Idempotent + best-effort. */
  // Hoisted: the response is OUTSIDE this block, so a block-scoped
  // declaration would leave the cancel path unable to report.
  let resyncErrs: string[] = [];
  if (toStatus === 'CANCELLED') {
    /* REPORTED, not discarded. The CREATE path returns this exact string[] as
    movementErrors; these mutations threw it away, so a resync that failed to
    book or drain stock returned a clean 200. writeMovements never throws, so
    the catch caught nothing either. */
    resyncErrs = [];
    try { resyncErrs = await resyncReturnInventory(sb, id, user.id); }
    catch (e) { resyncErrs = [String((e as Error)?.message ?? 'resync threw')]; }
  }

    return c.json({ consignmentReturn: data, ...(resyncErrs.length ? { movementErrors: resyncErrs } : {}) });
};
consignmentReturns.patch('/:id/status', patchConsignmentReturnStatusHandler);
