// ---------------------------------------------------------------------------
// assrConnectAck.ts — customer WhatsApp acknowledgement when a Service Case
// (ASSR) is CREATED, sent via Houzs Connect alongside the internal in-app
// notice (assrNotify.ts, which defers the WhatsApp side).
//
// The customer hears that their service request was received and the after-sales
// team is arranging it. Connect fires its "Service Case Received" automation
// (CONNECT_SERVICE_CASE_AUTOMATION), which sends the button-less template
// hc_service_case_received (params full_name + ref_1 = the SO/order ref + assr_no).
//
// GATE (owner 2026-11-11): only a case whose ORIGINAL order has a Delivery Order
// (the DO No. the board now shows) is acknowledged. A case with no DO — its order
// predates the ERP, or no DO has been raised — gets NO customer WhatsApp. This
// re-enables the create ack that HC-0222 (#5447) had turned off, now gated, so a
// DO-less case still sends the customer nothing.
//
// Best-effort and self-contained, mirroring assrNotify's contract: only when
// Connect is configured and the case has a usable phone and a DO, and it NEVER
// throws — a Connect failure must not fail case creation. Only on CREATE: the
// caller does not invoke this from the reassign paths.
//
// The Connect side must have the "Service Case Received" automation ENABLED and
// the Meta template hc_service_case_received approved for a send to go out; a
// disabled automation answers an empty `triggered`, which postConnectContact
// reports (not throws).
// ---------------------------------------------------------------------------

import type { Env } from "../types";
import { normalizePhone } from "../scm/shared/phone";
import { buildServiceCaseReceived, isConnectConfigured, postConnectContact } from "./connect";

/** True when the case's ORIGINAL order (soNo = the case doc_no) carries at least
 *  one Delivery Order — the same resolution the board uses: match the order by
 *  doc_no or linked_ac_docno, then look for a delivery_order on the resolved
 *  (or raw) doc_no. Fail-closed: a lookup error returns false, so the gate never
 *  lets an unverified case through. */
export async function caseHasDeliveryOrder(env: Env, soNo: string | null): Promise<boolean> {
  const doc = String(soNo ?? "").trim();
  if (!doc) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS has_do
         FROM scm.delivery_orders d
        WHERE d.so_doc_no = COALESCE(
                (SELECT o.doc_no FROM scm.mfg_sales_orders o
                   WHERE o.doc_no = ? OR o.linked_ac_docno = ?
                   ORDER BY (o.doc_no = ?) DESC LIMIT 1),
                ?)
        LIMIT 1`,
    )
      .bind(doc, doc, doc, doc)
      .first();
    return !!row;
  } catch (e) {
    console.warn(`[assr.create] DO gate check failed for ${doc}:`, (e as Error).message);
    return false;
  }
}

/** Fire the one-off customer acknowledgement for a newly-created case. soNo is
 *  the Sales Order the case is about (ref_1); assrNo is the case number. Sends
 *  nothing when Connect is off, the phone is unusable, or — owner 2026-11-11 —
 *  the case's order has no DO. Returns nothing and swallows every failure, so it
 *  is safe to await in the create path. */
export async function sendServiceCaseReceivedAck(
  env: Env,
  assrNo: string,
  soNo: string | null,
  customerName: string | null,
  phoneRaw: string | null,
): Promise<void> {
  if (!isConnectConfigured(env)) return;
  const phone = normalizePhone(phoneRaw);
  if (!phone) return;
  // No DO on the original order -> no customer message (owner 2026-11-11).
  if (!(await caseHasDeliveryOrder(env, soNo))) return;
  try {
    const res = await postConnectContact(
      env,
      buildServiceCaseReceived(phone, String(customerName ?? ""), String(soNo ?? ""), assrNo),
    );
    if (!res.ok) {
      console.error(`[assr.create] Connect ack failed (${assrNo}): ${res.error}`);
    }
  } catch (e) {
    console.error("[assr.create] Connect ack failed:", (e as Error).message);
  }
}
