// ---------------------------------------------------------------------------
// chat-callback-record.ts — record ONE customer tap against ONE Sales Order.
//
// /api/chat-callback receives one tap that may concern several orders (a
// customer with 2–4 orders gets ONE WhatsApp bundling them; Confirm / Amend
// applies to all of them). The route resolves the refs; this module does the
// per-order work it used to do inline, unchanged in substance:
//   1. idempotency — the same callback_id for the same doc is answered as a
//      duplicate, never written twice;
//   2. the scm.wa_message_log row — the RECORD of the answer (a failed insert
//      is thrown, the route answers 500 so chat retries);
//   3. the SO request columns the board shows (lib/chat-request-patch.ts),
//      written through advanceSoGeneration and audited as the customer.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceSoGeneration } from "../scm/lib/so-generation";
import { recordSoAudit } from "../scm/lib/so-audit";
import { chatRequestFieldChanges, chatRequestPatch, type ChatEvent } from "./chat-request-patch";

export interface ChatTapInput {
  /** Resolved company id (null only in the single-company / D1 state). */
  companyId: number | null;
  /** OUR doc_no — the board's key. */
  docNo: string;
  /** The number chat sent for this order (may be the AutoCount number). */
  customerRef: string;
  callbackId: string | null;
  event: ChatEvent;
  phone: string | null;
  requestedDate: string | null;
  reason: string | null;
  note: string | null;
}

export interface ChatTapResult {
  docNo: string;
  /** wa_message_log row id (the existing row when `duplicate`). */
  id: string | null;
  duplicate: boolean;
  so_request: { written: boolean; reason?: string };
}

export class ChatTapLogFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatTapLogFailed";
  }
}

/** The service client is typed for the scm schema; the audit helper's
 *  parameter type says "public" — same client, different generic. */
type AuditClient = Parameters<typeof recordSoAudit>[0];

/** The route hands in the scm-schema service client; the same client type the
 *  SO helpers take. Generic over the schema so neither side needs a cast. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js schema generics; the call sites are typed
type AnySchemaClient = SupabaseClient<any, any, any, any, any>;

export async function recordChatTap(sb: AnySchemaClient, input: ChatTapInput): Promise<ChatTapResult> {
  const { companyId, docNo, customerRef, callbackId, event, phone, requestedDate, reason, note } = input;

  // ── Idempotency ─────────────────────────────────────────────────────────
  // A webhook can fire twice for one tap. The id is matched against the exact
  // JSON fragment it was written as, scoped to this company AND this doc, and
  // only among this route's own rows — so neither another tenant's row, nor a
  // delivery-planning send, nor a sibling order of the same bundle can be
  // mistaken for a duplicate.
  if (callbackId) {
    let dupeQuery = sb
      .from("wa_message_log")
      .select("id")
      .eq("source", "chat-callback")
      .eq("doc_no", docNo)
      .like("payload", `%"callback_id":"${callbackId}"%`);
    if (companyId != null) dupeQuery = dupeQuery.eq("company_id", companyId);
    const { data: dupe, error: dupeErr } = await dupeQuery.limit(1);
    // NOT `data ?? []`. supabase-js does not throw: an unbound error here would
    // read a five-second blip as "not a duplicate" and write the customer's
    // answer twice — the exact class BUG-HISTORY 2026-07-17 records as money
    // collected twice at the door. If we cannot tell, we refuse and let chat
    // retry.
    if (dupeErr) throw new ChatTapLogFailed(dupeErr.message);
    if (dupe && dupe.length > 0) {
      return { docNo, id: (dupe[0] as { id: string }).id, duplicate: true, so_request: { written: false, reason: "duplicate" } };
    }
  }

  // ── Record ──────────────────────────────────────────────────────────────
  // Reuses scm.wa_message_log rather than a new table: the board already reads
  // it per doc, and one timeline of "what we sent / what they answered" beats
  // two. `success` is TRUE here in the sense the row means — the callback was
  // received and understood; `http_code` stays null because nothing was sent.
  // delivery-messages./statuses filters to source='delivery-planning' so these
  // rows cannot displace the board's send-status column.
  const payload = JSON.stringify({
    callback_id: callbackId,
    event,
    ref: docNo,
    // What chat actually sent, kept when it differs (an AutoCount number) so
    // a mismatch can be chased without guessing which number was matched.
    ...(customerRef !== docNo ? { customer_ref: customerRef } : {}),
    phone,
    requested_delivery_date: requestedDate,
    reason,
    note,
  });

  const { data: inserted, error: insErr } = await sb
    .from("wa_message_log")
    .insert({
      batch_id: crypto.randomUUID(),
      company_id: companyId,
      doc_no: docNo,
      phone: phone ?? "",
      payload,
      http_code: null,
      success: true,
      error: null,
      source: "chat-callback",
      created_by: null,
    })
    .select("id")
    .limit(1);

  // NOT best-effort, unlike the send path's log. There the WhatsApp had
  // already left and a log failure must not report a delivered message as an
  // error; here the row IS the delivery. Swallowing it would answer 200 to
  // chat, which would then never retry, and the customer's answer would be
  // gone for good.
  if (insErr) throw new ChatTapLogFailed(insErr.message);
  const id = (inserted?.[0] as { id: string } | undefined)?.id ?? null;

  // ── Mirror the REQUEST onto the SO ──────────────────────────────────────
  // The board's "Customer Request Date" / "Amend Reason" / "Delivery Message
  // Status" columns. chat-request-patch.ts decides the patch and pins that it
  // never names the schedule or the lifecycle. Written through
  // advanceSoGeneration like every other SO header write, so the version moves
  // and a stale SO editor save gets its 409 instead of silently putting the
  // customer's answer back. Best-effort AFTER the log row: the row is the
  // record; a lease / conflict here is reported, not retried.
  const requestPatch = chatRequestPatch(event, requestedDate, reason);
  let soRequest: ChatTapResult["so_request"] = { written: false, reason: "nothing_to_write" };
  if (Object.keys(requestPatch).length > 0) {
    try {
      let beforeQuery = sb
        .from("mfg_sales_orders")
        .select("amend_date_from_customer, amend_reason, delivery_message_status, status")
        .eq("doc_no", docNo);
      if (companyId != null) beforeQuery = beforeQuery.eq("company_id", companyId);
      const { data: beforeRow, error: beforeErr } = await beforeQuery.maybeSingle();
      if (beforeErr) throw beforeErr;
      const before = (beforeRow ?? {}) as Record<string, unknown>;
      const gen = await advanceSoGeneration(sb, docNo, requestPatch);
      if (!gen.applied) {
        soRequest = { written: false, reason: gen.reason };
      } else {
        soRequest = { written: true };
        const fieldChanges = chatRequestFieldChanges(requestPatch, before);
        if (fieldChanges.length > 0) {
          await recordSoAudit(sb as unknown as AuditClient, {
            docNo,
            action: "UPDATE_DETAILS",
            actorId: null,
            actorName: "Customer (WhatsApp)",
            fieldChanges,
            statusSnapshot: (before as { status?: string }).status ?? null,
            source: "chat-callback",
            note: `Customer tapped ${event} in WhatsApp${callbackId ? ` (${callbackId})` : ""}`,
          });
        }
      }
    } catch (e) {
      soRequest = { written: false, reason: String((e as Error)?.message ?? e).slice(0, 160) };
    }
  }

  return { docNo, id, duplicate: false, so_request: soRequest };
}
