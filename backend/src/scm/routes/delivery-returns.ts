// /delivery-returns — customer returning previously-delivered goods.
//
// Rebuilt 2026-05-29 as a faithful clone of the Delivery Order API
// (apps/api/src/routes/delivery-orders-mfg.ts), which is itself an SO clone:
// editable SO-style header, line-item CRUD, a recomputeTotals rollup, a
// convert-from-DO endpoint, and ROBUST + IDEMPOTENT inventory INCREASE on
// create.
//
// A Delivery Return = goods coming BACK, so processing one ADDS stock — the
// mirror image of the DO's deductInventoryForDo. The plain per-category rollup
// is copied from the DO recomputeTotals.
//
// Mounted at '/delivery-returns' in apps/api/src/index.ts.

import { Hono } from 'hono';
import { normalizePhone } from '../shared/phone';
import { buildVariantSummary } from '../shared';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY } from '../lib/companyScope';
import { writeMovements, defaultWarehouseId } from '../lib/inventory-movements';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { warehouseLabel } from '../lib/warehouse-label';
import { computeVariantKey, type VariantAttrs } from '../shared';
import { doLineRemaining, resolveCandidateDoIds, custKeyOf, type DoRemainingLine } from '../lib/do-line-remaining';
import { todayMyt } from '../lib/my-time';
import { validateItemCodes, unknownItemCodeResponse } from '../lib/validate-item-codes';
import { isServiceLine } from '../shared';
import { findServiceLineCodes, serviceLinesNotReturnableResponse } from '../lib/service-line-guard';
import { findUnlinkedDrLines, unlinkedReturnResponse } from '../lib/return-unlinked-lines';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { SO_ITEM_FINANCE_KEYS } from '../lib/finance-keys';
import { sourceUnitCostByItemId } from '../lib/source-cost';
import { resolveSalesScopeIds, salesDocOutOfScope, resolveCallerStaffId } from '../lib/salesScope';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';

export const deliveryReturns = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryReturns.use('*', supabaseAuth);

/* FINANCE-GATED header keys — cost / margin / per-category revenue+cost
   subtotals. All are in HEADER (so they travel in the DR list payload) but must
   reach ONLY a finance-viewer (lib/houzs-perms.canViewScmFinance). Stripped from
   every row for a non-finance caller. The DR header carries FOUR categories (no
   service_centi, unlike SO/DO/SI). Refund/total shown to everyone
   (local_total_centi / refund_centi) are NOT listed here. */
const DR_FINANCE_KEYS = [
  'mattress_sofa_centi', 'bedframe_centi', 'accessories_centi', 'others_centi',
  'mattress_sofa_cost_centi', 'bedframe_cost_centi', 'accessories_cost_centi', 'others_cost_centi',
  'total_cost_centi', 'total_margin_centi', 'margin_pct_basis',
] as const;

/* KEPT LOCAL, deliberately — do NOT "converge" DR_FINANCE_KEYS onto
   SO_FINANCE_KEYS. It is the finance-shaped subset of THIS file's HEADER select,
   and the delivery return speaks a narrower money vocabulary than the SO: no
   service_centi / service_cost_centi and no deposit_centi (a return takes no
   deposit). refund_centi is in HEADER and deliberately NOT here — the refund is
   what the customer is owed and everyone who passes the access gate may see it,
   the same line #625 drew and #632 kept. The per-LINE keys ARE shared: they are
   byte-identical across all seven sales documents, so they live in
   lib/finance-keys (SO_ITEM_FINANCE_KEYS) and are imported above. */

/** Strip header + line cost/margin in place for a non-finance caller. */
function gateDrFinance(
  c: Parameters<typeof canViewScmFinance>[0],
  deliveryReturn: unknown,
  items: unknown,
): void {
  if (canViewScmFinance(c)) return;
  if (deliveryReturn && typeof deliveryReturn === 'object') {
    for (const k of DR_FINANCE_KEYS) delete (deliveryReturn as Record<string, unknown>)[k];
  }
  for (const it of (Array.isArray(items) ? items : []) as Array<Record<string, unknown>>) {
    for (const k of SO_ITEM_FINANCE_KEYS) delete it[k];
  }
}

/* Full DR header — mirrors the editable DO header shape. The pre-rebuild
   columns (delivery_order_id / sales_invoice_id / reason / received-inspected-
   refunded timestamps / inspection_notes) stay; the DO-clone fields added in
   migration 0102 (debtor metadata / salesperson / address / per-category
   totals + costs / branding / venue / ref / warehouse) extend it. */
const HEADER =
  'id, return_number, do_doc_no, delivery_order_id, sales_invoice_id, ' +
  'debtor_code, debtor_name, return_date, reason, status, ' +
  'received_at, inspected_at, refunded_at, refund_centi, inspection_notes, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, sales_location, customer_state, customer_country, note, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi, ' +
  'mattress_sofa_cost_centi, bedframe_cost_centi, accessories_cost_centi, others_cost_centi, ' +
  'local_total_centi, total_cost_centi, total_margin_centi, margin_pct_basis, line_count, ' +
  'currency, warehouse_id, notes, created_at, created_by, updated_at';

const ITEM =
  'id, delivery_return_id, do_item_id, item_code, item_group, description, description2, ' +
  'uom, qty_returned, condition, unit_price_centi, discount_centi, line_total_centi, ' +
  'unit_cost_centi, line_cost_centi, line_margin_centi, refund_centi, variants, notes, created_at';

const nextNum = async (sb: any, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'delivery_returns', 'return_number', `${p}DR-${yymm}`);
};

/* Re-derive the DR header's per-category revenue/cost totals + grand total from
   its line items. Mirrors the DO recomputeTotals plain per-category rollup.
   Called after every item mutation.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale: a
   read it cannot vouch for must not become a written total, and it aborts by
   LOGGING because this roll-up only runs AFTER its triggering line write has
   committed (a throw becomes a 500 the client retries into a duplicate line).
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputeTotals(sb: any, deliveryReturnId: string) {
  const { data: items, error: itemsErr } = await sb.from('delivery_return_items')
    .select('item_group, line_total_centi, line_cost_centi')
    .eq('delivery_return_id', deliveryReturnId);
  /* A failed READ is not an empty return, and `?? []` cannot tell them apart —
     it folded a transient blip into a ZERO header AND a ZERO refund_centi on a
     return whose lines were intact, i.e. a refund owed to a customer silently
     became no refund. The ERROR is the signal, never the emptiness: a genuinely
     empty return resolves error === null with data === [] and MUST still zero. */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[dr-recompute] item read failed — header left unchanged:', deliveryReturnId, itemsErr.message);
    return;
  }
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of (items ?? []) as Array<{ item_group: string | null; line_total_centi: number | null; line_cost_centi: number | null }>) {
    const lineTotal = Number(it.line_total_centi ?? 0);
    const lineCost  = Number(it.line_cost_centi ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  const { error: updErr } = await sb.from('delivery_returns').update({
    mattress_sofa_centi: mattressSofa,
    bedframe_centi: bedframe,
    accessories_centi: accessories,
    others_centi: others,
    mattress_sofa_cost_centi: mattressSofaCost,
    bedframe_cost_centi: bedframeCost,
    accessories_cost_centi: accessoriesCost,
    others_cost_centi: othersCost,
    local_total_centi: total,
    total_cost_centi: totalCost,
    total_margin_centi: margin,
    margin_pct_basis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    // The refund total tracks the returned line value (kept for the legacy
    // refund_centi column the list + report still read).
    refund_centi: total,
    updated_at: new Date().toISOString(),
  }).eq('id', deliveryReturnId);
  /* The write's own result was discarded until 2026-07-17: a rejected UPDATE left
     the header STALE with nothing logged and every caller reporting success. */
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[dr-recompute] header update failed — totals left STALE:', deliveryReturnId, updErr.message);
  }
}

/* INCREASE inventory for a DR exactly once. ROBUST: fires on create (goods are
   received back the moment the return is created). IDEMPOTENT: a pre-insert
   existence check on the DR id skips re-increasing, and the partial UNIQUE
   index uq_inv_mov_dr_source (migration 0102) is the hard backstop against a
   race. Best-effort — a movement failure never rolls back the create (audit-DLQ
   pattern, same as the rest of inventory-movements + the DO deduction).

   This is the MIRROR IMAGE of delivery-orders-mfg.ts deductInventoryForDo: it
   writes IN movements (the FIFO trigger from migration 0053/0095 creates a lot
   per IN row), one row per (product_code, variant_key) bucket. The lot's unit
   cost is seeded from the line's unit_cost_centi (sen) so returned stock
   re-enters at its original cost rather than zero. */
/* ── resolveDrLineWarehouses (Agent D 2026-05-31, TASK #32) ───────────────────
   PER-WAREHOUSE CORRECTNESS for the RETURNS side. A Delivery Return must put
   stock BACK into the SAME warehouse the Delivery Order took it OUT of — never a
   single DR-header default. The DO took it from its SO line's warehouse
   (migration 0118), so each DR line resolves its warehouse by tracing
   do_item_id → delivery_order_items.so_item_id → mfg_sales_order_items.
   warehouse_id.

   Resolution order per DR line:
     1. the linked DO line's SO-line warehouse (do_item_id → … → SO line)
     2. the linked DO header's warehouse_id
     3. the DR header's warehouse_id (free/ad-hoc lines — none exist now that
        "no DO, no return" is enforced, but kept as a safety net)
     4. the return's OWN company's default warehouse (last-resort fallback)

   Returns a map of delivery_return_items.id → warehouse_id (or null when even
   the fallbacks are absent — the caller skips those lines). */
