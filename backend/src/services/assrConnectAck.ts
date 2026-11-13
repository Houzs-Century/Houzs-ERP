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
// (the DO No. the board shows) is acknowledged. A case with no DO — its order
// predates the ERP with no DO mirror, or no DO has been raised — gets NO customer
// WhatsApp. This re-enables the create ack that HC-0222 (#5447) had turned off,
// now gated, so a DO-less case still sends the customer nothing.
//
// The DO is resolved by `attachDeliveryOrders` — the SAME resolver the case detail
// and the Delivery Planning board use (hand-entered delivery_order, else
// sales_orders.transfer_to / the AutoCount DO-mirror matched by ref_no / scm by
// so_doc_no). Resolving it the narrow scm-only way missed HOUZS cases on an
// AutoCount-numbered order, which would have silenced an ack that should send.
//
// Best-effort and self-contained, mirroring assrNotify's contract: only when
// Connect is configured, the case has a usable phone, and it has a DO; it NEVER
// throws — a Connect failure must not fail case creation. Only on CREATE.
//
// Go-live needs the Connect "Service Case Received" automation ENABLED and the
// Meta template hc_service_case_received approved (both exist).
// ---------------------------------------------------------------------------

import type { Env } from "../types";
import { normalizePhone } from "../scm/shared/phone";
import { attachDeliveryOrders } from "./assr";
import { orderDoNumbers } from "./assrOrderDos";
import { buildServiceCaseReceived, isConnectConfigured, postConnectContact } from "./connect";

/** The case fields the DO gate + the ack need. company_code (HOUZS/2990) steers
 *  the resolver; ref_no matches the AutoCount DO-mirror; delivery_order is any
 *  hand-entered DO that wins outright. */
export interface AssrAckCase {
  assrNo: string;
  soNo: string | null;        // the case's doc_no (the SO/order ref), ref_1 in the template
  customerName: string | null;
  phone: string | null;
  refNo: string | null;
  companyCode: string | null;
  deliveryOrder: string | null;
}

/** True when the case resolves to at least one Delivery Order, via the one
 *  resolver the detail/board use. Fail-closed: a resolver error → false (never
 *  acknowledge a case whose DO we could not confirm). */
export async function caseHasDeliveryOrder(env: Env, c: AssrAckCase): Promise<boolean> {
  const row: Record<string, unknown> = {
    doc_no: c.soNo ?? "",
    ref_no: c.refNo ?? "",
    company_code: c.companyCode ?? null,
    delivery_order: c.deliveryOrder ?? null,
  };
  try {
    await attachDeliveryOrders(env, [row]);
    return orderDoNumbers(row).length > 0;
  } catch (e) {
    console.warn(`[assr.create] DO gate check failed for ${c.assrNo}:`, (e as Error).message);
    return false;
  }
}

/** Fire the one-off customer acknowledgement for a newly-created case. Sends
 *  nothing when Connect is off, the phone is unusable, or — owner 2026-11-11 —
 *  the case has no DO. Returns nothing and swallows every failure, so it is safe
 *  to await in the create path. */
export async function sendServiceCaseReceivedAck(env: Env, c: AssrAckCase): Promise<void> {
  if (!isConnectConfigured(env)) return;
  const phone = normalizePhone(c.phone);
  if (!phone) return;
  // No DO on the case -> no customer message (owner 2026-11-11).
  if (!(await caseHasDeliveryOrder(env, c))) return;
  try {
    const res = await postConnectContact(
      env,
      buildServiceCaseReceived(phone, String(c.customerName ?? ""), String(c.soNo ?? ""), c.assrNo),
    );
    if (!res.ok) {
      console.error(`[assr.create] Connect ack failed (${c.assrNo}): ${res.error}`);
    }
  } catch (e) {
    console.error("[assr.create] Connect ack failed:", (e as Error).message);
  }
}
