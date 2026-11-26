
import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceSoGeneration } from "../scm/lib/so-generation";
import { recordSoAudit } from "../scm/lib/so-audit";
import { chatRequestFieldChanges, chatRequestPatch, type ChatEvent, type PropertyAnswers } from "./chat-request-patch";

export interface ChatTapInput {
  companyId: number | null;
  docNo: string;
  customerRef: string;
  callbackId: string | null;
  event: ChatEvent;
  phone: string | null;
  requestedDate: string | null;
  reason: string | null;
  note: string | null;
  property?: PropertyAnswers | null;
}

export interface ChatTapResult {
  docNo: string;
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

type AuditClient = Parameters<typeof recordSoAudit>[0];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js schema generics; the call sites are typed
type AnySchemaClient = SupabaseClient<any, any, any, any, any>;

export async function recordChatTap(sb: AnySchemaClient, input: ChatTapInput): Promise<ChatTapResult> {
  const { companyId, docNo, customerRef, callbackId, event, phone, requestedDate, reason, note, property } = input;

  if (callbackId) {
    let dupeQuery = sb
      .from("wa_message_log")
      .select("id")
      .eq("source", "chat-callback")
      .eq("doc_no", docNo)
      .like("payload", `%"callback_id":"${callbackId}"%`);
    if (companyId != null) dupeQuery = dupeQuery.eq("company_id", companyId);
    const { data: dupe, error: dupeErr } = await dupeQuery.limit(1);
    if (dupeErr) throw new ChatTapLogFailed(dupeErr.message);
    if (dupe && dupe.length > 0) {
      return { docNo, id: (dupe[0] as { id: string }).id, duplicate: true, so_request: { written: false, reason: "duplicate" } };
    }
  }

  const payload = JSON.stringify({
    callback_id: callbackId,
    event,
    ref: docNo,
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

  if (insErr) throw new ChatTapLogFailed(insErr.message);
  const id = (inserted?.[0] as { id: string } | undefined)?.id ?? null;

  const requestPatch = chatRequestPatch(event, requestedDate, reason, property);
  let soRequest: ChatTapResult["so_request"] = { written: false, reason: "nothing_to_write" };
  if (Object.keys(requestPatch).length > 0) {
    try {
      let beforeQuery = sb
        .from("mfg_sales_orders")
        .select("amend_date_from_customer, amend_reason_from_customer, delivery_message_status, house_type, replacement_disposal, disposal_request, status")
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
