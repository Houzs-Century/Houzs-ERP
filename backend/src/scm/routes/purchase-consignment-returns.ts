// ----------------------------------------------------------------------------
// /purchase-consignment-returns — we send consigned goods back to the supplier.
//
// Closes the consignment loop: PC Order → PC Receive → (defect / oversupply /
// wrong item) → PC Return → supplier credit note.
//
// ON-LEDGER (since 2026-06-05): a Purchase Consignment Return ships the
// SUPPLIER'S consigned goods back out of MY warehouse, so it books an OUT just
// like a normal Purchase Return. Inventory is reconciled by resyncPcReturnInventory
// (below), self-healing on create / line CRUD / post / complete / cancel (cancel
// nets the OUT back to zero → an IN reversal). (It originally shipped off-ledger;
// the OUT ledger was added 2026-06-05.)
//
// Cloned from /purchase-returns (apps/api/src/routes/purchase-returns.ts). It
// still differs from a plain PR in two ways:
//   • Rollup target is the PC RECEIVE line (adjustPcReceiveReturnedQty,
//     recount-from-live), which in turn re-opens the PC Order received_qty via
//     recomputePcoReceived; the over-return cap is vs the PC Receive line.
//   • Inventory is reconciled by a single self-healing resync (resyncPcReturnInventory)
//     rather than PR's per-step writeMovements + reverseMovements plumbing.
//   • KEPT: create (header + items), line CRUD, list, detail, status lifecycle
//     (post/complete/cancel).
//
// Tables: purchase_consignment_returns / purchase_consignment_return_items
//   (migration 0154). FK renames: return→pc_receive_id / pc_order_id;
//   return_items→pc_receive_item_id.
// Numbering: PCT-YYMM-NNN.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { qtyCapRefusal } from '../lib/qty-cap';
import { buildVariantSummary, computeVariantKey, type VariantAttrs } from '../shared';
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '../shared/so-line-display';
import { writeMovements, defaultWarehouseId, resolveWarehouseLotBatches } from '../lib/inventory-movements';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { todayMyt } from '../lib/my-time';
import { enrichLinesWithFabricSupplierCode } from '../lib/fabric-supplier-code';
import { recomputePcoReceived } from './purchase-consignment-receives';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix,
  requireActiveCompanyId, scopeToCompanyId, NOT_THIS_COMPANY,
  isCrossCompanySource, crossCompanyConversionBlocked } from '../lib/companyScope';

export const purchaseConsignmentReturns = new Hono<{ Bindings: Env; Variables: Variables }>();
purchaseConsignmentReturns.use('*', supabaseAuth);

/* ── resyncPcReturnInventory — self-healing OUT ledger for a PC Return ─────────
   ONE function for the whole lifecycle (post / add-line / edit-qty / delete-line
   / cancel), mirroring resyncNoteInventory (OUT-primary — a supplier return ships
   the consigned stock back OUT). It reconciles the return's CURRENT lines (the
   TARGET net OUT per warehouse/product/variant/batch bucket) against what
   inventory_movements already record for this return, and writes only the DELTA:
     • first-ever OUT for a bucket  → PC_RETURN  (carries the "stock out" label;
       PC_RETURN has no unique index, but we keep the first/delta split for
       consistency with the note template)
     • any later increase           → STOCK_TRANSFER OUT
     • any decrease / give-back     → STOCK_TRANSFER IN
     • cancel → status CANCELLED → TARGET is empty → every bucket's net is driven
       back to 0 via STOCK_TRANSFER IN.
   Each line's warehouse resolves via pc_receive_item_id → receive →
   receive.warehouse_id, falling back to the header receive's warehouse, then the
   default. Sofa batch via resolveWarehouseLotBatches per warehouse. A return posts
   on create — it is "active" (books OUT) whenever status !== 'CANCELLED'.
   Idempotent: a re-run finds delta 0 everywhere and writes nothing. Best-effort. */
