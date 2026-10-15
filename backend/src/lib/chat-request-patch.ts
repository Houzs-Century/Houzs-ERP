// ---------------------------------------------------------------------------
// chat-request-patch.ts — what a customer's WhatsApp tap is allowed to write
// onto the Sales Order.
//
// /api/chat-callback records every tap in scm.wa_message_log. This module
// decides which of the SO's REQUEST columns that tap also fills, so the
// Delivery Planning board shows it in the columns it already has:
//   amend_date_from_customer    → "Customer Request Date"
//   amend_reason_from_customer  → "Customer Amend Reason"
//   delivery_message_status     → "Delivery Message Status"
// These are the request/evidence fields the HC Delivery sheet used to fill from
// Seampify. They are NOT the schedule: customer_delivery_date and
// amended_delivery_date (the dates trips are planned around) are never in a
// patch from here — a human applies a requested date from the board. Nor is
// amend_reason: that is OUR reason (the board's preset list, printed by the
// Postpone notice after "due to"), chosen by staff; until 2026-10-14 the
// customer's tap overwrote it. The test beside this file pins both lists.
// ---------------------------------------------------------------------------

import { normDate } from "../services/agents/schedule-reconcile";

/** Columns a chat tap may write. Anything else is a bug, not a feature. */
export const CHAT_WRITABLE_SO_COLUMNS = [
  "amend_date_from_customer",
  "amend_reason_from_customer",
  "delivery_message_status",
  // The Property Details form answers land in the board's own house / disposal
  // columns (owner 2026-10-14: "why isn't my New House / Replacement answer on
  // the board"). These are single facts about the customer's home, so unlike
  // amend_reason there is no competing staff value — the answer fills the
  // column staff would otherwise type, and staff can still edit it.
  "house_type",
  "replacement_disposal",
  "disposal_request",
] as const;

/** Columns a chat tap must NEVER write — the schedule, the lifecycle, and the
 *  staff-owned postpone reason. */
export const CHAT_FORBIDDEN_SO_COLUMNS = [
  "customer_delivery_date",
  "amended_delivery_date",
  "delivery_state",
  "status",
  "processing_date",
  "amend_reason",
] as const;

/** Values of the board's Delivery Message Status vocabulary this writes
 *  (frontend MESSAGE_STATUSES, delivery-planning-queries.ts). "(D)" = the
 *  delivery-date conversation, the one the board's Send Now opens. */
export const CHAT_MESSAGE_STATUS = {
  confirm: "Done Scheduling",
  amend: "Pending Reschedule (D)",
  // The postage conversation (Postage Confirm flow) is recorded in the log;
  // the board has no column for it, so no status moves.
  postage_confirm: null,
  postage_amend: null,
  // The Property Details form answers — written to the house / disposal
  // columns, no board status moves (the order was "Done Scheduling" already).
  property: null,
} as const;

export type ChatEvent = keyof typeof CHAT_MESSAGE_STATUS;
export const CHAT_EVENTS = Object.keys(CHAT_MESSAGE_STATUS) as ChatEvent[];

export type ChatRequestPatch = Partial<
  Record<(typeof CHAT_WRITABLE_SO_COLUMNS)[number], string | null>
>;

/**
 * The SO patch for one tap. `requestedDate` is the raw string the flow sent
 * (DD/MM/YYYY from the typed fallback, YYYY-MM-DD from the Flow DatePicker);
 * an unparseable date is simply not written — the log row keeps the raw text,
 * so nothing is lost and nothing wrong lands in a date column.
 */
export interface PropertyAnswers {
  /** Landed / Condo / Apartment -> the board's "Building Type". */
  houseType?: string | null;
  /** Move-in New House / Replace Furniture -> "New House / Replacement". */
  deliveryPurpose?: string | null;
  /** "Dispose of old items?" Yes / No. */
  needDisposal?: string | null;
  /** The items to dispose, free text (only when needDisposal is Yes). */
  disposalItem?: string | null;
}

export function chatRequestPatch(
  event: ChatEvent,
  requestedDate: string | null,
  reason: string | null,
  property?: PropertyAnswers | null,
): ChatRequestPatch {
  const status = CHAT_MESSAGE_STATUS[event];
  const patch: ChatRequestPatch = status ? { delivery_message_status: status } : {};
  if (event === "amend") {
    const iso = normDate(requestedDate);
    if (iso) patch.amend_date_from_customer = iso;
    if (reason) patch.amend_reason_from_customer = reason;
  }
  // Property Details form: each answer fills its board column. A blank answer
  // is not written, so a re-send never erases one the customer already gave.
  // "Disposal Request" is what to do with the old item: the items when they
  // said Yes, else their Yes/No answer verbatim.
  if (event === "property" && property) {
    const houseType = String(property.houseType ?? "").trim();
    const purpose = String(property.deliveryPurpose ?? "").trim();
    const need = String(property.needDisposal ?? "").trim();
    const item = String(property.disposalItem ?? "").trim();
    if (houseType) patch.house_type = houseType;
    if (purpose) patch.replacement_disposal = purpose;
    const disposal = /^yes$/i.test(need) ? item || need : need;
    if (disposal) patch.disposal_request = disposal;
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
    amend_reason_from_customer: "amendReasonFromCustomer",
    delivery_message_status: "deliveryMessageStatus",
    house_type: "houseType",
    replacement_disposal: "replacementDisposal",
    disposal_request: "disposalRequest",
  };
  const out: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const [col, to] of Object.entries(patch)) {
    const from = before[col] ?? null;
    if (String(from ?? "") !== String(to ?? "")) out.push({ field: names[col] ?? col, from, to });
  }
  return out;
}
