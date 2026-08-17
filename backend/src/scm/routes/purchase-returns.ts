// ----------------------------------------------------------------------------
// /purchase-returns — we send goods back to the supplier.
//
// Closes the procurement loop: PO → GRN → (defect / oversupply / wrong item
// discovered) → PurchaseReturn → supplier credit note.
//
// Endpoints:
//   GET    /purchase-returns                — list + filters
//   GET    /purchase-returns/:id            — header + items
//   POST   /purchase-returns                — create draft
//   PATCH  /purchase-returns/:id/post       — DRAFT → POSTED
//   PATCH  /purchase-returns/:id/complete   — POSTED → COMPLETED (with CN ref)
//   PATCH  /purchase-returns/:id/cancel     — → CANCELLED (if not completed)
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { qtyCapRefusal } from '../lib/qty-cap';
import { writeMovements, reverseMovements, defaultWarehouseId } from '../lib/inventory-movements';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { todayMyt } from '../lib/my-time';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { warehouseLabel } from '../lib/warehouse-label';
import { buildVariantSummary, computeVariantKey, type VariantAttrs } from '../shared';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { recomputePoReceived, resolvePoBatchByItem } from './grns';
import { findUnlinkedPrLines, unlinkedReturnResponse } from '../lib/return-unlinked-lines';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
  isCrossCompanySource, crossCompanyConversionBlocked } from '../lib/companyScope';
import {
  checkStockAvailability,
  shortStockResponse,
  type StockLineRequest,
  type StockShortage,
} from '../lib/check-stock-availability';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';
import { recordEntityAudit } from '../lib/entity-audit';

export const purchaseReturns = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseReturns.use('*', supabaseAuth);

const HEADER =
  'id, return_number, purchase_order_id, grn_id, supplier_id, return_date, ' +
  'reason, status, posted_at, completed_at, credit_note_ref, refund_centi, ' +
  'notes, created_at, created_by, updated_at';
const ITEM =
  'id, purchase_return_id, grn_item_id, material_kind, material_code, ' +
  'material_name, qty_returned, unit_price_centi, line_refund_centi, reason, notes, ' +
  /* item_group + variants drive the canonical SKU/build read-order sort (the
     sofa module walk + category rank); selected here so the PR detail + PDF
     order matches the sales side. */
  'item_group, variants, created_at';

const nextNum = async (sb: any, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'purchase_returns', 'return_number', `${p}PRT-${yymm}`);
};

/* ── Recompute PR header money rollup (mirror recomputeGrnTotals) ──────────
   Sum line_refund_centi across purchase_return_items → write refund_centi on
   the purchase_returns header. A return is qty × unit price (no tax/discount),
   so refund_centi is the document total.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale.
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputePrTotals(sb: any, prId: string) {
  const { data: items, error: itemsErr } = await sb.from('purchase_return_items')
    .select('line_refund_centi')
    .eq('purchase_return_id', prId);
  /* A failed READ is not an empty return, and `?? []` cannot tell them apart — it
     folded a transient blip into refund_centi ZERO, i.e. a refund the supplier
     owes us silently became no refund. The ERROR is the signal, never the
     emptiness: a genuinely empty return resolves error === null with data === []
     and MUST still fall through to zero the header. */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pr-recompute] item read failed — header left unchanged:', prId, itemsErr.message);
    return;
  }
  const refund = (items ?? []).reduce((s: number, r: any) => s + (r.line_refund_centi ?? 0), 0);
  const { error: updErr } = await sb.from('purchase_returns').update({
    refund_centi: refund,
    updated_at: new Date().toISOString(),
  }).eq('id', prId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pr-recompute] header update failed — refund left STALE:', prId, updErr.message);
  }
}

/* ── GRN→PR consumption helper (migration 0106, unified model) ──────────────
   Track grn_items.returned_qty as PR lines are drawn from / adjusted against /
   released back to a GRN line. base = qty_accepted (you can return up to what
   was accepted); remaining = qty_accepted - returned_qty. Mirrors
   adjustGrnInvoicedQty in purchase-invoices.ts. */
async function adjustGrnReturnedQty(sb: any, grnItemId: string, _delta?: number) {
  if (!grnItemId) return;
  /* RECOUNT-from-live (Wei Siang 2026-06-03 audit fix) — returned_qty is the SUM
     of qty_returned across LIVE (non-cancelled) purchase_return_items for this GRN
     line, clamped to [0, qty_accepted]. The old `cur + delta` arithmetic drifted
     PERMANENTLY if any one adjust was dropped (best-effort swallow) or replayed —
     it never reconverged, and it feeds two integrity gates (PO re-open + PI
     over-bill headroom). A recount self-heals, exactly like recomputeGrnInvoiced /
     recomputeGrnReceived. `_delta` is ignored (kept for call-site compatibility);
     every caller already mutated the PR rows BEFORE calling, so the live sum is
     authoritative. */
  /* The ERROR is the signal, never the emptiness — the same rule the mirror this
     docblock names (recomputeGrnInvoiced, purchase-invoices.ts) already follows
     on all three of its reads. `?? []` cannot tell a failed read from a GRN line
     with no live PR lines, and the two mean opposite things here: the recount
     below turns an empty result into `returned_qty = 0`, which RELEASES the GRN
     line — the same goods become returnable again AND the PI over-bill headroom
     (qty_accepted - invoiced_qty - returned_qty) re-opens, with nothing raised.
     A GRN line whose PR lines have genuinely all gone resolves error === null
     with data === [] and MUST still fall through to that release; that is the
     recount model working. Nothing is written above this point. */
  const { data: prLines, error: prLinesErr } = await sb.from('purchase_return_items')
    .select('qty_returned, purchase_return_id')
    .eq('grn_item_id', grnItemId);
  if (prLinesErr) {
    /* eslint-disable-next-line no-console */
    console.error('[adjustGrnReturnedQty] PR line read failed — returned_qty left unchanged:', grnItemId, prLinesErr.message);
    return;
  }
  const rows = (prLines ?? []) as Array<{ qty_returned: number; purchase_return_id: string }>;
  const prIds = [...new Set(rows.map((r) => r.purchase_return_id).filter(Boolean))];
  const cancelled = new Set<string>();
  if (prIds.length > 0) {
    /* Same rule, opposite direction: an empty `cancelled` from a FAILED read
       reads as "no return here is cancelled", so a cancelled PR's qty is counted
       as still returned and the GRN line stays consumed against a return that
       was voided. */
    const { data: prs, error: prsErr } = await sb.from('purchase_returns').select('id, status').in('id', prIds);
    if (prsErr) {
      /* eslint-disable-next-line no-console */
      console.error('[adjustGrnReturnedQty] PR status read failed — returned_qty left unchanged:', grnItemId, prsErr.message);
      return;
    }
    for (const p of (prs ?? []) as Array<{ id: string; status: string }>) {
      if ((p.status ?? '').toUpperCase() === 'CANCELLED') cancelled.add(p.id);
    }
  }
  let returned = 0;
  for (const r of rows) if (!cancelled.has(r.purchase_return_id)) returned += Number(r.qty_returned ?? 0);

  const { data: gi } = await sb.from('grn_items')
    .select('qty_accepted, purchase_order_item_id').eq('id', grnItemId).maybeSingle();
  if (!gi) return;
  const accepted = (gi as { qty_accepted: number }).qty_accepted ?? 0;
  const next = Math.min(accepted, Math.max(0, returned)); // clamp [0, accepted]
  const { error: updErr } = await sb.from('grn_items').update({ returned_qty: next }).eq('id', grnItemId);
  if (updErr) {
    /* A rejected UPDATE left returned_qty STALE with nothing logged, and it is
       read by two integrity gates (PO re-open + PI over-bill headroom). Do not
       recount the PO off a GRN line we failed to move. */
    /* eslint-disable-next-line no-console */
    console.error('[adjustGrnReturnedQty] returned_qty update failed — GRN line left STALE:', grnItemId, updErr.message);
    return;
  }
  // Returning goods nets down the parent PO line's received_qty (re-opens for a
  // replacement shipment). Recount it from live GRN lines.
  const poItemId = (gi as { purchase_order_item_id: string | null }).purchase_order_item_id;
  if (poItemId) await recomputePoReceived(sb, [poItemId]);
}

