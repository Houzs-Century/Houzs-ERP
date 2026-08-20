// /purchase-consignment-receives — Consignment receiving step.
// PC Order → PC Receive → PC Return.
//
// ON-LEDGER (since 2026-06-05): a Purchase Consignment Receive records the
// arrival of the SUPPLIER'S goods at MY warehouse on consignment. We hold the
// physical stock (settlement comes later), so it books an IN into the receive's
// warehouse — reconciled by resyncReceiveInventory (below), self-healing on
// create / line CRUD / cancel. (It originally shipped off-ledger; the IN ledger
// was added 2026-06-05 so consigned stock shows in Inventory.)
//
// Cloned from /grns (apps/api/src/routes/grns.ts). It still differs from a plain
// GRN in two ways:
//   • Rollup target is the PC ORDER, not a PO (recomputePcoReceived,
//     recount-from-live, like recomputePoReceived but pointed at
//     purchase_consignment_orders), with the over-receipt cap vs the PC order line.
//   • Inventory is reconciled by a single self-healing resync (resyncReceiveInventory)
//     rather than GRN's per-step writeMovements + FIFO/rack/recost plumbing.
//   • KEPT: create (header + items, full variant), line CRUD, list, detail, status.
//
// Tables: purchase_consignment_receives / purchase_consignment_receive_items
//   (migration 0154). FK renames: receive→purchase_consignment_order_id /
//   pc_order_no; receive_items→pc_order_item_id.
// Numbering: PCR-YYMM-NNN.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { qtyCapRefusal } from '../lib/qty-cap';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { buildVariantSummary, computeVariantKey, type VariantAttrs } from '../shared';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { writeMovements, defaultWarehouseId, resolveWarehouseLotCosts } from '../lib/inventory-movements';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { assertSourceLinesInCompany } from '../lib/ref-in-company';
import { mintMonthlyDocNo } from '../lib/doc-no';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
  isCrossCompanySource, crossCompanyConversionBlocked } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';

export const purchaseConsignmentReceives = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseConsignmentReceives.use('*', supabaseAuth);

/* ── Shared helper: post a PC Receive + roll up to PC Order items ──────────
   Counterpart of postGrnAndRollup. Recounts received_qty onto the PC ORDER lines
   (recompute-from-live) and flips the receive to POSTED; the inventory IN is then
   booked by resyncReceiveInventory (called at the end of this helper). */
async function postPcReceiveAndRollup(sb: any, receiveId: string): Promise<{ ok: true; recountError?: string } | { ok: false; reason: string; status?: number }> {
  const { data: items } = await sb.from('purchase_consignment_receive_items')
    .select('pc_order_item_id')
    .eq('pc_receive_id', receiveId);

  // Recount received_qty + re-evaluate PC Order status from live receive lines.
  const touchedPcoItemIds = (items ?? [])
    .map((it: { pc_order_item_id: string | null }) => it.pc_order_item_id);
  /* Carried, not discarded — the counterpart postGrnAndRollup returns its
     recountError and this one dropped it, so a PC Order could keep a stale
     received_qty while the receive reported a clean post. */
  const recount = await recomputePcoReceived(sb, touchedPcoItemIds);

  // Receives are created POSTED directly; this is idempotent on already-POSTED
  // rows (matches any non-CLOSED status). The inventory IN is booked by the
  // resync below.
  /* maybeSingle, NOT single: the two .neq gates make a zero-row result the
     ORDINARY outcome for a CLOSED/CANCELLED receive, and PostgREST reports zero
     rows to .single() as PGRST116 — so `error` was set, the 500 fired, and the
     `409 cannot_post` below was unreachable. Same fix as stock-transfers.ts's
     cancel and purchase-returns.ts's /:id/complete. */
  const { data, error } = await sb.from('purchase_consignment_receives').update({
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', receiveId).neq('status', 'CLOSED').neq('status', 'CANCELLED').select('id, status, posted_at').maybeSingle();
  if (error) return { ok: false, reason: error.message, status: 500 };
  if (!data) return { ok: false, reason: 'cannot_post', status: 409 };

  // ON-LEDGER (2026-06-05) — book the received consignment stock INTO the
  // receive's warehouse so it shows in Inventory. Self-healing resync (idempotent
  // + best-effort).
  try { await resyncReceiveInventory(sb, receiveId, null); } catch { /* best-effort */ }

  return recount.ok ? { ok: true } : { ok: true, recountError: recount.reason };
}

/* ── resyncReceiveInventory — self-healing IN ledger for a PC Receive ──────────
   ONE function for the whole lifecycle (post / add-line / edit-qty / delete-line
   / cancel), mirroring resyncNoteInventory but IN-primary (a receive books the
   supplier's consignment stock IN). It reconciles the receive's CURRENT lines
   (the TARGET net IN per product/variant bucket — all into the HEADER warehouse,
   batch=pc_order_no when linked) against what inventory_movements already record
   for this receive, and writes only the DELTA:
     • first-ever IN for a bucket   → PC_RECEIVE  (carries the "consignment stock
       IN" label; PC_RECEIVE has no unique index, but we keep the first/delta
       split for consistency with the note template)
     • any later increase           → STOCK_TRANSFER IN
     • any decrease / give-back     → STOCK_TRANSFER OUT
     • cancel → status CANCELLED → TARGET is empty → every bucket's net is driven
       back to 0 via STOCK_TRANSFER OUT.
   A receive posts on create — it is "active" (books IN) whenever status !==
   'CANCELLED'. Idempotent: a re-run finds delta 0 everywhere and writes nothing.
   Best-effort. */
async function resyncReceiveInventory(sb: any, receiveId: string, performedBy: string | null): Promise<string[]> {
  const { data: header } = await sb.from('purchase_consignment_receives')
    .select('receive_number, status, warehouse_id, pc_order_no, company_id').eq('id', receiveId).maybeSingle();
  if (!header) return [];
  const status = ((header as { status: string | null }).status ?? '').toUpperCase();
  const receiveNo = (header as { receive_number: string }).receive_number ?? receiveId;
  const cancelled = status === 'CANCELLED';

  // The receive STAMPS batch = the source PC Order number, mirroring how a GRN
  // stamps batch_no = source PO number (migration 0120). Manual receives (no
  // order) stay un-batched (plain FIFO).
  const batchNo = (header as { pc_order_no: string | null }).pc_order_no ?? null;
  // Single HEADER warehouse for all lines (the form's "Receive Into").
  const warehouseId = (header as { warehouse_id: string | null }).warehouse_id
    /* Per-company default (2026-08-03) — the old lookup was company-blind and
       let alphabetical `code` order pick across every company's is_default
       warehouses, so it resolved to 2990's Guangzhou warehouse for Houzs too. */
    ?? (await defaultWarehouseId(sb, (header as { company_id?: number | null }).company_id ?? undefined));

  // 1. TARGET net IN per bucket = sum of current lines (empty if cancelled).
  type Bucket = { item_code: string; variant_key: string; product_name: string | null; qty: number; unit_cost_sen: number };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled && warehouseId) {
    const { data: lines } = await sb.from('purchase_consignment_receive_items')
      .select('item_code, material_name, qty_accepted, unit_price_sen, item_group, variants')
      .eq('pc_receive_id', receiveId);
    // Commander 2026-06-18 — a consignment receive often carries a 0 price (the
    // supplier still owns the goods until settlement), so fall back to the SKU's
    // current on-hand weighted-avg cost instead of opening a 0-cost FIFO lot a
    // later sale would consume and under-state COGS on. Same fix the sales-side
    // consignment-returns.ts got for BUG-2026-06-07-001; this in-path was missed.
    const costByBucket = await resolveWarehouseLotCosts(sb, warehouseId);
    for (const it of ((lines ?? []) as Array<{ item_code: string; material_name: string | null; qty_accepted: number | null; unit_price_sen: number | null; item_group: string | null; variants: unknown }>)) {
      const qty = Number(it.qty_accepted ?? 0);
      if (qty <= 0) continue;
      const vk = computeVariantKey(it.item_group, (it.variants as VariantAttrs | null) ?? null);
      const lineCost = Number(it.unit_price_sen ?? 0);
      const unitCost = lineCost > 0 ? lineCost : (costByBucket.get(`${it.item_code}::${vk}`) ?? 0);
      const k = `${it.item_code}::${vk}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { item_code: it.item_code, variant_key: vk, product_name: it.material_name, qty, unit_cost_sen: unitCost });
    }
  }

  // 2. CURRENT net IN per bucket from ALL this receive's movements (PC_RECEIVE IN
  //    + any prior STOCK_TRANSFER resync/cancel deltas).
  const { data: movs } = await sb.from('inventory_movements')
    .select('movement_type, warehouse_id, item_code, variant_key, batch_no, qty, total_cost_sen, product_name')
    .eq('source_doc_id', receiveId)
    .in('source_doc_type', ['PC_RECEIVE', 'STOCK_TRANSFER']);
  type Agg = { in_qty: number; out_qty: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of (movs ?? []) as Array<{ movement_type: string; warehouse_id: string; item_code: string; variant_key: string | null; batch_no?: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>) {
    // Bucket on product+variant only — the receive is single-warehouse + single
    // batch, so the TARGET keys on product::variant and CURRENT must match.
    const k = `${m.item_code}::${m.variant_key ?? ''}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { in_qty: 0, out_qty: 0, product_name: m.product_name }; aggByBucket.set(k, a); }
    if (m.movement_type === 'IN') a.in_qty += Number(m.qty ?? 0);
    else if (m.movement_type === 'OUT') a.out_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.product_name;
  }

  // 3. delta = target − current_net_in. >0 → book more IN; <0 → give stock back OUT.
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const pcReceiveEmitted = new Set<string>(); // product::variant given a PC_RECEIVE this run
  for (const k of new Set<string>([...targetByBucket.keys(), ...aggByBucket.keys()])) {
    const t = targetByBucket.get(k);
    const a = aggByBucket.get(k) ?? { in_qty: 0, out_qty: 0, product_name: null };
    const delta = (t?.qty ?? 0) - (a.in_qty - a.out_qty);
    if (delta === 0) continue;
    if (!warehouseId) continue;
    const [pc, vk] = k.split('::');
    const pname = t?.product_name ?? a.product_name ?? null;
    if (delta > 0) {
      const neverMoved = a.in_qty === 0 && a.out_qty === 0;
      const usePcReceive = neverMoved && !pcReceiveEmitted.has(`${pc}::${vk}`);
      if (usePcReceive) pcReceiveEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: 'IN', warehouse_id: warehouseId, item_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: delta, unit_cost_sen: t?.unit_cost_sen ?? 0,
        source_doc_type: usePcReceive ? 'PC_RECEIVE' : 'STOCK_TRANSFER',
        source_doc_id: receiveId, source_doc_no: receiveNo,
        ...(batchNo ? { batch_no: batchNo } : {}),
        performed_by: performedBy,
        notes: usePcReceive ? 'Consignment stock received IN' : 'PC Receive resync: line qty increased / added.',
      });
    } else {
      writes.push({
        movement_type: 'OUT', warehouse_id: warehouseId, item_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: -delta,
        source_doc_type: 'STOCK_TRANSFER',
        source_doc_id: receiveId, source_doc_no: cancelled ? `${receiveNo}-CANCEL` : receiveNo,
        ...(batchNo ? { batch_no: batchNo } : {}),
        performed_by: performedBy,
        notes: cancelled ? 'PC Receive cancelled — stock out again' : 'PC Receive resync: line qty reduced / deleted.',
      });
    }
  }

  if (writes.length === 0) return [];
  // Multi-company: resync movements inherit the receive's company.
  const res = await writeMovements(sb, writes, (header as { company_id?: number | null }).company_id ?? null);
  /* Oversell retro-cost (0154) — a consignment receive opens lots, so a prior
     "ship anyway" DO that went out at RM0 in this warehouse can now be costed
     from them. Wired 2026-07-29; before that only a GRN reconciled (COE §2).
     Best-effort — never fails the receive. */
  if (res.ok) await reconcileUncostedAfterIn(sb, writes, performedBy);
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch { /* best-effort */ }
  return res.ok ? [] : [res.reason ?? 'PC receive inventory resync failed'];
}

