// ---------------------------------------------------------------------------
// assrConnectAck.ts — customer WhatsApp acknowledgement when a Service Case
// (ASSR) is CREATED, sent via Houzs Connect alongside the internal in-app
// notice (assrNotify.ts, which deferred the WhatsApp side).
//
// The customer hears that their service request was received and the after-sales
// team is arranging it. Connect fires its "Service Case Received" automation
// (CONNECT_SERVICE_CASE_AUTOMATION), which sends the button-less template
// hc_service_case_received (params full_name + ref_1 = the case number).
//
// Best-effort and self-contained, mirroring assrNotify's contract: only when
// Connect is configured and the case has a usable phone, and it NEVER throws —
// a Connect failure must not fail case creation. Only on CREATE: the caller does
// not invoke this from the reassign paths.
//
// Still dormant until the Connect side is enabled: the "Service Case Received"
// flow seeds DRAFT/disabled and the Meta template hc_service_case_received needs
// approval. A disabled automation answers an empty `triggered`, which
// postConnectContact reports (not throws); the wiring is correct regardless.
// ---------------------------------------------------------------------------

import type { Env } from "../types";
import { normalizePhone } from "../scm/shared/phone";
import { buildServiceCaseReceived, isConnectConfigured, postConnectContact } from "./connect";

/** Fire the one-off customer acknowledgement for a newly-created case. Returns
 *  nothing and swallows every failure — safe to await in the create path. */
export async function sendServiceCaseReceivedAck(
  env: Env,
  assrNo: string,
  customerName: string | null,
  phoneRaw: string | null,
): Promise<void> {
  if (!isConnectConfigured(env)) return;
  const phone = normalizePhone(phoneRaw);
  if (!phone) return;
  try {
    const res = await postConnectContact(
      env,
      buildServiceCaseReceived(phone, String(customerName ?? ""), assrNo),
    );
    if (!res.ok) {
      console.error(`[assr.create] Connect ack failed (${assrNo}): ${res.error}`);
    }
  } catch (e) {
    console.error("[assr.create] Connect ack failed:", (e as Error).message);
  }
}