async function resyncPcReturnInventory(sb: any, returnId: string, performedBy: string | null): Promise<string[]> {
  const { data: header } = await sb.from('purchase_consignment_returns')
    .select('return_number, status, pc_receive_id, company_id').eq('id', returnId).maybeSingle();
  if (!header) return [];
  const status = ((header as { status: string | null }).status ?? '').toUpperCase();
  const returnNo = (header as { return_number: string }).return_number ?? returnId;
  const cancelled = status === 'CANCELLED';

  // Header receive's warehouse — the fallback when a line has no receive link.
  let headerWh: string | null = null;
  if ((header as { pc_receive_id: string | null }).pc_receive_id) {
    const { data: rcv } = await sb.from('purchase_consignment_receives')
      .select('warehouse_id').eq('id', (header as { pc_receive_id: string }).pc_receive_id).maybeSingle();
    headerWh = (rcv as { warehouse_id: string | null } | null)?.warehouse_id ?? null;
  }
  /* Per-company default (2026-08-03) — the old lookup was company-blind and let
     alphabetical `code` order pick across every company's is_default rows. */
  const fallbackWh = headerWh
    ?? (await defaultWarehouseId(sb, (header as { company_id?: number | null }).company_id ?? undefined));

  // 1. TARGET net OUT per bucket = sum of current lines (empty if cancelled).
  type Bucket = { warehouse_id: string; product_code: string; variant_key: string; product_name: string | null; qty: number; batch_no: string | null };
  const targetByBucket = new Map<string, Bucket>();
  if (!cancelled) {
    const { data: lines } = await sb.from('purchase_consignment_return_items')
      .select('pc_receive_item_id, material_code, material_name, qty_returned, item_group, variants')
      .eq('purchase_consignment_return_id', returnId);
    const lineList = ((lines ?? []) as Array<{
      pc_receive_item_id: string | null; material_code: string; material_name: string | null;
      qty_returned: number | null; item_group: string | null; variants: unknown;
    }>);

    // Resolve per-line warehouse via receive_item → receive (handles multi-receive batches).
    const recvItemIds = [...new Set(lineList.map((l) => l.pc_receive_item_id).filter((x): x is string => !!x))];
    const whByRecvItem = new Map<string, string | null>();
    if (recvItemIds.length) {
      const { data: ri } = await sb.from('purchase_consignment_receive_items')
        .select('id, pc_receive_id').in('id', recvItemIds);
      const riRows = (ri ?? []) as Array<{ id: string; pc_receive_id: string }>;
      const recvIds = [...new Set(riRows.map((r) => r.pc_receive_id).filter(Boolean))];
      const { data: recvs } = recvIds.length
        ? await sb.from('purchase_consignment_receives').select('id, warehouse_id').in('id', recvIds)
        : { data: [] };
      const whByRecv = new Map(((recvs ?? []) as Array<{ id: string; warehouse_id: string | null }>).map((r) => [r.id, r.warehouse_id]));
      for (const r of riRows) whByRecvItem.set(r.id, whByRecv.get(r.pc_receive_id) ?? null);
    }

    // Resolve dye-lot batches for every warehouse the return pulls out of, so a
    // returned sofa consumes the right lot.
    const allWh = [...new Set(lineList.map((l) => (l.pc_receive_item_id ? whByRecvItem.get(l.pc_receive_item_id) : null) ?? fallbackWh).filter((x): x is string => !!x))];
    const batchByWh = new Map<string, Map<string, string | null>>();
    for (const wh of allWh) batchByWh.set(wh, await resolveWarehouseLotBatches(sb, wh));

    for (const it of lineList) {
      const qty = Number(it.qty_returned ?? 0);
      if (qty <= 0) continue;
      const wh = (it.pc_receive_item_id ? whByRecvItem.get(it.pc_receive_item_id) : null) ?? fallbackWh;
      if (!wh) continue;
      const vk = computeVariantKey(it.item_group, (it.variants as VariantAttrs | null) ?? null);
      const batch = batchByWh.get(wh)?.get(`${it.material_code}::${vk}`) ?? null;
      const k = `${wh}::${it.material_code}::${vk}::${batch ?? ''}`;
      const cur = targetByBucket.get(k);
      if (cur) cur.qty += qty;
      else targetByBucket.set(k, { warehouse_id: wh, product_code: it.material_code, variant_key: vk, product_name: it.material_name, qty, batch_no: batch });
    }
  }

  // 2. CURRENT net OUT per bucket from ALL this return's movements (PC_RETURN OUT
  //    + any prior STOCK_TRANSFER resync/cancel deltas).
  const { data: movs } = await sb.from('inventory_movements')
    .select('movement_type, warehouse_id, product_code, variant_key, batch_no, qty, total_cost_sen, product_name')
    .eq('source_doc_id', returnId)
    .in('source_doc_type', ['PC_RETURN', 'STOCK_TRANSFER']);
  type Agg = { out_qty: number; in_qty: number; out_total_cost: number; product_name: string | null };
  const aggByBucket = new Map<string, Agg>();
  for (const m of (movs ?? []) as Array<{ movement_type: string; warehouse_id: string; product_code: string; variant_key: string | null; batch_no?: string | null; qty: number; total_cost_sen: number | null; product_name: string | null }>) {
    const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    let a = aggByBucket.get(k);
    if (!a) { a = { out_qty: 0, in_qty: 0, out_total_cost: 0, product_name: m.product_name }; aggByBucket.set(k, a); }
    if (m.movement_type === 'OUT') { a.out_qty += Number(m.qty ?? 0); a.out_total_cost += Number(m.total_cost_sen ?? 0); }
    else if (m.movement_type === 'IN') a.in_qty += Number(m.qty ?? 0);
    if (!a.product_name) a.product_name = m.product_name;
  }

  // 3. delta = target − current_net_out. >0 → ship more OUT; <0 → give stock back IN.
  type MovOut = Parameters<typeof writeMovements>[1][number];
  const writes: MovOut[] = [];
  const pcReturnEmitted = new Set<string>(); // product::variant given a PC_RETURN this run
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
      const usePcReturn = neverMoved && !pcReturnEmitted.has(`${pc}::${vk}`);
      if (usePcReturn) pcReturnEmitted.add(`${pc}::${vk}`);
      writes.push({
        movement_type: 'OUT', warehouse_id: wh ?? '', product_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: delta,
        source_doc_type: usePcReturn ? 'PC_RETURN' : 'STOCK_TRANSFER',
        source_doc_id: returnId, source_doc_no: returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: usePcReturn ? 'Consignment goods returned to supplier — stock out' : 'PC Return resync: line qty increased / added.',
      });
    } else {
      const unitCost = a.out_qty > 0 ? Math.round(a.out_total_cost / a.out_qty) : 0;
      writes.push({
        movement_type: 'IN', warehouse_id: wh ?? '', product_code: pc ?? '', variant_key: vk ?? '', product_name: pname,
        qty: -delta, unit_cost_sen: unitCost,
        source_doc_type: 'STOCK_TRANSFER',
        source_doc_id: returnId, source_doc_no: cancelled ? `${returnNo}-CANCEL` : returnNo,
        ...(batch_no ? { batch_no } : {}),
        performed_by: performedBy,
        notes: cancelled ? 'PC Return cancelled — stock back IN' : 'PC Return resync: line qty reduced / deleted.',
      });
    }
  }

  if (writes.length === 0) return [];
  // Multi-company: resync movements inherit the return's company.
  const res = await writeMovements(sb, writes, (header as { company_id?: number | null }).company_id ?? null);
  /* Oversell retro-cost (0154) — a reduced / cancelled PC return writes a
     lot-opening IN (goods never left for the supplier after all), so a prior
     "ship anyway" DO that went out at RM0 in this warehouse can now be costed
     from it. Wired 2026-07-29; before that only a GRN reconciled (COE §2).
     Best-effort. */
  if (res.ok) await reconcileUncostedAfterIn(sb, writes, performedBy);
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch { /* best-effort */ }
  return res.ok ? [] : [res.reason ?? 'PC return inventory resync failed'];
}

const HEADER =
  'id, return_number, pc_order_id, pc_receive_id, supplier_id, return_date, ' +
  'reason, status, posted_at, completed_at, credit_note_ref, refund_centi, ' +
  'notes, created_at, created_by, updated_at';
const ITEM =
  'id, purchase_consignment_return_id, pc_receive_item_id, material_kind, material_code, ' +
  'material_name, qty_returned, unit_price_centi, line_refund_centi, reason, notes, ' +
  /* item_group + variants drive the canonical SKU/build read-order sort (the
     sofa module walk + category rank); selected here so the PC Return detail +
     PDF order matches the sales side. */
  'item_group, variants, created_at';

const nextNum = async (sb: any, c: any): Promise<string> => {
  // PCT-YYMM-NNN. max(suffix)+1 (NEVER count+1) so a deleted mid-month row can't
  // make the counter re-mint a surviving number forever — see doc-no.ts.
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'purchase_consignment_returns', 'return_number', `${p}PCT-${yymm}`);
};

/* ── Recompute PC Return header money rollup ───────────────────────────────
   Sum line_refund_centi across return_items → write refund_centi on the header.
   A return is qty × unit price (no tax/discount), so refund_centi is the total.

   Fails CLOSED and never throws (2026-07-17) — same contract as the SO's
   recomputeTotals (mfg-sales-orders.ts), which carries the full rationale.
   See BUG-HISTORY 2026-07-17 (fix/zeroing-twins). */
async function recomputePcReturnTotals(sb: any, prId: string) {
  const { data: items, error: itemsErr } = await sb.from('purchase_consignment_return_items')
    .select('line_refund_centi')
    .eq('purchase_consignment_return_id', prId);
  /* A failed READ is not an empty return, and `?? []` cannot tell them apart — it
     folded a transient blip into refund_centi ZERO, i.e. a refund owed silently
     became no refund. The ERROR is the signal, never the emptiness: a genuinely
     empty return resolves error === null with data === [] and MUST still fall
     through to zero the header. */
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pcret-recompute] item read failed — header left unchanged:', prId, itemsErr.message);
    return;
  }
  const refund = (items ?? []).reduce((s: number, r: any) => s + (r.line_refund_centi ?? 0), 0);
  const { error: updErr } = await sb.from('purchase_consignment_returns').update({
    refund_centi: refund,
    updated_at: new Date().toISOString(),
  }).eq('id', prId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[pcret-recompute] header update failed — refund left STALE:', prId, updErr.message);
  }
}

