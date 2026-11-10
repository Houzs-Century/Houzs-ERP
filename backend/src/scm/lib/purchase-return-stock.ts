// ----------------------------------------------------------------------------
// scm/lib/purchase-return-stock — a supplier return's stock and ledger writes.
//
// A Purchase Return is created POSTED: its stock OUT (and, for a REPAIR return,
// the paired IN to the repair warehouse), each source GRN line's returned_qty
// and the PO line's received_qty recount it drives. Cancelling reverses the OUT
// and recounts again. Moved out of routes/purchase-returns.ts, which sits at its
// size ceiling, so the same code runs on either client:
//   - PURCHASE_RETURN_MODE=atomic (the default, lib/stock-post-tx.ts): the status
//     write (the cancel's flip; the create's POSTED insert is undone instead) and
//     every write above commit together or not at all;
//   - "two-step": the old path, each write committed on its own.
// The retro-cost reconcile and SO allocation run after commit, in the route.
// ----------------------------------------------------------------------------

import { writeMovements, reverseMovementsCore, defaultWarehouseId } from './inventory-movements';
import * as bk from './stock-bucket-key'; // variant-tracked companies only; company 1 keys exactly as before
import { hasUnreadableLines, LINES_UNREADABLE, linesUnreadableMessage, unreadableMovementError } from './failed-read-refusal';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { STOCK_TX_ROLLED_BACK, stockTxFailureBody, type StockTx, type StockTxClient } from './stock-post-tx';
import { recomputePoReceived } from '../routes/grns';
import type { VariantAttrs } from '../shared';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-condition -- the
   recount, the resolver and the OUT writer moved here verbatim from
   routes/purchase-returns.ts (counted under that file's ceiling there);
   PostgREST client, untyped rows. */
type Db = any;
type MovementRow = Parameters<typeof writeMovements>[1][number];

export type PrRecount = { ok: true } | { ok: false; reason: string };

/* ── GRN→PR consumption helper (migration 0106, unified model) ──────────────
   Track grn_items.returned_qty as PR lines are drawn from / adjusted against /
   released back to a GRN line. base = qty_accepted (you can return up to what
   was accepted); remaining = qty_accepted - returned_qty. Mirrors
   adjustGrnInvoicedQty in purchase-invoices.ts. */
/* The recount below reports instead of logging: under PURCHASE_RETURN_MODE=atomic
   a recount that did not land rolls the return back with it; the route's
   adjustGrnReturnedQty (two-step, line edits) logs it as before. */
export async function recountGrnReturned(sb: Db, grnItemId: string): Promise<PrRecount> {
  if (!grnItemId) return { ok: true };
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
    return { ok: false, reason: `PR line read failed — returned_qty left unchanged: ${grnItemId} ${prLinesErr.message}` };
  }
  const rows = (prLines ?? []) as Array<{ qty_returned: number; purchase_return_id: string }>;
  const prIds = [...new Set(rows.map((r) => r.purchase_return_id).filter(Boolean))];
  const cancelled = new Set<string>();
  /* HC-0221: a CREDIT return the supplier will not replace keeps the PO received. */
  const noReplacement = new Set<string>();
  if (prIds.length > 0) {
    /* Same rule, opposite direction: an empty `cancelled` from a FAILED read
       reads as "no return here is cancelled", so a cancelled PR's qty is counted
       as still returned and the GRN line stays consumed against a return that
       was voided. */
    const { data: prs, error: prsErr } = await sb.from('purchase_returns').select('id, status, kind, supplier_replaces').in('id', prIds);
    if (prsErr) {
      return { ok: false, reason: `PR status read failed — returned_qty left unchanged: ${grnItemId} ${prsErr.message}` };
    }
    /* A REPAIR return keeps the goods on the books (they move to the repair
       warehouse and come back), so it does not consume the receipt: counting it
       re-opened the PO as unreceived while the unit sat in KL SERVICE
       (2990-PRT-2610-001 / 2990-PO-2607-018). Only a CREDIT return does.
       It still is not returnable again: the return caps subtract repairHeldQty. */
    for (const p of (prs ?? []) as Array<{ id: string; status: string; kind: string | null; supplier_replaces: boolean | null }>) {
      if ((p.status ?? '').toUpperCase() === 'CANCELLED' || p.kind === 'REPAIR') cancelled.add(p.id);
      else if (p.supplier_replaces === false) noReplacement.add(p.id);
    }
  }
  let returned = 0;
  let closed = 0;
  for (const r of rows) {
    if (cancelled.has(r.purchase_return_id)) continue;
    returned += Number(r.qty_returned ?? 0);
    if (noReplacement.has(r.purchase_return_id)) closed += Number(r.qty_returned ?? 0);
  }

  const { data: gi, error: giErr } = await sb.from('grn_items')
    .select('qty_accepted, purchase_order_item_id').eq('id', grnItemId).maybeSingle();
  if (giErr) return { ok: false, reason: `GRN line read failed — returned_qty left unchanged: ${grnItemId} ${giErr.message}` };
  if (!gi) return { ok: true };
  const accepted = (gi as { qty_accepted: number }).qty_accepted ?? 0;
  const next = Math.min(accepted, Math.max(0, returned)); // clamp [0, accepted]
  const nextClosed = Math.min(next, Math.max(0, closed));
  const { error: updErr } = await sb.from('grn_items').update({ returned_qty: next, returned_closed_qty: nextClosed }).eq('id', grnItemId);
  if (updErr) {
    /* A rejected UPDATE left returned_qty STALE with nothing logged, and it is
       read by two integrity gates (PO re-open + PI over-bill headroom). Do not
       recount the PO off a GRN line we failed to move. */
    return { ok: false, reason: `returned_qty update failed — GRN line left STALE: ${grnItemId} ${updErr.message}` };
  }
  // Returning goods nets down the parent PO line's received_qty (re-opens for a
  // replacement shipment). Recount it from live GRN lines.
  const poItemId = (gi as { purchase_order_item_id: string | null }).purchase_order_item_id;
  if (!poItemId) return { ok: true };
  const po = await recomputePoReceived(sb, [poItemId]);
  return po.ok ? { ok: true } : { ok: false, reason: `PO received recount: ${po.reason ?? 'unknown'}` };
}

