// Delivery Order → customer email, on CONFIRM.
//
// Owner ruling (2026-07-17): trigger "A" — tell the customer when the DO is
// CONFIRMED, not when it is delivered and not by hand. In this codebase the DO
// "Confirm" action is exactly the pre-ship → DISPATCHED transition
// (delivery-orders-mfg.ts:3768), and a DO created without `asDraft` is BORN
// DISPATCHED (:2472, :2858) — so "confirmed" has three call sites, all of which
// are the same event: goods have left for the customer.
//
// WHY THE BACKEND SENDS, and not the browser:
//   HOOKKA wired the same feature frontend-only and 128 DOs were never emailed —
//   the browser simply was not open. The send lives here so do_email_sent_at is
//   set by the thing that actually delivered the mail, which makes that silent
//   miss structurally impossible. This module renders NO PDF: Houzs's PDF
//   generator is frontend jsPDF (vendor/scm/lib/pdf-common.ts) which verifies
//   the embedded font's cmap covers every codepoint and throws rather than
//   corrupt; a backend generator would be a SECOND engine that regresses Chinese
//   customer names to '?', which is exactly the divergence HOOKKA now maintains
//   forever. backend/package.json has no pdf dependency — keep it that way.
//
// SAFETY — this ships OFF. `email.delivery_order` is seeded {"value":false}
// (mig 098:22-25) and `delivery_order` is in email.ts's FAIL_CLOSED_PURPOSES, so
// a missing toggle row also reads OFF. The gate is checked HERE before any write
// and again inside sendEmail; nothing is sent, claimed or stamped while it's off.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import { sendEmail, documentEmailHtml, isChannelEnabled } from '../../services/email';
import { getBrandingForCompany } from '../../services/branding';

const DO_EMAIL_COLS =
  'id, company_id, do_number, email, debtor_name, do_email_sent_at, ' +
  'address1, address2, city, postcode, state, ' +
  'customer_delivery_date, expected_delivery_at, driver_name, vehicle';

export interface DoEmailRow {
  id: string;
  company_id: number | string | null;
  do_number: string | null;
  email: string | null;
  debtor_name: string | null;
  do_email_sent_at: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  state: string | null;
  customer_delivery_date: string | null;
  expected_delivery_at: string | null;
  driver_name: string | null;
  vehicle: string | null;
}

/** Build the customer-facing DO email from the DO's own snapshot. Returns null
 *  when the DO has no recipient — the caller treats null as "nothing to send",
 *  never as an error: a customer with no email on file is an ordinary state,
 *  not an operator fault, and the goods still ship. */
export function buildDeliveryOrderEmail(
  row: DoEmailRow,
  companyName: string,
): { to: string; subject: string; html: string } | null {
  const to = (row.email ?? '').trim();
  if (!to || !to.includes('@')) return null;

  const docNo = row.do_number ?? row.id;
  const addr = [row.address1, row.address2, row.city, row.postcode, row.state]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(', ');

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Delivery Order', value: docNo },
  ];
  if (addr) rows.push({ label: 'Delivery To', value: addr });
  const scheduled = row.customer_delivery_date || row.expected_delivery_at;
  rows.push({ label: 'Scheduled', value: scheduled || 'To be confirmed' });
  if (row.driver_name) rows.push({ label: 'Driver', value: row.driver_name });
  if (row.vehicle) rows.push({ label: 'Lorry', value: row.vehicle });

  return {
    to,
    subject: `${companyName} — Delivery Order ${docNo}`,
    /* documentEmailHtml INLINES the whole summary and escapes every interpolated
       value. No attachment and no portal link yet: the owner's "之後可能也會要附件"
       is a LATER want, and neither is foreclosed — SendOptions.attachments is
       already forwarded to Resend (email.ts:233) and documentEmailHtml already
       takes a viewLink. See the note on attachments at the call site. */
    html: documentEmailHtml({
      docTypeLabel: 'Delivery Order',
      docNo,
      recipientName: row.debtor_name || 'Customer',
      rows,
      companyName,
      note: 'Your order is on its way and will arrive as scheduled above.',
    }),
  };
}

/**
 * Send the DO email exactly once, on confirm. Best-effort: NEVER throws and
 * never blocks the confirm — the goods are already out and the DO is the source
 * of truth for that; an email problem must not fail the document.
 *
 * Returns a short reason when the customer was NOT emailed and the operator
 * could act on it, else null. Callers surface it beside movementErrors.
 */
export async function maybeSendDeliveryOrderEmail(
  sb: SupabaseClient<any, any, any>,
  env: Env,
  deliveryOrderId: string,
): Promise<string | null> {
  try {
    if (!(await isChannelEnabled(env, 'delivery_order'))) return null;

    const { data, error } = await sb
      .from('delivery_orders')
      .select(DO_EMAIL_COLS)
      .eq('id', deliveryOrderId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as unknown as DoEmailRow;

    if (row.do_email_sent_at) return null;

    if (!(row.email ?? '').trim()) {
      return 'No delivery email was sent: this customer has no email address on the order.';
    }

    const branding = await getBrandingForCompany(env, row.company_id ?? null);
    const msg = buildDeliveryOrderEmail(row, branding.companyName);
    if (!msg) return null;

    const claimedAt = new Date().toISOString();
    const { data: claimed } = await sb
      .from('delivery_orders')
      .update({ do_email_sent_at: claimedAt })
      .eq('id', deliveryOrderId)
      .is('do_email_sent_at', null)
      .select('id')
      .maybeSingle();
    if (!claimed) return null;

    const result = await sendEmail(env, {
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      purpose: 'delivery_order',
      refType: 'delivery_order',
      companyCode: row.company_id != null ? String(row.company_id) : null,
    });

    if (result.status === 'sent') return null;

    await sb
      .from('delivery_orders')
      .update({ do_email_sent_at: null })
      .eq('id', deliveryOrderId)
      .eq('do_email_sent_at', claimedAt)
      .select('id')
      .maybeSingle();

    if (result.status === 'error') {
      return `The delivery email to ${msg.to} did not go out on the first try. It will be retried automatically.`;
    }
    return null;
  } catch {
    return null;
  }
}
