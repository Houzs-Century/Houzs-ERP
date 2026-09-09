// DO → SO "Delivered" sync.
//
// Requirement #3 (Loo, 2026-05-30): when the Backend creates a Delivery Order
// that fully covers a Sales Order, the SO auto-advances to DELIVERED — which
// the POS "My orders" board reflects live via Supabase realtime.
//
// Loo chose the SAFE rule (2026-05-30): an SO flips to DELIVERED only when
// EVERY non-cancelled SO line is fully covered by delivered DO quantities. A
// partial DO on a multi-line order does NOT mark the whole order delivered.
//
// Design notes:
//   - Best-effort + idempotent. A sync failure must NEVER roll back or block
//     the DO (the DO is the source of truth for goods leaving the building).
//   - The coverage DECISION is the pure `isSoFullyCovered` below (unit-tested);
//     this module's async wrapper is the thin Supabase glue around it.

import { DO_NOT_DELIVERED_IN_LIST, doCountsAsDelivered } from '../shared/do-shipped-states';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isServiceLine } from '../shared';
import { recordSoAudit } from './so-audit';
import { advanceSoGeneration } from './so-generation';
import { loadUnlinkedDoCoverage } from './do-unlinked-coverage';

export type SoLineQty = { id: string; qty: number };
export type DoLineQty = { soItemId: string | null; qty: number };

/** One delivery order of the SO, as the release guard sees it: its status,
 *  the header's own line_count, and how many rows delivery_order_items
 *  actually holds for it right now. */
export type DoLineCensus = {
  doNumber: string;
  status: string | null;
  lineCount: number | null;
  rowCount: number;
};

/** THE RELEASE GUARD'S DECISION (2026-09-04). Returns the delivery orders
 *  that COUNT as delivered (`doCountsAsDelivered`: every state but DRAFT and
 *  CANCELLED) yet hold ZERO line rows.
 *
 *  Such a document is not a delivery that un-happened; it is broken evidence.
 *  On 2026-09-02 three 2990 delivery orders (2607-016/018/019) carried
 *  line_count, money and OUT movements from 2026-07-23 while their 8 rows sat
 *  under three header ids that no longer existed. A QR-scan batch marked 24
 *  deliveries DELIVERED, this module re-derived coverage for each SO, read the
 *  empty documents as "nothing delivered", and released three delivered orders
 *  back to READY_TO_SHIP — where MRP planned sofas already in the customers'
 *  homes and handed a real PO to the wrong order. The release arm may only
 *  fire on POSITIVE evidence (a cancelled DO, a reduced line, a return); an
 *  empty live document is the signature of corruption and must HOLD the
 *  order, loudly, until a person looks. `line_count` is reported, not
 *  trusted: the rows are the evidence, and a null count on an empty shipped
 *  document is still an empty shipped document. Pure, so it is unit-tested. */
export function emptyLiveDeliveries(dos: DoLineCensus[]): string[] {
  return dos
    .filter((d) => doCountsAsDelivered(d.status) && d.rowCount === 0)
    .map((d) => d.doNumber);
}

/** Census of every delivery order whose header names this SO. Best-effort by
 *  construction: a failed read yields [] and the release arm behaves exactly
 *  as it did before the guard existed. */
async function loadEmptyLiveDeliveries(sb: SupabaseClient, docNo: string): Promise<string[]> {
  try {
    const { data: dosRaw, error } = await sb
      .from('delivery_orders')
      .select('id, do_number, status, line_count')
      .eq('so_doc_no', docNo);
    if (error || !dosRaw || dosRaw.length === 0) return [];
    const dos = dosRaw as Array<{ id: string; do_number: string; status: string | null; line_count: number | null }>;
    const { data: rowsRaw, error: rowsErr } = await sb
      .from('delivery_order_items')
      .select('delivery_order_id')
      .in('delivery_order_id', dos.map((d) => d.id));
    if (rowsErr) return [];
    const rowsByDo = new Map<string, number>();
    for (const r of (rowsRaw ?? []) as Array<{ delivery_order_id: string | null }>) {
      if (!r.delivery_order_id) continue;
      rowsByDo.set(r.delivery_order_id, (rowsByDo.get(r.delivery_order_id) ?? 0) + 1);
    }
    return emptyLiveDeliveries(dos.map((d) => ({
      doNumber: d.do_number,
      status: d.status,
      lineCount: d.line_count,
      rowCount: rowsByDo.get(d.id) ?? 0,
    })));
  } catch {
    return [];
  }
}