async function resolveDrLineWarehouses(
  sb: any,
  items: Array<{ id: string; do_item_id?: string | null }>,
  drHeaderWarehouseId: string | null,
  /* The return's company (2026-08-03) — step 4 is per company. It used to be a
     company-blind draw across every company's is_default warehouses, decided by
     alphabetical `code` order. */
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const doItemIds = [...new Set(items
    .map((it) => it.do_item_id ?? null)
    .filter((x): x is string => !!x))];

  // do_item_id → { so_item_id, do header warehouse }
  const doLineMeta = new Map<string, { soItemId: string | null; doWarehouseId: string | null }>();
  const soItemIds = new Set<string>();
  if (doItemIds.length > 0) {
    const { data: doLines } = await sb.from('delivery_order_items')
      .select('id, so_item_id, delivery_order_id').in('id', doItemIds);
    const doRows = (doLines ?? []) as Array<{ id: string; so_item_id: string | null; delivery_order_id: string }>;
    const doIds = [...new Set(doRows.map((r) => r.delivery_order_id).filter(Boolean))];
    const doHeaderWh = new Map<string, string | null>();
    if (doIds.length > 0) {
      const { data: doHeaders } = await sb.from('delivery_orders')
        .select('id, warehouse_id').in('id', doIds);
      for (const d of (doHeaders ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
        doHeaderWh.set(d.id, d.warehouse_id ?? null);
      }
    }
    for (const r of doRows) {
      if (r.so_item_id) soItemIds.add(r.so_item_id);
      doLineMeta.set(r.id, { soItemId: r.so_item_id ?? null, doWarehouseId: doHeaderWh.get(r.delivery_order_id) ?? null });
    }
  }

  // so_item_id → warehouse_id (the authoritative ship-from, 0118).
  const soWh = new Map<string, string | null>();
  if (soItemIds.size > 0) {
    const { data: soRows } = await sb.from('mfg_sales_order_items')
      .select('id, warehouse_id').in('id', [...soItemIds]);
    for (const r of (soRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      soWh.set(r.id, r.warehouse_id ?? null);
    }
  }

  const fallback = drHeaderWarehouseId ?? (await defaultWarehouseId(sb, companyId));
  for (const it of items) {
    const meta = it.do_item_id ? doLineMeta.get(it.do_item_id) : undefined;
    const fromSo = meta?.soItemId ? (soWh.get(meta.soItemId) ?? null) : null;
    out.set(it.id, fromSo ?? meta?.doWarehouseId ?? fallback);
  }
  return out;
}

/* warehouseCodeMap (Agent D 2026-05-31, TASK #32) — warehouse_id → display
   CODE for the per-line Warehouse column on the DR detail GET. Read-only. */
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

/* resolveDrLineBatches (Stage 4, Commander 2026-06-01) — sofa batch per DR line.
   Returned sofa modules must re-enter the SAME dye-lot batch they shipped from,
   so the batch view + batch-scoped consume stay consistent. Trace
   do_item_id → delivery_order_items.so_item_id → mfg_sales_order_items.
   allocated_batch_no. Best-effort: absent column (pre-0121) / non-sofa → no
   entry → plain non-batched IN, identical to the old behaviour. */
async function resolveDrLineBatches(
  sb: any,
  items: Array<{ id: string; do_item_id?: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const doItemIds = [...new Set(items.map((it) => it.do_item_id ?? null).filter((x): x is string => !!x))];
  if (doItemIds.length === 0) return out;
  const { data: doLines } = await sb.from('delivery_order_items')
    .select('id, so_item_id').in('id', doItemIds);
  const doRows = (doLines ?? []) as Array<{ id: string; so_item_id: string | null }>;
  const soByDoLine = new Map<string, string>();
  const soItemIds = new Set<string>();
  for (const r of doRows) { if (r.so_item_id) { soByDoLine.set(r.id, r.so_item_id); soItemIds.add(r.so_item_id); } }
  if (soItemIds.size === 0) return out;
  const batchBySo = new Map<string, string>();
  try {
    const { data: soRows, error } = await sb.from('mfg_sales_order_items')
      .select('id, allocated_batch_no').in('id', [...soItemIds]);
    if (!error) for (const r of (soRows ?? []) as Array<{ id: string; allocated_batch_no: string | null }>) {
      if (r.allocated_batch_no) batchBySo.set(r.id, r.allocated_batch_no);
    }
  } catch { /* column absent pre-0121 — no batches */ }
  for (const it of items) {
    const so = it.do_item_id ? soByDoLine.get(it.do_item_id) : undefined;
    const batch = so ? batchBySo.get(so) : undefined;
    if (batch) out.set(it.id, batch);
  }
  return out;
}

async function increaseInventoryForReturn(sb: any, deliveryReturnId: string, performedBy: string): Promise<string[]> {
  // Idempotency guard #1 — has this DR already written IN movements?
  const { count: existing } = await sb
    .from('inventory_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('source_doc_type', 'DR')
    .eq('source_doc_id', deliveryReturnId)
    .eq('movement_type', 'IN');
  if ((existing ?? 0) > 0) return []; // already increased — no-op

  const { data: drHeader } = await sb.from('delivery_returns')
    .select('return_number, warehouse_id, company_id')
    .eq('id', deliveryReturnId).maybeSingle();
  const { data: items } = await sb.from('delivery_return_items')
    .select('id, do_item_id, item_code, description, qty_returned, item_group, variants, unit_cost_centi')
    .eq('delivery_return_id', deliveryReturnId);
  const drHeaderWarehouseId = (drHeader as { warehouse_id: string | null } | null)?.warehouse_id ?? null;
  const drNo = (drHeader as { return_number: string } | null)?.return_number ?? deliveryReturnId;
  if (!items) return [];

  // Per-line warehouse — each returned line re-enters the warehouse the DO line
  // shipped from (its SO line's warehouse, 0118), not a single DR-header default.
  const lineWh = await resolveDrLineWarehouses(
    sb,
    items as Array<{ id: string; do_item_id?: string | null }>,
    drHeaderWarehouseId,
    (drHeader as { company_id?: number | null } | null)?.company_id ?? undefined,
  );
  // Sofa batch per DR line — returned modules re-enter the batch they shipped from.
  const lineBatch = await resolveDrLineBatches(sb, items as Array<{ id: string; do_item_id?: string | null }>);

  /* Collapse identical (warehouse_id, product_code, variant_key, batch_no) lines
     into one IN row. A DR can list the same product across two lines AND across
     two warehouses (multi-DO merge); bucketing by warehouse keeps each
     warehouse's increase correct + idempotency-safe. batch_no joins the key so a
     returned sofa module re-opens a lot tagged with its own dye-lot batch. Unit
     cost carried from the first line in the bucket (returned stock re-enters at
     its original per-unit cost). */
  const byKey = new Map<string, {
    warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number; batch_no: string | null;
  }>();
  for (const it of (items as Array<{ id: string; item_code: string; description: string | null; qty_returned: number; item_group?: string | null; variants?: VariantAttrs | null; unit_cost_centi?: number | null }>)) {
    /* P1 SO-SKU spec §4.6 — depth guard: a SERVICE line must never write stock
       IN. The route guards reject them at create/edit; this keeps any line
       that slips through (legacy data, direct DB write) inventory-neutral. */
    if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
    const qty = Number(it.qty_returned ?? 0);
    if (qty <= 0) continue;
    const warehouseId = lineWh.get(it.id) ?? null;
    if (!warehouseId) continue; // no resolvable warehouse — skip rather than guess
    const variantKey = computeVariantKey(it.item_group ?? null, it.variants ?? null);
    const batchNo = lineBatch.get(it.id) ?? null;
    const k = `${warehouseId}::${it.item_code}::${variantKey}::${batchNo ?? ''}`;
    const cur = byKey.get(k);
    if (cur) { cur.qty += qty; }
    else byKey.set(k, {
      warehouse_id: warehouseId,
      product_code: it.item_code,
      variant_key: variantKey,
      product_name: it.description,
      qty,
      unit_cost_sen: Number(it.unit_cost_centi ?? 0),
      batch_no: batchNo,
    });
  }
  const movements = [...byKey.values()].map((m) => ({
    movement_type: 'IN' as const,
    warehouse_id: m.warehouse_id,
    product_code: m.product_code,
    variant_key: m.variant_key,
    product_name: m.product_name,
    qty: m.qty,
    // Seed the FIFO lot's per-unit cost so returned stock re-enters at its
    // original cost (the DO deduction leaves OUT rows costless — the trigger
    // computes the consumed cost — but IN rows must carry the lot cost).
    unit_cost_sen: m.unit_cost_sen,
    source_doc_type: 'DR' as const,
    source_doc_id: deliveryReturnId,
    source_doc_no: drNo,
    performed_by: performedBy,
    ...(m.batch_no ? { batch_no: m.batch_no } : {}),
  }));
  const movementErrors: string[] = [];
  if (movements.length > 0) {
    /* Capture the best-effort write result so the caller can surface a failed
       stock IN (was silently swallowed — DR created with goods NOT booked back
       and the caller never told). No rollback; just make it loud. */
    const res = await writeMovements(sb, movements, (drHeader as { company_id?: number | null } | null)?.company_id ?? null);
    if (!res.ok) movementErrors.push(`IN ${drNo}: ${res.reason ?? 'unknown'}`);
    /* Oversell retro-cost (0154) — a customer return puts goods back on the
       shelf, which is a stock IN like any other. A prior "ship anyway" DO that
       went out at RM0 in this warehouse can now be costed from the re-opened
       lots. Wired 2026-07-29; before that only a GRN reconciled (COE §2).
       Best-effort — never fails the return. */
    if (res.ok) await reconcileUncostedAfterIn(sb, movements, performedBy);
  }
  return movementErrors;
}

/* ── resyncInventoryForReturn (2026-06-01 — DR line-edit/delete/cancel rollback) ──
   A DR books goods BACK INTO stock on create (increaseInventoryForReturn writes
   IN rows under source_doc_type 'DR'). But a later LINE EDIT (qty reduced) or
   LINE DELETE left those IN rows untouched → on-hand stayed permanently inflated
   by the removed qty. This helper re-derives the DR's intended net stock impact
   from its CURRENT lines and writes a single signed ADJUSTMENT delta per bucket
   to close the gap — the exact mirror of resyncInventoryForDo on the DO side.

   It also SUBSUMES the old cancel reversal: when the DR is CANCELLED the target
   is zero, so the delta removes the full remaining net — one code path for every
   rollback (edit / delete / cancel), so the three can't drift.

   BATCH-AWARE (Stage 4): the forward IN rows carry batch_no for sofa/dye-lot
   items (resolveDrLineBatches). A negative delta on a batched bucket is written
   as an OUT carrying that batch_no so the FIFO/lot consumer removes stock from
   the EXACT lot it re-entered (keeping inventory_lots truthful); a positive delta
   on a batched bucket re-opens the lot with an IN. Non-batched buckets use a
   FIFO-neutral signed ADJUSTMENT. Either way the row is tagged
   source_doc_type='ADJUSTMENT' so it sidesteps uq_inv_mov_dr_source (scoped to
   source_doc_type='DR', migration 0102).

   We write the delta as a FIFO-neutral ADJUSTMENT (movement_type 'ADJUSTMENT',
   source_doc_type 'ADJUSTMENT', source_doc_id = DR id). The inventory_balances
   view treats ADJUSTMENT as signed (migration 0095), and the DR source key's
   UNIQUE index (uq_inv_mov_dr_source, 0102) does NOT cover ADJUSTMENT rows, so
   any number of delta rows coexist. IDEMPOTENT by construction: re-running finds
   delta 0 (the prior ADJUSTMENT already closed the gap) → no write. Best-effort:
   a movement failure never blocks the edit/cancel. */
/* Returns the movement-write failures, [] when clean - the SAME contract as
   increaseInventoryForReturn above, whose own comment records why: a swallowed
   result meant the DR was created with the goods NOT booked back and the caller
   was never told. That fix landed on the CREATE path only. writeMovements never
   throws, so the four best-effort try/catch callers below caught nothing. */
async function resyncInventoryForReturn(sb: any, deliveryReturnId: string, performedBy: string): Promise<string[]> {
  const { data: drHeader } = await sb.from('delivery_returns')
    .select('return_number, status, warehouse_id, company_id')
    .eq('id', deliveryReturnId).maybeSingle();
  if (!drHeader) return [];
  const drStatus = ((drHeader as { status: string | null }).status ?? '').toUpperCase();
  const drHeaderWarehouseId = (drHeader as { warehouse_id: string | null }).warehouse_id ?? null;
  const drNo = (drHeader as { return_number: string }).return_number ?? deliveryReturnId;

  // 1. TARGET net IN per (warehouse, product, variant, batch_no) bucket = sum of
  //    the DR's CURRENT lines (mirror of increaseInventoryForReturn's bucketing,
  //    batch_no included so a sofa line targets its OWN dye-lot). A CANCELLED DR
  //    has a target of zero — every bucket must drain back out.
  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; batch_no: string | null; product_name: string | null; qty: number; unit_cost_sen: number };
  const targetByBucket = new Map<string, Bucket>();
  if (drStatus !== 'CANCELLED') {
    const { data: items } = await sb.from('delivery_return_items')
      .select('id, do_item_id, item_code, description, qty_returned, item_group, variants, unit_cost_centi')
      .eq('delivery_return_id', deliveryReturnId);
    const lineRows = (items ?? []) as Array<{ id: string; do_item_id?: string | null; item_code: string; description: string | null; qty_returned: number; item_group?: string | null; variants?: VariantAttrs | null; unit_cost_centi?: number | null }>;
    const lineWh = await resolveDrLineWarehouses(
      sb,
      lineRows as Array<{ id: string; do_item_id?: string | null }>,
      drHeaderWarehouseId,
      (drHeader as { company_id?: number | null }).company_id ?? undefined,
    );
    const lineBatch = await resolveDrLineBatches(sb, lineRows as Array<{ id: string; do_item_id?: string | null }>);
    for (const it of lineRows) {
      /* P1 SO-SKU spec §4.6 — SERVICE lines never wrote IN on create, so they
         stay out of the resync TARGET too (else the delta walk would write a
         phantom IN to "catch up"). */
      if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
      const qty = Number(it.qty_returned ?? 0);
      if (qty <= 0) continue;
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) continue; // unresolvable warehouse — skip rather than guess
      const variant_key = computeVariantKey(it.item_group ?? null, it.variants ?? null);
      const batch_no = lineBatch.get(it.id) ?? null;
      const k = `${warehouseId}::${it.item_code}::${variant_key}::${batch_no ?? ''}`;
      const cur = targetByBucket.get(k);
      if (cur) { cur.qty += qty; }
      else targetByBucket.set(k, { warehouse_id: warehouseId, product_code: it.item_code, variant_key, batch_no, product_name: it.description, qty, unit_cost_sen: Number(it.unit_cost_centi ?? 0) });
    }
  }

  // 2. CURRENT net IN already booked for this DR = Σ IN/OUT rows (source 'DR')
  //    plus Σ prior resync rows (source 'ADJUSTMENT' — signed ADJUSTMENT for
  //    plain buckets, or IN/OUT carrying batch_no for sofa buckets). Bucketing by
  //    batch_no keeps each dye-lot's delta independent. Forward-compat: pre-0120
  //    the batch_no column doesn't exist → retry without it (every batch '').
  type Agg = { net_in: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  const addMov = (m: { movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; batch_no?: string | null; qty: number; product_name: string | null }) => {
    const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let agg = aggByBucket.get(k);
    if (!agg) { agg = { net_in: 0, product_name: m.product_name }; aggByBucket.set(k, agg); }
    const q = Number(m.qty ?? 0);
    if (m.movement_type === 'IN') agg.net_in += q;
    else if (m.movement_type === 'OUT') agg.net_in -= q;
    else if (m.movement_type === 'ADJUSTMENT') agg.net_in += q; // already signed
    if (!agg.product_name) agg.product_name = m.product_name;
  };
  const readDrMovs = async (sourceType: string) => {
    const sel = 'movement_type, warehouse_id, product_code, variant_key, batch_no, qty, product_name';
    let res = await sb.from('inventory_movements').select(sel)
      .eq('source_doc_type', sourceType).eq('source_doc_id', deliveryReturnId);
    if (res.error && (res.error.message ?? '').includes('batch_no')) {
      res = await sb.from('inventory_movements')
        .select('movement_type, warehouse_id, product_code, variant_key, qty, product_name')
        .eq('source_doc_type', sourceType).eq('source_doc_id', deliveryReturnId);
    }
    return (res.data ?? []) as any[];
  };
  for (const m of await readDrMovs('DR')) addMov(m);
  for (const m of await readDrMovs('ADJUSTMENT')) addMov(m);

  // 3. Per-bucket delta = target − current_net. delta > 0 adds stock back (a line
  //    qty was raised); delta < 0 removes over-booked stock (line reduced /
  //    deleted / DR cancelled). BATCHED bucket → write an IN/OUT carrying batch_no
  //    so the FIFO/lot consumer touches the EXACT dye-lot (keeping inventory_lots
  //    truthful). PLAIN bucket → FIFO-neutral signed ADJUSTMENT. Either way the
  //    row is source_doc_type='ADJUSTMENT' (uq_inv_mov_dr_source is scoped to
  //    source_doc_type='DR', so no collision).
  const allKeys = new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()]);
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  for (const k of allKeys) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { net_in: 0, product_name: null };
    const delta = (t?.qty ?? 0) - a.net_in;
    if (delta === 0) continue;
    const parts = k.split('::');
    const batchNo = parts[3] || null;
    const note = drStatus === 'CANCELLED'
      ? `Delivery return ${drNo} cancelled — reversing return (stock removed)`
      : `Delivery return ${drNo} line edited — resyncing returned stock`;
    const base = {
      warehouse_id: parts[0] ?? '',
      product_code: parts[1] ?? '',
      variant_key: parts[2] ?? '',
      product_name: t?.product_name ?? a.product_name ?? null,
      source_doc_type: 'ADJUSTMENT' as const,
      source_doc_id: deliveryReturnId,
      source_doc_no: drNo,
      performed_by: performedBy,
      notes: note,
    };
    if (batchNo) {
      // Sofa/dye-lot: move the exact lot. + re-opens it (IN), − consumes it (OUT).
      writes.push(delta > 0
        ? { ...base, movement_type: 'IN', qty: delta, unit_cost_sen: t?.unit_cost_sen ?? 0, batch_no: batchNo }
        : { ...base, movement_type: 'OUT', qty: -delta, batch_no: batchNo });
    } else {
      writes.push({
        ...base,
        movement_type: 'ADJUSTMENT',
        qty: delta, // signed: + adds stock, − removes it
        unit_cost_sen: delta > 0 ? (t?.unit_cost_sen ?? 0) : 0,
      });
    }
  }
  const resyncErrors: string[] = [];
  if (writes.length > 0) {
    const wrote = await writeMovements(sb, writes, (drHeader as { company_id?: number | null } | null)?.company_id ?? null);
    if (!wrote.ok) resyncErrors.push('return resync: ' + (wrote.reason ?? 'unknown'));
    /* Oversell retro-cost (0154) — a resync that RAISES the returned qty writes a
       lot-opening IN / positive ADJUSTMENT, so it is a stock IN and gets the same
       retro-cost as the create path. Negative deltas are filtered out. */
    await reconcileUncostedAfterIn(sb, writes, performedBy);
    /* Returned-stock level changed → re-walk SO allocation. Best-effort. */
    try {
      const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
      await recomputeSoStockAllocation(sb);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-dr-resync failed:', e); }
  }
  /* DR 3B — the return qty just changed (line edited / deleted / cancelled), so
     the SO's NET delivered (delivered − returned) changed too. Reconcile the
     SO's stored delivery status: a return un-covers a fully-delivered SO and
     releases it DELIVERED → READY_TO_SHIP so the operator can re-ship; a
     cancelled/reduced return re-covers it back to DELIVERED. Run unconditionally
     (not gated on inventory writes) so the status always tracks the lines. */
  await reopenSoFromReturn(sb, deliveryReturnId, performedBy);
  return resyncErrors;
}

/* DR 3B (Wei Siang 2026-06-01) — reconcile the Sales Order(s) behind a Delivery
   Return. A return brings goods back, so the SO is no longer fully delivered and
   must re-open (DELIVERED → READY_TO_SHIP) to owe + re-ship that qty;
   syncSoDeliveredFromDo now nets returns out of coverage, so calling it here is
   what drives the release (and the reverse — re-advance to DELIVERED — when a
   return is cancelled/reduced). Resolves the SO doc no(s) two ways: the DR
   header's delivery_order_id → delivery_orders.so_doc_no (fast path), falling
   back to tracing the DR lines' do_item_id → DO line → so_item → doc_no when the
   header link is missing. Best-effort + idempotent; safe to call on every DR
   mutation (create / add-line / edit / delete / cancel). */
async function reopenSoFromReturn(
  sb: any,
  deliveryReturnId: string,
  actorId?: string | null,
): Promise<void> {
  try {
    const docs = new Set<string>();
    const { data: drHdr } = await sb.from('delivery_returns')
      .select('delivery_order_id').eq('id', deliveryReturnId).maybeSingle();
    const doId = (drHdr as { delivery_order_id: string | null } | null)?.delivery_order_id ?? null;
    if (doId) {
      const { data: doHdr } = await sb.from('delivery_orders')
        .select('so_doc_no').eq('id', doId).maybeSingle();
      const so = (doHdr as { so_doc_no: string | null } | null)?.so_doc_no ?? null;
      if (so) docs.add(so);
    }
    if (docs.size === 0) {
      const { data: drItems } = await sb.from('delivery_return_items')
        .select('do_item_id').eq('delivery_return_id', deliveryReturnId);
      const doItemIds = [...new Set(((drItems ?? []) as Array<{ do_item_id: string | null }>)
        .map((r) => r.do_item_id).filter((x): x is string => !!x))];
      if (doItemIds.length > 0) {
        const { data: doItems } = await sb.from('delivery_order_items')
          .select('so_item_id').in('id', doItemIds);
        const soItemIds = [...new Set(((doItems ?? []) as Array<{ so_item_id: string | null }>)
          .map((r) => r.so_item_id).filter((x): x is string => !!x))];
        if (soItemIds.length > 0) {
          const { data: soItems } = await sb.from('mfg_sales_order_items')
            .select('doc_no').in('id', soItemIds);
          for (const r of (soItems ?? []) as Array<{ doc_no: string | null }>) {
            if (r.doc_no) docs.add(r.doc_no);
          }
        }
      }
    }
    if (docs.size === 0) return;
    const { syncSoDeliveredFromDo } = await import('../lib/so-delivery-sync');
    await syncSoDeliveredFromDo(sb, [...docs], actorId ?? null);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-delivered-sync] post-dr failed:', e); }
}

/* Commander 2026-05-30 (Phase B) — LINE-LEVEL, QUANTITY-BASED DO → Delivery
   Return remaining. Wraps the shared Pending formula (do-line-remaining.ts):
   remaining_to_return = delivered − invoiced − returned. The SAME pool as
   remaining_to_invoice — invoiced units can't be returned + vice-versa.
   Cancelling a return releases its qty back to Pending. */
async function doReturnableRemaining(sb: any, doIds: string[]): Promise<Map<string, DoRemainingLine>> {
  return doLineRemaining(sb, doIds);
}

/* Over-return guard for the bulk create POST. Every DO-linked line must respect
   the live Pending pool (delivered − invoiced − returned). Callers reject lines
   with no doItemId BEFORE calling this (bug #16 — "no DO, no Return"), so any line
   reaching here is DO-linked. Mirrors the convert-from-DO picker's per-line check
   so the New-Return form is not a back door that returns more than was delivered.
   Returns a 409 body to reject, or null to allow. */
async function checkDrOverRemaining(
  sb: any,
  items: Array<Record<string, unknown>>,
): Promise<{ error: string; message: string; lines: Array<{ doItemId: string; requested: number; remaining: number }> } | null> {
  const wanted = new Map<string, number>();
  for (const it of items) {
    const doItemId = (it.doItemId as string | undefined) ?? null;
    if (!doItemId) continue;
    const q = Number(it.qtyReturned ?? it.qty ?? 0);
    wanted.set(doItemId, (wanted.get(doItemId) ?? 0) + q);
  }
  if (wanted.size === 0) return null;

  const ids = [...wanted.keys()];
  const { data: rows, error } = await sb
    .from('delivery_order_items')
    .select('id, delivery_order_id')
    .in('id', ids);
  if (error) return null; // load failure → don't block; the insert will surface real errors
  const doIds = [...new Set((rows ?? []).map((r: { delivery_order_id: string }) => r.delivery_order_id))] as string[];
  const remainingMap = await doReturnableRemaining(sb, doIds);

  const offenders: Array<{ doItemId: string; requested: number; remaining: number }> = [];
  for (const [doItemId, requested] of wanted) {
    const remaining = remainingMap.get(doItemId)?.remaining ?? 0;
    if (requested > remaining) offenders.push({ doItemId, requested, remaining });
  }
  if (offenders.length === 0) return null;
  return {
    error: 'over_remaining',
    message: 'One or more lines return more than the remaining (delivered − invoiced − returned) quantity.',
    lines: offenders,
  };
}

/* Build one delivery_return_items insert row from a client line payload.
   Shared by POST / (bulk create), POST /:id/items (single add), and the
   convert-from-DO copy. Computes line_total / line_cost / margin so
   recomputeTotals can roll them up.

   `sourceCostByDoItem` (lib/source-cost) is the server's own read of the SOURCE
   DO line's unit_cost_centi. When the line is DO-linked it WINS over the
   client's `unitCostCenti` unconditionally — a return must be booked at the cost
   the DO actually shipped at, and that is a historical snapshot, not a catalog
   lookup. Ignoring the client here is what makes stripping the cost off
   /returnable-do-lines safe: a non-finance caller now echoes nothing that can
   reach the column (the #632 trap, disarmed at its root rather than trusted not
   to fire). A free-hand line has no source row, so it keeps the client value. */
function buildItemRow(
  deliveryReturnId: string,
  it: Record<string, unknown>,
  sourceCostByDoItem?: Map<string, number>,
) {
  const qty = Number(it.qtyReturned ?? it.qty ?? 1);
  const unitPrice = Number(it.unitPriceCenti ?? 0);
  const discount = Number(it.discountCenti ?? 0);
  const doItemId = (it.doItemId as string | undefined) ?? undefined;
  const sourceCost = doItemId ? sourceCostByDoItem?.get(doItemId) : undefined;
  const unitCost = sourceCost !== undefined ? sourceCost : Number(it.unitCostCenti ?? 0);
  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  const refund = it.refundCenti !== undefined ? Number(it.refundCenti) : lineTotal;
  return {
    delivery_return_id: deliveryReturnId,
    do_item_id: (it.doItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty_returned: qty,
    condition: (it.condition as string) ?? null,
    unit_price_centi: unitPrice,
    discount_centi: discount,
    line_total_centi: lineTotal,
    unit_cost_centi: unitCost,
    line_cost_centi: lineCost,
    line_margin_centi: lineTotal - lineCost,
    refund_centi: refund,
    variants,
    notes: (it.notes as string | undefined) ?? null,
  };
}

// ── List ────────────────────────────────────────────────────────────────
deliveryReturns.get('/', async (c) => {
  const sb = c.get('supabase');
  /* Row-level visibility scope — the SAME rule and the SAME source of truth as
     the SO / DO / SI list handlers (lib/salesScope): view-all callers
     (`scm.so.view_all` or a director position via canViewAllSales) are
     unrestricted; everyone else sees SELF + their full manager_id downline.
     DR was the one sales document that row-scoped NOBODY, so every salesperson
     read every other salesperson's returns while the sibling lists denied them.
     A NULL salesperson_id row is NOT visible to a scoped caller — `.in()` never
     matches NULL, the same way SO/DO/SI already behave, and salesScope's
     salesDocOutOfScope rules null out-of-scope explicitly. An unattributed
     return stays visible to every view-all caller, who can assign its
     salesperson via PATCH /:id and hand it back to the rep's list.
     NOTE: must pass the REAL Houzs integer user id (houzsUser) — user.id here
     is the bridge's pinned system staff uuid, and feeding that to the scope
     lookup is the documented non-admin 500. */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));
  let q = sb.from('delivery_returns').select(HEADER).order('return_date', { ascending: false }).limit(500);
  if (scopeIds) q = q.in('salesperson_id', scopeIds);
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  /* Convert-from column (display-only, audit R8): the DR list already shows its
     source DO (do_doc_no); resolve the Sales Order behind that DO so the list
     can also show "From SO", matching the SO/DO/SI lists. One batched read
     keyed by delivery_order_id → delivery_orders.so_doc_no; best-effort, never
     throws (the SO number is ancillary, must not 500 the list). */
  if (Array.isArray(data) && data.length > 0) {
    const drRows = data as unknown as Array<Record<string, unknown>>;
    const doIds = [...new Set(
      drRows
        .map((r) => r.delivery_order_id as string | null)
        .filter((d): d is string => !!d),
    )];
    const soByDoId = new Map<string, string>();
    if (doIds.length > 0) {
      const { data: doRows } = await sb.from('delivery_orders').select('id, so_doc_no').in('id', doIds);
      for (const d of ((doRows ?? []) as Array<{ id: string | null; so_doc_no: string | null }>)) {
        if (d.id && d.so_doc_no) soByDoId.set(d.id, d.so_doc_no);
      }
    }
    for (const r of drRows) {
      r.so_doc_no = soByDoId.get((r.delivery_order_id as string | null) ?? '') ?? null;
    }
  }
  /* Finance gate — cost / margin / per-category subtotals reach ONLY a
     finance-viewer; stripped from every row otherwise. */
  if (!canViewScmFinance(c) && Array.isArray(data)) {
    for (const r of data) {
      if (r && typeof r === 'object') {
        for (const k of DR_FINANCE_KEYS) delete (r as Record<string, unknown>)[k];
      }
    }
  }
  return c.json({ deliveryReturns: data ?? [] });
});

