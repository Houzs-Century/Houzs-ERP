
import { DO_NOT_DELIVERED_IN_LIST, doCountsAsDelivered } from '../shared/do-shipped-states';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isServiceLine } from '../shared';
import { recordSoAudit } from './so-audit';
import { advanceSoGeneration } from './so-generation';
import { autoFinalInvoiceBestEffort } from './auto-final-invoice';
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

const DELIVERABLE_FROM = ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED'];

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
      const soCompanyId = (so as { company_id?: number | null } | null)?.company_id ?? null;
      if (!status) continue;
      const canAdvance = DELIVERABLE_FROM.includes(status);
      const canRelease = status === 'DELIVERED' || status === 'SHIPPED';
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
      for (const a of attributed) {
        doItemRows.push({ id: a.doLineId, so_item_id: a.soItemId, qty: a.qty });
        doLines.push({ soItemId: a.soItemId, qty: a.qty });
      }

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

      const netByLine = new Map<string, number>();
      for (const d of doLines) {
        if (!d.soItemId) continue;
        netByLine.set(d.soItemId, (netByLine.get(d.soItemId) ?? 0) + (d.qty ?? 0));
      }
      for (const r of returnLines) {
        if (!r.soItemId) continue;
        netByLine.set(r.soItemId, (netByLine.get(r.soItemId) ?? 0) - (r.qty ?? 0));
      }
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
      // Goods out (a covering non-DRAFT/CANCELLED DO) = SHIPPED, NOT delivered.
      // DELIVERED is set only once the delivery actually happens — the daily
      // local sweep (deliverDueShippedOrders: do_date passed + a driver) or the
      // EM sheet sync. owner 2026-10-27: 到日子 + 有 DO + 有司机 = 已送达;
      // 东马按 Google 表的 "Done Delivered"。
      // Actually delivered? A covering DO that is SIGNED / DELIVERED (a POD was
      // run) or carries a delivered timestamp means the delivery HAPPENED — the
      // SO is DELIVERED now, and the delivered-message + invoice fire. Merely
      // LOADED / in-transit coverage is only SHIPPED; the daily local sweep (or
      // the EM sheet sync) delivers it later.
      const { data: doStatesRaw, error: doStatesErr } = await sb
        .from('delivery_orders')
        .select('status, customer_delivered_date')
        .eq('so_doc_no', docNo)
        .not('status', 'in', DO_NOT_DELIVERED_IN_LIST);
      const anyDoDelivered = !doStatesErr
        && ((doStatesRaw ?? []) as Array<{ status: string | null; customer_delivered_date: string | null }>)
          .some((d) => d.status === 'SIGNED' || d.status === 'DELIVERED' || !!d.customer_delivered_date);

      let target: string | null = null;
      if (fullyCovered && canAdvance) target = anyDoDelivered ? 'DELIVERED' : 'SHIPPED';
      else if (!fullyCovered && canRelease) {
        const broken = await loadEmptyLiveDeliveries(sb, docNo);
        if (broken.length > 0) {
          await recordReleaseRefused(sb, docNo, actorId, broken);
          continue;
        }
        target = RELEASE_TO;
      }
      if (!target || target === status) continue;

      const note = target === 'DELIVERED'
        ? 'Auto: Delivery Order covers this SO and is signed/delivered — delivered'
        : target === 'SHIPPED'
          ? 'Auto: Delivery Order fully covers this SO — goods shipped out (delivered follows on the actual-delivery sweep)'
          : 'Auto: SO no longer fully shipped (DO cancelled / reduced, or goods returned) — released to re-ship';
      const generation = await advanceSoGeneration(sb, docNo, { status: target }, { status });
      if (!generation.applied) continue;
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
      /* THE FINAL INVOICE AT DELIVERY (docs/bugs/0830) fires on the DELIVERED hop
         only: a SIGNED/DELIVERED DO (a POD) delivers the SO here and is invoiced
         here. A merely-shipped (SHIPPED) order is NOT invoiced here — it is
         invoiced later, when the daily local sweep (deliverDueShippedOrders) or,
         for East Malaysia, the sheet sync flips SHIPPED -> DELIVERED. */
      if (target === 'DELIVERED') await autoFinalInvoiceBestEffort(sb, { docNo, companyId: soCompanyId, actorId: actorId ?? null });
    } catch {
    }
  }
}