const RELEASE_REFUSED_ACTION = 'RELEASE_REFUSED';
const RELEASE_REFUSED_QUIET_MS = 24 * 60 * 60 * 1000;

/** The hold is not silent — silent is how the 2026-08-17 shape went unseen for
 *  three weeks — but it must not spam either: the sync runs on every DO
 *  mutation, and a scan batch touches one SO many times. One audit row per SO
 *  per day, then quiet until a person acts. */
async function recordReleaseRefused(
  sb: SupabaseClient,
  docNo: string,
  actorId: string | null | undefined,
  brokenDos: string[],
): Promise<void> {
  try {
    const note = `Kept at DELIVERED: ${brokenDos.join(', ')} count(s) as delivered but hold NO line rows. `
      + 'That is broken delivery evidence, not an un-delivery. The order is NOT released to re-ship; '
      + 'restore the delivery order lines (see docs/bugs, 2026-09-04) and the next sync clears this.';
    /* The Worker log always gets the line; only the audit ROW is rate-limited. */
    /* eslint-disable-next-line no-console */
    console.warn(`[so-delivery-sync] ${docNo}: ${note}`);
    const since = new Date(Date.now() - RELEASE_REFUSED_QUIET_MS).toISOString();
    const { data: recent, error: recentErr } = await sb
      .from('mfg_so_audit_log')
      .select('id')
      .eq('so_doc_no', docNo)
      .eq('action', RELEASE_REFUSED_ACTION)
      .gte('created_at', since)
      .limit(1);
    /* A failed de-dup read is not "no recent row": writing on it would let a
       database blip turn one hold into a row per scan. Skip the note; the log
       line above already carries it. */
    if (recentErr) return;
    if ((recent ?? []).length > 0) return;
    await recordSoAudit(sb, {
      docNo,
      action: RELEASE_REFUSED_ACTION,
      actorId: actorId ?? null,
      actorName: 'System (delivery sync)',
      source: 'automation',
      statusSnapshot: 'DELIVERED',
      fieldChanges: [{ field: 'status', from: 'DELIVERED', to: 'DELIVERED' }],
      note,
    });
  } catch {
    /* best-effort — the hold itself already happened; the note is a courtesy */
  }
}

/** Pure coverage decision. `soLines` must already EXCLUDE cancelled SO lines;
 *  `doLines` should EXCLUDE lines belonging to cancelled DOs; `returnLines`
 *  (optional) should EXCLUDE lines belonging to cancelled Delivery Returns.
 *  Returns true iff every SO line's NET delivered quantity
 *  (Σ delivered across DOs − Σ returned across DRs) meets or exceeds its
 *  ordered qty. An SO with no lines is never "fully covered" (nothing shipped
 *  ≠ delivered).
 *
 *  Wei Siang 2026-06-01 (DR 3B): a Delivery Return brings goods back, so the
 *  order is NO LONGER fully delivered — it owes that qty again and must
 *  re-open (DELIVERED → READY_TO_SHIP) so a fresh DO can re-ship it. Netting
 *  the return here is what drives that release in syncSoDeliveredFromDo. */
export function isSoFullyCovered(
  soLines: SoLineQty[],
  doLines: DoLineQty[],
  returnLines: DoLineQty[] = [],
): boolean {
  if (soLines.length === 0) return false;
  const netByLine = new Map<string, number>();
  for (const d of doLines) {
    if (!d.soItemId) continue;
    netByLine.set(d.soItemId, (netByLine.get(d.soItemId) ?? 0) + (d.qty ?? 0));
  }
  for (const r of returnLines) {
    if (!r.soItemId) continue;
    netByLine.set(r.soItemId, (netByLine.get(r.soItemId) ?? 0) - (r.qty ?? 0));
  }
  return soLines.every((l) => (netByLine.get(l.id) ?? 0) >= l.qty);
}