// ── Returnable DO lines (line-level partial-return picker) ────────────────
/* Commander 2026-05-30 (Phase B) — feeds the line-level DO→Delivery Return
   picker. Returns each DO LINE that can still be returned (remaining > 0),
   where remaining = delivered − invoiced − returned (derived live). With
   ?doIds= it scopes to those DOs; without it, every non-cancelled DO.

   IMPORTANT (route ordering): this STATIC path MUST be registered BEFORE the
   `/:id` param route below, or Hono tries to cast it to an id.

   FINANCE: each descriptor carries the source DO line's `unitCostCenti`, so this
   picker shipped every delivered line's unit cost to any caller who could reach
   it — #632 named it and correctly declined to strip it, because the New-Return
   form echoed the value back and the create path trusted it, so a strip alone
   would have booked every converted return at cost 0. That echo is now dead:
   buildItemRow re-reads the cost from the source DO line server-side and ignores
   the client. The strip is therefore safe, and it is done HERE at the response
   rather than inside doLineRemaining — that helper is shared with the SI/DR
   server-side convert paths, which legitimately need the real cost. camelCase is
   why no existing list matched this: SO_ITEM_FINANCE_KEYS is snake_case
   PostgREST vocabulary, and lib/finance-keys warns that a camelCasing surface
   must strip in ITS OWN vocabulary. This is that surface. */