/* ── PC-Receive→PC-Return consumption helper (recount-from-live) ─────────────
   Track purchase_consignment_receive_items.returned_qty as PR lines are drawn
   from / adjusted against / released back to a receive line. base = qty_accepted
   (you can return up to what was accepted); remaining = qty_accepted -
   returned_qty. returned_qty is the SUM of qty_returned across LIVE
   (non-cancelled) PC return lines for this receive line, clamped to
   [0, qty_accepted]. A recount self-heals (no `cur + delta` drift). Returning
   goods then nets down the parent PC Order's received_qty via
   recomputePcoReceived. This helper only moves the returned-qty rollup; the
   inventory OUT is handled separately by resyncPcReturnInventory. */
async function adjustPcReceiveReturnedQty(sb: any, receiveItemId: string, _delta?: number) {
  if (!receiveItemId) return;
  const { data: prLines } = await sb.from('purchase_consignment_return_items')
    .select('qty_returned, purchase_consignment_return_id')
    .eq('pc_receive_item_id', receiveItemId);
  const rows = (prLines ?? []) as Array<{ qty_returned: number; purchase_consignment_return_id: string }>;
  const prIds = [...new Set(rows.map((r) => r.purchase_consignment_return_id).filter(Boolean))];
  const cancelled = new Set<string>();
  if (prIds.length > 0) {
    const { data: prs } = await sb.from('purchase_consignment_returns').select('id, status').in('id', prIds);
    for (const p of (prs ?? []) as Array<{ id: string; status: string }>) {
      if ((p.status ?? '').toUpperCase() === 'CANCELLED') cancelled.add(p.id);
    }
  }
  let returned = 0;
  for (const r of rows) if (!cancelled.has(r.purchase_consignment_return_id)) returned += Number(r.qty_returned ?? 0);

  const { data: gi } = await sb.from('purchase_consignment_receive_items')
    .select('qty_accepted, pc_order_item_id').eq('id', receiveItemId).maybeSingle();
  if (!gi) return;
  const accepted = (gi as { qty_accepted: number }).qty_accepted ?? 0;
  const next = Math.min(accepted, Math.max(0, returned)); // clamp [0, accepted]
  await sb.from('purchase_consignment_receive_items').update({ returned_qty: next }).eq('id', receiveItemId);
  // Returning goods nets down the parent PC Order line's received_qty (re-opens
  // for a replacement shipment). Recount it from live receive lines.
  const pcoItemId = (gi as { pc_order_item_id: string | null }).pc_order_item_id;
  if (pcoItemId) await recomputePcoReceived(sb, [pcoItemId]);
}

purchaseConsignmentReturns.get('/', async (c) => {
  const sb = c.get('supabase');
  let q = sb.from('purchase_consignment_returns')
    .select(`${HEADER}, supplier:suppliers(id, code, name), purchase_consignment_order:purchase_consignment_orders(id, pc_number), pc_receive:purchase_consignment_receives(id, receive_number)`)
    .order('return_date', { ascending: false })
    .limit(300);
  const status = c.req.query('status'); if (status) q = q.eq('status', status);
  const supplierId = c.req.query('supplierId'); if (supplierId) q = q.eq('supplier_id', supplierId);
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ purchaseReturns: data ?? [] });
});

// ── Returnable PC Receive lines (From-Receive multi-picker) ───────────────
// Every purchase_consignment_receive_item with remaining = qty_accepted −
// returned_qty still > 0, across all non-cancelled PC Receives. Mirrors the
// DO→DR returnable picker. MUST precede /:id so the static path isn't an id.
purchaseConsignmentReturns.get('/returnable-receive-lines', async (c) => {
  const sb = c.get('supabase');
  const { data: receives, error: rErr } = await paginateAll((from, to) => scopeToCompany(
    sb
      .from('purchase_consignment_receives')
      .select('id, receive_number, supplier_id, status, supplier:suppliers(id, code, name)'),
    c,
  )
    .neq('status', 'CANCELLED')
    .order('receive_number', { ascending: false })
    .range(from, to));
  if (rErr) return c.json({ error: 'load_failed', reason: rErr.message }, 500);
  const recvList = (receives ?? []) as Array<{ id: string; receive_number: string; supplier_id: string | null; supplier?: { name?: string | null } | null }>;
  if (recvList.length === 0) return c.json({ lines: [] });
  const recvById = new Map(recvList.map((r) => [r.id, r]));
  const recvIds = recvList.map((r) => r.id);

  const { data: items, error: iErr } = await chunkIn<Record<string, unknown>>(recvIds, (batch, from, to) => sb
    .from('purchase_consignment_receive_items')
    .select('id, pc_receive_id, material_kind, material_code, material_name, item_group, description, uom, qty_accepted, returned_qty, unit_price_centi, variants')
    .in('pc_receive_id', batch)
    .range(from, to));
  if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
  const itemList = (items ?? []) as Array<Record<string, unknown>>;

  const lines = itemList.map((it) => {
    const r = recvById.get(it.pc_receive_id as string);
    const accepted = Number(it.qty_accepted ?? 0);
    const returned = Number(it.returned_qty ?? 0);
    return {
      receiveItemId: it.id as string,
      pcReceiveId: it.pc_receive_id as string,
      receiveNumber: r?.receive_number ?? '',
      supplierId: r?.supplier_id ?? null,
      supplierName: r?.supplier?.name ?? null,
      materialKind: (it.material_kind as string) ?? 'OTHER',
      materialCode: it.material_code as string,
      materialName: (it.material_name as string) ?? '',
      itemGroup: (it.item_group as string | null) ?? null,
      description: (it.description as string | null) ?? null,
      uom: (it.uom as string | null) ?? null,
      accepted,
      returned,
      remaining: accepted - returned,
      unitPriceCenti: Number(it.unit_price_centi ?? 0),
      variants: it.variants ?? null,
    };
  }).filter((l) => l.remaining > 0);

  return c.json({ lines });
});

