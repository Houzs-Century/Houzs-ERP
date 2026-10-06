// ---------------------------------------------------------------------------
// chat-request-patch.ts — what a customer's WhatsApp tap is allowed to write
// onto the Sales Order.
//
// /api/chat-callback records every tap in scm.wa_message_log. This module
// decides which of the SO's REQUEST columns that tap also fills, so the
// Delivery Planning board shows it in the columns it already has:
//   amend_date_from_customer  → "Customer Request Date"
//   amend_reason              → "Amend Reason"
//   delivery_message_status   → "Delivery Message Status"
// These are the request/evidence fields the HC Delivery sheet used to fill from
// Seampify. They are NOT the schedule: customer_delivery_date and
// amended_delivery_date (the dates trips are planned around) are never in a
// patch from here — a human applies a requested date from the board. The test
// beside this file pins that list.
// ---------------------------------------------------------------------------

import { normDate } from "../services/agents/schedule-reconcile";

/** Columns a chat tap may write. Anything else is a bug, not a feature. */
export const CHAT_WRITABLE_SO_COLUMNS = [
  "amend_date_from_customer",
  "amend_reason",
  "delivery_message_status",
] as const;

/** Columns a chat tap must NEVER write — the schedule and the lifecycle. */
export const CHAT_FORBIDDEN_SO_COLUMNS = [
  "customer_delivery_date",
  "amended_delivery_date",
  "delivery_state",
  "status",
  "processing_date",
] as const;

/** Values of the board's Delivery Message Status vocabulary this writes
 *  (frontend MESSAGE_STATUSES, delivery-planning-queries.ts). "(D)" = the
 *  delivery-date conversation, the one the board's Send Now opens. */
export const CHAT_MESSAGE_STATUS = {
  confirm: "Done Scheduling",
  amend: "Pending Reschedule (D)",
} as const;

export type ChatEvent = keyof typeof CHAT_MESSAGE_STATUS;

export type ChatRequestPatch = Partial<
  Record<(typeof CHAT_WRITABLE_SO_COLUMNS)[number], string | null>
>;

/**
 * The SO patch for one tap. `requestedDate` is the raw string the flow sent
 * (DD/MM/YYYY from the typed fallback, YYYY-MM-DD from the Flow DatePicker);
 * an unparseable date is simply not written — the log row keeps the raw text,
 * so nothing is lost and nothing wrong lands in a date column.
 */
export function chatRequestPatch(
  event: ChatEvent,
  requestedDate: string | null,
  reason: string | null,
): ChatRequestPatch {
  const patch: ChatRequestPatch = { delivery_message_status: CHAT_MESSAGE_STATUS[event] };
  if (event === "amend") {
    const iso = normDate(requestedDate);
    if (iso) patch.amend_date_from_customer = iso;
    if (reason) patch.amend_reason = reason;
  }
  return patch;
}

/** The document-number alphabet. A ref is interpolated into a PostgREST
 *  filter where `,` `(` `)` are syntax, so anything else is refused, never
 *  escaped. An unresolved Connect placeholder ("{refs_all}") fails this too. */
export const DOC_REF_RE = /^[A-Za-z0-9_\-/.]+$/;

/** At most this many orders in one tap — a WhatsApp bundle shows 3 and says
 *  "you have N orders"; a longer list is a malformed caller, not a customer. */
export const MAX_CALLBACK_REFS = 20;

/**
 * The orders one tap applies to: the primary `ref` plus the bundle's `refs`
 * (comma-joined by the ERP's send as `refs_all`), trimmed, de-duplicated, in
 * order, primary first. Entries outside the doc-number alphabet are dropped
 * silently — the primary is validated by the caller, which answers 400.
 */
export function parseCallbackRefs(ref: string, refs: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? "").trim().slice(0, 64);
    if (!s || !DOC_REF_RE.test(s) || out.includes(s)) return;
    if (out.length < MAX_CALLBACK_REFS) out.push(s);
  };
  push(ref);
  if (typeof refs === "string") refs.split(",").forEach(push);
  else if (Array.isArray(refs)) refs.forEach(push);
  return out;
}

/** Audit field names (so-audit-labels.ts keys) for the columns a patch set. */
export function chatRequestFieldChanges(
  patch: ChatRequestPatch,
  before: Record<string, unknown>,
): Array<{ field: string; from: unknown; to: unknown }> {
  const names: Record<string, string> = {
    amend_date_from_customer: "amendDateFromCustomer",
    amend_reason: "amendReason",
    delivery_message_status: "deliveryMessageStatus",
  };
  const out: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const [col, to] of Object.entries(patch)) {
    const from = before[col] ?? null;
    if (String(from ?? "") !== String(to ?? "")) out.push({ field: names[col] ?? col, from, to });
  }
  return out;
}