purchaseReturns.get('/', async (c) => {
  const sb = c.get('supabase');
  let q = sb.from('purchase_returns')
    .select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_order:purchase_orders(id, po_number), grn:grns(id, grn_number)`)
    .order('return_date', { ascending: false })
    .limit(300);
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  const supplierId = c.req.query('supplierId'); if (supplierId) q = q.eq('supplier_id', supplierId);
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ purchaseReturns: data ?? [] });
});

purchaseReturns.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('purchase_returns')
      .select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_order:purchase_orders(id, po_number), grn:grns(id, grn_number)`)
      .eq('id', id), c).maybeSingle(),
    sb.from('purchase_return_items').select(ITEM).eq('purchase_return_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Per-line Warehouse column (Agent D, TASK #32): resolve the SAME warehouse
     the return OUT pulls stock from (grn_item → GRN warehouse → header GRN →
     default) so the operator sees which warehouse each line ships back from.
     Display-only. */
  /* Canonical SKU/build order at READ (sofa modules LHF→NA→RHF, mains→
     accessories→services), mirroring the SO detail GET. The shared helper keys
     on `item_code`; PR lines expose `material_code`, so sort a shimmed view
     that carries the original row back unchanged. `.order('created_at')` above
     stays as the stable tiebreaker — pure ordering, no persistence touched. */
  type PrItemRow = Record<string, unknown> & { id: string; grn_item_id?: string | null; material_code: string; item_code: string };
  const rawItems = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((i.data ?? []) as unknown as Array<{ id: string; grn_item_id?: string | null; material_code: string } & Record<string, unknown>>)
        .map((it): PrItemRow => ({ ...it, item_code: it.material_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  const headerGrnId = (h.data as { grn_id?: string | null }).grn_id ?? null;
  const lineWh = await resolvePrLineWarehouses(sb, rawItems, headerGrnId, activeCompanyId(c));
  const codeMap = await warehouseCodeMap(sb, [...lineWh.values()]);
  const items = rawItems.map((it) => {
    const wid = lineWh.get(it.id) ?? null;
    return { ...it, warehouse_id: wid, warehouse_code: wid ? (codeMap.get(wid) ?? null) : null };
  });
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ purchaseReturn: h.data, items });
});

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// For a PR: the parent GRN + parent PO (both nullable on purchase_returns).
purchaseReturns.get('/:id/linked', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  /* Company-scoped like every other read on this router. Without it a caller in
     one company could resolve ANOTHER company's purchase return to its GRN and
     PO numbers by id — the only read here that skipped the scope (found
     2026-08-12 by code read; the module guide claimed scoping that was absent). */
  const { data, error } = await scopeToCompany(
    sb
      .from('purchase_returns')
      .select(`
        id,
        grn:grns(id, grn_number),
        purchase_order:purchase_orders(id, po_number)
      `)
      .eq('id', id),
    c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  // Supabase typegen returns joined rows as arrays even for to-one FKs.
  const raw = data as unknown as {
    grn?: { id: string; grn_number: string } | Array<{ id: string; grn_number: string }> | null;
    purchase_order?: { id: string; po_number: string } | Array<{ id: string; po_number: string }> | null;
  };
  const grn: { id: string; grn_number: string } | null =
    Array.isArray(raw.grn) ? (raw.grn[0] ?? null) : (raw.grn ?? null);
  const po: { id: string; po_number: string } | null =
    Array.isArray(raw.purchase_order) ? (raw.purchase_order[0] ?? null) : (raw.purchase_order ?? null);
  return c.json({ grn, purchaseOrder: po });
});

/* PR-DRAFT-removal — shared inventory-OUT side-effect. Called inline on
   POST so the new PR is created as POSTED with movements already written.
   Best-effort: doesn't roll back the row on movement failure. */
/* ── resolvePrLineWarehouses (Agent D 2026-05-31, TASK #32) ───────────────────
   PER-WAREHOUSE CORRECTNESS for the supplier-return side. A Purchase Return
   takes stock OUT of the warehouse the goods were RECEIVED into — i.e. the
   source GRN line's warehouse. A PR built via /from-grns can batch lines from
   several GRNs that may sit in different warehouses (same supplier), so a single
   primary-GRN warehouse for every line could draw OUT of the wrong warehouse.
   Resolve per line via grn_item_id → grn_items.grn_id → grns.warehouse_id.

   Resolution order per PR line:
     1. the source GRN line's GRN warehouse (grn_item_id → … → grns)
     2. the primary GRN's warehouse (manual lines with no grn_item_id)
     3. the return's OWN company's default warehouse (last-resort fallback)

   Returns a map of purchase_return_items.id → warehouse_id (or null when even
   the fallbacks are absent — the caller skips those lines). */