// SO statuses we may auto-advance to DELIVERED. Anything already at
// INVOICED/CLOSED is done; ON_HOLD/CANCELLED must NOT be auto-flipped.
//
// NO `on_hold` TERM HERE, AND THAT IS DELIBERATE (mig 0324). Every guard that
// asks "may somebody ACT on this document" gained one; this is not that kind of
// site. This is a WRITER that re-derives a status from a fact — the goods were
// delivered — and the reason ON_HOLD was excluded was that the auto-flip would
// have OVERWRITTEN a hold a person had set. Since the hold moved into its own
// column, writing `status` cannot touch it, so a held order whose delivery
// completes should read DELIVERED and carry its Hold chip: both facts, at once,
// which is precisely what a status-hold made impossible.
//
// `ON_HOLD` stays in neither list and out of DELIVERABLE_FROM for a different
// reason that still holds: a LEGACY row sitting on that label keeps its hold in
// the status column and nowhere else, so auto-flipping it would destroy the
// hold. Same reasoning as recomputePoReceived in routes/grns.ts.
const DELIVERABLE_FROM = ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED'];

// Bug #4 — the status we RELEASE a DELIVERED SO back to when its DO is cancelled
// (or a line shrinks) and it is no longer fully covered. The SO enum has no
// 'PARTIALLY_DELIVERED', so the reversible target within DELIVERABLE_FROM is
// READY_TO_SHIP: goods are on hand to ship the remaining qty again. Only an SO
// whose stored status is exactly DELIVERED is released — INVOICED/CLOSED/ON_HOLD/
// CANCELLED are left to manual control (an invoiced order isn't "un-delivered" by
// a DO edit; finance unwinds the SI first).
const RELEASE_TO = 'READY_TO_SHIP';

/** For each SO doc no, recompute its delivery status from CURRENT live delivered
 *  quantities and reconcile the stored status — BIDIRECTIONAL + IDEMPOTENT:
 *    • fully covered  & status ∈ DELIVERABLE_FROM → advance to DELIVERED
 *    • NOT fully covered & status == DELIVERED    → release to READY_TO_SHIP
 *    • otherwise (already correct / terminal / manual) → no-op
 *  This makes cancelling an SO's only DO rebook the order and release it (Fully →
 *  Partially), instead of leaving it latched at DELIVERED. Records the transition
 *  in BOTH audit tables (status-changes + unified audit log, source='automation')
 *  so the SO History panel matches manual moves. Best-effort: every SO is wrapped
 *  so one failure can't block the DO or the other SOs. */