deliveryReturns.get('/returnable-do-lines', async (c) => {
  const sb = c.get('supabase');
  // Company scope (owner 2026-08-10 audit) — see resolveCandidateDoIds.
  const doIds = await resolveCandidateDoIds(sb, c.req.query('doIds'), activeCompanyId(c));
  if (doIds.length === 0) return c.json({ lines: [] });
  const remainingMap = await doReturnableRemaining(sb, doIds);
  const lines = [...remainingMap.values()].filter((l) => l.remaining > 0);
  if (!canViewScmFinance(c)) {
    for (const l of lines) delete (l as unknown as Record<string, unknown>).unitCostCenti;
  }
  return c.json({ lines });
});

// ── Detail ──────────────────────────────────────────────────────────────
deliveryReturns.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('delivery_returns').select(HEADER).eq('id', id), c).maybeSingle(),
    sb.from('delivery_return_items').select(ITEM).eq('delivery_return_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Own/downline sales scope (lib/salesScope.ts) — mirror the list scope above,
     exactly as the DO and SI details do. A scoped seller must not read another
     salesperson's return by enumerating ids; out-of-scope → 404, indistinguishable
     from a missing one. Directors/view-all bypass. HEADER carries salesperson_id
     already. Runs BEFORE the warehouse resolution so an out-of-scope id costs no
     extra queries. */
  {
    const sp = (h.data as { salesperson_id?: number | string | null }).salesperson_id;
    if (await salesDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), sp)) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  /* Per-line Warehouse column (Agent D, TASK #32): resolve the SAME warehouse
     the return IN puts stock back into (DO/SO line → DO header → DR header →
     default) so the operator sees which warehouse each line restocks.
     Display-only. */
  const rawItems = (i.data ?? []) as unknown as Array<{ id: string; do_item_id?: string | null } & Record<string, unknown>>;
  const headerWh = (h.data as { warehouse_id?: string | null }).warehouse_id ?? null;
  const lineWh = await resolveDrLineWarehouses(sb, rawItems, headerWh, activeCompanyId(c));
  const codeMap = await warehouseCodeMap(sb, [...lineWh.values()]);
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    return { ...it, warehouse_id: wid, warehouse_code: wid ? (codeMap.get(wid) ?? null) : null };
  });
  /* Finance gate — cost / margin (header + per line) reach ONLY a finance-viewer.
     The refund/total everyone is meant to see (local_total_centi / refund_centi /
     line_total_centi) are deliberately NOT stripped. */
  gateDrFinance(c, h.data, items);
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ deliveryReturn: h.data, items });
});