async function resolvePrLineWarehouses(
  sb: any,
  items: Array<{ id: string; grn_item_id?: string | null }>,
  primaryGrnId: string | null,
  /* The return's company (2026-08-03) — step 3 is per company. It used to be a
     company-blind draw across every company's is_default warehouses, decided by
     alphabetical `code` order. */
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const grnItemIds = [...new Set(items
    .map((it) => it.grn_item_id ?? null)
    .filter((x): x is string => !!x))];

  // grn_item_id → grn_id → warehouse_id.
  const grnItemToGrn = new Map<string, string | null>();
  const grnIds = new Set<string>();
  if (grnItemIds.length > 0) {
    const { data: giRows } = await sb.from('grn_items')
      .select('id, grn_id').in('id', grnItemIds);
    for (const r of (giRows ?? []) as Array<{ id: string; grn_id: string | null }>) {
      grnItemToGrn.set(r.id, r.grn_id ?? null);
      if (r.grn_id) grnIds.add(r.grn_id);
    }
  }
  if (primaryGrnId) grnIds.add(primaryGrnId);
  const grnWh = new Map<string, string | null>();
  if (grnIds.size > 0) {
    const { data: grnRows } = await sb.from('grns')
      .select('id, warehouse_id').in('id', [...grnIds]);
    for (const r of (grnRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      grnWh.set(r.id, r.warehouse_id ?? null);
    }
  }

  const fallback = (primaryGrnId ? grnWh.get(primaryGrnId) ?? null : null) ?? (await defaultWarehouseId(sb, companyId));
  for (const it of items) {
    const grnId = it.grn_item_id ? (grnItemToGrn.get(it.grn_item_id) ?? null) : null;
    const fromGrn = grnId ? (grnWh.get(grnId) ?? null) : null;
    out.set(it.id, fromGrn ?? fallback);
  }
  return out;
}

/* warehouseCodeMap (Agent D 2026-05-31, TASK #32) — warehouse_id → display
   CODE for the per-line Warehouse column on the PR detail GET. Read-only. */
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

async function writePurchaseReturnMovements(sb: any, prId: string, returnNumber: string, grnId: string | null, userId: string): Promise<string[]> {
  // Multi-company: the PR's movements inherit the PR header's company.
  const { data: prHeader } = await sb.from('purchase_returns')
    .select('company_id').eq('id', prId).maybeSingle();
  const prCompanyId = (prHeader as { company_id?: number | null } | null)?.company_id ?? null;
  const { data: items } = await sb.from('purchase_return_items')
    .select('id, grn_item_id, material_code, material_name, qty_returned, item_group, variants')
    .eq('purchase_return_id', prId);
  if (!items) return [];
  // Per-line warehouse — each line draws OUT of its source GRN line's warehouse,
  // not a single primary-GRN default (a batched PR can span warehouses).
  const lineWh = await resolvePrLineWarehouses(
    sb,
    items as Array<{ id: string; grn_item_id?: string | null }>,
    grnId,
    prCompanyId ?? undefined,
  );

  /* Resolve the dye-lot batch each returned line drew in at GRN time so the
     return OUT consumes the EXACT PO/dye-lot it came from — not plain FIFO across
     a different lot. The source GRN's IN movement stamped batch_no = source PO
     number (migration 0120, keyed by warehouse+product+variant). We map each PR
     line → its source GRN (grn_item_id → grn_items.grn_id, else primary grnId),
     read those GRNs' IN movements, and match the bucket. Only sofa/batched lines
     resolve to a non-null batch; un-batched RM stays plain FIFO. Forward-compat:
     pre-0120 the column is absent → retry without it → every line un-batched. */
  const itemList = (items ?? []) as Array<{ id: string; grn_item_id?: string | null; material_code: string; material_name: string | null; qty_returned: number; item_group?: string | null; variants?: VariantAttrs | null }>;
  // PR line id → source GRN id (its own GRN line's GRN, else the primary GRN).
  const lineGrnId = new Map<string, string | null>();
  {
    const giIds = [...new Set(itemList.map((it) => it.grn_item_id ?? null).filter((x): x is string => !!x))];
    const giToGrn = new Map<string, string | null>();
    if (giIds.length > 0) {
      const { data: giRows } = await sb.from('grn_items').select('id, grn_id').in('id', giIds);
      for (const r of (giRows ?? []) as Array<{ id: string; grn_id: string | null }>) giToGrn.set(r.id, r.grn_id ?? null);
    }
    for (const it of itemList) {
      lineGrnId.set(it.id, (it.grn_item_id ? giToGrn.get(it.grn_item_id) : null) ?? grnId ?? null);
    }
  }
  // Read the IN movements of every source GRN, keyed `grnId::warehouse::code::variant` → batch_no.
  const batchByBucket = new Map<string, string>();
  {
    const srcGrnIds = [...new Set([...lineGrnId.values()].filter((x): x is string => !!x))];
    if (srcGrnIds.length > 0) {
      let inRes = await sb.from('inventory_movements')
        .select('source_doc_id, product_code, variant_key, warehouse_id, batch_no')
        .eq('source_doc_type', 'GRN').eq('movement_type', 'IN').in('source_doc_id', srcGrnIds);
      if (inRes.error && (inRes.error.message ?? '').includes('batch_no')) {
        inRes = { data: [], error: null } as typeof inRes;
      }
      for (const m of (inRes.data ?? []) as Array<{ source_doc_id: string; product_code: string; variant_key: string | null; warehouse_id: string; batch_no?: string | null }>) {
        if (m.batch_no == null) continue;
        batchByBucket.set(`${m.source_doc_id}::${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ''}`, m.batch_no);
      }
    }
  }

  const movements = itemList
    .filter((it) => it.qty_returned > 0)
    .map((it) => {
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) return null;
      const variantKey = computeVariantKey(it.item_group, it.variants ?? null);
      const srcGrn = lineGrnId.get(it.id) ?? null;
      const batchNo = srcGrn ? (batchByBucket.get(`${srcGrn}::${warehouseId}::${it.material_code}::${variantKey}`) ?? null) : null;
      return {
        movement_type: 'OUT' as const,
        warehouse_id: warehouseId,
        product_code: it.material_code,
        variant_key: variantKey,
        product_name: it.material_name,
        qty: it.qty_returned,
        source_doc_type: 'PURCHASE_RETURN' as const,
        source_doc_id: prId,
        source_doc_no: returnNumber,
        // Stamp the source GRN line's dye-lot batch so the FIFO trigger depletes
        // THAT PO/lot, not a different one. Only when the GRN IN had a batch.
        ...(batchNo ? { batch_no: batchNo } : {}),
        performed_by: userId,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  const movementErrors: string[] = [];
  if (movements.length > 0) {
    /* Capture the best-effort write result so the caller can surface a failed
       stock OUT (was silently swallowed — PR created with stock NOT returned to
       the supplier and the caller never told). No rollback; just make it loud. */
    const res = await writeMovements(sb, movements, prCompanyId);
    if (!res.ok) movementErrors.push(`OUT ${returnNumber}: ${res.reason ?? 'unknown'}`);
    /* PR post = stock OUT to supplier → other READY SOs that needed it may
       regress. Re-walk SO allocation. Best-effort. */
    try {
      const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
      await recomputeSoStockAllocation(sb);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-pr-post failed:', e); }
  }
  return movementErrors;
}

/* ── checkPrStockAvailability (audit gap #7) ─────────────────────────────────
   On-hand floor for the supplier-return OUT. A Purchase Return writes an
   inventory OUT (goods leave to the supplier), so — exactly like the DO ship
   side (check-stock-availability) — verify the SOURCE warehouse actually holds
   the returned qty BEFORE the OUT, instead of letting a PR silently drive stock
   negative with no prompt. Soft-waivable: the caller 409s short_stock unless
   confirmShortStock is set (the shared FE authedFetch wrapper renders the
   shortage, asks "return anyway? (stock goes negative)", and retries with the
   flag) — the same house pattern the DO ship paths use, so a legitimate return
   of in-stock goods passes straight through with no prompt.

   PR lines can span warehouses (a batched /from-grns pulls from each line's
   source-GRN warehouse), so resolve each line's warehouse via the SAME
   resolvePrLineWarehouses the OUT uses, group requests per warehouse, and run
   the shared checkStockAvailability once per warehouse, combining shortages.
   Lines whose warehouse can't be resolved are skipped here — the OUT skips them
   too (writePurchaseReturnMovements drops a null-warehouse line). */
async function checkPrStockAvailability(
  sb: any,
  lines: Array<{
    id: string; grn_item_id?: string | null; material_code: string;
    material_name?: string | null; item_group?: string | null;
    variants?: VariantAttrs | null; qty: number;
  }>,
  headerGrnId: string | null,
  companyId: number | undefined,
): Promise<StockShortage[]> {
  const active = lines.filter((l) => Number(l.qty) > 0);
  if (active.length === 0) return [];
  const lineWh = await resolvePrLineWarehouses(
    sb, active.map((l) => ({ id: l.id, grn_item_id: l.grn_item_id ?? null })), headerGrnId, companyId,
  );
  const byWh = new Map<string, StockLineRequest[]>();
  for (const l of active) {
    const wh = lineWh.get(l.id) ?? null;
    if (!wh) continue; // no warehouse resolved → the OUT skips this line too
    const arr = byWh.get(wh) ?? [];
    arr.push({
      itemCode: l.material_code,
      productName: l.material_name ?? null,
      variantKey: computeVariantKey(l.item_group ?? null, l.variants ?? null),
      qty: Number(l.qty),
    });
    byWh.set(wh, arr);
  }
  const shortages: StockShortage[] = [];
  for (const [wh, reqs] of byWh) {
    shortages.push(...(await checkStockAvailability(sb, wh, reqs)));
  }
  return shortages;
}

/* ── writePrLineDeltaMovement (Commander 2026-06-01, audit fix #5) ───────────
   The create path writes the inventory OUT for every initial line, but line
   CRUD after create (add / edit qty / delete) used to touch only
   grn_items.returned_qty and the money rollup — never the physical inventory.
   So editing a PR line's qty (10→2) or deleting it left the original OUT
   standing and desynced stock from returned_qty permanently. This writes the
   single-line delta movement so add/increase = more OUT, reduce/delete =
   compensating IN. deltaQty>0 → OUT (more goods leave to supplier); deltaQty<0
   → IN (goods come back). Resolves the line's source-GRN warehouse exactly
   like the create path. Best-effort: never throws (mirrors writeMovements).

   RETURNS the create path's `movementErrors` shape — `string[]`, one
   `OUT|IN <returnNumber>: <reason>` per failure, exactly what
   writePurchaseReturnMovements produces. It used to return void, so the
   three line verbs had nothing to report even though the failure was known
   here; see their response comments. */
async function writePrLineDeltaMovement(
  sb: any,
  args: {
    prId: string; returnNumber: string; headerGrnId: string | null; userId: string;
    companyId: number | undefined;
    line: { id: string; grn_item_id?: string | null; material_code: string;
            material_name: string | null; item_group?: string | null; variants?: VariantAttrs | null };
    deltaQty: number;
  },
): Promise<string[]> {
  if (!args.deltaQty) return [];
  const isOut = args.deltaQty > 0;
  const dir = isOut ? 'OUT' : 'IN';
  /* Set the moment writeMovements confirms the insert. A throw AFTER that point
     comes from a best-effort follow-up (retro-cost, SO re-allocation), and
     reporting it as a failed stock write would be a different lie than the one
     being fixed — the ledger did move. */
  let wrote = false;
  try {
    const lineWh = await resolvePrLineWarehouses(
      sb, [{ id: args.line.id, grn_item_id: args.line.grn_item_id ?? null }], args.headerGrnId, args.companyId,
    );
    const warehouseId = lineWh.get(args.line.id) ?? null;
    /* No warehouse resolved → no movement is ATTEMPTED, and the create path
       drops the same line silently (writePurchaseReturnMovements filters it out
       and reports nothing). Same concept, same shape: do not invent a second
       error class here. */
    if (!warehouseId) return [];
    const variantKey = computeVariantKey(args.line.item_group, args.line.variants ?? null);
    // Batch: resolve THIS line's OWN dye-lot deterministically from its source GRN
    // line's PO (grn_item_id → purchase_order_item_id → PO number). Not a .limit(1)
    // bucket lookup, which could grab a sibling line's batch when two lines of the
    // same product/variant came from different POs.
    let batchNo: string | null = null;
    if (args.line.grn_item_id) {
      const { data: gi } = await sb.from('grn_items')
        .select('purchase_order_item_id').eq('id', args.line.grn_item_id).maybeSingle();
      const poItemId = (gi as { purchase_order_item_id: string | null } | null)?.purchase_order_item_id ?? null;
      if (poItemId) batchNo = (await resolvePoBatchByItem(sb, [poItemId])).get(poItemId) ?? null;
    }
    // Cost (reversing IN only): the PR OUT's stamped cost for this bucket so stock
    // re-enters at its real basis, not zero.
    let unitCostSen = 0;
    if (!isOut) {
      const inRes = await sb.from('inventory_movements')
        .select('unit_cost_sen')
        .eq('source_doc_type', 'PURCHASE_RETURN').eq('source_doc_id', args.prId)
        .eq('movement_type', 'OUT').eq('warehouse_id', warehouseId)
        .eq('product_code', args.line.material_code).eq('variant_key', variantKey)
        .limit(1);
      const row = ((inRes.data ?? []) as Array<{ unit_cost_sen?: number | null }>)[0];
      unitCostSen = Number(row?.unit_cost_sen ?? 0);
    }
    // Multi-company: the delta movement inherits the PR header's company.
    const { data: prHeader } = await sb.from('purchase_returns')
      .select('company_id').eq('id', args.prId).maybeSingle();
    const deltaRows: Parameters<typeof writeMovements>[1] = [{
      movement_type: isOut ? 'OUT' : 'IN',
      warehouse_id: warehouseId,
      product_code: args.line.material_code,
      variant_key: variantKey,
      product_name: args.line.material_name,
      qty: Math.abs(args.deltaQty),
      ...(isOut ? {} : { unit_cost_sen: unitCostSen }),
      ...(batchNo ? { batch_no: batchNo } : {}),
      source_doc_type: 'PURCHASE_RETURN' as const,
      source_doc_id: args.prId,
      source_doc_no: args.returnNumber,
      performed_by: args.userId,
      notes: isOut ? 'PR line added/increased' : 'PR line reduced/removed — reversing return',
    }];
    /* The result is READ, not dropped. writeMovements NEVER THROWS — it logs and
       returns `{ ok:false, reason }` (lib/inventory-movements.ts:188, "Never
       throws — returns true/false so callers can log without rolling back the
       post") — so the try/catch wrapping this whole function catches NOTHING
       from it. Discarding the result left the line edit fully applied
       (qty_returned, grn_items.returned_qty, the refund rollup) with the
       compensating stock movement missing and every caller answering 201/200:
       precisely the desync this function was written to end. The create path in
       this same file already captures it (:394) and its comment says why. */
    const movementCompanyId = (prHeader as { company_id?: number | null } | null)?.company_id ?? null;
    const res = await writeMovements(sb, deltaRows, movementCompanyId);
    if (!res.ok) {
      /* eslint-disable-next-line no-console */
      console.error('[pr-line-delta] stock movement NOT written — PR line changed, inventory did not:',
        args.returnNumber, 'line', args.line.id, dir, Math.abs(args.deltaQty), res.reason ?? 'unknown');
      /* Two durable traces, neither of which rolls the edit back — the shape the
         DO resync (delivery-orders-mfg.ts, resyncInventoryForDo) took from the
         GRN recount precedent (grns.ts postGrnAndRollup): a RECOUNT_FAILED row
         on the document's own trail, plus movementErrors on the response. The
         edit STANDS; an edit must not be rolled back for a ledger hiccup. */
      try {
        await recordEntityAudit(sb, {
          entityType: 'PURCHASE_RETURN',
          entityId: args.prId,
          entityDocNo: args.returnNumber,
          action: 'RECOUNT_FAILED',
          companyId: movementCompanyId ?? args.companyId ?? null,
          source: 'writePrLineDeltaMovement',
          note:
            `Line change committed on this return but its ${dir} delta movement ` +
            `(qty ${Math.abs(args.deltaQty)}, line ${args.line.id}) was NOT written: ${res.reason ?? 'unknown'}. ` +
            `The ledger does not reflect this change until /inventory/reconcile repairs it.`,
        });
      } catch { /* the trail is the backstop, not another way to lose the edit */ }
      return [`${dir} ${args.returnNumber}: ${res.reason ?? 'unknown'}`];
    }
    wrote = true;
    /* Oversell retro-cost (0154) — a REVERSING delta is an IN: the goods never
       went back to the supplier, so they re-open a lot a prior "ship anyway" DO
       can be costed from. Wired 2026-07-29; before that only a GRN reconciled
       (COE §2). The OUT direction is filtered out by the helper. Best-effort.
       Gated on the write having landed, like all four sibling call sites
       (purchase-consignment-returns :199, purchase-consignment-receives :207,
       consignment-notes :379, consignment-returns :383) — there is no arriving
       lot to reconcile against when the IN was refused. */
    await reconcileUncostedAfterIn(sb, deltaRows, args.userId);
    try {
      const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
      await recomputeSoStockAllocation(sb);
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-pr-line-delta failed:', e); }
    return [];
  } catch (e) {
    /* eslint-disable-next-line no-console */
    console.error('[pr-line-delta] movement failed:', e);
    /* Reported only when the write was never confirmed — see `wrote` above. */
    return wrote ? [] : [`${dir} ${args.returnNumber}: ${(e as Error)?.message ?? 'unknown'}`];
  }
}

purchaseReturns.post('/', async (c) => {
  /* company-scope: the source GRN is checked against the active company below
     (header grnId AND every line's grn_item_id, via isCrossCompanySource), and
     the only by-id write is the ROLLBACK of the header this handler inserted
     moments earlier. Verified 2026-08-13. */
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (body.status === 'DRAFT') return c.json({ error: 'draft_status_not_supported', message: 'DRAFT was removed in migration 0078 — PRs post immediately on create.' }, 400);
  if (!body.supplierId) return c.json({ error: 'supplier_required' }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: 'items_required' }, 400);

  const sb = c.get('supabase'); const user = c.get('user');

  /* CROSS-COMPANY SOURCE (lib/companyScope) — the bare-create path takes the
     source GRN as a body field, and everything below stamps the ACTIVE company:
     the header, the lines (stampCompany), and the inventory OUT
     (writePurchaseReturnMovements uses the PR header's company). A grnId from
     the other company therefore produces this company's return against that
     company's receipt. Optional by design — a genuinely manual return sends no
     grnId, resolves to no source, and is unaffected. */
  if (body.grnId) {
    const { data: srcGrn } = await sb.from('grns')
      .select('grn_number, company_id').eq('id', body.grnId as string).maybeSingle();
    const src = srcGrn as { grn_number?: string | null; company_id?: number | null } | null;
    if (src && isCrossCompanySource(src.company_id, c)) {
      return c.json(crossCompanyConversionBlocked(src.grn_number ?? null, src.company_id, c), 409);
    }
  }

  /* "Manual lines (no grnItemId) stay uncapped" — true, and the same back door
     the delivery side had. An unlinked line on a return that NAMES a GRN still
     sends the stock OUT while moving no grn_items.returned_qty, so the same
     goods can be returned again and the guard below never sees it. Refused only
     when the named GRN already contains that material, so a genuinely manual
     return line still passes. See docs/unlinked-line-duplicate-coe.md. */
  {
    const unlinked = await findUnlinkedPrLines(
      sb,
      (body.grnId as string | undefined) ?? null,
      (body.grnNumber as string | undefined) ?? null,
      items.map((it, idx) => ({
        lineRef: String(idx),
        itemCode: String(it.materialCode ?? ''),
        qty: Number(it.qtyReturned ?? it.qty ?? 0),
        soItemId: (it.grnItemId as string | undefined) ?? null,
      })),
    );
    if (unlinked.length > 0) return c.json(unlinkedReturnResponse(unlinked, 'purchase'), 409);
  }

  /* Audit gap #7 — REJECT a GRN-linked over-return with the SAME 409 the
     add-line path (`POST /:id/items`) returns, instead of the old silent
     Math.min clamp. Clamping quietly shrank the operator's number and hid the
     mistake; the add-line path already 409s `qty_exceeds_remaining`, so the
     bare-create path now behaves identically. remaining = qty_accepted -
     returned_qty. Manual lines (no grnItemId) stay uncapped. */
  const preGrnItemIds = [...new Set(items
    .map((it) => (it.grnItemId as string | undefined) ?? null)
    .filter((x): x is string => !!x))];
  const remainingByGrnItem = new Map<string, number>();
  if (preGrnItemIds.length > 0) {
    /* The parent GRN rides the embed for the cross-company guard: these
       grn_item ids are caller-supplied, and adjustGrnReturnedQty writes
       returned_qty on whichever company owns them while the return itself is
       stamped with the ACTIVE company. The header-level grnId check above only
       covers the note the return NAMES; a line can point somewhere else. */
    const { data: giRows } = await sb.from('grn_items')
      .select('id, qty_accepted, returned_qty, grn:grns!inner ( grn_number, company_id )').in('id', preGrnItemIds);
    type GiRow = {
      id: string; qty_accepted: number; returned_qty: number;
      grn?: { grn_number?: string | null; company_id?: number | null } | Array<{ grn_number?: string | null; company_id?: number | null }> | null;
    };
    const giList = (giRows ?? []) as unknown as GiRow[];
    const parentOf = (g: GiRow) => (Array.isArray(g.grn) ? g.grn[0] : g.grn) ?? null;
    const foreign = giList.find((g) => isCrossCompanySource(parentOf(g)?.company_id, c));
    if (foreign) {
      const p = parentOf(foreign);
      return c.json(crossCompanyConversionBlocked(p?.grn_number ?? null, p?.company_id, c), 409);
    }
    for (const r of giList) {
      remainingByGrnItem.set(r.id, Math.max(0, (r.qty_accepted ?? 0) - (r.returned_qty ?? 0)));
    }
  }
  for (const it of items) {
    const grnItemId = (it.grnItemId as string | undefined) ?? null;
    if (!grnItemId || !remainingByGrnItem.has(grnItemId)) continue;
    const requested = Number(it.qtyReturned ?? 0);
    const remaining = remainingByGrnItem.get(grnItemId) as number;
    if (requested > remaining) {
      return c.json({ error: 'qty_exceeds_remaining', requested, remaining }, 409);
    }
  }

  let totalRefund = 0;
  const itemRows = items.map((it) => {
    const grnItemId = (it.grnItemId as string | undefined) ?? null;
    const qty = Number(it.qtyReturned ?? 0);
    const unit = Number(it.unitPriceCenti ?? 0);
    // Refund follows the returned qty (a return has no discount).
    const lineRefund = qty * unit;
    totalRefund += lineRefund;
    return {
      grn_item_id: grnItemId,
      material_kind: it.materialKind,
      material_code: it.materialCode,
      material_name: it.materialName,
      qty_returned: qty,
      unit_price_centi: unit,
      line_refund_centi: lineRefund,
      reason: (it.reason as string | undefined) ?? null,
      notes: (it.notes as string | undefined) ?? null,
      // Commander 2026-05-29 — persist category + variants (columns exist;
      // writePurchaseReturnMovements reads them for the inventory-OUT
      // variant_key) so a Purchase Return mirrors WHAT was returned, like GRN/PI.
      item_group: (it.itemGroup as string | null | undefined) ?? null,
      variants: (it.variants as Record<string, unknown> | null | undefined) ?? null,
    };
  }).filter((r) => Number(r.qty_returned) > 0);

  if (itemRows.length === 0) {
    return c.json({ error: 'no_returnable_qty', message: 'Every line is already fully returned (nothing left to return).' }, 400);
  }

  /* PR-DRAFT-removal — PR is created POSTED, inventory OUT written inline. */
  const grnId = (body.grnId as string | undefined) ?? null;

  /* Audit gap #7 — on-hand floor. The PR posts its inventory OUT inline below;
     verify the source warehouse holds the returned qty FIRST (soft-waivable via
     confirmShortStock, mirroring the DO ship side) so a return can't silently
     drive stock negative. Synthetic ids feed the per-line warehouse resolver
     (rows aren't inserted yet). */
  if (!(body.confirmShortStock as boolean | undefined)) {
    const shortages = await checkPrStockAvailability(
      sb,
      itemRows.map((r, idx) => ({
        id: `new-${idx}`,
        grn_item_id: r.grn_item_id,
        material_code: String(r.material_code),
        material_name: (r.material_name as string | null | undefined) ?? null,
        item_group: r.item_group,
        variants: r.variants as VariantAttrs | null,
        qty: Number(r.qty_returned),
      })),
      grnId,
      activeCompanyId(c),
    );
    if (shortages.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(shortStockResponse(shortages), 409);
    }
  }

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('purchase_returns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    return_number: returnNumber,
    purchase_order_id: (body.purchaseOrderId as string | undefined) ?? null,
    grn_id: grnId,
    supplier_id: body.supplierId,
    return_date: (body.returnDate as string) ?? todayMyt(),
    reason: (body.reason as string | undefined) ?? null,
    refund_centi: totalRefund,
    notes: (body.notes as string | undefined) ?? null,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select(HEADER).single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const rowsWithId = itemRows.map((r) => ({ ...r, purchase_return_id: h.id }));
  const { error: iErr } = await sb.from('purchase_return_items').insert(stampCompany(rowsWithId, c));
  if (iErr) {
    await sb.from('purchase_returns').delete().eq('id', h.id);
    return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  }

  const movementErrors = await writePurchaseReturnMovements(sb, h.id, h.return_number, grnId, user.id);

  /* Audit fix #3 — consume each GRN-linked line's returned_qty (0106). The
     bare-create path never did this, so a PR raised here didn't net down the
     source GRN line / PO received_qty — only /from-grns and /from-grn did.
     Now parity: every GRN-linked line increments returned_qty by its (clamped)
     returned qty. Manual lines (no grn_item_id) are skipped. */
  for (const r of itemRows) {
    if (r.grn_item_id) await adjustGrnReturnedQty(sb, r.grn_item_id, Number(r.qty_returned));
  }

  return c.json({ id: h.id, returnNumber: h.return_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
});

// Batch-convert multiple POSTED GRNs into ONE Purchase Return. Aggregates
// all qty_rejected lines across the selected GRNs (must share a supplier).
/* Exported so the company-scope tests can drive it without the supabaseAuth
   bridge, which cannot run in the vitest harness. Same reason
   createPurchaseInvoiceFromGrnHandler and createPcReturnFromPcReceivesHandler
   are exported; the route registration below is unchanged. */
export const createPurchaseReturnFromGrnsHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: both source reads below are SCOPED, so another company's GRN
     is not visible here at all; the by-id write is this handler's own rollback. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { grnIds?: string[]; reason?: string; notes?: string; confirmShortStock?: boolean };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const grnIds = body.grnIds ?? [];
  if (grnIds.length === 0) return c.json({ error: 'grn_ids_required' }, 400);

  /* SOURCE LOAD, SCOPED — the grnIds arrive in the request body, so this is the
     read that decides which receipts this conversion can see. Scoped, so another
     company's GRN id resolves to NO ROW and falls out at `grns_not_found`.
     REPLACED an isCrossCompanySource loop that ran right after this load and can
     no longer fire: grnList, and the GRN-item read further down (keyed on the
     same grnIds), now contain only this company's rows.

     THE COST: a hand-crafted request naming the other company's receipt gets
     `grns_not_found` instead of "that receipt belongs to 2990, switch company" —
     the same trade the PO's /:id/convert-from-so records, and taken for the same
     reason: naming the other company would require an UNSCOPED read of a
     document this handler otherwise never touches. */
  const { data: grns, error: grnErr } = await scopeToCompany(sb.from('grns')
    .select('id, grn_number, supplier_id, purchase_order_id, status, company_id')
    .in('id', grnIds), c);
  if (grnErr) return c.json({ error: 'load_failed', reason: grnErr.message }, 500);
  const grnList = (grns ?? []) as Array<{ id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; company_id?: number | null }>;
  if (grnList.length === 0) return c.json({ error: 'grns_not_found' }, 404);

  const notPosted = grnList.filter((g) => g.status !== 'POSTED');
  if (notPosted.length > 0) {
    return c.json({ error: 'not_all_posted', message: `These GRNs are not POSTED: ${notPosted.map((g) => g.grn_number).join(', ')}` }, 400);
  }
  const supplierIds = new Set(grnList.map((g) => g.supplier_id));
  if (supplierIds.size > 1) {
    return c.json({ error: 'mixed_suppliers', message: 'All selected GRNs must be from the same supplier' }, 400);
  }
  const supplierId = [...supplierIds][0]!;

  /* Load rejected items across all GRNs. LINE-level half of the same source
     document — same predicate as the header read above, because
     `.in('grn_id', grnIds)` is itself an id-keyed read and that is the shape
     this sweep exists for. */
  const { data: items } = await scopeToCompany(sb.from('grn_items')
    .select('id, grn_id, material_kind, material_code, material_name, qty_accepted, qty_rejected, returned_qty, rejection_reason, unit_price_centi, item_group, variants, description, description2, uom')
    .in('grn_id', grnIds)
    .gt('qty_rejected', 0), c);
  // Cap each line's return at its remaining (qty_accepted - returned_qty, 0106) —
  // a GRN line can be returned across multiple PRs. Drop lines already fully
  // returned. We return min(qty_rejected, remaining).
  const rejectedItems = ((items ?? []) as Array<{
    id: string; grn_id: string; material_kind: string; material_code: string; material_name: string;
    qty_accepted: number; qty_rejected: number; returned_qty: number; rejection_reason: string | null; unit_price_centi: number;
    item_group: string | null; variants: Record<string, unknown> | null; description: string | null; description2: string | null; uom: string | null;
  }>)
    .map((it) => {
      const remaining = (it.qty_accepted ?? 0) - (it.returned_qty ?? 0);
      return { ...it, _qty: Math.min(it.qty_rejected ?? 0, Math.max(0, remaining)) };
    })
    .filter((it) => it._qty > 0);
  if (rejectedItems.length === 0) {
    return c.json({ error: 'no_rejected_qty', message: 'None of the selected GRNs have remaining rejected qty to return' }, 400);
  }

  // Generate PR number.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  // Minted inside insertWithDocNoRetry below so a concurrent-create collision
  // (23505 on return_number) re-derives the next free number instead of 500ing.
  const p = companyDocPrefix(c);
  const nextPrtNumber = async (): Promise<string> =>
    mintMonthlyDocNo(sb, 'purchase_returns', 'return_number', `${p}PRT-${yymm}`);

  const grnNumbersJoined = grnList.map((g) => g.grn_number).join(', ');
  const totalRefund = rejectedItems.reduce((s, it) => s + (it._qty * it.unit_price_centi), 0);

  const primaryGrnId = grnList[0]!.id;

  /* Audit gap #7 — on-hand floor before the inventory OUT (soft-waivable via
     confirmShortStock, mirroring the DO ship side). Each line draws OUT of its
     source-GRN warehouse (grn_item_id = the rejected line's id). */
  if (!body.confirmShortStock) {
    const shortages = await checkPrStockAvailability(
      sb,
      rejectedItems.map((it, idx) => ({
        id: `new-${idx}`,
        grn_item_id: it.id,
        material_code: it.material_code,
        material_name: it.material_name,
        item_group: it.item_group,
        variants: (it.variants as VariantAttrs | null) ?? null,
        qty: it._qty,
      })),
      primaryGrnId,
      activeCompanyId(c),
    );
    if (shortages.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(shortStockResponse(shortages), 409);
    }
  }

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; return_number: string }>(
    nextPrtNumber,
    (returnNumber) => sb.from('purchase_returns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    return_number: returnNumber,
    purchase_order_id: grnList[0]!.purchase_order_id,
    grn_id: primaryGrnId,                              // primary GRN ref
    supplier_id: supplierId,
    return_date: todayMyt(),
    reason: body.reason ?? `Batch from ${grnList.length} GRNs: ${grnNumbersJoined}`,
    refund_centi: totalRefund,
    notes: body.notes ?? null,
    /* PR-DRAFT-removal — auto-POSTED on create. */
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select('id, return_number').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const rows = rejectedItems.map((it) => ({
    purchase_return_id: h.id,
    grn_item_id: it.id,
    material_kind: it.material_kind,
    material_code: it.material_code,
    material_name: it.material_name,
    qty_returned: it._qty,
    unit_price_centi: it.unit_price_centi,
    line_refund_centi: it._qty * it.unit_price_centi,
    reason: it.rejection_reason,
    item_group: it.item_group,
    variants: it.variants,
    description: it.description,
    description2: it.description2 ?? (buildVariantSummary(String(it.item_group ?? ''), it.variants ?? null) || null),
    uom: it.uom ?? 'UNIT',
  }));
  const { error: iErr } = await sb.from('purchase_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('purchase_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  // Consume each GRN line: increment returned_qty by the returned qty (0106).
  for (const it of rejectedItems) {
    await adjustGrnReturnedQty(sb, it.id, it._qty);
  }

  const movementErrors = await writePurchaseReturnMovements(sb, h.id, h.return_number, primaryGrnId, user.id);

  return c.json({ id: h.id, returnNumber: h.return_number, grnCount: grnList.length, lineCount: rejectedItems.length, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
purchaseReturns.post('/from-grns', createPurchaseReturnFromGrnsHandler);

/* ── POST /from-grn ─────────────────────────────────────────────────────
   Single-GRN convert (GRN list right-click "Convert to PR"). Unlike
   /from-grns (which only copies REJECTED qty across many GRNs), this copies
   ALL of the GRN's accepted lines into a NEW Purchase Return so the user can
   then trim qty in the PR draft. Returns the created PR's { id } to navigate to.

   Body: { grnId, reason?, notes? }  →  201 { id, returnNumber }. */
/* Exported so the company-scope tests can drive it without the supabaseAuth
   bridge, which cannot run in the vitest harness. Same reason
   createPurchaseInvoiceFromGrnHandler and createPcReturnFromPcReceiveHandler
   are exported; the route registration below is unchanged. */
export const createPurchaseReturnFromGrnHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: both source reads below are SCOPED, so another company's GRN
     is not visible here at all; the remaining by-id statements read that same
     GRN's own lines and roll back this handler's own header. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { grnId?: string; reason?: string; notes?: string; confirmShortStock?: boolean };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const grnId = body.grnId;
  if (!grnId) return c.json({ error: 'grn_id_required' }, 400);

  /* SOURCE LOAD, SCOPED — grnId arrives in the request body, so this is the read
     that decides what this conversion can see. Scoped, so another company's GRN
     resolves to NO ROW and falls out at `grn_not_found`.
     REPLACED an isCrossCompanySource comparison that sat right after this load
     and can no longer fire.

     THE COST: a hand-crafted request naming the other company's receipt gets
     `grn_not_found` instead of "that receipt belongs to 2990, switch company" —
     same trade, same reason, as the PO's /:id/convert-from-so: naming the other
     company would require an UNSCOPED read of a document this handler otherwise
     never touches. */
  const { data: grn, error: grnErr } = await scopeToCompany(sb.from('grns')
    .select('id, grn_number, supplier_id, purchase_order_id, status, company_id')
    .eq('id', grnId), c).maybeSingle();
  if (grnErr) return c.json({ error: 'load_failed', reason: grnErr.message }, 500);
  if (!grn) return c.json({ error: 'grn_not_found' }, 404);
  const g = grn as { id: string; grn_number: string; supplier_id: string; purchase_order_id: string | null; status: string; company_id?: number | null };
  if (g.status !== 'POSTED') return c.json({ error: 'grn_not_posted', status: g.status }, 409);

  // LINE-level half of the same source document, under the same predicate.
  const { data: items } = await scopeToCompany(sb.from('grn_items')
    .select('id, material_kind, material_code, material_name, qty_accepted, qty_rejected, returned_qty, rejection_reason, unit_price_centi, item_group, variants, description, description2, uom')
    .eq('grn_id', grnId)
    .gt('qty_accepted', 0), c);
  const allLines = ((items ?? []) as Array<{
    id: string; material_kind: string; material_code: string; material_name: string;
    qty_accepted: number; qty_rejected: number; returned_qty: number; rejection_reason: string | null; unit_price_centi: number;
    item_group: string | null; variants: Record<string, unknown> | null; description: string | null; description2: string | null; uom: string | null;
  }>);
  // Only copy lines with remaining = qty_accepted - returned_qty > 0, and return
  // the REMAINING qty (a GRN can be returned across multiple PRs, 0106).
  const lines = allLines
    .map((it) => ({ ...it, _remaining: (it.qty_accepted ?? 0) - (it.returned_qty ?? 0) }))
    .filter((it) => it._remaining > 0);
  if (lines.length === 0) return c.json({ error: 'nothing_to_return', message: 'GRN is fully returned' }, 400);

  /* Audit gap #7 — on-hand floor before the inventory OUT (soft-waivable via
     confirmShortStock, mirroring the DO ship side). */
  if (!body.confirmShortStock) {
    const shortages = await checkPrStockAvailability(
      sb,
      lines.map((it, idx) => ({
        id: `new-${idx}`,
        grn_item_id: it.id,
        material_code: it.material_code,
        material_name: it.material_name,
        item_group: it.item_group,
        variants: (it.variants as VariantAttrs | null) ?? null,
        qty: it._remaining,
      })),
      g.id,
      activeCompanyId(c),
    );
    if (shortages.length > 0) {
      markIdempotencyNoWrite(c);
      return c.json(shortStockResponse(shortages), 409);
    }
  }

  const totalRefund = lines.reduce((s, it) => s + (it._remaining * it.unit_price_centi), 0);

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('purchase_returns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    return_number: returnNumber,
    purchase_order_id: g.purchase_order_id,
    grn_id: g.id,
    supplier_id: g.supplier_id,
    return_date: todayMyt(),
    reason: body.reason ?? `From ${g.grn_number}`,
    refund_centi: totalRefund,
    notes: body.notes ?? null,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select('id, return_number').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const rows = lines.map((it) => ({
    purchase_return_id: h.id,
    grn_item_id: it.id,
    material_kind: it.material_kind,
    material_code: it.material_code,
    material_name: it.material_name,
    qty_returned: it._remaining,
    unit_price_centi: it.unit_price_centi,
    line_refund_centi: it._remaining * it.unit_price_centi,
    reason: it.rejection_reason,
    item_group: it.item_group,
    variants: it.variants,
    description: it.description,
    description2: it.description2 ?? (buildVariantSummary(String(it.item_group ?? ''), it.variants ?? null) || null),
    uom: it.uom ?? 'UNIT',
  }));
  const { error: iErr } = await sb.from('purchase_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('purchase_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  // Consume each GRN line: increment returned_qty by the returned remaining (0106).
  for (const it of lines) {
    await adjustGrnReturnedQty(sb, it.id, it._remaining);
  }

  const movementErrors = await writePurchaseReturnMovements(sb, h.id, h.return_number, g.id, user.id);
  // Refresh header refund_centi from the inserted lines (parity with GRN).
  await recomputePrTotals(sb, h.id);

  return c.json({ id: h.id, returnNumber: h.return_number, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
purchaseReturns.post('/from-grn', createPurchaseReturnFromGrnHandler);

purchaseReturns.patch('/:id/post', async (c) => {
  /* PR-DRAFT-removal — kept for backward compat; idempotent. POST handler
     now creates PRs as POSTED with inventory OUT already written. If the
     row is already POSTED we 200 without re-writing movements (would
     double-debit inventory). */
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(sb.from('purchase_returns').select('id, status, posted_at, return_number, grn_id').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const row = cur as { id: string; status: string; posted_at: string | null; return_number: string; grn_id: string | null };
  if (row.status === 'POSTED' || row.status === 'COMPLETED') {
    return c.json({ purchaseReturn: row });
  }
  return c.json({ error: 'cannot_post', message: `Cannot post a ${row.status} return.` }, 409);
});

// Exported for the lifecycle tests: supabaseAuth cannot run in the vitest
// harness, so the tests mount the handler rather than the router (same reason
// cancelPurchaseReturnHandler below is exported).
export const completePurchaseReturnHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { creditNoteRef?: string };
  try { body = (await c.req.json()) as typeof body; } catch { body = {}; }

  /* Tenancy gate BEFORE the state-guarded update, so a same-company return that
     just isn't POSTED still gets the "not posted" message, not a company miss. */
  const { data: owned } = await scopeToCompanyId(sb.from('purchase_returns').select('id').eq('id', id), co.companyId).maybeSingle();
  if (!owned) return c.json(NOT_THIS_COMPANY, 404);

  const updates: Record<string, unknown> = {
    status: 'COMPLETED',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (body.creditNoteRef) updates.credit_note_ref = body.creditNoteRef;

  /* maybeSingle, NOT single. The `.eq('status','POSTED')` gate makes a zero-row
     result the ORDINARY outcome for a DRAFT/COMPLETED/CANCELLED return, and
     PostgREST reports zero rows to `.single()` as PGRST116 — so `error` was set,
     the 500 above fired, and the `409 not_posted` below could never be reached.
     Same defect and same fix as stock-transfers.ts's cancel (`already_cancelled`
     was unreachable and a repeat cancel 500'd) and as the sibling
     purchase-consignment-returns.ts `/:id/complete`, which already uses
     maybeSingle for exactly this reason. */
  const { data, error } = await scopeToCompanyId(sb.from('purchase_returns').update(updates)
    .eq('id', id), co.companyId).eq('status', 'POSTED').select('id, status, completed_at').maybeSingle();
  if (error) return c.json({ error: 'complete_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_posted' }, 409);
  return c.json({ purchaseReturn: data });
};
purchaseReturns.patch('/:id/complete', completePurchaseReturnHandler);

/* ── PATCH /:id/cancel — cancel a PR + reverse its return ───────────────────
   Commander 2026-05-30 — the PR module is a Confirmed-clone of the PO module,
   including a Cancel action. A Purchase Return wrote inventory OUT on create
   (returning goods to the supplier reduces stock — see
   writePurchaseReturnMovements). Cancelling a PR:
     1. Sets status='CANCELLED' (idempotent — already-cancelled echoes back;
        a COMPLETED return cannot be cancelled).
     2. Reverses the inventory OUT: writes an IN movement per line for
        qty_returned (negating the original OUT), to the same warehouse the
        create path debited (GRN's warehouse_id, else default).
   Step 2 is best-effort (mirrors writePurchaseReturnMovements / the GRN cancel
   in grns.ts) — a movement failure does not un-cancel the PR. */
export const cancelPurchaseReturnHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const user = c.get('user');
  /* Surfaced in the response, the way the create path already surfaces
     movementErrors. A cancel that only PARTLY reversed its stock must not
     report a clean 200. */
  const reversalErrors: string[] = [];
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Read → guard → update → reverse (mirrors the GRN cancel's split).
  const { data: cur, error: readErr } = await scopeToCompanyId(sb.from('purchase_returns')
    .select('id, status, return_number, grn_id')
    .eq('id', id), co.companyId).maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const head = cur as { id: string; status: string; return_number: string; grn_id: string | null };
  if (head.status === 'COMPLETED') return c.json({ error: 'cannot_cancel', message: 'Already completed' }, 409);
  // Idempotent — already cancelled, echo back without re-reversing (would
  // double-credit inventory).
  if (head.status === 'CANCELLED') return c.json({ purchaseReturn: { id, status: 'CANCELLED' } });

  /* Bug #3/#11 — ATOMIC single ACTIVE→CANCELLED transition. The conditional
     UPDATE excludes COMPLETED and CANCELLED so two concurrent cancels race on
     the row and only ONE flips it (the other gets no row back → idempotent
     no-op), so the inventory IN reversal + returned_qty release below run
     exactly once, never double-crediting stock. */
  const { data: updRow, error: updErr } = await scopeToCompanyId(sb.from('purchase_returns').update({
    status: 'CANCELLED', updated_at: new Date().toISOString(),
  }).eq('id', id), co.companyId).neq('status', 'CANCELLED').neq('status', 'COMPLETED').select('id').maybeSingle();
  if (updErr) return c.json({ error: 'cancel_failed', reason: updErr.message }, 500);
  if (!updRow) {
    // Lost the race (already cancelled) or it became COMPLETED meanwhile.
    const { data: now } = await scopeToCompanyId(sb.from('purchase_returns').select('id, status').eq('id', id), co.companyId).maybeSingle();
    const st = (now as { status: string } | null)?.status;
    if (st === 'CANCELLED') return c.json({ purchaseReturn: { id, status: 'CANCELLED' } });
    if (st === 'COMPLETED') return c.json({ error: 'cannot_cancel', message: 'Already completed' }, 409);
    return c.json({ error: 'cannot_cancel' }, 409);
  }

  // Reverse the inventory OUT via the shared helper: it reads THIS PR's own OUT
  // movements and posts an opposite IN per bucket carrying the EXACT batch_no +
  // unit_cost_sen the OUT stamped — so a sofa return re-enters its dye-lot at the
  // real cost (not a zero-cost un-batched lot, the old bespoke bug). Idempotent
  // (signed-net-per-bucket) + per-line-warehouse aware via the original rows.
  // Best-effort; never un-cancel on a movement failure.
  try {
    const rev = await reverseMovements(sb, 'PURCHASE_RETURN', id, user.id);
    /* PARTIAL FAILURE IS REPORTED. reverseMovements inserts row by row on
       purpose ("so a single collision doesn't abort the whole reversal",
       inventory-movements.ts:571) and returns { ok, reversed, skipped, failed,
       reason }. Only `reversed > 0` was read, so reversed:3 / failed:2 entered
       the branch below and the handler returned a clean 200 - the cancel
       reported success while part of the stock never came back.

       The cancel still STANDS (a ledger hiccup must not un-cancel a document);
       what changes is that the caller is told. */
    if (!rev.ok) {
      reversalErrors.push(
        `Stock reversal incomplete: ${rev.reversed} reversed, ${rev.failed} failed` +
        (rev.reason ? ` (${rev.reason})` : '') +
        '. The return is cancelled; run /inventory/reconcile to repair the ledger.',
      );
    }
    if (rev.reversed > 0) {
      /* PR cancel reversed stock IN → may unlock PENDING SOs. Re-walk. */
      try {
        const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
        await recomputeSoStockAllocation(sb);
      } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-pr-cancel failed:', e); }
    }
  } catch { /* best-effort: never un-cancel on a movement failure */ }

  // Release the GRN-line consumption: decrement returned_qty for every
  // GRN-linked line (best-effort, mirrors the inventory reversal above). The
  // lines are reloaded so we know each line's qty_returned + grn_item_id.
  try {
    const { data: relLines } = await sb.from('purchase_return_items')
      .select('qty_returned, grn_item_id').eq('purchase_return_id', id);
    for (const l of (relLines ?? []) as Array<{ qty_returned: number; grn_item_id: string | null }>) {
      if (l.grn_item_id) await adjustGrnReturnedQty(sb, l.grn_item_id, -(l.qty_returned ?? 0));
    }
  } catch { /* best-effort */ }

  return c.json({
    purchaseReturn: { id, status: 'CANCELLED' },
    ...(reversalErrors.length ? { reversalErrors } : {}),
  });
};
purchaseReturns.patch('/:id/cancel', cancelPurchaseReturnHandler);

/* ════════════════════════════════════════════════════════════════════════
   PR PO-clone CRUD (PATCH header + line add / edit / delete) — mirrors the
   GRN detail page's confirmed/immediate-save editing (apps/api/src/routes/grns.ts).
   The editable line quantity is qty_returned; line_refund_centi =
   qty_returned * unit_price_centi (a return has no discount/delivery);
   recomputePrTotals rolls the header refund_centi.
   ════════════════════════════════════════════════════════════════════════ */

/* ── PATCH /:id — header update (mirror GRN's PATCH /:id) ── */
purchaseReturns.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of [
    ['supplierId', 'supplier_id'], ['returnDate', 'return_date'],
    ['reason', 'reason'], ['creditNoteRef', 'credit_note_ref'],
    ['notes', 'notes'],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data, error } = await scopeToCompanyId(sb.from('purchase_returns').update(updates).eq('id', id), co.companyId).select(HEADER).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ purchaseReturn: data });
});

/* ── POST /:id/items — add one purchase_return_item. qty → qty_returned. ── */
/* A CANCELLED / COMPLETED purchase return is terminal — its line CRUD now moves
   real inventory (writePrLineDeltaMovement), so editing a reversed PR would
   re-corrupt stock against an already-released returned_qty. Lock line edits to
   ACTIVE returns. */
async function prLineLock(sb: any, prId: string): Promise<{ error: string; message: string } | null> {
  const { data } = await sb.from('purchase_returns').select('status').eq('id', prId).maybeSingle();
  const st = (data as { status: string } | null)?.status;
  if (st === 'CANCELLED') return { error: 'pr_cancelled', message: 'This purchase return is cancelled — its lines can no longer be changed.' };
  if (st === 'COMPLETED') return { error: 'pr_completed', message: 'This purchase return is completed — its lines can no longer be changed.' };
  return null;
}

export const addPurchaseReturnItemHandler = async (c: any) => {
  const prId = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.materialCode) return c.json({ error: 'material_code_required' }, 400);
  if (!it.materialName) return c.json({ error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* The child is stamped with the active company; the parent it hangs off must
     be this company's too, or a line lands on another company's return. */
  const { data: parent } = await scopeToCompanyId(sb.from('purchase_returns').select('id').eq('id', prId), co.companyId).maybeSingle();
  if (!parent) return c.json(NOT_THIS_COMPANY, 404);
  { const lock = await prLineLock(sb, prId); if (lock) return c.json(lock, 409); }
  const qtyReturned = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const lineRefund = qtyReturned * unitPriceCenti;

  // GRN-linked line: cap qty at that GRN line's remaining (accepted - returned).
  const grnItemId = (it.grnItemId as string) ?? null;
  if (grnItemId) {
    const capLock = await qtyCapRefusal(sb, {
      table: 'grn_items', id: grnItemId,
      capColumn: 'qty_accepted', drawnColumns: ['returned_qty'],
      requested: qtyReturned, what: 'GRN line',
    });
    if (capLock) return c.json(capLock, 409);
  }

  const row: Record<string, unknown> = {
    purchase_return_id: prId,
    grn_item_id: grnItemId,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    material_code: it.materialCode,
    material_name: it.materialName,
    // PR line money meaning: qty = qty_returned; total = qty * unit price.
    qty_returned: qtyReturned,
    unit_price_centi: unitPriceCenti,
    line_refund_centi: lineRefund,
    reason: (it.reason as string) ?? null,
    notes: (it.notes as string) ?? null,
    /* variant fields (mirror GRN/PO line) */
    gap_inches: (it.gapInches as number) ?? null,
    divan_height_inches: (it.divanHeightInches as number) ?? null,
    divan_price_sen: Number(it.divanPriceSen ?? 0),
    leg_height_inches: (it.legHeightInches as number) ?? null,
    leg_price_sen: Number(it.legPriceSen ?? 0),
    custom_specials: (it.customSpecials as unknown) ?? null,
    line_suffix: (it.lineSuffix as string) ?? null,
    special_order_price_sen: Number(it.specialOrderPriceSen ?? 0),
    variants: (it.variants as unknown) ?? null,
    item_group: (it.itemGroup as string) ?? null,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
    uom: (it.uom as string) ?? 'UNIT',
  };
  const { data, error } = await sb.from('purchase_return_items').insert({ company_id: activeCompanyId(c), ...row }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  /* Bug #3/#11 — POST-INSERT over-return verification. The pre-check is a
     read-then-write race: two concurrent adds against the same GRN line can each
     read remaining and both insert → over-returned. After committing, re-read
     the GRN line's accepted + the LIVE sum of qty_returned across all
     non-cancelled PR lines for it; if returned now exceeds accepted, OUR insert
     broke the cap → delete it + 409. (Fully DB-atomic needs an RPC — see report.) */
  if (grnItemId) {
    const inserted = data as unknown as { id: string } | null;
    const { data: gi } = await sb.from('grn_items')
      .select('qty_accepted').eq('id', grnItemId).maybeSingle();
    if (gi) {
      const cap = (gi as { qty_accepted: number }).qty_accepted ?? 0;
      const { data: sib } = await sb.from('purchase_return_items')
        .select('qty_returned, purchase_return_id').eq('grn_item_id', grnItemId);
      const sibRows = (sib ?? []) as Array<{ qty_returned: number; purchase_return_id: string }>;
      const prIds = [...new Set(sibRows.map((r) => r.purchase_return_id))];
      const cancelled = new Set<string>();
      if (prIds.length > 0) {
        const { data: prs } = await sb.from('purchase_returns').select('id, status').in('id', prIds);
        for (const p of (prs ?? []) as Array<{ id: string; status: string }>) {
          if (p.status === 'CANCELLED') cancelled.add(p.id);
        }
      }
      const liveReturned = sibRows
        .filter((r) => !cancelled.has(r.purchase_return_id))
        .reduce((s, r) => s + Number(r.qty_returned ?? 0), 0);
      if (liveReturned > cap && inserted?.id) {
        await sb.from('purchase_return_items').delete().eq('id', inserted.id);
        return c.json({ error: 'qty_exceeds_remaining', requested: qtyReturned, remaining: cap - (liveReturned - qtyReturned) }, 409);
      }
    }
  }

  // Consume the GRN line if this PR line is GRN-linked (manual lines consume
  // nothing). Increment returned_qty by the new line's qty.
  if (grnItemId) await adjustGrnReturnedQty(sb, grnItemId, qtyReturned);
  await recomputePrTotals(sb, prId);

  /* Audit fix #5 — write the inventory OUT for the newly added line. Without
     this, adding a line to a POSTED PR touched returned_qty + money but never
     the physical stock, leaving inventory permanently over the books. */
  let movementErrors: string[] = [];
  if (qtyReturned > 0) {
    const { data: hdr } = await sb.from('purchase_returns')
      .select('return_number, grn_id').eq('id', prId).maybeSingle();
    const inserted = data as unknown as { id: string } | null;
    if (hdr && inserted?.id) {
      movementErrors = await writePrLineDeltaMovement(sb, {
        prId,
        returnNumber: (hdr as { return_number: string }).return_number,
        headerGrnId: (hdr as { grn_id: string | null }).grn_id ?? null,
        userId: c.get('user').id,
        companyId: activeCompanyId(c),
        line: {
          id: inserted.id,
          grn_item_id: grnItemId,
          material_code: String(it.materialCode),
          material_name: (it.materialName as string | null) ?? null,
          item_group: (it.itemGroup as string | null) ?? null,
          variants: (it.variants as VariantAttrs | null) ?? null,
        },
        deltaQty: qtyReturned,
      });
    }
  }
  /* REPORTED, not discarded — the same `movementErrors: string[]` the CREATE
     path (POST /) returns. This returned a clean 201 while the line's stock OUT
     was refused, so qty_returned, grn_items.returned_qty and the refund rollup
     all moved with no compensating movement and the operator was told it
     worked. The line STAYS (best-effort ledger, as everywhere on these paths). */
  return c.json({ item: data, movementErrors: movementErrors.length ? movementErrors : undefined }, 201);
};
purchaseReturns.post('/:id/items', addPurchaseReturnItemHandler);

/* ── PATCH /:id/items/:itemId — partial line update. qty → qty_returned. ── */
export const patchPurchaseReturnItemHandler = async (c: any) => {
  const prId = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  { const lock = await prLineLock(sb, prId); if (lock) return c.json(lock, 409); }

  /* Audit 2026-06-11 M10 — scope the line to THIS PR: a mismatched itemId
     must 404, not edit another PR's line while the GRN release / stock
     movement / recompute run against this one. */
  const { data: prev } = await scopeToCompanyId(sb.from('purchase_return_items')
    .select('qty_returned, unit_price_centi, item_group, variants, grn_item_id, material_code, material_name')
    .eq('id', itemId).eq('purchase_return_id', prId), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);

  // The editable quantity is qty_returned.
  const prevQty = (prev as { qty_returned: number }).qty_returned;
  const grnItemId = (prev as { grn_item_id: string | null }).grn_item_id ?? null;
  const qtyReturned = it.qty !== undefined ? Number(it.qty) : prevQty;
  const unit = it.unitPriceCenti !== undefined ? Number(it.unitPriceCenti) : (prev as { unit_price_centi: number }).unit_price_centi;
  const lineRefund = qtyReturned * unit;

  const updates: Record<string, unknown> = {
    qty_returned: qtyReturned,
    unit_price_centi: unit,
    line_refund_centi: lineRefund,
  };
  for (const [from, to] of [
    ['materialCode', 'material_code'], ['materialName', 'material_name'],
    ['itemGroup', 'item_group'], ['description', 'description'], ['uom', 'uom'],
    ['reason', 'reason'], ['notes', 'notes'],
    ['gapInches', 'gap_inches'], ['divanHeightInches', 'divan_height_inches'],
    ['divanPriceSen', 'divan_price_sen'], ['legHeightInches', 'leg_height_inches'],
    ['legPriceSen', 'leg_price_sen'], ['customSpecials', 'custom_specials'],
    ['lineSuffix', 'line_suffix'], ['specialOrderPriceSen', 'special_order_price_sen'],
    ['variants', 'variants'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  /* description2 is server-owned: recompute from effective itemGroup + variants. */
  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  // GRN-linked + qty changed: pre-check the delta won't push the GRN line over
  // its accepted. headroom for THIS line = accepted - (returned - prevQty).
  const delta = qtyReturned - prevQty;
  if (grnItemId && delta !== 0) {
    const capLock = await qtyCapRefusal(sb, {
      table: 'grn_items', id: grnItemId,
      capColumn: 'qty_accepted', drawnColumns: ['returned_qty'],
      requested: qtyReturned, ownPriorDraw: prevQty, what: 'GRN line',
    });
    if (capLock) return c.json(capLock, 409);
  }

  const { error } = await scopeToCompanyId(sb.from('purchase_return_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  // Apply the consumption delta to the source GRN line (helper clamps to
  // [0, qty_accepted]).
  if (grnItemId && delta !== 0) await adjustGrnReturnedQty(sb, grnItemId, delta);
  await recomputePrTotals(sb, prId);

  /* Audit fix #5 — write the compensating inventory movement for the qty
     change. delta>0 → more goods leave (OUT); delta<0 → goods come back (IN).
     Uses the effective (possibly edited) material identity. */
  let movementErrors: string[] = [];
  if (delta !== 0) {
    const { data: hdr } = await sb.from('purchase_returns')
      .select('return_number, grn_id').eq('id', prId).maybeSingle();
    if (hdr) {
      const effGroup = (it.itemGroup ?? (prev as { item_group?: string | null }).item_group) as string | null | undefined;
      const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as VariantAttrs | null | undefined;
      movementErrors = await writePrLineDeltaMovement(sb, {
        prId,
        returnNumber: (hdr as { return_number: string }).return_number,
        headerGrnId: (hdr as { grn_id: string | null }).grn_id ?? null,
        userId: c.get('user').id,
        companyId: activeCompanyId(c),
        line: {
          id: itemId,
          grn_item_id: grnItemId,
          material_code: String((it.materialCode ?? (prev as { material_code: string }).material_code)),
          material_name: ((it.materialName ?? (prev as { material_name: string | null }).material_name) as string | null) ?? null,
          item_group: effGroup ?? null,
          variants: effVariants ?? null,
        },
        deltaQty: delta,
      });
    }
  }
  /* REPORTED, not discarded — same field, same shape as the CREATE path (POST /).
     A qty edit that moved qty_returned, returned_qty and the refund while its
     compensating movement was refused used to answer a clean 200. The edit
     STANDS; the operator is told, and the trail carries a RECOUNT_FAILED row. */
  return c.json({ ok: true, movementErrors: movementErrors.length ? movementErrors : undefined });
};
purchaseReturns.patch('/:id/items/:itemId', patchPurchaseReturnItemHandler);

/* ── DELETE /:id/items/:itemId — remove a line + recompute header. ── */
export const deletePurchaseReturnItemHandler = async (c: any) => {
  const prId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  { const lock = await prLineLock(sb, prId); if (lock) return c.json(lock, 409); }
  // Read the line first so we can release its GRN-line consumption on delete.
  // Audit 2026-06-11 M10 — scoped to THIS PR: a mismatched itemId must 404,
  // not delete another PR's line while the GRN release / stock compensation
  // run against this one.
  const { data: line } = await scopeToCompanyId(sb.from('purchase_return_items')
    .select('qty_returned, grn_item_id, material_code, material_name, item_group, variants')
    .eq('id', itemId).eq('purchase_return_id', prId), co.companyId).maybeSingle();
  if (!line) return c.json(NOT_THIS_COMPANY, 404);
  const { error } = await scopeToCompanyId(sb.from('purchase_return_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  let movementErrors: string[] = [];
  if (line) {
    const l = line as { qty_returned: number; grn_item_id: string | null; material_code: string; material_name: string | null; item_group: string | null; variants: VariantAttrs | null };
    // Release: decrement returned_qty by the deleted line's qty (helper clamps ≥0).
    if (l.grn_item_id) await adjustGrnReturnedQty(sb, l.grn_item_id, -(l.qty_returned ?? 0));

    /* Audit fix #5 — deleting a line reverses its return: bring the goods back
       IN (deltaQty negative). Without this the OUT written at create/add stayed
       standing and stock drifted below the books permanently. */
    const qty = Number(l.qty_returned ?? 0);
    if (qty > 0) {
      const { data: hdr } = await sb.from('purchase_returns')
        .select('return_number, grn_id').eq('id', prId).maybeSingle();
      if (hdr) {
        movementErrors = await writePrLineDeltaMovement(sb, {
          prId,
          returnNumber: (hdr as { return_number: string }).return_number,
          headerGrnId: (hdr as { grn_id: string | null }).grn_id ?? null,
          userId: c.get('user').id,
          companyId: activeCompanyId(c),
          line: {
            id: itemId,
            grn_item_id: l.grn_item_id,
            material_code: l.material_code,
            material_name: l.material_name,
            item_group: l.item_group,
            variants: l.variants,
          },
          deltaQty: -qty,
        });
      }
    }
  }
  await recomputePrTotals(sb, prId);
  /* 200 + body, not 204. A deleted line reverses its return with a compensating
     IN, and a refused IN left the goods deducted for good while the response
     said 204 No Content — a status that cannot carry the failure at all. Every
     sibling line-delete already answers 200 `{ ok, movementErrors? }`
     (consignment-notes.ts, consignment-returns.ts, delivery-returns.ts), and
     authedFetch parses a JSON 200 the same way it swallowed the 204. */
  return c.json({ ok: true, movementErrors: movementErrors.length ? movementErrors : undefined });
};
purchaseReturns.delete('/:id/items/:itemId', deletePurchaseReturnItemHandler);