purchaseConsignmentReturns.get('/:id', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const [h, i] = await Promise.all([
    scopeToCompany(sb.from('purchase_consignment_returns')
      .select(`${HEADER}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_consignment_order:purchase_consignment_orders(id, pc_number), pc_receive:purchase_consignment_receives(id, receive_number)`)
      .eq('id', id), c).maybeSingle(),
    sb.from('purchase_consignment_return_items').select(ITEM).eq('purchase_consignment_return_id', id).order('created_at'),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  /* Canonical SKU/build order at READ (sofa modules LHF→NA→RHF, mains→
     accessories→services), mirroring the SO detail GET. The shared helper keys
     on `item_code`; PC return lines expose `material_code`, so sort a shimmed
     view that carries the original row back unchanged. `.order('created_at')`
     above stays as the stable tiebreaker — pure ordering, no persistence touched. */
  type PctItemRow = Record<string, unknown> & { id: string; material_code: string; item_code: string };
  const items = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      ((i.data ?? []) as unknown as Array<Record<string, unknown> & { id: string; material_code: string }>)
        .map((it): PctItemRow => ({ ...it, item_code: it.material_code })),
      (r) => r.item_group as string | null | undefined,
    ),
  );
  // Stamp each line's supplier fabric code so the on-screen line reads
  // "BF-01 (PC151-01)" — same READ enrichment as the SO/PO/DO/SI details
  // (owner 2026-07-24). ONE batched query; fail-soft.
  await enrichLinesWithFabricSupplierCode(sb, c, items);
  return c.json({ purchaseReturn: h.data, items });
});

// ── Linked docs (Smart Buttons fan-out) ─────────────────────────────
// For a PC Return: the parent PC Receive + parent PC Order (both nullable).
purchaseConsignmentReturns.get('/:id/linked', async (c) => {
  /* Company-scoped like every other read on this router. Without it a caller in
     one company could resolve ANOTHER company's PC return to its linked document
     numbers by id. All seven /:id/linked endpoints shared this gap (found
     2026-08-12 by code read; two module guides claimed scoping that was absent). */
  const sb = c.get('supabase'); const id = c.req.param('id');
  const { data, error } = await scopeToCompany(sb
    .from('purchase_consignment_returns')
    .select(`
      id,
      pc_receive:purchase_consignment_receives(id, receive_number),
      purchase_consignment_order:purchase_consignment_orders(id, pc_number)
    `)
    .eq('id', id), c)
    .maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const raw = data as unknown as {
    pc_receive?: { id: string; receive_number: string } | Array<{ id: string; receive_number: string }> | null;
    purchase_consignment_order?: { id: string; pc_number: string } | Array<{ id: string; pc_number: string }> | null;
  };
  const receive: { id: string; receive_number: string } | null =
    Array.isArray(raw.pc_receive) ? (raw.pc_receive[0] ?? null) : (raw.pc_receive ?? null);
  const pco: { id: string; pc_number: string } | null =
    Array.isArray(raw.purchase_consignment_order) ? (raw.purchase_consignment_order[0] ?? null) : (raw.purchase_consignment_order ?? null);
  return c.json({ pcReceive: receive, purchaseConsignmentOrder: pco });
});

purchaseConsignmentReturns.post('/', async (c) => {
  /* company-scope: the source PC Receive named in the body is refused when it
     belongs to another company (isCrossCompanySource, below); the only by-id
     write is this handler's own rollback. Verified 2026-08-13. */
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (body.status === 'DRAFT') return c.json({ error: 'draft_status_not_supported', message: 'Consignment returns post immediately on create.' }, 400);
  if (!body.supplierId) return c.json({ error: 'supplier_required' }, 400);
  const items = body.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(items) || !items.length) return c.json({ error: 'items_required' }, 400);

  const sb = c.get('supabase'); const user = c.get('user');

  /* CROSS-COMPANY SOURCE (lib/companyScope) — the bare-create path takes the
     source receive as a body field and everything below stamps the ACTIVE
     company: the header, the lines, and the inventory OUT the resync books. A
     pcReceiveId from the other company would have this company return that
     company's consigned goods and net down its received_qty. Optional by design
     — a manual return sends no pcReceiveId and is unaffected. */
  if (body.pcReceiveId) {
    const { data: srcRecv, error: srcRecvErr } = await sb.from('purchase_consignment_receives')
      .select('receive_number, company_id').eq('id', body.pcReceiveId as string).maybeSingle();
    if (srcRecvErr) return c.json({ error: 'lookup_failed', reason: srcRecvErr.message }, 500);
    const src = srcRecv as { receive_number?: string | null; company_id?: number | null } | null;
    if (src && isCrossCompanySource(src.company_id, c)) {
      return c.json(crossCompanyConversionBlocked(src.receive_number ?? null, src.company_id, c), 409);
    }
  }

  /* Reject (don't clamp) any PC-receive-linked line that exceeds its remaining
     (qty_accepted - returned_qty) — matches the add-line + edit paths, which
     409 instead of silently normalizing. Manual lines (no pc_receive_item_id)
     are uncapped. */
  const preReceiveItemIds = [...new Set(items
    .map((it) => (it.pcReceiveItemId as string | undefined) ?? null)
    .filter((x): x is string => !!x))];
  const remainingByReceiveItem = new Map<string, number>();
  if (preReceiveItemIds.length > 0) {
    const { data: giRows } = await sb.from('purchase_consignment_receive_items')
      .select('id, qty_accepted, returned_qty').in('id', preReceiveItemIds);
    for (const r of (giRows ?? []) as Array<{ id: string; qty_accepted: number; returned_qty: number }>) {
      remainingByReceiveItem.set(r.id, Math.max(0, (r.qty_accepted ?? 0) - (r.returned_qty ?? 0)));
    }
  }
  for (const it of items) {
    const receiveItemId = (it.pcReceiveItemId as string | undefined) ?? null;
    if (receiveItemId && remainingByReceiveItem.has(receiveItemId)) {
      const requested = Number(it.qtyReturned ?? 0);
      const remaining = remainingByReceiveItem.get(receiveItemId) as number;
      if (requested > remaining) {
        return c.json({ error: 'qty_exceeds_remaining', requested, remaining, materialCode: it.materialCode ?? null }, 409);
      }
    }
  }

  let totalRefund = 0;
  const itemRows = items.map((it) => {
    const receiveItemId = (it.pcReceiveItemId as string | undefined) ?? null;
    const qty = Number(it.qtyReturned ?? 0);
    const unit = Number(it.unitPriceCenti ?? 0);
    const lineRefund = qty * unit;
    totalRefund += lineRefund;
    return {
      pc_receive_item_id: receiveItemId,
      material_kind: it.materialKind,
      material_code: it.materialCode,
      material_name: it.materialName,
      qty_returned: qty,
      unit_price_centi: unit,
      line_refund_centi: lineRefund,
      reason: (it.reason as string | undefined) ?? null,
      notes: (it.notes as string | undefined) ?? null,
      item_group: (it.itemGroup as string | null | undefined) ?? null,
      variants: (it.variants as Record<string, unknown> | null | undefined) ?? null,
      // description2 = rendered variant + SPECIAL summary. The server-convert
      // paths already set it; this New-page create was the one path that dropped
      // it, leaving PCRet rows inconsistent with every sibling table (2026-07-20).
      description2: buildVariantSummary(
        String((it.itemGroup as string | null | undefined) ?? ''),
        (it.variants as Record<string, unknown> | null | undefined) ?? null,
      ) || null,
    };
  }).filter((r) => Number(r.qty_returned) > 0);

  if (itemRows.length === 0) {
    return c.json({ error: 'no_returnable_qty', message: 'Every line is already fully returned (nothing left to return).' }, 400);
  }

  // PC Return is created POSTED. The inventory OUT is booked by the resync below.
  const pcOrderId = (body.pcOrderId as string | undefined) ?? null;
  const pcReceiveId = (body.pcReceiveId as string | undefined) ?? null;
  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('purchase_consignment_returns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    return_number: returnNumber,
    pc_order_id: pcOrderId,
    pc_receive_id: pcReceiveId,
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

  const rowsWithId = itemRows.map((r) => ({ ...r, purchase_consignment_return_id: h.id }));
  const { error: iErr } = await sb.from('purchase_consignment_return_items').insert(stampCompany(rowsWithId, c));
  if (iErr) {
    await sb.from('purchase_consignment_returns').delete().eq('id', h.id);
    return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500);
  }

  /* Consume each PC-receive-linked line's returned_qty (recount-from-live), which
     nets down the source receive line + PC Order received_qty. Manual lines (no
     pc_receive_item_id) are skipped. (Inventory OUT is resynced separately below.) */
  for (const r of itemRows) {
    if (r.pc_receive_item_id) await adjustPcReceiveReturnedQty(sb, r.pc_receive_item_id, Number(r.qty_returned));
  }

  // Inventory OUT — pull the returned stock back out of its receive's warehouse.
  // Self-healing resync (idempotent + best-effort).
  try { await resyncPcReturnInventory(sb, h.id, user.id); } catch { /* best-effort */ }

  return c.json({ id: h.id, returnNumber: h.return_number }, 201);
});