/* Insert the DR header from a client body. Shared by POST / and the
   convert-from-DO endpoint. Returns the inserted header row (HEADER cols). */
async function insertHeader(sb: any, userId: string, body: Record<string, unknown>, c: any) {
  const phoneRaw = (body.phone as string | undefined) ?? null;
  const emPhoneRaw = (body.emergencyContactPhone as string | undefined) ?? null;
  /* Owner ruling 2026-07-16 — "要自動標記create order的人": with the picker left
     blank the DR landed unattributed, and now that the DR list/detail are
     row-scoped by salesperson_id the rep who created it could not see their own
     return. Fall back to the CREATOR's real scm.staff uuid, mirroring SO create
     (mfg-sales-orders.ts createSalesOrderCore). Lives in insertHeader so BOTH
     create paths get it: POST / (blank picker) and POST /from-do, which copies
     salesperson_id off the source DO header and yields NULL whenever that DO
     carries none.

     resolveCallerStaffId takes the REAL Houzs integer id from houzsUser —
     NEVER c.get('user').id, which inside /api/scm/* is the bridge's pinned
     system staff uuid (the documented 500 / mis-attribution trap).

     UNRESOLVABLE CALLER → NULL, deliberately NOT the pinned system row (this is
     where SO create differs: it degrades to user.id). Stamping the shared system
     uuid would attribute every such DR to one identity — the pos-cart bug (#633)
     — and, under the scoping this backstops, hand them to nobody while looking
     attributed. NULL stays honest: invisible to a scoped rep, visible to every
     view-all caller, who can assign the salesperson via PATCH /:id. */
  const salespersonId =
    (body.salespersonId as string | null | undefined) ??
    (await resolveCallerStaffId(sb, c.get('houzsUser')?.id));
  return insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('delivery_returns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    return_number: returnNumber,
    do_doc_no: (body.doDocNo as string) ?? null,
    delivery_order_id: (body.deliveryOrderId as string) ?? null,
    sales_invoice_id: (body.salesInvoiceId as string) ?? null,
    debtor_code: (body.debtorCode as string) ?? null,
    debtor_name: (body.debtorName ?? body.customerName) as string,
    return_date: (body.returnDate as string) ?? todayMyt(),
    reason: (body.reason as string) ?? null,
    address1: (body.address1 as string) ?? null,
    address2: (body.address2 as string) ?? null,
    city: (body.city as string) ?? null,
    state: (body.state as string) ?? (body.customerState as string) ?? null,
    customer_state: (body.customerState as string) ?? (body.state as string) ?? null,
    customer_country: (body.customerCountry as string) ?? null,
    postcode: (body.postcode as string) ?? null,
    phone: phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null,
    salesperson_id: salespersonId,
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
    /* A return = goods are RECEIVED back the moment it's created. Skip the
       PENDING→RECEIVED→INSPECTED hand-walk: start at RECEIVED and increase
       stock right after the items insert. */
    status: 'RECEIVED',
    received_at: new Date().toISOString(),
    notes: (body.notes as string) ?? null,
    created_by: userId,
    }).select(HEADER).single(),
  );
}