const HEADER =
  'id, receive_number, purchase_consignment_order_id, pc_order_no, supplier_id, received_at, delivery_note_ref, status, notes, ' +
  'warehouse_id, ' +
  'currency, subtotal_sen, tax_sen, total_sen, ' +
  'posted_at, created_at, created_by, updated_at';
const ITEM =
  'id, pc_receive_id, pc_order_item_id, material_kind, item_code, material_name, supplier_sku, ' +
  'qty_received, qty_accepted, qty_rejected, rejection_reason, unit_price_sen, notes, ' +
  /* variant fields (migration 0057) */
  'item_group, description, description2, uom, discount_sen, variants, ' +
  'gap_inches, divan_height_inches, divan_price_sen, leg_height_inches, leg_price_sen, ' +
  'custom_specials, line_suffix, special_order_price_sen, ' +
  /* line money + per-line date + cost snapshot */
  'line_total_sen, delivery_date, unit_cost_sen, ' +
  /* consumption tracking (downstream PR draw) */
  'invoiced_qty, returned_qty, created_at, ' +
  /* rack placement (nullable physical link; off-ledger, never required) */
  'rack_id';

const nextNumber = async (sb: any, prefix: string, table: string, col: string, c: any): Promise<string> => {
  // <PREFIX>-YYMM-NNN. max(suffix)+1 (NEVER count+1) so a deleted mid-month row
  // can't make the counter re-mint a surviving number forever — see doc-no.ts.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, table, col, `${p}${prefix}-${yymm}`);
};

/* ── Recompute PC Receive header money rollups ────────────────────────────
   Sum line_total_sen across receive_items → write subtotal_sen +
   total_sen. The receive carries no tax, so total = subtotal.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale.
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputePcReceiveTotals(sb: any, receiveId: string) {
  const { data: items, error: itemsErr } = await sb.from('purchase_consignment_receive_items')
    .select('line_total_sen')
    .eq('pc_receive_id', receiveId);
  /* A failed READ is not an empty receive, and `?? []` cannot tell them apart —
     it folded a transient blip into subtotal_sen / total_sen ZERO on a
     receive whose lines were intact. The ERROR is the signal, never the
     emptiness: a genuinely empty receive resolves error === null with data === []
     and MUST still fall through to zero the header. */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pcr-recompute] item read failed — header left unchanged:', receiveId, itemsErr.message);
    return;
  }
  const subtotal = (items ?? []).reduce((s: number, r: any) => s + (r.line_total_sen ?? 0), 0);
  const { error: updErr } = await sb.from('purchase_consignment_receives').update({
    subtotal_sen: subtotal,
    total_sen: subtotal,
    updated_at: new Date().toISOString(),
  }).eq('id', receiveId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pcr-recompute] header update failed — totals left STALE:', receiveId, updErr.message);
  }
}

/* ── Post-insert over-receipt verification for BULK creates ────────────────
   Mirrors verifyGrnOverReceipt: after the receive's lines commit, re-sum the
   LIVE qty_accepted across all non-cancelled receive lines per affected PC Order
   line; if any now exceeds the PC Order line's qty, THIS receive broke the cap →
   the caller deletes it + signals 409. */