export async function syncSoDeliveredFromDo(
  sb: SupabaseClient,
  soDocNos: Array<string | null | undefined>,
  actorId: string | null | undefined,
): Promise<void> {
  const docs = [...new Set(soDocNos.filter((d): d is string => !!d))];
  for (const docNo of docs) {
    try {
      const { data: so } = await sb
        .from('mfg_sales_orders').select('status, company_id').eq('doc_no', docNo).maybeSingle();
      const status = (so as { status?: string } | null)?.status;
      // Multi-company (mig 0061): the status-change audit row inherits the SO's company.
      const soCompanyId = (so as { company_id?: number | null } | null)?.company_id ?? null;
      // Only DELIVERABLE_FROM (forward) or a currently-DELIVERED SO (reverse) are
      // in play; everything else is terminal/manual and left untouched.
      if (!status) continue;
      const canAdvance = DELIVERABLE_FROM.includes(status);
      const canRelease = status === 'DELIVERED';
      if (!canAdvance && !canRelease) continue;

      const { data: soItemsRaw } = await sb
        .from('mfg_sales_order_items').select('id, qty, item_code, item_group')
        .eq('doc_no', docNo).eq('cancelled', false);
      const soLines = ((soItemsRaw ?? []) as Array<{ id: string; qty: number; item_code: string | null; item_group: string | null }>)
        .map((l) => ({ id: l.id, qty: Number(l.qty), item_code: l.item_code, item_group: l.item_group }));
      if (soLines.length === 0) continue;

      // Cumulative delivered qty per SO line across ALL non-cancelled DOs that
      // reference these SO items (a line may be split over several DOs). This is
      // re-derived live every call, so a cancelled DO drops out of the sum.
      // Keep the DO line id so returns can be traced back to the SO line below.
      // LEAK GUARD (PRE-SHIP): a DO that has not shipped must never count
      // toward SO delivery coverage (else it could auto-advance the SO to
      // DELIVERED or stamp lines READY without any stock leaving). That is
      // DRAFT and CANCELLED. It named only DRAFT until 2026-08-20, then DRAFT
      // *and* LOADED; on 2026-08-22 LOADED left again because the owner moved
      // the stock-out to the confirm step, so a Confirmed delivery HAS shipped
      // and must count. The literal is built from DO_NOT_DELIVERED_STATES, so it
      // cannot drift from the JS predicate the coverage engine uses — which is
      // why that ruling re-computed this site rather than leaving it behind.
      // The HOLD is deliberately not read here (mig 0324): a held delivery's
      // goods have still left, and freezing its counts is exactly what #2661
      // avoided by leaving this site status-only.
      const { data: doItemsRaw } = await sb
        .from('delivery_order_items')
        .select('id, so_item_id, qty, delivery_orders!inner(status)')
        .in('so_item_id', soLines.map((l) => l.id))
        .not('delivery_orders.status', 'in', DO_NOT_DELIVERED_IN_LIST);
      const doItemRows = (doItemsRaw ?? []) as Array<{ id: string; so_item_id: string | null; qty: number }>;
      const doLines = doItemRows.map((d) => ({ soItemId: d.so_item_id, qty: Number(d.qty) }));

      /* THE SAME SHIPMENT, READ THE OTHER WAY. `so_item_id` is nullable behind
         an `ON DELETE SET NULL` FK, so deleting ONE Sales-Order line blanks the
         pointer on every document that served it — and isSoFullyCovered, which
         opens with `if (!d.soItemId) continue`, then reads a delivered order as
         undelivered and leaves it CONFIRMED for good (26 lines across 8 live
         2990 DOs on 2026-08-17, while MRP re-ordered the same goods). The DO
         header's own so_doc_no still records which order it served; attribute
         on that, capped by what the real links already cover, so the two
         readings can never double-count. Best-effort by construction: a failed
         read yields [] and this stays exactly as strict as it was. */
      const linkedByLine = new Map<string, number>();
      for (const d of doLines) {
        if (!d.soItemId) continue;
        linkedByLine.set(d.soItemId, (linkedByLine.get(d.soItemId) ?? 0) + d.qty);
      }
      const attributed = await loadUnlinkedDoCoverage(
        sb,
        [docNo],
        soLines.map((l) => ({ id: l.id, docNo, itemCode: l.item_code, qty: l.qty })),
        linkedByLine,
      );
      /* Pushed into BOTH collections as ordinary delivered rows: doLines feeds
         coverage + the READY stamp, doItemRows is what the return-netting maps
         do_item_id through — a return against one of these must re-open the
         order exactly as it does for a linked line. */
      for (const a of attributed) {
        doItemRows.push({ id: a.doLineId, so_item_id: a.soItemId, qty: a.qty });
        doLines.push({ soItemId: a.soItemId, qty: a.qty });
      }

      // DR 3B — Σ returned qty per SO line across all non-cancelled Delivery
      // Returns. A DR line carries do_item_id (the DO line it returns), so map
      // do_item_id → so_item_id via the active DO lines we just loaded, then sum
      // qty_returned per SO line. Netting these out of coverage is what lets a
      // return re-open a fully-delivered SO (DELIVERED → READY_TO_SHIP).
      const doLineToSoItem = new Map<string, string | null>();
      for (const d of doItemRows) doLineToSoItem.set(d.id, d.so_item_id);
      const returnLines: DoLineQty[] = [];
      const doLineIds = doItemRows.map((d) => d.id);
      if (doLineIds.length > 0) {
        const { data: drItemsRaw } = await sb
          .from('delivery_return_items')
          .select('do_item_id, qty_returned, delivery_returns!inner(status)')
          .in('do_item_id', doLineIds)
          .neq('delivery_returns.status', 'CANCELLED');
        for (const r of (drItemsRaw ?? []) as Array<{ do_item_id: string | null; qty_returned: number }>) {
          if (!r.do_item_id) continue;
          const soItemId = doLineToSoItem.get(r.do_item_id) ?? null;
          returnLines.push({ soItemId, qty: Number(r.qty_returned ?? 0) });
        }
      }

      const fullyCovered = isSoFullyCovered(soLines, doLines, returnLines);

      // Line-level READY flip (Wei Siang 2026-06-01): a single SO line that has
      // been fully shipped out — NET delivered (Σ DO − Σ DR) ≥ its ordered qty —
      // must read READY, never stay stuck at PENDING. This is the "grab" case:
      // a DO is force-opened to push stock out before the line was ever marked
      // READY, so without this the line latches at PENDING forever even though
      // the goods have left the building.
      //
      // Why HERE and not in recomputeSoStockAllocation: recompute deliberately
      // SKIPS fully-shipped lines (deliverable_remaining ≤ 0 → `continue`), so it
      // never owns a shipped line's status. This reconciler is the sole writer
      // that lands shipped lines on READY. recompute always runs just BEFORE this
      // on every DO/DR mutation, so a line that a return drops back UNDER qty
      // leaves this jurisdiction (net < qty here → untouched) and recompute
      // re-derives its READY/PENDING from on-hand. Bidirectional + idempotent
      // (the `.neq` guard makes a re-run a no-op). 'READY' is already an allowed
      // stock_status value — no schema/constraint change.
      const netByLine = new Map<string, number>();
      for (const d of doLines) {
        if (!d.soItemId) continue;
        netByLine.set(d.soItemId, (netByLine.get(d.soItemId) ?? 0) + (d.qty ?? 0));
      }
      for (const r of returnLines) {
        if (!r.soItemId) continue;
        netByLine.set(r.soItemId, (netByLine.get(r.soItemId) ?? 0) - (r.qty ?? 0));
      }
      // SERVICE lines (delivery fee / dispose) have no inventory — never stamp a
      // stock_status on them (they don't participate in stock readiness).
      const shippedLines = soLines.filter((l) =>
        !isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code }) &&
        (netByLine.get(l.id) ?? 0) >= l.qty);
      const stampedCodes: string[] = [];
      for (const l of shippedLines) {
        const { data: stamped } = await sb.from('mfg_sales_order_items')
          .update({ stock_status: 'READY', stock_qty_ready: l.qty })
          .eq('id', l.id)
          .neq('stock_status', 'READY')
          .select('id');
        if ((stamped ?? []).length > 0) stampedCodes.push(l.item_code ?? l.id);
      }
      /* History audit (owner requirement: automated changes visible) — one
         summary row when shipped lines were auto-stamped READY. Only emitted
         when a row ACTUALLY flipped (the .neq guard + .select tell us), so
         idempotent re-runs stay silent. Best-effort by recordSoAudit design. */
      if (stampedCodes.length > 0) {
        await recordSoAudit(sb, {
          docNo,
          action: 'UPDATE_LINE',
          actorId: actorId ?? null,
          actorName: 'System (delivery sync)',
          source: 'automation',
          note: 'Line(s) marked READY — fully covered by delivery',
          fieldChanges: [{ field: 'stockStatus', from: 'auto', to: `READY: ${stampedCodes.join(', ')}` }],
        });
      }

      // Decide the reconciled status. No-op when it already matches (idempotent).
      let target: string | null = null;
      if (fullyCovered && canAdvance) target = 'DELIVERED';
      else if (!fullyCovered && canRelease) {
        /* RELEASE ONLY ON POSITIVE EVIDENCE (2026-09-04). "Not covered" can
           mean a cancelled DO, a reduced line, a return — or a shipped
           delivery order whose line rows are simply GONE. The last one is the
           corruption this module turned into three re-orders on 2026-09-02;
           it is held here, named in the SO's history, and never released. */
        const broken = await loadEmptyLiveDeliveries(sb, docNo);
        if (broken.length > 0) {
          await recordReleaseRefused(sb, docNo, actorId, broken);
          continue;
        }
        target = RELEASE_TO;
      }
      if (!target || target === status) continue;

      const note = target === 'DELIVERED'
        ? 'Auto: Delivery Order fully covers this SO'
        : 'Auto: SO no longer fully delivered (DO cancelled / reduced, or goods returned) — released to re-ship';
      const generation = await advanceSoGeneration(sb, docNo, { status: target }, { status });
      if (!generation.applied) continue;
      // Mirror the status-PATCH audit trail (both tables) so the SO History
      // panel shows this auto-transition beside manual transitions.
      await sb.from('mfg_so_status_changes').insert({
        ...(soCompanyId != null ? { company_id: soCompanyId } : {}),
        doc_no: docNo, from_status: status, to_status: target,
        changed_by: actorId ?? null, notes: note,
      });
      await recordSoAudit(sb, {
        docNo, action: 'UPDATE_STATUS', actorId: actorId ?? null,
        fieldChanges: [{ field: 'status', from: status, to: target }],
        statusSnapshot: target, source: 'automation',
        note,
      });
    } catch {
      /* best-effort — a sync failure must NEVER roll back or block the DO */
    }
  }
}