// ── Create ──────────────────────────────────────────────────────────────
// Accepts the full DO-cloned header + line items. A return is RECEIVED on
// creation → stock is increased immediately (idempotent).
deliveryReturns.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const debtorName = (body.debtorName ?? body.customerName) as string | undefined;
  if (!debtorName) return c.json({ error: 'debtor_name_required' }, 400);
  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: 'items_required' }, 400);

  const sb = c.get('supabase'); const user = c.get('user');

  /* Edge #4 — itemCode catalog guard. */
  {
    const codeCheck = await validateItemCodes(sb, items.map((it) => it.itemCode as string | null | undefined), activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* An unlinked line on a return that NAMES a Delivery Order still brings the
     stock back IN, but counts against no DO line — so the returned pool never
     moves and the same goods can be returned again. Same shape that let one
     Sales Order ship twice (docs/unlinked-line-duplicate-coe.md); refused only
     when the named DO already contains that item, so a goodwill item added to a
     return still passes. */
  {
    const unlinked = await findUnlinkedDrLines(
      sb,
      (body.deliveryOrderId as string | undefined) ?? null,
      (body.doDocNo as string | undefined) ?? null,
      items.map((it, idx) => ({
        lineRef: String(idx),
        itemCode: String(it.itemCode ?? ''),
        qty: Number(it.qtyReturned ?? it.qty ?? 0),
        soItemId: (it.doItemId as string | undefined) ?? null,
      })),
    );
    if (unlinked.length > 0) return c.json(unlinkedReturnResponse(unlinked, 'delivery'), 409);
  }

  /* P1 SO-SKU spec §4.6 — SERVICE lines (delivery fee / dispose / lift) ride
     SO→DO→SI but are NOT returnable goods: a DR line for one would write
     phantom stock IN. Reject the whole request so the operator removes them. */
  {
    const svc = await findServiceLineCodes(sb, items.map((it) => ({
      itemCode: it.itemCode as string | null | undefined,
      itemGroup: it.itemGroup as string | null | undefined,
    })), activeCompanyId(c));
    if (svc.length > 0) return c.json(serviceLinesNotReturnableResponse(svc), 409);
  }

  /* Bug #16 (Commander 2026-05-31) — "no DO, no Return". Every return line MUST
     be tied to a Delivery Order line; only goods actually shipped can come back.
     Free-entry (doItemId=null) lines were a back door that wrote stock IN with no
     cap — reject them outright rather than letting them through uncapped. */
  {
    const freeEntry = items.filter((it) => !((it.doItemId as string | undefined) ?? null));
    if (freeEntry.length > 0) {
      return c.json({
        error: 'do_link_required',
        message: 'Every return line must reference a delivered Delivery Order line. Only shipped goods can be returned.',
        lines: freeEntry.map((it) => ({ itemCode: (it.itemCode as string) ?? null })),
      }, 409);
    }
  }

  /* Remaining-to-return guard — every DO-linked line must respect the live
     Pending pool. Mirrors the convert-from-DO picker so the New-Return form
     can't over-return a delivered line. */
  {
    const over = await checkDrOverRemaining(sb, items);
    if (over) return c.json(over, 409);
  }

  const { data: header, error: hErr } = await insertHeader(sb, user.id, body, c);
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  /* Re-derive every DO-linked line's cost from the SOURCE DO line, server-side.
     The New-Return form seeds its drafts off /returnable-do-lines and posts the
     cost back; trusting that echo is what a finance strip would have turned into
     a silent "book at cost 0" (#632). */
  const sourceCostByDoItem = await sourceUnitCostByItemId(
    sb, 'delivery_order_items', items.map((it: Record<string, unknown>) => it.doItemId as string | undefined),
  );
  const rows = items.map((it) => buildItemRow(h.id, it, sourceCostByDoItem));
  const { error: iErr } = await sb.from('delivery_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('delivery_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
  await recomputeTotals(sb, h.id);

  /* Bug #3/#11 — over-return race guard. checkDrOverRemaining above is
     read-before-write, so two parallel returns of the same DO line could both
     pass and over-return. After inserting (and BEFORE writing any stock), re-derive
     the live remaining for the referenced DO lines — now counting THIS DR — and
     ROLLBACK (delete the just-created DR) if any line went negative. No inventory
     was written yet, so the rollback is clean. Mirrors the /from-sos Edge #E
     pattern. */
  {
    const drItemDoIds = [...new Set(items
      .map((it) => (it.doItemId as string | undefined) ?? null)
      .filter((x): x is string => !!x))];
    if (drItemDoIds.length > 0) {
      const { data: rowsForDo } = await sb.from('delivery_order_items')
        .select('delivery_order_id').in('id', drItemDoIds);
      const doIds = [...new Set(((rowsForDo ?? []) as Array<{ delivery_order_id: string }>)
        .map((r) => r.delivery_order_id))];
      const recheck = await doReturnableRemaining(sb, doIds);
      const overReturned = drItemDoIds
        .map((doItemId) => recheck.get(doItemId))
        .filter((l): l is DoRemainingLine => l !== undefined && l.remaining < 0);
      if (overReturned.length > 0) {
        await sb.from('delivery_return_items').delete().eq('delivery_return_id', h.id);
        await sb.from('delivery_returns').delete().eq('id', h.id);
        return c.json({
          error: 'race_conflict',
          message: 'Another operator just returned overlapping qty from this Delivery Order. Refresh and try again.',
          conflicts: overReturned.map((l) => ({ doNumber: l.doNumber, itemCode: l.itemCode, remaining: l.remaining })),
        }, 409);
      }
    }
  }

  /* A DR = goods received back on creation → increase stock now (idempotent:
     the existence check + UNIQUE index mean this never double-increases even
     if the create is retried). */
  const movementErrors = await increaseInventoryForReturn(sb, h.id, user.id);

  /* B2C SO auto-allocation — returned goods re-enter stock; another customer's
     pending SO might now be fulfillable. Best-effort. */
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-dr failed:', e); }

  /* DR 3B (Wei Siang 2026-06-01) — returned goods mean the SO is no longer
     fully delivered; re-open it (DELIVERED → READY_TO_SHIP) so a fresh DO can
     re-ship the returned qty. Best-effort. */
  await reopenSoFromReturn(sb, h.id, user.id);

  return c.json({ id: h.id, returnNumber: h.return_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

// ── Convert picked DO LINES (partial qty) → ONE Delivery Return ────────────
/* Commander 2026-05-30 (Phase B) — LINE-LEVEL, QUANTITY-BASED convert, mirroring
   the SO→DO /from-sos picker. Pick individual DO LINES (each with a qty
   1..remaining_to_return) of ONE customer and combine them into ONE Delivery
   Return. A DO line can be returned across SEVERAL returns until its remaining
   (delivered − invoiced − returned, derived live) reaches 0. Invoiced units
   can't be returned — they're already out of the Pending pool.

   Body: { picks: [{ doItemId, qty, condition? }] }.

   Steps:
     1. Resolve every picked DO line's parent DO + live remaining via
        doReturnableRemaining.
     2. Validate (a) all picks share ONE customer (else 400 mixed_customers),
        (b) each pick qty is 1..remaining_to_return (else 409 over_remaining).
     3. Create ONE return (status RECEIVED) — header copied from the FIRST
        pick's DO; one return line per pick (qty_returned = picked, do_item_id
        set). recomputeTotals, then increaseInventoryForReturn (idempotent).

   Mounted at both /from-do and /from-dos so existing callers keep working. */
const convertDoLinesToReturn = async (c: any) => {
  let body: { picks?: Array<{ doItemId?: string; qty?: number; qtyReturned?: number; condition?: string }> };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }

  const sb = c.get('supabase'); const user = c.get('user');

  // Collapse duplicate doItemIds (sum their qty) so a line can't appear twice.
  // Keep the first non-empty condition seen for each line.
  const pickQtyById = new Map<string, number>();
  const conditionById = new Map<string, string>();
  for (const p of (body.picks ?? [])) {
    if (!p || !p.doItemId) continue;
    const q = Number(p.qty ?? p.qtyReturned ?? 0);
    if (!(q > 0)) continue;
    pickQtyById.set(p.doItemId, (pickQtyById.get(p.doItemId) ?? 0) + q);
    if (p.condition && !conditionById.has(p.doItemId)) conditionById.set(p.doItemId, p.condition);
  }
  if (pickQtyById.size === 0) return c.json({ error: 'picks_required' }, 400);

  // 1. Resolve each picked DO line → its parent DO, then derive remaining.
  const pickedIds = [...pickQtyById.keys()];
  const { data: pickedItemRows, error: pErr } = await sb
    .from('delivery_order_items')
    .select('id, delivery_order_id')
    .in('id', pickedIds);
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const idToDo = new Map<string, string>();
  for (const r of (pickedItemRows ?? []) as Array<{ id: string; delivery_order_id: string }>) idToDo.set(r.id, r.delivery_order_id);
  const missing = pickedIds.filter((id) => !idToDo.has(id));
  if (missing.length > 0) return c.json({ error: 'do_item_not_found', missing }, 404);

  const doIds = [...new Set([...idToDo.values()])];
  const remainingMap = await doReturnableRemaining(sb, doIds);

  // 2a. Same-customer guard — every picked line must share ONE customer.
  const customers = new Set<string>();
  const customerNames = new Set<string>();
  for (const id of pickedIds) {
    const line = remainingMap.get(id);
    if (!line) return c.json({ error: 'do_item_not_found', missing: [id] }, 404);
    customers.add(custKeyOf(line));
    customerNames.add(line.debtorName ?? line.debtorCode ?? '(none)');
  }
  if (customers.size > 1) {
    return c.json({
      error: 'mixed_customers',
      message: 'All picked Delivery Order lines must belong to the same customer to combine into one Delivery Return.',
      customers: [...customerNames],
    }, 400);
  }

  // 2b. Per-line qty guard — 1..remaining_to_return.
  for (const id of pickedIds) {
    const line = remainingMap.get(id)!;
    const qty = pickQtyById.get(id)!;
    if (qty < 1 || qty > line.remaining) {
      return c.json({
        error: 'over_remaining',
        message: `${line.itemCode} on ${line.doNumber}: return qty ${qty} exceeds remaining ${line.remaining}.`,
        doItemId: id,
        doNumber: line.doNumber,
        itemCode: line.itemCode,
        remaining: line.remaining,
        requested: qty,
      }, 409);
    }
  }

  /* P1 SO-SKU spec §4.6 — SERVICE lines ride the DO (D2 final) so the picker
     CAN surface them, but they are not returnable goods. Reject the convert
     if any picked line is a SERVICE line. */
  {
    const svc = await findServiceLineCodes(sb, pickedIds.map((id) => {
      const line = remainingMap.get(id)!;
      return { itemCode: line.itemCode, itemGroup: line.itemGroup };
    }), activeCompanyId(c));
    if (svc.length > 0) return c.json(serviceLinesNotReturnableResponse(svc), 409);
  }

  // 3. Create ONE return header from the FIRST pick's DO. "First" = the DO of
  //    the earliest-sorted picked line so the result is deterministic.
  const sortedPicks = pickedIds
    .map((id) => remainingMap.get(id)!)
    .sort((a, b) => a.doNumber.localeCompare(b.doNumber) || a.doItemId.localeCompare(b.doItemId));
  const firstDoId = sortedPicks[0]!.deliveryOrderId;
  const distinctDoNumbers = [...new Set(sortedPicks.map((l) => l.doNumber))].sort();

  // Pull the FIRST DO's header for the return header snapshot.
  const { data: doHeader, error: dhErr } = await sb.from('delivery_orders')
    .select('id, do_number, debtor_code, debtor_name, phone, email, salesperson_id, agent, ' +
            'customer_type, building_type, branding, venue, venue_id, ref, customer_so_no, ' +
            'sales_location, customer_state, customer_country, address1, address2, city, state, postcode, ' +
            'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
            'warehouse_id, currency, note')
    .eq('id', firstDoId).maybeSingle();
  if (dhErr) return c.json({ error: 'load_failed', reason: dhErr.message }, 500);
  if (!doHeader) return c.json({ error: 'delivery_order_not_found' }, 404);
  const doh = doHeader as unknown as Record<string, unknown>;

  const { data: header, error: hErr } = await insertHeader(sb, user.id, {
    doDocNo: doh.do_number,
    deliveryOrderId: doh.id,
    debtorCode: doh.debtor_code,
    debtorName: doh.debtor_name,
    phone: doh.phone,
    email: doh.email,
    salespersonId: doh.salesperson_id,
    agent: doh.agent,
    customerType: doh.customer_type,
    buildingType: doh.building_type,
    branding: doh.branding,
    venue: doh.venue,
    venueId: doh.venue_id,
    ref: distinctDoNumbers.length > 1 ? `Merged from ${distinctDoNumbers.join(', ')}` : (doh.ref ?? null),
    customerSoNo: doh.customer_so_no,
    salesLocation: doh.sales_location,
    customerState: doh.customer_state,
    customerCountry: doh.customer_country,
    address1: doh.address1,
    address2: doh.address2,
    city: doh.city,
    state: doh.state,
    postcode: doh.postcode,
    emergencyContactName: doh.emergency_contact_name,
    emergencyContactPhone: doh.emergency_contact_phone,
    emergencyContactRelationship: doh.emergency_contact_relationship,
    warehouseId: doh.warehouse_id,
    currency: doh.currency,
    note: doh.note,
    reason: distinctDoNumbers.length > 1
      ? `Return from DO ${distinctDoNumbers.join(', ')}`
      : `Return from DO ${String(doh.do_number ?? '')}`,
  }, c);
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  // 3b. One return line per pick — qty_returned = the picked qty, do_item_id
  //     set for the remaining-formula link. Carry cost so margins survive.
  const rows = sortedPicks.map((line) => buildItemRow(h.id, {
    doItemId: line.doItemId,
    itemCode: line.itemCode,
    itemGroup: line.itemGroup,
    description: line.description,
    uom: line.uom,
    qtyReturned: pickQtyById.get(line.doItemId)!,
    condition: conditionById.get(line.doItemId) ?? 'NEW',
    unitPriceCenti: line.unitPriceCenti,
    // Carry the DO line's discount (hardcoding 0 overstated the refund);
    // mirrors the SI convert-from-DO path.
    discountCenti: line.discountCenti,
    unitCostCenti: line.unitCostCenti,
    variants: line.variants,
  }));
  const { error: iErr } = await sb.from('delivery_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('delivery_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }
  await recomputeTotals(sb, h.id);

  /* Bug #3/#11 — over-return race guard (mirrors the bulk POST / above). The
     per-line qty check at step 2b is read-before-write, so two parallel converts
     of the same DO line could each pass and over-return. After inserting (and
     BEFORE writing any stock), re-derive the live remaining for the referenced DO
     lines — now counting THIS DR — and ROLLBACK (delete the just-created DR) if any
     picked line went negative. No inventory was written yet → clean rollback. */
  {
    const recheck = await doReturnableRemaining(sb, doIds);
    const overReturned = pickedIds
      .map((doItemId) => recheck.get(doItemId))
      .filter((l): l is DoRemainingLine => l !== undefined && l.remaining < 0);
    if (overReturned.length > 0) {
      await sb.from('delivery_return_items').delete().eq('delivery_return_id', h.id);
      await sb.from('delivery_returns').delete().eq('id', h.id);
      return c.json({
        error: 'race_conflict',
        message: 'Another operator just returned overlapping qty from this Delivery Order. Refresh and try again.',
        conflicts: overReturned.map((l) => ({ doNumber: l.doNumber, itemCode: l.itemCode, remaining: l.remaining })),
      }, 409);
    }
  }

  // Goods received back → increase stock (idempotent).
  const movementErrors = await increaseInventoryForReturn(sb, h.id, user.id);

  /* DR 3B (Wei Siang 2026-06-01) — re-open the SO this return came from
     (DELIVERED → READY_TO_SHIP) so the returned qty can be re-shipped on a
     fresh DO. Best-effort. */
  await reopenSoFromReturn(sb, h.id, user.id);

  return c.json({ id: h.id, returnNumber: h.return_number, lineCount: rows.length, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
deliveryReturns.post('/from-do', convertDoLinesToReturn);
deliveryReturns.post('/from-dos', convertDoLinesToReturn);

// ── Header PATCH (editable SO/DO-style fields) ─────────────────────────────
deliveryReturns.patch('/:id', async (c) => {
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
  if (Object.keys(updates).length === 1) return c.json({ ok: true, changed: 0 });

  const { data, error } = await scopeToCompanyId(sb.from('delivery_returns').update(updates).eq('id', id), co.companyId).select('id').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ ok: true, id });
});

// ── Item CRUD ─────────────────────────────────────────────────────────────
deliveryReturns.post('/:id/items', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);

  /* Bug #16 — "no DO, no Return": a single-added line must also reference a DO line. */
  if (!((it.doItemId as string | undefined) ?? null)) {
    return c.json({
      error: 'do_link_required',
      message: 'Every return line must reference a delivered Delivery Order line. Only shipped goods can be returned.',
    }, 409);
  }

  /* Edge #4 — itemCode catalog guard. */
  {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* P1 SO-SKU spec §4.6 — SERVICE lines are not returnable goods. */
  {
    const svc = await findServiceLineCodes(sb, [{
      itemCode: it.itemCode as string | null | undefined,
      itemGroup: it.itemGroup as string | null | undefined,
    }], activeCompanyId(c));
    if (svc.length > 0) return c.json(serviceLinesNotReturnableResponse(svc), 409);
  }

  const { data: header } = await scopeToCompanyId(sb.from('delivery_returns').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!header) return c.json(NOT_THIS_COMPANY, 404);

  /* Over-return guard for the single-add path too. */
  {
    const over = await checkDrOverRemaining(sb, [it]);
    if (over) return c.json(over, 409);
  }

  const row = buildItemRow(id, it, await sourceUnitCostByItemId(
    sb, 'delivery_order_items', [it.doItemId as string | undefined],
  ));
  const { data, error } = await sb.from('delivery_return_items').insert({ ...row, company_id: activeCompanyId(c) }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  /* Adding a return line must put its goods back into stock, same as the line
     edit/delete paths below — otherwise on-hand stays short by the added qty.
     Idempotent + best-effort (resync targets net-IN = sum of current lines). */
  /* REPORTED: writeMovements never throws, so this catch caught nothing and a
     failed stock resync returned a clean 200. Same contract the CREATE path
     already uses. */
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncInventoryForReturn(sb, id, c.get('user')?.id); }
  catch (e) { resyncErrs = [`return resync threw: ${(e as Error)?.message ?? 'unknown'}`]; }
  return c.json({ item: data, movementErrors: resyncErrs.length ? resyncErrs : undefined }, 201);
});

deliveryReturns.patch('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  /* Edge #4 — itemCode catalog guard (only when caller is changing it). */
  if (it.itemCode !== undefined) {
    const codeCheck = await validateItemCodes(sb, [it.itemCode as string], activeCompanyId(c));
    if (!codeCheck.ok) return c.json(unknownItemCodeResponse(codeCheck.unknown), 409);
  }

  /* Audit 2026-06-11 M10 — scope the line to THIS return: a mismatched itemId
     must 404, not edit another DR's line while the recompute + stock resync
     run against this one. Company scope layered on top so the line can't belong
     to another company's return either. */
  const { data: prev } = await scopeToCompanyId(sb.from('delivery_return_items')
    .select('qty_returned, unit_price_centi, discount_centi, unit_cost_centi, item_code, item_group, description, uom, variants, notes, condition, do_item_id')
    .eq('id', itemId).eq('delivery_return_id', id), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);

  /* P1 SO-SKU spec §4.6 — block edits that would TURN a return line into a
     SERVICE line (code/group swap). Effective = patch value ?? stored value. */
  if (it.itemCode !== undefined || it.itemGroup !== undefined) {
    const svc = await findServiceLineCodes(sb, [{
      itemCode: (it.itemCode ?? prev.item_code) as string | null | undefined,
      itemGroup: (it.itemGroup ?? prev.item_group) as string | null | undefined,
    }], activeCompanyId(c));
    if (svc.length > 0) return c.json(serviceLinesNotReturnableResponse(svc), 409);
  }

  const qty = (it.qtyReturned ?? it.qty) !== undefined ? Number(it.qtyReturned ?? it.qty) : Number(prev.qty_returned);

  /* Over-return cap (parity with create + add-line; was the one DR back door).
     An edited qty must not push the DO line past its remaining (delivered −
     invoiced − returned). The line's OWN current qty is already in `returned`, so
     only the INCREASE is checked against remaining; a reduction always passes. */
  {
    const doItemId = (prev as { do_item_id?: string | null }).do_item_id ?? null;
    const delta = qty - Number(prev.qty_returned ?? 0);
    if (doItemId && delta > 0) {
      const over = await checkDrOverRemaining(sb, [{ doItemId, qtyReturned: delta } as Record<string, unknown>]);
      if (over) return c.json(over, 409);
    }
  }

  const unitPrice = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : Number(prev.unit_price_centi);
  const discount = it.discountCenti !== undefined ? Number(it.discountCenti) : Number(prev.discount_centi);
  /* A caller who cannot READ the cost must not WRITE it. The detail GET now
     strips unit_cost_centi for a non-finance caller, and DeliveryReturnDetail
     seeds each line draft straight off that payload (`unit_cost_centi ?? 0`) and
     posts the value back here on save — so trusting the client would let the
     stripped field round-trip as a genuine 0 and wipe the line's cost basis
     (recomputeTotals would then roll the DR's cost to 0 and its margin to the
     full refund). This route accepts ANY defined value, unlike the SO PATCH,
     whose `explicitCost > 0` precedence makes a 0 fall through to the stored
     cost — which is why the same strip was safe there (#625). Keep the stored
     cost for a non-finance caller; a finance caller is unaffected. */
  const unitCost = (canViewScmFinance(c) && it.unitCostCenti !== undefined)
    ? Number(it.unitCostCenti)
    : Number(prev.unit_cost_centi);
  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;

  const updates: Record<string, unknown> = {
    qty_returned: qty, unit_price_centi: unitPrice, discount_centi: discount, unit_cost_centi: unitCost,
    line_total_centi: lineTotal, line_cost_centi: lineCost, line_margin_centi: lineTotal - lineCost,
    refund_centi: lineTotal,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['itemGroup', 'item_group'], ['description', 'description'],
    ['uom', 'uom'], ['variants', 'variants'], ['notes', 'notes'], ['condition', 'condition'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* Description 2 is always the server-generated variant summary. */
  {
    const effGroup = (it.itemGroup ?? prev.item_group) as string | null | undefined;
    const effVariants = (it.variants ?? prev.variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const { error } = await scopeToCompanyId(sb.from('delivery_return_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  /* A DR put goods back into stock on create; an edited qty must re-sync that
     stock or on-hand stays inflated. Idempotent + best-effort. */
  /* REPORTED: writeMovements never throws, so this catch caught nothing and a
     failed stock resync returned a clean 200. Same contract the CREATE path
     already uses. */
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncInventoryForReturn(sb, id, user?.id); }
  catch (e) { resyncErrs = [`return resync threw: ${(e as Error)?.message ?? 'unknown'}`]; }
  return c.json({ ok: true, movementErrors: resyncErrs.length ? resyncErrs : undefined });
});

deliveryReturns.delete('/:id/items/:itemId', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const itemId = c.req.param('itemId'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* Audit 2026-06-11 M10 — scope the line to THIS return: a mismatched itemId
     must 404, not delete another DR's line while the recompute + stock resync
     run against this one. Company scope layered on top so the line can't belong
     to another company's return either. */
  {
    const { data: line } = await scopeToCompanyId(sb.from('delivery_return_items')
      .select('id').eq('id', itemId).eq('delivery_return_id', id), co.companyId).maybeSingle();
    if (!line) return c.json(NOT_THIS_COMPANY, 404);
  }
  const { error } = await scopeToCompanyId(sb.from('delivery_return_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  await recomputeTotals(sb, id);
  /* Deleting a returned line must take its re-stocked goods back out, or on-hand
     stays inflated by the removed qty. Idempotent + best-effort. */
  /* REPORTED: writeMovements never throws, so this catch caught nothing and a
     failed stock resync returned a clean 200. Same contract the CREATE path
     already uses. */
  let resyncErrs: string[] = [];
  try { resyncErrs = await resyncInventoryForReturn(sb, id, user?.id); }
  catch (e) { resyncErrs = [`return resync threw: ${(e as Error)?.message ?? 'unknown'}`]; }
  return c.json({ ok: true, movementErrors: resyncErrs.length ? resyncErrs : undefined });
});

// ── Status transition ──────────────────────────────────────────────────────
// Kept simple per spec: a return is RECEIVED on create (stock already added);
// CANCELLED is allowed. Other statuses (INSPECTED / REFUNDED / CREDIT_NOTED /
// REJECTED) remain valid enum values and stamp their timestamp.
//
// Migration 0107 — CANCELLED reverses the inventory IN a DR wrote on create
// (a DR put goods BACK into stock; cancelling must take them out again), via
// resyncInventoryForReturn with a CANCELLED target of zero — the same delta-based
// helper that also handles line edit/delete, so the three rollback paths can't
// drift. It writes batch-scoped IN/OUT for sofa lots and a FIFO-neutral signed
// ADJUSTMENT otherwise, all tagged source_doc_type='ADJUSTMENT' so they sidestep
// the uq_inv_mov_dr_source unique index. Idempotent by construction: a re-run
// finds delta 0. The cancelled return's qty also returns to Pending automatically
// (the do-line-remaining formula filters non-cancelled DRs).
export const patchDeliveryReturnStatusHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id'); const user = c.get('user');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { status?: string; inspectionNotes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!body.status) return c.json({ error: 'status_required' }, 400);

  // Read the current status so the CANCELLED reversal is idempotent.
  const { data: cur } = await scopeToCompanyId(sb.from('delivery_returns').select('status').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const prevStatus = (cur as { status: string }).status;
  // Already cancelled → echo back without re-reversing (would double-deduct).
  if (body.status === 'CANCELLED' && prevStatus === 'CANCELLED') {
    return c.json({ deliveryReturn: { id, status: 'CANCELLED' } });
  }
  /* Audit 2026-06-10 #3 (IMPORTANT) — a CANCELLED DR is FINAL. Un-cancelling
     left the cancel's stock drain in place (resync only runs on the CANCELLED
     transition), so the books said "returned" while the shelf stayed empty.
     Raise a NEW Delivery Return instead. */
  if (prevStatus === 'CANCELLED') {
    return c.json({
      error: 'dr_cancelled_final',
      reason: 'A cancelled Delivery Return cannot be reactivated — its stock entry was already drained. Create a new return instead.',
    }, 409);
  }

  const now = new Date().toISOString();
  const ts: Record<string, string> = { updated_at: now, status: body.status };
  if (body.status === 'RECEIVED') ts.received_at = now;
  if (body.status === 'INSPECTED') { ts.inspected_at = now; if (body.inspectionNotes) ts.inspection_notes = body.inspectionNotes; }
  if (body.status === 'REFUNDED') ts.refunded_at = now;

  /* Bug #3/#11 — ATOMIC cancel guard. The read-then-write above has a TOCTOU
     window: two concurrent cancels can both read a non-cancelled status and both
     fall through to reverse the return's stock (double-reverse). For the CANCELLED
     transition we make the write conditional on the row still being non-cancelled
     and treat "no row returned" as "someone else already cancelled" → idempotent
     echo, NO second reversal. Postgres serialises the UPDATEs so exactly one wins
     the row and fires the single reversal. */
  let data: { id: string; status: string } | null;
  if (body.status === 'CANCELLED') {
    const { data: updated, error } = await scopeToCompanyId(sb.from('delivery_returns')
      .update(ts).eq('id', id), co.companyId).neq('status', 'CANCELLED')
      .select('id, status').maybeSingle();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!updated) {
      // Lost the race — another concurrent cancel already flipped it. Do NOT
      // reverse again; echo the cancelled state.
      return c.json({ deliveryReturn: { id, status: 'CANCELLED' } });
    }
    data = updated as { id: string; status: string };
  } else {
    const { data: updated, error } = await scopeToCompanyId(sb.from('delivery_returns')
      .update(ts).eq('id', id), co.companyId).select('id, status').single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    data = updated as { id: string; status: string };
  }

  // Cancelling a DR → drain the inventory IN it wrote on create back out, via
  // resyncInventoryForReturn (target net 0). It writes a FIFO-neutral signed
  // ADJUSTMENT (unindexed by the DR source key, carrying variant_key) — we CANNOT
  // reuse reverseMovements: its balancing OUT reuses the DR's (source_doc_type,
  // source_doc_id, product_code, variant_key) key, which the partial UNIQUE index
  // uq_inv_mov_dr_source (migration 0102, keyed WITHOUT movement_type) rejects →
  // the insert silently fails and the returned stock stays added.
  // Hoisted: the response below is OUTSIDE this block, so a block-scoped
  // declaration would leave the cancel path unable to report its failures.
  let resyncErrs: string[] = [];
  if (body.status === 'CANCELLED') {
    // Unified rollback: target net = 0 for a cancelled DR, so the resync drains
    // back out exactly the stock still booked by this return (the create IN minus
    // any line-edit adjustments). Same code path as line edit/delete — they can't
    // drift. Idempotent + best-effort.
    /* REPORTED: writeMovements never throws, so this catch caught nothing and a
       failed stock resync returned a clean 200. Same contract the CREATE path
       already uses. */
    resyncErrs = [];
    try { resyncErrs = await resyncInventoryForReturn(sb, id, user.id); }
    catch (e) { resyncErrs = [`return resync threw: ${(e as Error)?.message ?? 'unknown'}`]; }
    /* DR cancel pulled stock back out → other READY SOs that relied on it may
       now regress to PENDING. Re-walk allocation. Best-effort. */
    try {
      const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
      await recomputeSoStockAllocation(sb);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-dr-cancel failed:', e); }
  }

    return c.json({ deliveryReturn: data, movementErrors: resyncErrs.length ? resyncErrs : undefined });
};
deliveryReturns.patch('/:id/status', patchDeliveryReturnStatusHandler);