// Batch-convert multiple POSTED PC Receives into ONE PC Return. Aggregates all
// qty_rejected lines across the selected receives (must share a supplier).
/* Exported so the company-scope tests can drive it without the supabaseAuth
   bridge, which cannot run in the vitest harness. Same reason
   createPurchaseInvoiceFromGrnHandler and appendDoLinesToSalesInvoiceHandler
   are exported; the route registration below is unchanged. */
export const createPcReturnFromPcReceivesHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: both source reads below are SCOPED, so another company's PC
     Receive is not visible here at all; the by-id write is this handler's own
     rollback. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { pcReceiveIds?: string[]; reason?: string; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const receiveIds = body.pcReceiveIds ?? [];
  if (receiveIds.length === 0) return c.json({ error: 'pc_receive_ids_required' }, 400);

  /* SOURCE LOAD, SCOPED — the receive ids arrive in the request body, so this is
     the read that decides what this conversion can see. Scoped, so another
     company's receive resolves to NO ROW and falls out at
     `pc_receives_not_found`.
     REPLACED an isCrossCompanySource loop that ran right after this load and can
     no longer fire.

     THE COST: a hand-crafted request naming the other company's receive gets
     `pc_receives_not_found` instead of "that receive belongs to 2990, switch
     company" — the trade the PO's /:id/convert-from-so already records, taken
     here for the same reason. */
  const { data: receives, error: recvErr } = await scopeToCompany(sb.from('purchase_consignment_receives')
    .select('id, receive_number, supplier_id, purchase_consignment_order_id, status, company_id')
    .in('id', receiveIds), c);
  if (recvErr) return c.json({ error: 'load_failed', reason: recvErr.message }, 500);
  const recvList = (receives ?? []) as Array<{ id: string; receive_number: string; supplier_id: string; purchase_consignment_order_id: string | null; status: string; company_id?: number | null }>;
  if (recvList.length === 0) return c.json({ error: 'pc_receives_not_found' }, 404);

  const notPosted = recvList.filter((g) => g.status !== 'POSTED');
  if (notPosted.length > 0) {
    return c.json({ error: 'not_all_posted', message: `These receives are not POSTED: ${notPosted.map((g) => g.receive_number).join(', ')}` }, 400);
  }
  const supplierIds = new Set(recvList.map((g) => g.supplier_id));
  if (supplierIds.size > 1) {
    return c.json({ error: 'mixed_suppliers', message: 'All selected receives must be from the same supplier' }, 400);
  }
  const supplierId = [...supplierIds][0]!;

  // LINE-level half of the same source document — same predicate as the header
  // read above, because `.in('pc_receive_id', receiveIds)` is itself an id-keyed
  // read and that is the shape this sweep exists for.
  const { data: items } = await scopeToCompany(sb.from('purchase_consignment_receive_items')
    .select('id, pc_receive_id, material_kind, material_code, material_name, qty_accepted, qty_rejected, returned_qty, rejection_reason, unit_price_centi, item_group, variants, description, description2, uom')
    .in('pc_receive_id', receiveIds)
    .gt('qty_rejected', 0), c);
  // Cap each line's return at its remaining (qty_accepted - returned_qty) — a
  // receive line can be returned across multiple PRs. Drop fully-returned lines.
  const rejectedItems = ((items ?? []) as Array<{
    id: string; pc_receive_id: string; material_kind: string; material_code: string; material_name: string;
    qty_accepted: number; qty_rejected: number; returned_qty: number; rejection_reason: string | null; unit_price_centi: number;
    item_group: string | null; variants: Record<string, unknown> | null; description: string | null; description2: string | null; uom: string | null;
  }>)
    .map((it) => {
      const remaining = (it.qty_accepted ?? 0) - (it.returned_qty ?? 0);
      return { ...it, _qty: Math.min(it.qty_rejected ?? 0, Math.max(0, remaining)) };
    })
    .filter((it) => it._qty > 0);
  if (rejectedItems.length === 0) {
    return c.json({ error: 'no_rejected_qty', message: 'None of the selected receives have remaining rejected qty to return' }, 400);
  }

  const recvNumbersJoined = recvList.map((g) => g.receive_number).join(', ');
  const totalRefund = rejectedItems.reduce((s, it) => s + (it._qty * it.unit_price_centi), 0);

  const primaryReceiveId = recvList[0]!.id;
  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('purchase_consignment_returns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    return_number: returnNumber,
    pc_order_id: recvList[0]!.purchase_consignment_order_id,
    pc_receive_id: primaryReceiveId,
    supplier_id: supplierId,
    return_date: todayMyt(),
    reason: body.reason ?? `Batch from ${recvList.length} receives: ${recvNumbersJoined}`,
    refund_centi: totalRefund,
    notes: body.notes ?? null,
    status: 'POSTED',
    posted_at: new Date().toISOString(),
    created_by: user.id,
  }).select('id, return_number').single(),
  );
  if (hErr) return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  const h = header as unknown as { id: string; return_number: string };

  const rows = rejectedItems.map((it) => ({
    purchase_consignment_return_id: h.id,
    pc_receive_item_id: it.id,
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
  const { error: iErr } = await sb.from('purchase_consignment_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('purchase_consignment_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  // Consume each receive line: recount returned_qty from live.
  for (const it of rejectedItems) {
    await adjustPcReceiveReturnedQty(sb, it.id, it._qty);
  }

  // Inventory OUT — pull the returned stock back out of its receive's warehouse.
  // Self-healing resync (idempotent + best-effort).
  try { await resyncPcReturnInventory(sb, h.id, user.id); } catch { /* best-effort */ }

  return c.json({ id: h.id, returnNumber: h.return_number, pcReceiveCount: recvList.length, lineCount: rejectedItems.length }, 201);
};
purchaseConsignmentReturns.post('/from-pc-receives', createPcReturnFromPcReceivesHandler);

/* ── POST /from-pc-receive ──────────────────────────────────────────────
   Single-receive convert. Copies ALL of the receive's accepted lines (remaining
   only) into a NEW PC Return so the user can trim qty in the draft. */
/* Exported so the company-scope tests can drive it without the supabaseAuth
   bridge, which cannot run in the vitest harness. Same reason
   createPurchaseInvoiceFromGrnHandler and appendDoLinesToSalesInvoiceHandler
   are exported; the route registration below is unchanged. */
export const createPcReturnFromPcReceiveHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  /* company-scope: both source reads below are SCOPED, so another company's PC
     Receive is not visible here at all; the remaining by-id statements read that
     receive's own lines and roll back this handler's own header. */
  const sb = c.get('supabase'); const user = c.get('user');
  let body: { pcReceiveId?: string; reason?: string; notes?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const receiveId = body.pcReceiveId;
  if (!receiveId) return c.json({ error: 'pc_receive_id_required' }, 400);

  /* SOURCE LOAD, SCOPED — pcReceiveId arrives in the request body, so this is
     the read that decides what this conversion can see. Scoped, so another
     company's receive resolves to NO ROW and falls out at
     `pc_receive_not_found`.
     REPLACED an isCrossCompanySource comparison that sat right after this load
     and can no longer fire.

     THE COST: a hand-crafted request naming the other company's receive gets
     `pc_receive_not_found` instead of "that receive belongs to 2990, switch
     company" — same trade, same reason, as the PO's /:id/convert-from-so. */
  const { data: receive, error: recvErr } = await scopeToCompany(sb.from('purchase_consignment_receives')
    .select('id, receive_number, supplier_id, purchase_consignment_order_id, status, company_id')
    .eq('id', receiveId), c).maybeSingle();
  if (recvErr) return c.json({ error: 'load_failed', reason: recvErr.message }, 500);
  if (!receive) return c.json({ error: 'pc_receive_not_found' }, 404);
  const g = receive as { id: string; receive_number: string; supplier_id: string; purchase_consignment_order_id: string | null; status: string; company_id?: number | null };
  if (g.status !== 'POSTED') return c.json({ error: 'pc_receive_not_posted', status: g.status }, 409);

  // LINE-level half of the same source document, under the same predicate.
  const { data: items } = await scopeToCompany(sb.from('purchase_consignment_receive_items')
    .select('id, material_kind, material_code, material_name, qty_accepted, qty_rejected, returned_qty, rejection_reason, unit_price_centi, item_group, variants, description, description2, uom')
    .eq('pc_receive_id', receiveId)
    .gt('qty_accepted', 0), c);
  const allLines = ((items ?? []) as Array<{
    id: string; material_kind: string; material_code: string; material_name: string;
    qty_accepted: number; qty_rejected: number; returned_qty: number; rejection_reason: string | null; unit_price_centi: number;
    item_group: string | null; variants: Record<string, unknown> | null; description: string | null; description2: string | null; uom: string | null;
  }>);
  const lines = allLines
    .map((it) => ({ ...it, _remaining: (it.qty_accepted ?? 0) - (it.returned_qty ?? 0) }))
    .filter((it) => it._remaining > 0);
  if (lines.length === 0) return c.json({ error: 'nothing_to_return', message: 'Receive is fully returned' }, 400);

  const totalRefund = lines.reduce((s, it) => s + (it._remaining * it.unit_price_centi), 0);

  const { data: header, error: hErr } = await insertWithDocNoRetry<{ id: string; return_number: string }>(
    () => nextNum(sb, c),
    (returnNumber) => sb.from('purchase_consignment_returns').insert({
    company_id: activeCompanyId(c), // multi-company: stamp the active company
    return_number: returnNumber,
    pc_order_id: g.purchase_consignment_order_id,
    pc_receive_id: g.id,
    supplier_id: g.supplier_id,
    return_date: todayMyt(),
    reason: body.reason ?? `From ${g.receive_number}`,
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
    purchase_consignment_return_id: h.id,
    pc_receive_item_id: it.id,
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
  const { error: iErr } = await sb.from('purchase_consignment_return_items').insert(stampCompany(rows, c));
  if (iErr) { await sb.from('purchase_consignment_returns').delete().eq('id', h.id); return c.json({ error: 'items_insert_failed', reason: iErr.message }, 500); }

  for (const it of lines) {
    await adjustPcReceiveReturnedQty(sb, it.id, it._remaining);
  }

  await recomputePcReturnTotals(sb, h.id);

  // Inventory OUT — pull the returned stock back out of its receive's warehouse.
  // Self-healing resync (idempotent + best-effort).
  try { await resyncPcReturnInventory(sb, h.id, user.id); } catch { /* best-effort */ }

  return c.json({ id: h.id, returnNumber: h.return_number }, 201);
};
purchaseConsignmentReturns.post('/from-pc-receive', createPcReturnFromPcReceiveHandler);

purchaseConsignmentReturns.patch('/:id/post', async (c) => {
  // Kept for backward compat; idempotent. POST creates PRs as POSTED.
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const { data: cur } = await scopeToCompanyId(sb.from('purchase_consignment_returns').select('id, status, posted_at, return_number, pc_receive_id').eq('id', id), co.companyId).maybeSingle();
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const row = cur as { id: string; status: string; posted_at: string | null; return_number: string; pc_receive_id: string | null };
  if (row.status === 'POSTED' || row.status === 'COMPLETED') {
    return c.json({ purchaseConsignmentReturn: row });
  }
  return c.json({ error: 'cannot_post', message: `Cannot post a ${row.status} return.` }, 409);
});

purchaseConsignmentReturns.patch('/:id/complete', async (c) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { creditNoteRef?: string };
  try { body = (await c.req.json()) as typeof body; } catch { body = {}; }

  /* Tenancy before the status guard: a cross-company return is not found (404),
     while a same-company non-POSTED return still surfaces not_posted (409). */
  const { data: cur, error: readErr } = await scopeToCompanyId(sb.from('purchase_consignment_returns')
    .select('id').eq('id', id), co.companyId).maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);

  const updates: Record<string, unknown> = {
    status: 'COMPLETED',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (body.creditNoteRef) updates.credit_note_ref = body.creditNoteRef;

  const { data, error } = await scopeToCompanyId(sb.from('purchase_consignment_returns').update(updates)
    .eq('id', id).eq('status', 'POSTED'), co.companyId).select('id, status, completed_at').maybeSingle();
  if (error) return c.json({ error: 'complete_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_posted' }, 409);
  return c.json({ purchaseConsignmentReturn: data });
});

/* ── PATCH /:id/cancel — cancel a PC Return ─────────────────────────────────
   Cancelling a PC Return sets status='CANCELLED' and releases the PC-receive-line
   consumption (recount returned_qty from live, which re-opens the PC Order
   received_qty). Inventory is reversed too (on-ledger since 2026-06-05): the
   resync drives the booked OUT back to zero. A COMPLETED return cannot be cancelled. */
export const cancelPurchaseConsignmentReturnHandler = async (c: any) => {
  const sb = c.get('supabase'); const id = c.req.param('id');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: cur, error: readErr } = await scopeToCompanyId(sb.from('purchase_consignment_returns')
    .select('id, status, return_number, pc_receive_id')
    .eq('id', id), co.companyId).maybeSingle();
  if (readErr) return c.json({ error: 'load_failed', reason: readErr.message }, 500);
  if (!cur) return c.json(NOT_THIS_COMPANY, 404);
  const head = cur as { id: string; status: string; return_number: string; pc_receive_id: string | null };
  if (head.status === 'COMPLETED') return c.json({ error: 'cannot_cancel', message: 'Already completed' }, 409);
  if (head.status === 'CANCELLED') return c.json({ purchaseConsignmentReturn: { id, status: 'CANCELLED' } });

  /* ATOMIC single ACTIVE→CANCELLED transition — two concurrent cancels race and
     only ONE flips it (the other gets no row back → idempotent no-op), so the
     returned_qty release below runs exactly once. */
  const { data: updRow, error: updErr } = await scopeToCompanyId(sb.from('purchase_consignment_returns').update({
    status: 'CANCELLED', updated_at: new Date().toISOString(),
  }).eq('id', id).neq('status', 'CANCELLED').neq('status', 'COMPLETED'), co.companyId).select('id').maybeSingle();
  if (updErr) return c.json({ error: 'cancel_failed', reason: updErr.message }, 500);
  if (!updRow) {
    const { data: now } = await scopeToCompanyId(sb.from('purchase_consignment_returns').select('id, status').eq('id', id), co.companyId).maybeSingle();
    const st = (now as { status: string } | null)?.status;
    if (st === 'CANCELLED') return c.json({ purchaseConsignmentReturn: { id, status: 'CANCELLED' } });
    if (st === 'COMPLETED') return c.json({ error: 'cannot_cancel', message: 'Already completed' }, 409);
    return c.json({ error: 'cannot_cancel' }, 409);
  }

  // Release the PC-receive-line consumption: recount returned_qty for every
  // receive-linked line (the PR is now CANCELLED, so the recount excludes it).
  // (Inventory reversal is done separately just below.) Best-effort.
  try {
    const { data: relLines } = await sb.from('purchase_consignment_return_items')
      .select('qty_returned, pc_receive_item_id').eq('purchase_consignment_return_id', id);
    for (const l of (relLines ?? []) as Array<{ qty_returned: number; pc_receive_item_id: string | null }>) {
      if (l.pc_receive_item_id) await adjustPcReceiveReturnedQty(sb, l.pc_receive_item_id, -(l.qty_returned ?? 0));
    }
  } catch { /* best-effort */ }

  // Inventory reversal (2026-06-05, now on-ledger) — the status is now CANCELLED,
  // so the resync drives every bucket's net back to 0 (STOCK_TRANSFER IN puts the
  // stock back). Best-effort.
  try {
    await resyncPcReturnInventory(sb, id, c.get('user')?.id ?? null);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[pc-return] cancel reversal failed:', e); }

  return c.json({ purchaseConsignmentReturn: { id, status: 'CANCELLED' } });
};
purchaseConsignmentReturns.patch('/:id/cancel', cancelPurchaseConsignmentReturnHandler);

/* ════════════════════════════════════════════════════════════════════════
   PC Return CRUD (PATCH header + line add / edit / delete) — mirrors the PR
   detail page editing. The editable line quantity is qty_returned;
   line_refund_centi = qty_returned * unit_price_centi (no discount);
   recomputePcReturnTotals rolls the header refund_centi. Line CRUD recounts
   returned_qty onto the PC Receive AND resyncs the inventory OUT (on-ledger).
   ════════════════════════════════════════════════════════════════════════ */

/* ── PATCH /:id — header update ── */
purchaseConsignmentReturns.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [from, to] of [
    ['supplierId', 'supplier_id'], ['returnDate', 'return_date'],
    ['reason', 'reason'], ['creditNoteRef', 'credit_note_ref'],
    ['notes', 'notes'],
  ] as const) {
    if (body[from] !== undefined) updates[to] = body[from];
  }
  const { data, error } = await scopeToCompanyId(sb.from('purchase_consignment_returns').update(updates).eq('id', id), co.companyId).select(HEADER).maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) return c.json(NOT_THIS_COMPANY, 404);
  return c.json({ purchaseConsignmentReturn: data });
});

/* A CANCELLED / COMPLETED return is terminal — lock line edits to ACTIVE
   returns. (Off-ledger, but a reversed/completed PR's returned_qty has already
   been released/settled — editing it would re-corrupt the recount gates.) */
async function pcReturnLineLock(sb: any, prId: string): Promise<{ error: string; message: string } | null> {
  const { data } = await sb.from('purchase_consignment_returns').select('status').eq('id', prId).maybeSingle();
  const st = (data as { status: string } | null)?.status;
  if (st === 'CANCELLED') return { error: 'pc_return_cancelled', message: 'This consignment return is cancelled — its lines can no longer be changed.' };
  if (st === 'COMPLETED') return { error: 'pc_return_completed', message: 'This consignment return is completed — its lines can no longer be changed.' };
  return null;
}

/* ── POST /:id/items — add one return_item. qty → qty_returned. ── */
purchaseConsignmentReturns.post('/:id/items', async (c) => {
  const prId = c.req.param('id');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (!it.materialCode) return c.json({ error: 'material_code_required' }, 400);
  if (!it.materialName) return c.json({ error: 'material_name_required' }, 400);

  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  /* The child line is stamped with the active company; the parent return it hangs
     off must be this company's too, or a line lands on another company's return. */
  const { data: parent } = await scopeToCompanyId(sb.from('purchase_consignment_returns').select('id').eq('id', prId), co.companyId).maybeSingle();
  if (!parent) return c.json(NOT_THIS_COMPANY, 404);
  { const lock = await pcReturnLineLock(sb, prId); if (lock) return c.json(lock, 409); }
  const qtyReturned = Number(it.qty ?? 1);
  const unitPriceCenti = Number(it.unitPriceCenti ?? 0);
  const lineRefund = qtyReturned * unitPriceCenti;

  // PC-receive-linked line: cap qty at that receive line's remaining.
  const receiveItemId = (it.pcReceiveItemId as string) ?? null;
  if (receiveItemId) {
    const capLock = await qtyCapRefusal(sb, {
      table: 'purchase_consignment_receive_items', id: receiveItemId,
      capColumn: 'qty_accepted', drawnColumns: ['returned_qty'],
      requested: qtyReturned, what: 'PC Receive line',
    });
    if (capLock) return c.json(capLock, 409);
  }

  const row: Record<string, unknown> = {
    purchase_consignment_return_id: prId,
    pc_receive_item_id: receiveItemId,
    material_kind: (it.materialKind as string) ?? 'mfg_product',
    material_code: it.materialCode,
    material_name: it.materialName,
    qty_returned: qtyReturned,
    unit_price_centi: unitPriceCenti,
    line_refund_centi: lineRefund,
    reason: (it.reason as string) ?? null,
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
  };
  const { data, error } = await sb.from('purchase_consignment_return_items').insert({ company_id: activeCompanyId(c), ...row }).select(ITEM).single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);

  /* POST-INSERT over-return verification — the pre-check is a read-then-write
     race. After committing, re-read the receive line's accepted + the LIVE sum of
     qty_returned across all non-cancelled PR lines for it; if returned now
     exceeds accepted, OUR insert broke the cap → delete it + 409. */
  if (receiveItemId) {
    const inserted = data as unknown as { id: string } | null;
    const { data: gi } = await sb.from('purchase_consignment_receive_items')
      .select('qty_accepted').eq('id', receiveItemId).maybeSingle();
    if (gi) {
      const cap = (gi as { qty_accepted: number }).qty_accepted ?? 0;
      const { data: sib } = await sb.from('purchase_consignment_return_items')
        .select('qty_returned, purchase_consignment_return_id').eq('pc_receive_item_id', receiveItemId);
      const sibRows = (sib ?? []) as Array<{ qty_returned: number; purchase_consignment_return_id: string }>;
      const prIds = [...new Set(sibRows.map((r) => r.purchase_consignment_return_id))];
      const cancelled = new Set<string>();
      if (prIds.length > 0) {
        const { data: prs } = await sb.from('purchase_consignment_returns').select('id, status').in('id', prIds);
        for (const p of (prs ?? []) as Array<{ id: string; status: string }>) {
          if (p.status === 'CANCELLED') cancelled.add(p.id);
        }
      }
      const liveReturned = sibRows
        .filter((r) => !cancelled.has(r.purchase_consignment_return_id))
        .reduce((s, r) => s + Number(r.qty_returned ?? 0), 0);
      if (liveReturned > cap && inserted?.id) {
        await sb.from('purchase_consignment_return_items').delete().eq('id', inserted.id);
        return c.json({ error: 'qty_exceeds_remaining', requested: qtyReturned, remaining: cap - (liveReturned - qtyReturned) }, 409);
      }
    }
  }

  // Consume the receive line if this PR line is receive-linked (recount-from-live).
  // Manual lines consume nothing.
  if (receiveItemId) await adjustPcReceiveReturnedQty(sb, receiveItemId, qtyReturned);
  await recomputePcReturnTotals(sb, prId);
  // Book the added line's stock OUT (self-healing resync). Best-effort.
  try { await resyncPcReturnInventory(sb, prId, c.get('user')?.id ?? null); } catch { /* best-effort */ }

  return c.json({ item: data }, 201);
});

