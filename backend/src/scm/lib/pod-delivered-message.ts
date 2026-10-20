// Auto "Delivery Completed" WhatsApp on a real POD (#5).
//
// When a Delivery Order is marked DELIVERED with REAL proof of delivery
// (signature / photo / GPS) AND that delivery completes its Sales Order, fire the
// 'Delivery Completed' Connect automation ONCE, thanking the customer.
//
// Owner decision (2026-10-19): fires AUTOMATICALLY, and ONLY on a real POD — an
// evidence-free "mark delivered" (office advance, DoLoadScan, PublicDoScan) never
// auto-thanks. Best-effort and INERT without Connect: like the DO email it never
// throws and never blocks the DO write, and with CONNECT_WEBHOOK_URL/_KEY unset it
// does nothing. It sends through the SAME path as the board's "Send Now"
// (sendDeliveryMessageForDocs), so there is one sender and one wa_message_log
// shape. The once-guard column pod_completed_msg_sent_at (mig 20261020T1700) is
// claimed atomically so a concurrent double-DELIVERED, or a later re-delivery,
// cannot send the thank-you twice.

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { isConnectConfigured } from '../../services/connect';
import { sendDeliveryMessageForDocs } from '../routes/delivery-messages';

/** PURE gate — thank the customer iff the completing DO carries real POD
 *  evidence, the SO it belongs to is now fully delivered, and no message has
 *  been sent for this DO yet. Unit-tested; the async wrapper below is only the
 *  Supabase glue that reads these three facts. */
export function shouldSendPodDelivered(input: {
  hasPod: boolean;
  soFullyDelivered: boolean;
  alreadySent: boolean;
}): boolean {
  return input.hasPod && input.soFullyDelivered && !input.alreadySent;
}

interface PodDoRow {
  so_doc_no: string | null;
  signature_data: string | null;
  pod_r2_key: string | null;
  pod_lat: number | null;
  pod_completed_msg_sent_at: string | null;
}

/** Best-effort: never throws, never blocks the DO. Fire the 'Delivery Completed'
 *  message once for a DO whose real POD completes its SO. Call AFTER
 *  syncSoDeliveredFromDo, so the SO's status already reflects this delivery. */
export async function maybeSendPodDeliveredWhatsApp(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  deliveryOrderId: string,
): Promise<void> {
  try {
    // INERT without Connect — checked FIRST, before any read or the claim write,
    // so an unconfigured deployment touches nothing (matches maybeSendDeliveryOrderEmail).
    if (!isConnectConfigured(c.env)) return;
    const sb = c.get('supabase');

    // company-scope: the DO id is this DELIVERED status handler's own already
    // authorised document; reading its POD evidence + once-guard back by that id
    // is not a cross-tenant lookup (same shape as the handler's so_doc_no read).
    const { data, error } = await sb
      .from('delivery_orders')
      .select('so_doc_no, signature_data, pod_r2_key, pod_lat, pod_completed_msg_sent_at')
      .eq('id', deliveryOrderId)
      .maybeSingle();
    if (error || !data) return;
    const d = data as unknown as PodDoRow;

    const soDocNo = (d.so_doc_no ?? '').trim();
    if (!soDocNo) return;
    const hasPod = d.signature_data != null || d.pod_r2_key != null || d.pod_lat != null;
    const alreadySent = d.pod_completed_msg_sent_at != null;

    // "Fully delivered" = syncSoDeliveredFromDo advanced the SO to DELIVERED (its
    // sole fully-covered effect; it ran just before this hook). company-scope:
    // the SO is read by the DO's own so_doc_no — the widened TMS linkage the
    // shared sender itself uses.
    const { data: soRow, error: soErr } = await sb
      .from('mfg_sales_orders').select('status').eq('doc_no', soDocNo).maybeSingle();
    if (soErr) return;
    const soFullyDelivered = (soRow as { status?: string } | null)?.status === 'DELIVERED';

    if (!shouldSendPodDelivered({ hasPod, soFullyDelivered, alreadySent })) return;

    // Claim the once-guard atomically: Postgres serialises the two UPDATEs and the
    // `.is(null)` filter means exactly one caller gets a row; the loser of a
    // concurrent double-DELIVERED sees none and returns. Mirrors
    // maybeSendDeliveryOrderEmail (do-email.ts).
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = await sb
      .from('delivery_orders')
      .update({ pod_completed_msg_sent_at: claimedAt })
      .eq('id', deliveryOrderId)
      .is('pod_completed_msg_sent_at', null)
      .select('id')
      .maybeSingle();
    // No claim (write error, or lost a concurrent double-DELIVERED) → do not send.
    if (claimErr || !claimed) return;

    const result = await sendDeliveryMessageForDocs(c, [soDocNo], 'delivery_completed', {});
    if (result.sent.length > 0) return; // claim stands = the customer was thanked

    // Not sent (no phone, Connect down, automation disabled, a fail-closed read)
    // → RELEASE the claim, so the stamp only ever means "the customer WAS thanked"
    // and a later re-delivery / retry can fire.
    await sb
      .from('delivery_orders')
      .update({ pod_completed_msg_sent_at: null })
      .eq('id', deliveryOrderId)
      .eq('pod_completed_msg_sent_at', claimedAt)
      .select('id')
      .maybeSingle();
  } catch {
    // Best-effort: the DO is committed and the goods are out. Never rethrow.
  }
}