/** Every GRN line a return draws on, recounted; the first failure stops it. */
export async function recountGrnLines(sb: Db, grnItemIds: ReadonlyArray<string | null | undefined>): Promise<PrRecount> {
  for (const id of new Set(grnItemIds.filter((x): x is string => !!x))) {
    const r = await recountGrnReturned(sb, id);
    if (!r.ok) return r;
  }
  return { ok: true };
}

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
export async function resolvePrLineWarehouses(
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

/* PR-DRAFT-removal — shared inventory-OUT side-effect, written as the new PR is
   created POSTED. `wrote` = there were rows to write (the route re-walks SO
   allocation after commit). Atomic: a failure rolls back the create; two-step:
   reported, the row stands. */
export type PrStockOut = { errors: string[]; wrote: boolean };
export async function prStockOutCore(sb: Db, prId: string, returnNumber: string, grnId: string | null, userId: string): Promise<PrStockOut> {
  const done = (errors: string[], wrote = false): PrStockOut => ({ errors, wrote });
  // Multi-company: the PR's movements inherit the PR header's company.
  const { data: prHeader, error: prHeaderErr } = await sb.from('purchase_returns')
    .select('company_id, kind, repair_warehouse_id').eq('id', prId).maybeSingle();
  if (prHeaderErr) return done([unreadableMovementError('the purchase return', prHeaderErr)]);
  const prHead = prHeader as { company_id?: number | null; kind?: string | null; repair_warehouse_id?: string | null } | null;
  const prCompanyId = prHead?.company_id ?? null;
  /* A REPAIR return does not take the goods off the books: they go to the
     supplier and are expected back, so each line's OUT is paired with an IN to
     the repair warehouse. Until then the warehouse did this by hand with a
     stock transfer, which recorded the move and nothing else (owner
     2026-09-28). NULL for a CREDIT return, and the DB CHECK guarantees a REPAIR
     one has it. */
  const repairWarehouseId = prHead?.kind === 'REPAIR' ? (prHead.repair_warehouse_id ?? null) : null;
  const { data: items, error: itemsErr } = await sb.from('purchase_return_items')
    .select('id, grn_item_id, item_code, material_name, qty_returned, item_group, variants')
    .eq('purchase_return_id', prId);
  if (itemsErr || !items) return done(itemsErr ? [unreadableMovementError('the purchase return lines', itemsErr)] : []);
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
  const itemList = (items ?? []) as Array<{ id: string; grn_item_id?: string | null; item_code: string; material_name: string | null; qty_returned: number; item_group?: string | null; variants?: VariantAttrs | null }>;
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
        .select('source_doc_id, item_code, variant_key, warehouse_id, batch_no')
        .eq('source_doc_type', 'GRN').eq('movement_type', 'IN').in('source_doc_id', srcGrnIds);
      if (inRes.error && (inRes.error.message ?? '').includes('batch_no')) {
        inRes = { data: [], error: null } as typeof inRes;
      }
      for (const m of (inRes.data ?? []) as Array<{ source_doc_id: string; item_code: string; variant_key: string | null; warehouse_id: string; batch_no?: string | null }>) {
        if (m.batch_no == null) continue;
        batchByBucket.set(`${m.source_doc_id}::${m.warehouse_id}::${m.item_code}::${bk.bucketIdFor(prCompanyId, m.variant_key)}`, m.batch_no);
      }
    }
  }

  const prKeyOf = await bk.stockBucketKeyResolver(sb, prCompanyId, itemList.map((it) => bk.stockKeyLine(it, lineWh.get(it.id) ?? null)));
  const movements = itemList
    .filter((it) => it.qty_returned > 0)
    .map((it) => {
      const warehouseId = lineWh.get(it.id) ?? null;
      if (!warehouseId) return null;
      const variantKey = prKeyOf(bk.stockKeyLine(it, warehouseId));
      const srcGrn = lineGrnId.get(it.id) ?? null;
      const batchNo = srcGrn ? (batchByBucket.get(`${srcGrn}::${warehouseId}::${it.item_code}::${bk.bucketIdFor(prCompanyId, variantKey)}`) ?? null) : null;
      return {
        movement_type: 'OUT' as const,
        warehouse_id: warehouseId,
        item_code: it.item_code,
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
  /* The repair leg. Same line, same quantity, same batch — one movement pair,
     so the stock is never in two places and never in none. */
  const repairIns = repairWarehouseId
    ? movements.map((m) => ({ ...m, movement_type: 'IN' as const, warehouse_id: repairWarehouseId }))
    : [];
  const movementErrors: string[] = [];
  if (movements.length > 0) {
    /* Capture the write result so the caller can surface a failed stock OUT (was
       silently swallowed — PR created with stock NOT returned to the supplier
       and the caller never told). Atomic: the caller rolls back on it. */
    const res = await writeMovements(sb, movements, prCompanyId);
    if (!res.ok) movementErrors.push(`OUT ${returnNumber}: ${res.reason ?? 'unknown'}`);
    if (repairIns.length > 0) {
      /* Reported, never assumed: an IN that failed after a clean OUT means the
         goods left the warehouse and landed nowhere, which is the one outcome
         a repair return must not hide. */
      const inRes = await writeMovements(sb, repairIns, prCompanyId);
      if (!inRes.ok) movementErrors.push(`IN ${returnNumber}: ${inRes.reason ?? 'unknown'}`);
    }
  }
  return done(movementErrors, movements.length > 0);
}

/* ── The atomic runs (PURCHASE_RETURN_MODE=atomic) ─────────────────────────── */

export type PrStockFailure = { ok: false; reason: string; status: number; detail?: string };

function prCoreFailure(errors: string[]): PrStockFailure {
  return { ok: false, reason: hasUnreadableLines(errors) ? LINES_UNREADABLE : STOCK_TX_ROLLED_BACK, status: 503, detail: errors.join('; ') };
}

/** What the operator reads when an atomic return write rolled back. Nothing was written. */
export function prStockFailureBody(what: 'returned' | 'cancelled', f: { reason: string; detail?: string }): object {
  if (f.reason === LINES_UNREADABLE) {
    return { error: LINES_UNREADABLE, message: linesUnreadableMessage('the purchase return', what), ...(f.detail ? { detail: f.detail } : {}) };
  }
  return stockTxFailureBody(what, f);
}

/* The OUT (+ repair IN) and the recount of every GRN line the return draws on. */
async function prPostCore(t: Db, prId: string, returnNumber: string, grnId: string | null, userId: string, grnItemIds: ReadonlyArray<string | null | undefined>): Promise<{ ok: true; wrote: boolean } | PrStockFailure> {
  const out = await prStockOutCore(t, prId, returnNumber, grnId, userId);
  if (out.errors.length > 0) return prCoreFailure(out.errors);
  const recount = await recountGrnLines(t, grnItemIds);
  if (!recount.ok) return { ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, detail: `GRN returned recount: ${recount.reason}` };
  return { ok: true, wrote: out.wrote };
}

export type PrCreated = { id: string; return_number: string };

/**
 * The create's stock and ledger writes in ONE transaction: the OUT (and the
 * repair leg), each source GRN line's returned_qty / returned_closed_qty
 * (whether the supplier replaces) and the PO line received recount. The header
 * and lines were inserted POSTED before this runs, so when it rolls back no
 * stock moved and the just-created return is deleted again (lines first,
 * scoped to the company). `removed` false = the delete failed too; the body says so.
 */
export async function postCreatedPrAtomically(
  tx: StockTx, sb: Db, h: PrCreated, grnId: string | null, companyId: number | null, userId: string,
  grnItemIds: ReadonlyArray<string | null | undefined>,
): Promise<{ ok: true; wrote: boolean } | { ok: false; removed: boolean; body: object }> {
  const out = await tx((t) => prPostCore(t, h.id, h.return_number, grnId, userId, grnItemIds));
  if (out.ok) return out;
  let removed = false;
  try {
    const items = await scopeToCompanyIdOrOpen(sb.from('purchase_return_items').delete().eq('purchase_return_id', h.id), companyId);
    const head = items?.error ? items : await scopeToCompanyIdOrOpen(sb.from('purchase_returns').delete().eq('id', h.id), companyId);
    removed = !items?.error && !head?.error;
  } catch { /* reported below */ }
  return {
    ok: false,
    removed,
    body: {
      ...(prStockFailureBody('returned', out) as object),
      message: removed
        ? `Nothing was returned: the stock change was rolled back and ${h.return_number} was not kept. Please try again.`
        : `Nothing was returned: the stock change was rolled back, but ${h.return_number} could not be removed. Cancel it before raising the return again.`,
      removed,
    },
  };
}

/** The cancel's status write (scoped CAS, refuses COMPLETED / CANCELLED). */
export type PrFlipResult = { data: { id: string } | null; error: { message: string; code?: string } | null };
export type PrFlipMiss = { ok: false; reason: 'flip'; status: 409; flip: PrFlipResult };
export type PrCancelOutcome =
  | { ok: true; reversed: number; openedLotRows: MovementRow[] }
  | PrFlipMiss
  | PrStockFailure;
export const isPrFlipMiss = (o: PrCancelOutcome): o is PrFlipMiss => !o.ok && 'flip' in o;

/**
 * The cancel in ONE transaction: the flip to CANCELLED, the reversing IN of
 * every OUT (and OUT of every repair IN) the return wrote, with the exact batch
 * and cost the OUT carried, and the GRN returned / PO received recount that
 * releases the lines. A partial reversal or a failed recount rolls the flip
 * back, so a return never reads CANCELLED with its stock still out.
 * `openedLotRows` is the after-commit retro-cost input.
 */
export async function cancelPrAtomically(tx: StockTx, prId: string, userId: string, flip: (t: StockTxClient) => Promise<PrFlipResult>): Promise<PrCancelOutcome> {
  return tx(async (t): Promise<PrCancelOutcome> => {
    const f = await flip(t);
    if (f.error || !f.data) return { ok: false, reason: 'flip', status: 409, flip: f };
    const rev = await reverseMovementsCore(t, 'PURCHASE_RETURN', prId, userId);
    if (!rev.ok) {
      return { ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, detail: `stock reversal: ${rev.reversed} reversed, ${rev.failed} failed${rev.reason ? ` (${rev.reason})` : ''}` };
    }
    const { data: lines, error: linesErr } = await t.from('purchase_return_items').select('grn_item_id').eq('purchase_return_id', prId);
    if (linesErr) return prCoreFailure([unreadableMovementError('the purchase return lines', linesErr)]);
    const recount = await recountGrnLines(t, ((lines ?? []) as Array<{ grn_item_id: string | null }>).map((l) => l.grn_item_id));
    if (!recount.ok) return { ok: false, reason: STOCK_TX_ROLLED_BACK, status: 503, detail: `GRN returned recount: ${recount.reason}` };
    return { ok: true, reversed: rev.reversed, openedLotRows: rev.openedLotRows };
  });
}