/* ── PATCH /:id/items/:itemId — partial line update. qty → qty_returned. ── */
purchaseConsignmentReturns.patch('/:id/items/:itemId', async (c) => {
  const prId = c.req.param('id'); const itemId = c.req.param('itemId');
  let it: Record<string, unknown>;
  try { it = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  { const lock = await pcReturnLineLock(sb, prId); if (lock) return c.json(lock, 409); }

  const { data: prev } = await scopeToCompanyId(sb.from('purchase_consignment_return_items')
    .select('qty_returned, unit_price_centi, item_group, variants, pc_receive_item_id, material_code, material_name')
    .eq('id', itemId), co.companyId).maybeSingle();
  if (!prev) return c.json(NOT_THIS_COMPANY, 404);

  const prevQty = (prev as { qty_returned: number }).qty_returned;
  const receiveItemId = (prev as { pc_receive_item_id: string | null }).pc_receive_item_id ?? null;
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

  // Receive-linked + qty changed: pre-check the delta won't push the receive line
  // over its accepted. headroom for THIS line = accepted - (returned - prevQty).
  const delta = qtyReturned - prevQty;
  if (receiveItemId && delta !== 0) {
    const capLock = await qtyCapRefusal(sb, {
      table: 'purchase_consignment_receive_items', id: receiveItemId,
      capColumn: 'qty_accepted', drawnColumns: ['returned_qty'],
      requested: qtyReturned, ownPriorDraw: prevQty, what: 'PC Receive line',
    });
    if (capLock) return c.json(capLock, 409);
  }

  const { error } = await scopeToCompanyId(sb.from('purchase_consignment_return_items').update(updates).eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  // Apply the consumption delta to the source receive line (recount-from-live,
  // qty rollup only; helper clamps to [0, qty_accepted]). The inventory OUT is
  // resynced just below.
  if (receiveItemId && delta !== 0) await adjustPcReceiveReturnedQty(sb, receiveItemId, delta);
  await recomputePcReturnTotals(sb, prId);
  // Adjust inventory by the qty/variant delta (self-healing resync). Best-effort.
  try { await resyncPcReturnInventory(sb, prId, c.get('user')?.id ?? null); } catch { /* best-effort */ }

  return c.json({ ok: true });
});

/* ── DELETE /:id/items/:itemId — remove a line + recompute header. ── */
purchaseConsignmentReturns.delete('/:id/items/:itemId', async (c) => {
  const prId = c.req.param('id'); const itemId = c.req.param('itemId');
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  { const lock = await pcReturnLineLock(sb, prId); if (lock) return c.json(lock, 409); }
  // Read the line first so we can release its receive-line consumption on delete.
  const { data: line } = await scopeToCompanyId(sb.from('purchase_consignment_return_items')
    .select('qty_returned, pc_receive_item_id').eq('id', itemId), co.companyId).maybeSingle();
  if (!line) return c.json(NOT_THIS_COMPANY, 404);
  const { error } = await scopeToCompanyId(sb.from('purchase_consignment_return_items').delete().eq('id', itemId), co.companyId);
  if (error) return c.json({ error: 'delete_failed', reason: error.message }, 500);
  {
    const l = line as { qty_returned: number; pc_receive_item_id: string | null };
    // Release: recount returned_qty from live (the deleted line is gone), which
    // nets the receive line + PC Order back up. (Inventory is given back IN by
    // the resync just below.)
    if (l.pc_receive_item_id) await adjustPcReceiveReturnedQty(sb, l.pc_receive_item_id, -(l.qty_returned ?? 0));
  }
  await recomputePcReturnTotals(sb, prId);
  // Give the deleted line's stock back IN (self-healing resync). Best-effort.
  try { await resyncPcReturnInventory(sb, prId, c.get('user')?.id ?? null); } catch { /* best-effort */ }
  return c.body(null, 204);
});
