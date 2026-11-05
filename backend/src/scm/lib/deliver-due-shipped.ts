// ----------------------------------------------------------------------------
// deliver-due-shipped — the daily LOCAL "actually delivered" sweep.
//
// Owner 2026-10-27. so-delivery-sync now only SHIPS an order (status SHIPPED)
// when a delivery order covers it; it never delivers. A LOCAL (non-East-Malaysia,
// non-Singapore) order becomes DELIVERED only once the delivery has actually
// happened, which the ERP reads as three facts together — the same "fully
// dispatched" test the driver run-sheet uses (frontend runSheetDispatch):
//
//   1. the order is SHIPPED (a covering DO exists — goods are out),
//   2. that DO's delivery date (do_date = AutoCount DocDate) has PASSED, and
//   3. a driver is assigned to it.
//
// 到日子 + 有 DO + 有司机 = 已送达. The one-day lag (a delivery on day D reads
// DELIVERED from D+1) is intended: "今天以前的日期 = 已送货".
//
// East Malaysia (Sabah / Sarawak / Labuan) and Singapore are NEVER swept here:
// their do_date is only a ship-out date and their real delivered signal lives in
// the HC Delivery sheet ("Done Delivered"), synced separately. Leaving them out
// means this sweep never wrongly delivers an in-transit EM/SG order.
//
// Runs in the daily 02:00 cron. Best-effort + idempotent: one SO's failure never
// blocks the rest, and a re-run only flips what is now eligible. The final
// invoice at delivery (when a company's deposit-invoice flow is on) is raised
// here, at the real delivery, instead of at ship-out.
// ----------------------------------------------------------------------------

import { DO_NOT_DELIVERED_IN_LIST } from '../shared/do-shipped-states';
import { recordSoAudit } from './so-audit';
import { advanceSoGeneration } from './so-generation';
import { autoFinalInvoiceBestEffort } from './auto-final-invoice';

/** East Malaysia + Singapore are excluded: do_date is their ship-out date, not a
 *  delivery; their delivered signal is the HC Delivery sheet. Everything else is
 *  LOCAL and swept on the date + driver rule. */
export function isLocalDeliveryGeography(state: string | null, country: string | null): boolean {
  if ((country ?? '').trim().toLowerCase() === 'singapore') return false;
  const s = (state ?? '').trim().toLowerCase();
  return !(s === 'sabah' || s === 'sarawak' || s === 'labuan');
}

/** A SHIPPED order is DELIVERED once its DO's delivery date has PASSED (strictly
 *  before today, Malaysia) AND a driver is on it — 到日子 + 有司机. Pure, so it is
 *  unit-tested; the sweep below is the thin Supabase glue around it. */
export function isShippedOrderDeliveredNow(input: {
  doDate: string | null;
  today: string;
  hasDriver: boolean;
}): boolean {
  const d = (input.doDate ?? '').slice(0, 10);
  return !!d && d < input.today && input.hasDriver;
}

export type DeliverDueResult = { scanned: number; delivered: number; skipped: number };

/** Flip every eligible LOCAL SHIPPED order to DELIVERED. `today` is YYYY-MM-DD
 *  (Malaysia). Pure glue around Supabase — safe to call from the daily cron. */
export async function deliverDueShippedOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose scm client, like advanceSoGeneration and the other cron helpers
  sb: any,
  today: string,
  actorId: string | null,
): Promise<DeliverDueResult> {
  const { data: soRaw, error: soErr } = await sb
    .from('mfg_sales_orders')
    .select('doc_no, company_id, customer_state, customer_country')
    .eq('status', 'SHIPPED')
    .limit(5000);
  // A failed read is not "no SHIPPED orders" — deliver nothing this run.
  if (soErr) return { scanned: 0, delivered: 0, skipped: 0 };
  const sos = ((soRaw ?? []) as Array<{
    doc_no: string; company_id: number | null; customer_state: string | null; customer_country: string | null;
  }>).filter((s) => isLocalDeliveryGeography(s.customer_state, s.customer_country));

  let delivered = 0;
  let skipped = 0;
  for (const so of sos) {
    try {
      // Live (non-DRAFT/CANCELLED) DOs for this SO, latest delivery date first.
      const { data: doRaw, error: doErr } = await sb
        .from('delivery_orders')
        .select('id, do_date, driver_id')
        .eq('so_doc_no', so.doc_no)
        .not('status', 'in', DO_NOT_DELIVERED_IN_LIST)
        .order('do_date', { ascending: false, nullsFirst: false });
      if (doErr) { skipped++; continue; } // can't read its DOs → don't deliver
      const dos = (doRaw ?? []) as Array<{ id: string; do_date: string | null; driver_id: string | null }>;
      if (dos.length === 0) { skipped++; continue; }
      const latest = dos[0]!;

      // A driver must be assigned — DO header driver_id OR a crew row driver, the
      // same crew the board / run-sheet reads.
      let hasDriver = !!latest.driver_id;
      if (!hasDriver) {
        const { data: crew, error: crewErr } = await sb
          .from('delivery_order_crew')
          .select('driver_1_id, driver_2_id, driver_1_name, driver_2_name')
          .eq('do_id', latest.id)
          .maybeSingle();
        if (crewErr) { skipped++; continue; } // can't confirm the driver → don't deliver
        const c = (crew ?? {}) as Record<string, string | null>;
        hasDriver = !!(c.driver_1_id || c.driver_2_id || (c.driver_1_name ?? '').trim() || (c.driver_2_name ?? '').trim());
      }

      // Deliver only once the DO's delivery date has passed and a driver is on it.
      if (!isShippedOrderDeliveredNow({ doDate: latest.do_date, today, hasDriver })) { skipped++; continue; }

      // Deliver — generation-guarded so a concurrent edit cannot double-apply.
      const gen = await advanceSoGeneration(sb, so.doc_no, { status: 'DELIVERED' }, { status: 'SHIPPED' });
      if (!gen.applied) { skipped++; continue; }
      await sb.from('mfg_so_status_changes').insert({
        ...(so.company_id != null ? { company_id: so.company_id } : {}),
        doc_no: so.doc_no, from_status: 'SHIPPED', to_status: 'DELIVERED',
        changed_by: actorId ?? null,
        notes: 'Auto: delivery done — DO date passed and a driver is assigned',
      });
      await recordSoAudit(sb, {
        docNo: so.doc_no, action: 'UPDATE_STATUS', actorId: actorId ?? null,
        fieldChanges: [{ field: 'status', from: 'SHIPPED', to: 'DELIVERED' }],
        statusSnapshot: 'DELIVERED', source: 'automation',
        note: 'Auto: local delivery done (DO date passed + driver)',
      });
      // The final invoice at delivery (docs/bugs/0830) now fires HERE — at the
      // real delivery — not at ship-out. Gated + best-effort inside.
      await autoFinalInvoiceBestEffort(sb, { docNo: so.doc_no, companyId: so.company_id, actorId: actorId ?? null });
      delivered++;
    } catch {
      skipped++;
    }
  }
  return { scanned: sos.length, delivered, skipped };
}