async function verifyPcReceiveOverReceipt(
  sb: any,
  receiveId: string,
  pcoItemIds: Array<string | null | undefined>,
): Promise<{ pcoItemId: string; requested: number; remaining: number } | null> {
  const ids = [...new Set(pcoItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return null;
  try {
    const { data: pcoItems } = await sb.from('purchase_consignment_order_items')
      .select('id, qty').in('id', ids);
    const capById = new Map<string, number>(
      ((pcoItems ?? []) as Array<{ id: string; qty: number }>).map((r) => [r.id, r.qty ?? 0]),
    );
    const { data: sib } = await sb.from('purchase_consignment_receive_items')
      .select('pc_order_item_id, qty_accepted, pc_receive_id')
      .in('pc_order_item_id', ids);
    const sibRows = (sib ?? []) as Array<{ pc_order_item_id: string; qty_accepted: number; pc_receive_id: string }>;
    const receiveIds = [...new Set(sibRows.map((r) => r.pc_receive_id).filter(Boolean))];
    const cancelled = new Set<string>();
    if (receiveIds.length > 0) {
      const { data: gs } = await sb.from('purchase_consignment_receives').select('id, status').in('id', receiveIds);
      for (const g of (gs ?? []) as Array<{ id: string; status: string }>) {
        if (g.status === 'CANCELLED') cancelled.add(g.id);
      }
    }
    const liveByPcoi = new Map<string, number>();
    const thisReceiveByPcoi = new Map<string, number>();
    for (const r of sibRows) {
      if (cancelled.has(r.pc_receive_id)) continue;
      const q = Number(r.qty_accepted ?? 0);
      liveByPcoi.set(r.pc_order_item_id, (liveByPcoi.get(r.pc_order_item_id) ?? 0) + q);
      if (r.pc_receive_id === receiveId) thisReceiveByPcoi.set(r.pc_order_item_id, (thisReceiveByPcoi.get(r.pc_order_item_id) ?? 0) + q);
    }
    for (const pcoiId of ids) {
      const cap = capById.get(pcoiId) ?? 0;
      const live = liveByPcoi.get(pcoiId) ?? 0;
      if (live > cap) {
        const mine = thisReceiveByPcoi.get(pcoiId) ?? 0;
        return { pcoItemId: pcoiId, requested: mine, remaining: cap - (live - mine) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ── Self-heal PC Order receipt counter (live-count model) ─────────────────
   Mirrors recomputePoReceived but pointed at purchase_consignment_orders /
   _items. For each given pc_order_item, RECOUNT received_qty from scratch as the
   sum of qty_accepted (net of returned_qty) across ALL live (non-cancelled)
   receive lines that point at it, then re-evaluate the parent PC Order's status.
   No inventory is touched. Never resurrects a CANCELLED PC Order. Best-effort. */
/* Reports its outcome, the way recomputePoReceived does.
   It used to return void and only console.error, so the PC lane never received
   the 2026-07-31 upgrade that followed eleven POs sitting with their goods in
   the warehouse and received_qty untouched for seventeen days — the only trace
   being a console line in an ephemeral Worker log. Both writes below are now
   CHECKED for the same reason the PO twin's are: supabase-js RESOLVES on a
   rejected write instead of throwing, so an unchecked failure never reaches the
   catch and the function would report a recount that never happened. */
export async function recomputePcoReceived(
  sb: any,
  pcoItemIds: Array<string | null | undefined>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ids = [...new Set(pcoItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return { ok: true };

  try {
    const { data: rlines } = await sb.from('purchase_consignment_receive_items')
      .select('pc_order_item_id, qty_accepted, returned_qty, pc_receive_id')
      .in('pc_order_item_id', ids);
    const rows = (rlines ?? []) as Array<{ pc_order_item_id: string; qty_accepted: number; returned_qty: number; pc_receive_id: string }>;
    const receiveIds = [...new Set(rows.map((r) => r.pc_receive_id).filter(Boolean))];
    const cancelled = new Set<string>();
    if (receiveIds.length > 0) {
      const { data: gs } = await sb.from('purchase_consignment_receives').select('id, status').in('id', receiveIds);
      for (const g of (gs ?? []) as Array<{ id: string; status: string }>) {
        if (g.status === 'CANCELLED') cancelled.add(g.id);
      }
    }
    const recvByPcoi = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const r of rows) {
      if (cancelled.has(r.pc_receive_id)) continue;
      const net = Number(r.qty_accepted ?? 0) - Number(r.returned_qty ?? 0);
      recvByPcoi.set(r.pc_order_item_id, (recvByPcoi.get(r.pc_order_item_id) ?? 0) + Math.max(0, net));
    }
    const itemWrites = await Promise.all([...recvByPcoi.entries()].map(([pcoiId, recv]) =>
      sb.from('purchase_consignment_order_items').update({ received_qty: recv }).eq('id', pcoiId),
    ));
    const itemErr = itemWrites.find((r: { error?: { message?: string } | null }) => r?.error);
    if (itemErr) {
      return { ok: false, reason: `received_qty write failed: ${itemErr.error?.message ?? 'unknown'}` };
    }

    // Re-evaluate each touched PC Order's status from its (now-recounted) lines.
    const { data: pcoiRows } = await sb.from('purchase_consignment_order_items')
      .select('purchase_consignment_order_id').in('id', ids);
    const pcoIds = [...new Set(((pcoiRows ?? []) as Array<{ purchase_consignment_order_id: string }>)
      .map((r) => r.purchase_consignment_order_id).filter(Boolean))];
    for (const pcoId of pcoIds) {
      const { data: lines } = await sb.from('purchase_consignment_order_items')
        .select('qty, received_qty').eq('purchase_consignment_order_id', pcoId);
      const ll = (lines ?? []) as Array<{ qty: number; received_qty: number }>;
      if (ll.length === 0) continue;
      const anyReceived = ll.some((l) => (l.received_qty ?? 0) > 0);
      const fully = ll.every((l) => (l.received_qty ?? 0) >= l.qty);
      const newStatus = fully ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'SUBMITTED';
      const { data: head } = await sb.from('purchase_consignment_orders')
        .select('received_at').eq('id', pcoId).maybeSingle();
      const prevReceivedAt = (head as { received_at: string | null } | null)?.received_at ?? null;
      const patch: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() };
      patch.received_at = fully ? (prevReceivedAt ?? new Date().toISOString()) : null;
      const { error: pcoErr } = await sb.from('purchase_consignment_orders')
        .update(patch).eq('id', pcoId).neq('status', 'CANCELLED');
      if (pcoErr) {
        return { ok: false, reason: `PC order status write failed for ${pcoId}: ${pcoErr.message ?? 'unknown'}` };
      }
    }
    return { ok: true };
  } catch (e) {
    console.error('[recomputePcoReceived] best-effort recount failed', { pcoItemIds: ids, error: e });
    return { ok: false, reason: (e as Error)?.message ?? 'recount threw' };
  }
}

/* ── PC Receive child-lock guard ───────────────────────────────────────────
   A PC Receive locks (read-only — no line edit / no cancel) once ANY of its
   lines has a downstream PC Return (returned_qty > 0). There is no PC invoice in
   scope, so invoiced_qty is not consulted. Returns the blocking JSON, or null if
   the receive is free to edit. */
async function pcReceiveHasDownstream(sb: any, receiveId: string): Promise<{ error: string; message: string } | null> {
  const { data, error } = await sb.from('purchase_consignment_receive_items')
    .select('returned_qty').eq('pc_receive_id', receiveId);
  /* A failed read is not an empty line set (mirrors scm/lib/downstream-lock.ts).
     Dropping the error made `data ?? []` read as "no line has been returned",
     which is the absence that authorises the cancel / line edit this guard
     exists to refuse. A failed read must never read as an absence when the
     absence is what authorises the write. */
  if (error) {
    return { error: 'downstream_check_failed', message: `Could not check whether this Receive has a Consignment Return, so it is locked for safety — try again (${error.message}).` };
  }
  const any = ((data ?? []) as Array<{ returned_qty: number }>)
    .some((r) => (r.returned_qty ?? 0) > 0);
  if (any) return { error: 'pc_receive_has_downstream', message: 'Receive has a Consignment Return — delete it first to edit' };
  return null;
}

/* ── Per-PC-receive consumption flags ──────────────────────────────────────
   From a receive's items compute: has_children (any line returned_qty>0),
   fully_returned (every accepted line has returned_qty >= qty_accepted). */
function computePcReceiveFlags(items: Array<{ qty_accepted?: number | null; returned_qty?: number | null }>) {
  const accepted = items.filter((r) => (r.qty_accepted ?? 0) > 0);
  const hasChildren = items.some((r) => (r.returned_qty ?? 0) > 0);
  const fullyReturned = accepted.length > 0 && accepted.every((r) => (r.returned_qty ?? 0) >= (r.qty_accepted ?? 0));
  return { has_children: hasChildren, fully_returned: fullyReturned };
}

purchaseConsignmentReceives.get('/', async (c) => {
  const sb = c.get('supabase');
  let q = sb.from('purchase_consignment_receives').select(`${HEADER}, supplier:suppliers(id, code, name), purchase_consignment_order:purchase_consignment_orders(id, pc_number)`).order('received_at', { ascending: false });
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  const supplierId = c.req.query('supplierId'); if (supplierId) q = q.eq('supplier_id', supplierId);
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data ?? []) as Array<{ id: string } & Record<string, unknown>>;
  const ids = rows.map((g) => g.id);
  const linesByReceive = new Map<string, Array<{ qty_accepted: number | null; returned_qty: number | null }>>();
  if (ids.length > 0) {
    const { data: lineRows, error: lineErr } = await sb
      .from('purchase_consignment_receive_items')
      .select('pc_receive_id, qty_accepted, returned_qty')
      .in('pc_receive_id', ids);
    if (lineErr) return c.json({ error: 'load_failed', reason: lineErr.message }, 500);
    for (const li of (lineRows ?? []) as Array<{ pc_receive_id: string; qty_accepted: number | null; returned_qty: number | null }>) {
      const arr = linesByReceive.get(li.pc_receive_id) ?? [];
      arr.push({ qty_accepted: li.qty_accepted, returned_qty: li.returned_qty });
      linesByReceive.set(li.pc_receive_id, arr);
    }
  }
  const receives = rows.map((g) => ({
    ...g,
    total_sen: (g.total_sen as number | null | undefined) ?? 0,
    ...computePcReceiveFlags(linesByReceive.get(g.id) ?? []),
  }));
  return c.json({ grns: receives });
});

/* ── GET /outstanding-pco-items ──────────────────────────────────────────
   PC Order line items with remaining qty > 0, for the multi-select "Receive
   from PC Orders" picker. Mirrors GRN /outstanding-po-items; this endpoint is a
   read-only query (no inventory side-effects) without the warehouse-lock plumbing. */
purchaseConsignmentReceives.get('/outstanding-pco-items', async (c) => {
  const sb = c.get('supabase');
  const { data: items, error } = await scopeToCompany(
    sb
      .from('purchase_consignment_order_items')
      .select(`
      id, purchase_consignment_order_id, material_kind, item_code, material_name, item_group,
      description, qty, received_qty, unit_price_sen, warehouse_id, variants, delivery_date,
      pco:purchase_consignment_orders!inner ( id, pc_number, supplier_id, status, po_date, expected_at,
        purchase_location_id, supplier:suppliers ( code, name ) )
    `),
    c,
  )
    .order('purchase_consignment_order_id', { ascending: false })
    .limit(500);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Row = {
    id: string; purchase_consignment_order_id: string; material_kind: string; item_code: string;
    material_name: string; item_group: string | null; description: string | null;
    qty: number; received_qty: number; unit_price_sen: number;
    warehouse_id: string | null; variants: unknown; delivery_date: string | null;
    pco: {
      id: string; pc_number: string; supplier_id: string; status: string;
      po_date: string; expected_at: string | null; purchase_location_id: string | null;
      supplier: { code: string; name: string } | null;
    };
  };

  const rows = ((items ?? []) as unknown as Row[])
    .filter((r) => r.pco.status === 'SUBMITTED' || r.pco.status === 'PARTIALLY_RECEIVED')
    .filter((r) => r.qty - (r.received_qty ?? 0) > 0);

  const outstanding = rows.map((r) => ({
    pcoItemId:       r.id,
    pcoId:           r.pco.id,
    pcoDocNo:        r.pco.pc_number,
    itemCode:        r.item_code,
    description:     r.description ?? r.material_name,
    itemGroup:       r.item_group ?? '',
    qty:             r.qty,
    receivedQty:     r.received_qty ?? 0,
    remainingQty:    r.qty - (r.received_qty ?? 0),
    unitPriceSen:  r.unit_price_sen,
    warehouseId:     r.warehouse_id,
    variants:        r.variants,
    deliveryDate:    r.delivery_date ?? null,
    supplierId:      r.pco.supplier_id,
    supplierCode:    r.pco.supplier?.code ?? '',
    supplierName:    r.pco.supplier?.name ?? '',
    poDate:          r.pco.po_date,
    expectedAt:      r.pco.expected_at,
  }));

  return c.json({ items: outstanding });
});

/* Per-receive-line downstream breakdown — for each receive item id, the PC
   Returns it was carried into (via purchase_consignment_return_items
   .pc_receive_item_id), carrying the return number + qty + status. Cancelled PRs
   excluded. Read-only display aid, no writes. */
export type PcReceiveLineDownstream = { docNumber: string; docType: 'PR'; qty: number; status: string };
export async function pcReceiveLineDownstream(
  sb: any,
  receiveItemIds: string[],
): Promise<Map<string, PcReceiveLineDownstream[]>> {
  const out = new Map<string, PcReceiveLineDownstream[]>();
  const ids = [...new Set(receiveItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return out;

  const { data: prLines } = await sb
    .from('purchase_consignment_return_items')
    .select('pc_receive_item_id, qty_returned, purchase_consignment_return_id')
    .in('pc_receive_item_id', ids);
  const rows = (prLines ?? []) as Array<{ pc_receive_item_id: string | null; qty_returned: number; purchase_consignment_return_id: string }>;
  const prIds = [...new Set(rows.map((r) => r.purchase_consignment_return_id).filter(Boolean))];
  if (prIds.length === 0) return out;
  const { data: prHeads } = await sb.from('purchase_consignment_returns').select('id, return_number, status').in('id', prIds);
  const prMeta = new Map<string, { docNumber: string; status: string }>();
  for (const p of (prHeads ?? []) as Array<{ id: string; return_number: string | null; status: string | null }>) {
    if ((p.status ?? '').toUpperCase() === 'CANCELLED') continue;
    prMeta.set(p.id, { docNumber: p.return_number ?? '—', status: (p.status ?? '').toUpperCase() });
  }
  for (const r of rows) {
    if (!r.pc_receive_item_id) continue;
    const meta = prMeta.get(r.purchase_consignment_return_id);
    if (!meta) continue;
    const arr = out.get(r.pc_receive_item_id) ?? [];
    arr.push({ docNumber: meta.docNumber, docType: 'PR', qty: Number(r.qty_returned ?? 0), status: meta.status });
    out.set(r.pc_receive_item_id, arr);
  }
  return out;
}

// ── Outstanding PC Order lines (From-Order multi-picker) ──────────────────
// Every purchase_consignment_order_item with outstanding = qty − received_qty
// still > 0, across all non-cancelled PC Orders. Mirrors the PO→GRN from-po
// picker. MUST precede /:id so the static path isn't read as an id.
purchaseConsignmentReceives.get('/outstanding-order-lines', async (c) => {
  const sb = c.get('supabase');
  const { data: orders, error: oErr } = await paginateAll((from, to) => scopeToCompany(
    sb
      .from('purchase_consignment_orders')
      .select('id, pc_number, supplier_id, status, supplier:suppliers(id, code, name)'),
    c,
  )
    .neq('status', 'CANCELLED')
    .order('pc_number', { ascending: false })
    .range(from, to));
  if (oErr) return c.json({ error: 'load_failed', reason: oErr.message }, 500);
  const orderList = (orders ?? []) as Array<{ id: string; pc_number: string; supplier_id: string | null; supplier?: { name?: string | null } | null }>;
  if (orderList.length === 0) return c.json({ lines: [] });
  const orderById = new Map(orderList.map((o) => [o.id, o]));
  const orderIds = orderList.map((o) => o.id);

  const { data: items, error: iErr } = await chunkIn<Record<string, unknown>>(orderIds, (batch, from, to) => sb
    .from('purchase_consignment_order_items')
    .select('id, purchase_consignment_order_id, material_kind, item_code, material_name, supplier_sku, item_group, description, uom, qty, received_qty, unit_price_sen, variants')
    .in('purchase_consignment_order_id', batch)
    .range(from, to));
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  const itemList = (items ?? []) as Array<Record<string, unknown>>;

  const lines = itemList.map((it) => {
    const o = orderById.get(it.purchase_consignment_order_id as string);
    const ordered = Number(it.qty ?? 0);
    const received = Number(it.received_qty ?? 0);
    return {
      orderItemId: it.id as string,
      purchaseConsignmentOrderId: it.purchase_consignment_order_id as string,
      pcNumber: o?.pc_number ?? '',
      supplierId: o?.supplier_id ?? null,
      supplierName: o?.supplier?.name ?? null,
      materialKind: (it.material_kind as string) ?? 'OTHER',
      itemCode: it.item_code as string,
      materialName: (it.material_name as string) ?? '',
      supplierSku: (it.supplier_sku as string | null) ?? null,
      itemGroup: (it.item_group as string | null) ?? null,
      description: (it.description as string | null) ?? null,
      uom: (it.uom as string | null) ?? null,
      ordered,
      received,
      outstanding: ordered - received,
      unitPriceSen: Number(it.unit_price_sen ?? 0),
      variants: it.variants ?? null,
    };
  }).filter((l) => l.outstanding > 0);

  return c.json({ lines });
});

purchaseConsignmentReceives.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('purchase_consignment_receives').select(`${HEADER}, supplier:suppliers(id, code, name), purchase_consignment_order:purchase_consignment_orders(id, pc_number)`).eq('id', id), c).maybeSingle(),
    sb.from('purchase_consignment_receive_items').select(ITEM).eq('pc_receive_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  const itemRows = (i.data ?? []) as Array<{ qty_accepted?: number | null; returned_qty?: number | null }>;
  const receive = { ...(h.data as Record<string, unknown>), ...computePcReceiveFlags(itemRows) };

  /* Surface "received from which PC Order" + receive date per line, plus the
     downstream PC Return breakdown. */
  /* Canonical SKU/build order at READ (sofa modules LHF→NA→RHF, mains→
     accessories→services), mirroring the SO detail GET. The shared helper keys
     on `item_code`; PC receive lines expose `item_code`, so sort a shimmed
     view that carries the original row back unchanged. `.order('created_at')`
     above stays as the stable tiebreaker — pure ordering, no persistence touched. */
  type PcrLineRow = Record<string, unknown> & { id: string; pc_order_item_id: string | null; item_code: string };
  const lineItems = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; pc_order_item_id: string | null; item_code: string }>)
        .map((it): PcrLineRow => ({ ...it, item_code: it.item_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  const headerReceivedAt = (h.data as { received_at?: string | null }).received_at ?? null;
  const pcoItemIds = [...new Set(lineItems.map((it) => it.pc_order_item_id).filter((x): x is string => Boolean(x)))];
  const pcoNoByItemId = new Map<string, string>();
  const downstreamMap = await pcReceiveLineDownstream(sb, lineItems.map((it) => it.id));
  if (pcoItemIds.length > 0) {
    const { data: pcoiRows } = await sb.from('purchase_consignment_order_items')
      .select('id, pco:purchase_consignment_orders ( pc_number )')
      .in('id', pcoItemIds);
    for (const r of (pcoiRows ?? []) as Array<{ id: string; pco: { pc_number: string } | Array<{ pc_number: string }> | null }>) {
      const pco = Array.isArray(r.pco) ? r.pco[0] : r.pco;
      if (pco?.pc_number) pcoNoByItemId.set(r.id, pco.pc_number);
    }
  }
  const items = lineItems.map((it) => ({
    ...it,
    source_pco_number: it.pc_order_item_id ? (pcoNoByItemId.get(it.pc_order_item_id) ?? null) : null,
    received_at: headerReceivedAt,
    downstream: downstreamMap.get(it.id) ?? [],
  }));
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ grn: receive, items });
});

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// For a PC Receive: the parent PC Order + downstream PC Returns.
purchaseConsignmentReceives.get('/:id/linked', async (c) => {
  /* Company-scoped like every other read on this router. Without it a caller in
     one company could resolve ANOTHER company's PC receive to its linked document
     numbers by id. All seven /:id/linked endpoints shared this gap (found
     2026-08-12 by code read; two module guides claimed scoping that was absent). */
  const sb = c.get('supabase'); const id = c.req.param('id');

  const [recvRes, prRes] = await Promise.all([
    scopeToCompany(sb.from('purchase_consignment_receives')
      .select('id, purchase_consignment_order_id, purchase_consignment_order:purchase_consignment_orders(id, pc_number)')
      .eq('id', id), c)
      .maybeSingle(),
    sb.from('purchase_consignment_returns')
      .select('id, return_number, status, return_date')
      .eq('pc_receive_id', id)
      .order('return_date', { ascending: false }),
  ]);

  if (recvRes.error) return c.json({ error: 'load_failed', reason: recvRes.error.message }, 500);
  if (!recvRes.data) return c.json({ error: 'not_found' }, 404);
  if (prRes.error)  return c.json({ error: 'load_failed', reason: prRes.error.message  }, 500);

  const raw = recvRes.data as unknown as {
    purchase_consignment_order?: { id: string; pc_number: string } | Array<{ id: string; pc_number: string }> | null;
  };
  const pcoJoin = raw.purchase_consignment_order;
  const pco: { id: string; pc_number: string } | null =
    Array.isArray(pcoJoin) ? (pcoJoin[0] ?? null) : (pcoJoin ?? null);

  return c.json({
    purchaseConsignmentOrder: pco,
    returns:                  prRes.data ?? [],
  });
});

purchaseConsignmentReceives.post('/', async (c) => {
  /* company-scope: the parent PC Order named in the body is refused when it
     belongs to another company (isCrossCompanySource, below); the other by-id
     writes roll back the header this handler just inserted. Verified 2026-08-13. */
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (body.status === 'DRAFT') return c.json({ error: 'draft_status_not_supported', message: 'Consignment receives post immediately on create.' }, 400);
  /* A receive may be created WITHOUT a parent PC Order (manual receipt). Only the
     supplier is required; purchaseConsignmentOrderId is optional. Each line still
     carries its own pc_order_item_id (or null) so the received-qty rollup runs
     per-line for PC-order-linked rows and is skipped for manual rows. */
  if (!body.supplierId) return c.json({ error: 'supplier_required' }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: 'items_required' }, 400);

  const sb = c.get('supabase'); const user = c.get('user');

  /* Over-receipt guard — PC-order-linked lines can't accept more than the PC
     Order line's remaining (qty - received_qty). Lines with no pc_order_item_id
     (manual receipts) are uncapped. Picks that target the SAME PC Order line
     within one receive are summed. */
  {
    const acceptedByPcoItem = new Map<string, number>();
    for (const it of items) {
      const pcoItemId = (it.pcOrderItemId as string | undefined) ?? null;
      if (!pcoItemId) continue;
      const accepted = Number(it.qtyAccepted ?? it.qtyReceived ?? 0);
      acceptedByPcoItem.set(pcoItemId, (acceptedByPcoItem.get(pcoItemId) ?? 0) + accepted);
    }
    if (acceptedByPcoItem.size > 0) {
      const xl = await assertSourceLinesInCompany(sb, c, 'purchase_consignment_order_items', [...acceptedByPcoItem.keys()]);
      if (!xl.ok) return c.json(xl.body, xl.status);
      const { data: pcoItems } = await sb.from('purchase_consignment_order_items')
        .select('id, qty, received_qty').in('id', [...acceptedByPcoItem.keys()]);
      const remByPcoItem = new Map<string, number>(
        ((pcoItems ?? []) as Array<{ id: string; qty: number; received_qty: number }>)
          .map((r) => [r.id, (r.qty ?? 0) - (r.received_qty ?? 0)]),
      );
      for (const [pcoItemId, accepted] of acceptedByPcoItem) {
        const remaining = remByPcoItem.get(pcoItemId) ?? 0;
        if (accepted > remaining) {
          return c.json({ error: 'qty_exceeds_remaining', pcoItemId, requested: accepted, remaining }, 409);
        }
      }
    }
  }

  const receiveNumber = await nextNumber(sb, 'PCR', 'purchase_consignment_receives', 'receive_number', c);

  // Snapshot the PC Order number (pc_order_no) when linked.
  const pcOrderId = (body.purchaseConsignmentOrderId as string | undefined) ?? null;
  let pcOrderNo: string | null = null;
  if (pcOrderId) {
    const { data: pcoHead } = await sb.from('purchase_consignment_orders').select('pc_number, company_id').eq('id', pcOrderId).maybeSingle();
    const pco = pcoHead as { pc_number?: string | null; company_id?: number | null } | null;
    /* CROSS-COMPANY SOURCE (lib/companyScope) — the parent PC Order arrives as a
       body field and the receive below is stamped `activeCompanyId(c)`, so a PC
       Order id from the other company would have this company receive against
       it and recomputePcoReceived would then move that company's received_qty.
       A manual receive sends no parent, resolves to no source, and is
       unaffected. Refused before the doc number is committed to. */
    if (pco && isCrossCompanySource(pco.company_id, c)) {
      return c.json(crossCompanyConversionBlocked(pco.pc_number ?? null, pco.company_id, c), 409);
    }
    pcOrderNo = pco?.pc_number ?? null;
  }

  // Created POSTED directly — no inventory IN is written.
  const { data: header, error: hErr } = await sb.from('purchase_consignment_receives').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    receive_number: receiveNumber,
    purchase_consignment_order_id: pcOrderId,
    pc_order_no: pcOrderNo,
    supplier_id: body.supplierId,
    received_at: dateOrNull(body.receivedAt) ?? todayMyt(),
    delivery_note_ref: (body.deliveryNoteRef as string) ?? null,
    notes: (body.notes as string) ?? null,
    warehouse_id: (body.warehouseId as string | undefined) ?? null,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select(HEADER).single();
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; receive_number: string };

  const rows = items.map((it) => {
    const qtyReceived = Number(it.qtyReceived ?? 0);
    const unitPriceSen = Number(it.unitPriceSen ?? 0);
    const discountSen = Number(it.discountSen ?? 0);
    return {
      pc_receive_id: h.id,
      pc_order_item_id: (it.pcOrderItemId as string | undefined) ?? null,
      material_kind: it.materialKind,
      item_code: it.itemCode,
      material_name: it.materialName,
      supplier_sku: (it.supplierSku as string | undefined) ?? null,
      qty_received: qtyReceived,
      qty_accepted: Number(it.qtyAccepted ?? it.qtyReceived ?? 0),
      qty_rejected: Number(it.qtyRejected ?? 0),
      rejection_reason: (it.rejectionReason as string | undefined) ?? null,
      unit_price_sen: unitPriceSen,
      discount_sen: discountSen,
      line_total_sen: (qtyReceived * unitPriceSen) - discountSen,
      delivery_date: dateOrNull(it.deliveryDate),
      unit_cost_sen: Number(it.unitCostSen ?? 0),
      notes: (it.notes as string | undefined) ?? null,
      item_group: (it.itemGroup as string | undefined) ?? null,
      variants: it.variants ?? null,
      description: (it.description as string | undefined) ?? null,
      description2: buildVariantSummary(String(it.itemGroup ?? ''), (it.variants as Record<string, unknown> | null) ?? null) || null,
      rack_id: (it.rackId as string | undefined) || null,
    };
  });
  const { error: iErr } = await sb.from('purchase_consignment_receive_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('purchase_consignment_receives').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  /* Post-insert over-receipt verification — the pre-check above is a read-then-
     write race. Re-sum live received per PC Order line; if any now exceeds cap,
     THIS receive broke it → delete it + 409. */
  {
    const over = await verifyPcReceiveOverReceipt(sb, h.id, items.map((it) => (it.pcOrderItemId as string | undefined) ?? null));
    if (over) {
      await sb.from('purchase_consignment_receive_items').delete().eq('pc_receive_id', h.id);
      await sb.from('purchase_consignment_receives').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', pcoItemId: over.pcoItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  // Roll up qty_accepted to PC Order items + book the inventory IN (both inside
  // postPcReceiveAndRollup). Best-effort.
  await postPcReceiveAndRollup(sb, h.id);
  // Populate header money rollups from the inserted lines.
  await recomputePcReceiveTotals(sb, h.id);

  return c.json({ id: h.id, grnNumber: h.receive_number }, 201);
});

// ── POST /from-pcos ─────────────────────────────────────────────────────
// Batch-convert multiple PC Orders into ONE PC Receive (same supplier).
// Pre-fills qty_received + qty_accepted with the outstanding qty per line.
/* Exported so the company-scope tests can drive it without the supabaseAuth
   bridge, which cannot run in the vitest harness. Same reason
   createPurchaseInvoiceFromGrnHandler and appendDoLinesToSalesInvoiceHandler
   are exported; the route registration below is unchanged. */
export const createPcReceiveFromPcosHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: both source reads below are SCOPED, so another company's PC
     Order is not visible here at all; the by-id writes are this handler's own
     rollback. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { purchaseConsignmentOrderIds?: string[]; deliveryNoteRef?: string; notes?: string; warehouseId?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const pcoIds = body.purchaseConsignmentOrderIds ?? [];
  if (pcoIds.length === 0) return c.json({ error: 'pco_ids_required' }, 400);

  /* SOURCE LOAD, SCOPED — the PC Order ids arrive in the request body, so this
     is the read that decides what this conversion can see. Scoped, so another
     company's PC Order resolves to NO ROW and falls out at `pcos_not_found`.
     REPLACED an isCrossCompanySource loop that ran right after this load and can
     no longer fire.

     THE COST: a hand-crafted request naming the other company's PC Order gets
     `pcos_not_found` instead of "that consignment order belongs to 2990, switch
     company" — the trade the PO's /:id/convert-from-so already records, taken for
     the same reason: naming the other company needs an UNSCOPED read this
     handler otherwise never makes. */
  const { data: pcos, error: pcoErr } = await scopeToCompany(sb.from('purchase_consignment_orders')
    .select('id, pc_number, supplier_id, status, company_id')
    .in('id', pcoIds), c);
  if (pcoErr) return c.json({ error: 'load_failed', reason: pcoErr.message }, 500);
  const pcoList = (pcos ?? []) as Array<{ id: string; pc_number: string; supplier_id: string; status: string; company_id?: number | null }>;
  if (pcoList.length === 0) return c.json({ error: 'pcos_not_found' }, 404);

  const supplierIds = new Set(pcoList.map((p) => p.supplier_id));
  if (supplierIds.size > 1) {
    return c.json({ error: 'mixed_suppliers', message: 'All selected PC Orders must be from the same supplier' }, 400);
  }
  const supplierId = [...supplierIds][0]!;

  // LINE-level half of the same source document — scoped under the same
  // predicate as the header read above. `.in('purchase_consignment_order_id',
  // pcoIds)` is id-keyed, and an id-keyed read on a converter is the shape this
  // sweep exists for, so it carries the predicate rather than inheriting it.
  const { data: items } = await scopeToCompany(sb.from('purchase_consignment_order_items')
    .select('id, purchase_consignment_order_id, material_kind, item_code, material_name, qty, received_qty, unit_price_sen, ' +
      'item_group, description, description2, uom, variants, gap_inches, divan_height_inches, divan_price_sen, ' +
      'leg_height_inches, leg_price_sen, custom_specials, line_suffix, special_order_price_sen, discount_sen, unit_cost_sen, delivery_date')
    .in('purchase_consignment_order_id', pcoIds), c);
  const itemList = ((items ?? []) as unknown as Array<{
    id: string; purchase_consignment_order_id: string; material_kind: string; item_code: string;
    material_name: string; qty: number; received_qty: number; unit_price_sen: number;
    item_group?: string | null; description?: string | null; description2?: string | null;
    uom?: string; variants?: unknown; gap_inches?: number | null;
    divan_height_inches?: number | null; divan_price_sen?: number;
    leg_height_inches?: number | null; leg_price_sen?: number;
    custom_specials?: unknown; line_suffix?: string | null; special_order_price_sen?: number;
    discount_sen?: number; unit_cost_sen?: number; delivery_date?: string | null;
  }>).filter((it) => it.qty - (it.received_qty ?? 0) > 0);

  if (itemList.length === 0) return c.json({ error: 'nothing_outstanding', message: 'No outstanding lines came back for this PC Order. Open it and check its received balance before treating it as received in full.' }, 400);

  const receiveNumber = await nextNumber(sb, 'PCR', 'purchase_consignment_receives', 'receive_number', c);

  const pcoNumbersJoined = pcoList.map((p) => p.pc_number).join(', ');
  const { data: header, error: hErr } = await sb.from('purchase_consignment_receives').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    receive_number: receiveNumber,
    purchase_consignment_order_id: pcoList[0]!.id,
    pc_order_no: pcoList[0]!.pc_number,
    supplier_id: supplierId,
    received_at: todayMyt(),
    delivery_note_ref: body.deliveryNoteRef ?? null,
    notes: `Batch-converted from ${pcoList.length} PC Orders: ${pcoNumbersJoined}${body.notes ? ` · ${body.notes}` : ''}`,
    warehouse_id: body.warehouseId ?? null,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select('id, receive_number').single();
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; receive_number: string };

  const rows = itemList.map((it) => {
    const qtyReceived = it.qty - (it.received_qty ?? 0);
    const discountSen = it.discount_sen ?? 0;
    return {
      pc_receive_id: h.id,
      pc_order_item_id: it.id,
      material_kind: it.material_kind,
      item_code: it.item_code,
      material_name: it.material_name,
      qty_received: qtyReceived,
      qty_accepted: qtyReceived,
      qty_rejected: 0,
      unit_price_sen: it.unit_price_sen,
      line_total_sen: (qtyReceived * it.unit_price_sen) - discountSen,
      unit_cost_sen: it.unit_cost_sen ?? 0,
      item_group: it.item_group ?? null,
      description: it.description ?? null,
      description2: it.description2 ?? null,
      uom: it.uom ?? 'UNIT',
      variants: it.variants ?? null,
      gap_inches: it.gap_inches ?? null,
      divan_height_inches: it.divan_height_inches ?? null,
      divan_price_sen: it.divan_price_sen ?? 0,
      leg_height_inches: it.leg_height_inches ?? null,
      leg_price_sen: it.leg_price_sen ?? 0,
      custom_specials: it.custom_specials ?? null,
      line_suffix: it.line_suffix ?? null,
      special_order_price_sen: it.special_order_price_sen ?? 0,
      discount_sen: discountSen,
      delivery_date: it.delivery_date ?? null,
    };
  });
  const { error: iErr } = await sb.from('purchase_consignment_receive_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('purchase_consignment_receives').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  {
    const over = await verifyPcReceiveOverReceipt(sb, h.id, itemList.map((it) => it.id));
    if (over) {
      await sb.from('purchase_consignment_receive_items').delete().eq('pc_receive_id', h.id);
      await sb.from('purchase_consignment_receives').delete().eq('id', h.id);
      return c.json({ error: 'qty_exceeds_remaining', pcoItemId: over.pcoItemId, requested: over.requested, remaining: over.remaining }, 409);
    }
  }

  await postPcReceiveAndRollup(sb, h.id);
  await recomputePcReceiveTotals(sb, h.id);

  return c.json({ id: h.id, grnNumber: h.receive_number, pcoCount: pcoList.length, lineCount: itemList.length }, 201);
};
purchaseConsignmentReceives.post('/from-pcos', createPcReceiveFromPcosHandler);

purchaseConsignmentReceives.patch('/:id/post', async (c) => {
  // Kept as a no-op endpoint for backward compat — receives are created POSTED.
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(sb.from('purchase_consignment_receives').select('id, status, posted_at').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const row = cur as { id: string; status: string; posted_at: string | null };
  if (row.status === 'POSTED') {
    return c.json({ receive: row });
  }
  /* Audit 2026-06-20 — a CANCELLED PC Receive is FINAL: its inventory IN was
     already reversed by the cancel resync. Re-posting would re-book the stock IN
     (on-hand permanently inflated). Create a new receive instead. */
  if (row.status === 'CANCELLED') {
    return c.json({ error: 'receive_cancelled_final', message: 'A cancelled PC Receive cannot be re-posted — its stock was already reversed. Create a new receive.' }, 409);
  }
  const res = await postPcReceiveAndRollup(sb, id);
  if (!res.ok) return c.json({ error: 'post_failed', reason: res.reason }, 500);
  /* maybeSingle: a company-scoped by-id read can legitimately match zero rows (a
     cancel that raced in behind the post), and .single() turns that into a
     PGRST116 error — a post that COMMITTED answering 500. */
  const { data } = await scopeToCompanyId(sb.from('purchase_consignment_receives').select('id, status, posted_at').eq('id', id), co.companyId).maybeSingle();
  /* recountError surfaced, matching the GRN post which returns the same field.
     The receive IS posted — a stale received_qty on the parent PC Order must not
     un-post it — but the operator and /inventory/reconcile now learn that the
     roll-up did not land, instead of a clean 200 hiding it. */
  return c.json({ receive: data, ...(res.recountError ? { recountError: res.recountError } : {}) });
});

/* ── PATCH /:id/cancel — cancel a PC Receive ────────────────────────────────
   Cancelling a PC Receive sets status='CANCELLED' and recounts received_qty onto
   the parent PC Order lines (so this receive's lines drop out and the PC Order
   re-opens). Inventory is reversed too (on-ledger since 2026-06-05): the resync
   drives the booked IN back to zero. */
export const cancelPurchaseConsignmentReceiveHandler = async (c: any) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: cur, error: readErr } = await scopeToCompanyId(sb.from('purchase_consignment_receives')
    .select('id, status, receive_number')
    .eq('id', id), co.companyId).maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const head = cur as { id: string; status: string; receive_number: string };
  if (head.status === 'CANCELLED') {
    const { data } = await scopeToCompanyId(sb.from('purchase_consignment_receives').select(HEADER).eq('id', id), co.companyId).maybeSingle();
    return c.json({ receive: data ?? { id, status: 'CANCELLED' } });
  }

  // Child-lock: can't cancel a receive that has a downstream PC Return — the
  // return must be deleted first.
  const childLock = await pcReceiveHasDownstream(sb, id);
  if (childLock) return c.json(childLock, 409);

  // Load the receive lines once — needed for the PC Order recount below.
  const { data: lines } = await sb.from('purchase_consignment_receive_items')
    .select('pc_order_item_id')
    .eq('pc_receive_id', id);
  const lineList = (lines ?? []) as Array<{ pc_order_item_id: string | null }>;

  /* ATOMIC single ACTIVE→CANCELLED transition — two concurrent cancels race on
     the row and only ONE flips it (the other gets no row back → idempotent
     no-op), so the PC Order recount below runs exactly once. */
  const { data: updRow, error: updErr } = await scopeToCompanyId(sb.from('purchase_consignment_receives')
    .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', id), co.companyId).neq('status', 'CANCELLED').select('id').maybeSingle();
  if (updErr) return c.json({ error: 'cancel_failed', reason: updErr.message }, 500);
  if (!updRow) {
    const { data } = await scopeToCompanyId(sb.from('purchase_consignment_receives').select(HEADER).eq('id', id), co.companyId).maybeSingle();
    return c.json({ receive: data ?? { id, status: 'CANCELLED' } });
  }

  // Recount received_qty on each linked PC Order item from live receive lines —
  // this cancelled receive's lines now drop out, auto-releasing the PC Order.
  try {
    await recomputePcoReceived(sb, lineList.map((it) => it.pc_order_item_id));
  } catch { /* best-effort */ }

  // Inventory reversal (2026-06-05, now on-ledger) — the status is now CANCELLED,
  // so the resync drives every bucket's net back to 0 (STOCK_TRANSFER OUT).
  // Best-effort.
  try {
    await resyncReceiveInventory(sb, id, c.get('user')?.id ?? null);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pc-receive] cancel reversal failed:', e); }

  const { data } = await scopeToCompanyId(sb.from('purchase_consignment_receives').select(HEADER).eq('id', id), co.companyId).maybeSingle();
  return c.json({ receive: data ?? { id, status: 'CANCELLED' } });
};
purchaseConsignmentReceives.patch('/:id/cancel', cancelPurchaseConsignmentReceiveHandler);

/* ════════════════════════════════════════════════════════════════════════
   PC Receive CRUD (PATCH header + line add / edit / delete) — mirrors the GRN
   detail page editing. The editable line quantity is qty_received;
   line_total_sen = qty_received * unit_price_sen - discount_sen;
   recomputePcReceiveTotals rolls the header subtotal/total. Line CRUD recounts
   received_qty onto the PC Order AND resyncs the inventory IN (on-ledger).
   ════════════════════════════════════════════════════════════════════════ */

/* ── PATCH /:id — header update ── */
purchaseConsignmentReceives.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of [
    ['supplierId', 'supplier_id'], ['receivedAt', 'received_at'],
    ['deliveryNoteRef', 'delivery_note_ref'],
    ['notes', 'notes'], ['currency', 'currency'],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  /* A cleared received-date posts "" and this loop wrote it through to the
     date column, which Postgres rejects and 500s the save. */
  coerceEmptyDates(updates);
  const { data, error } = await scopeToCompanyId(sb.from('purchase_consignment_receives').update(updates).eq('id', id), co.companyId).select(HEADER).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ receive: data });
});

/* ── POST /:id/items — add one receive_item. qty maps to qty_received. ── */
purchaseConsignmentReceives.post('/:id/items', async (c) => {
  const receiveId = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.itemCode) return c.json({ error: 'item_code_required' }, 400);
  if (!it.materialName) return c.json({ error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* The child is stamped with the active company; the parent it hangs off must
     be this company's too, or a line lands on another company's PC Receive. */
  const { data: parent } = await scopeToCompanyId(sb.from('purchase_consignment_receives').select('id').eq('id', receiveId), co.companyId).maybeSingle();
  if (!parent) return c.json(NOT_THIS_COMPANY, 404);
  // Child-lock: a receive with any downstream PC Return is read-only.
  const childLock = await pcReceiveHasDownstream(sb, receiveId);
  if (childLock) return c.json(childLock, 409);

  const qtyReceived = Number(it.qty ?? 1);
  const unitPriceSen = Number(it.unitPriceSen ?? 0);
  const discountSen = Number(it.discountSen ?? 0);
  const lineTotal = (qtyReceived * unitPriceSen) - discountSen;

  /* Over-receipt guard — a PC-order-linked added line can't accept more than the
     PC Order line's remaining (qty - received_qty). Manual lines uncapped. */
  const addLinePcoItemId = (it.pcOrderItemId as string) ?? null;
  if (addLinePcoItemId) {
    const xl = await assertSourceLinesInCompany(sb, c, 'purchase_consignment_order_items', [addLinePcoItemId]);
    if (!xl.ok) return c.json(xl.body, xl.status);
    const capLock = await qtyCapRefusal(sb, {
      table: 'purchase_consignment_order_items', id: addLinePcoItemId,
      capColumn: 'qty', drawnColumns: ['received_qty'],
      requested: qtyReceived, what: 'PC Order line',
    });
    if (capLock) return c.json({ ...capLock, pcoItemId: addLinePcoItemId }, 409);
  }

  const row: Record<string, unknown> = {
    pc_receive_id: receiveId,
    pc_order_item_id: (it.pcOrderItemId as string) ?? null,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    item_code: it.itemCode,
    material_name: it.materialName,
    supplier_sku: (it.supplierSku as string) ?? null,
    qty_received: qtyReceived,
    qty_accepted: qtyReceived,
    qty_rejected: 0,
    unit_price_sen: unitPriceSen,
    discount_sen: discountSen,
    line_total_sen: lineTotal,
    unit_cost_sen: Number(it.unitCostSen ?? 0),
    notes: (it.notes as string) ?? null,
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
    delivery_date: dateOrNull(it.deliveryDate),
  };
  const { data, error } = await sb.from('purchase_consignment_receive_items').insert({ company_id: activeCompanyId(c), ...row }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  /* POST-INSERT over-receipt verification — the pre-check is a read-then-write
     race. After committing, re-read the PC Order line's qty + the LIVE sum of
     qty_accepted across all non-cancelled receive lines for it; if that now
     exceeds qty, OUR insert broke the cap → delete it + 409. */
  if (addLinePcoItemId) {
    const inserted = data as unknown as { id: string } | null;
    const { data: pcoItem } = await sb.from('purchase_consignment_order_items')
      .select('qty').eq('id', addLinePcoItemId).maybeSingle();
    if (pcoItem) {
      const cap = (pcoItem as { qty: number }).qty ?? 0;
      const { data: sib } = await sb.from('purchase_consignment_receive_items')
        .select('qty_accepted, pc_receive_id').eq('pc_order_item_id', addLinePcoItemId);
      const sibRows = (sib ?? []) as Array<{ qty_accepted: number; pc_receive_id: string }>;
      const receiveIds = [...new Set(sibRows.map((r) => r.pc_receive_id))];
      const cancelled = new Set<string>();
      if (receiveIds.length > 0) {
        const { data: gs } = await sb.from('purchase_consignment_receives').select('id, status').in('id', receiveIds);
        for (const g of (gs ?? []) as Array<{ id: string; status: string }>) {
          if (g.status === 'CANCELLED') cancelled.add(g.id);
        }
      }
      const liveAccepted = sibRows
        .filter((r) => !cancelled.has(r.pc_receive_id))
        .reduce((s, r) => s + Number(r.qty_accepted ?? 0), 0);
      if (liveAccepted > cap && inserted?.id) {
        await sb.from('purchase_consignment_receive_items').delete().eq('id', inserted.id);
        return c.json({ error: 'qty_exceeds_remaining', pcoItemId: addLinePcoItemId, requested: qtyReceived, remaining: cap - (liveAccepted - qtyReceived) }, 409);
      }
    }
  }

  await recomputePcReceiveTotals(sb, receiveId);
  // Roll the added line's qty onto the PC Order. Best-effort.
  try { await recomputePcoReceived(sb, [addLinePcoItemId]); } catch { /* best-effort */ }
  // Book the added line's stock IN (self-healing resync). Best-effort.
  try { await resyncReceiveInventory(sb, receiveId, c.get('user')?.id ?? null); } catch { /* best-effort */ }
  return c.json({ item: data }, 201);
});

/* ── PATCH /:id/items/:itemId — partial line update. qty → qty_received. ── */
purchaseConsignmentReceives.patch('/:id/items/:itemId', async (c) => {
  const receiveId = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Child-lock: a receive with any downstream PC Return is read-only.
  const childLock = await pcReceiveHasDownstream(sb, receiveId);
  if (childLock) return c.json(childLock, 409);

  const { data: prev } = await scopeToCompanyId(sb.from('purchase_consignment_receive_items')
    .select('qty_received, qty_accepted, unit_price_sen, discount_sen, item_group, variants, pc_order_item_id, item_code, material_name')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);

  const qtyReceived = it.qty !== undefined ? Number(it.qty) : (prev as { qty_received: number }).qty_received;

  /* Over-receipt guard on edit — a PC-order-linked line can't be raised past the
     PC Order line's headroom = qty - (received_qty - this line's current
     receipt). Manual lines uncapped. */
  {
    const pcoItemId = (prev as { pc_order_item_id: string | null }).pc_order_item_id;
    const prevQty = (prev as { qty_received: number }).qty_received ?? 0;
    if (pcoItemId && qtyReceived > prevQty) {
      const capLock = await qtyCapRefusal(sb, {
        table: 'purchase_consignment_order_items', id: pcoItemId,
        capColumn: 'qty', drawnColumns: ['received_qty'],
        requested: qtyReceived, ownPriorDraw: prevQty, what: 'PC Order line',
      });
      if (capLock) return c.json({ ...capLock, pcoItemId }, 409);
    }
  }

  const unit = it.unitPriceSen !== undefined ? Number(it.unitPriceSen) : (prev as { unit_price_sen: number }).unit_price_sen;
  const discount = it.discountSen !== undefined ? Number(it.discountSen) : ((prev as { discount_sen: number }).discount_sen ?? 0);
  const lineTotal = (qtyReceived * unit) - discount;

  const updates: Record<string, unknown> = {
    qty_received: qtyReceived,
    qty_accepted: qtyReceived,
    unit_price_sen: unit,
    discount_sen: discount,
    line_total_sen: lineTotal,
  };
  for (const [from, to] of [
    ['itemCode', 'item_code'], ['materialName', 'material_name'],
    ['supplierSku', 'supplier_sku'], ['itemGroup', 'item_group'],
    ['description', 'description'], ['uom', 'uom'],
    ['unitCostSen', 'unit_cost_sen'], ['notes', 'notes'],
    ['gapInches', 'gap_inches'], ['divanHeightInches', 'divan_height_inches'],
    ['divanPriceSen', 'divan_price_sen'], ['legHeightInches', 'leg_height_inches'],
    ['legPriceSen', 'leg_price_sen'], ['customSpecials', 'custom_specials'],
    ['lineSuffix', 'line_suffix'], ['specialOrderPriceSen', 'special_order_price_sen'],
    ['variants', 'variants'], ['deliveryDate', 'delivery_date'],
  ] as const) {
    if (it[from] !== undefined) updates[to] = it[from];
  }
  coerceEmptyDates(updates);
  /* description2 is server-owned: recompute from effective itemGroup + variants. */
  {
    const effGroup = (it.itemGroup ?? (prev as { item_group?: string }).item_group) as string | null | undefined;
    const effVariants = (it.variants ?? (prev as { variants?: unknown }).variants) as Record<string, unknown> | null | undefined;
    updates['description2'] = buildVariantSummary(String(effGroup ?? ''), effVariants ?? null) || null;
  }

  const { error } = await scopeToCompanyId(sb.from('purchase_consignment_receive_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

  await recomputePcReceiveTotals(sb, receiveId);
  // Editing qty_accepted changes how much the PC Order counts as received —
  // recount it. Best-effort.
  try { await recomputePcoReceived(sb, [(prev as { pc_order_item_id: string | null }).pc_order_item_id]); } catch { /* best-effort */ }
  // Adjust inventory by the qty/variant delta (self-healing resync). Best-effort.
  try { await resyncReceiveInventory(sb, receiveId, c.get('user')?.id ?? null); } catch { /* best-effort */ }
  return c.json({ ok: true });
});

/* ── DELETE /:id/items/:itemId — remove a line + roll back its PC Order receipt. ──
   Reads the line's pc_order_item_id BEFORE delete, then recounts the PC Order's
   received_qty from live lines and resyncs inventory (the deleted line's IN is
   driven back out). Blocked by the child-lock (any downstream PC Return). */
purchaseConsignmentReceives.delete('/:id/items/:itemId', async (c) => {
  const receiveId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  // Child-lock: a receive with any downstream PC Return is read-only.
  const childLock = await pcReceiveHasDownstream(sb, receiveId);
  if (childLock) return c.json(childLock, 409);

  /* Scoped delete doubles as the tenancy gate and hands back the line's
     pc_order_item_id for the PC Order recount below. */
  const { data: del, error } = await scopeToCompanyId(sb.from('purchase_consignment_receive_items').delete().eq('id', itemId), co.companyId).select('pc_order_item_id').maybeSingle();
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  if (!del) return c.json(NOT_THIS_COMPANY, 404);

  const l = del as { pc_order_item_id: string | null };
  // Recount the PC Order receipt for the removed line's source (best-effort).
  try { await recomputePcoReceived(sb, [l.pc_order_item_id]); } catch { /* best-effort */ }

  await recomputePcReceiveTotals(sb, receiveId);
  // Give the deleted line's stock back OUT (self-healing resync). Best-effort.
  try { await resyncReceiveInventory(sb, receiveId, c.get('user')?.id ?? null); } catch { /* best-effort */ }
  return c.body(null, 204);
});
