// ---------------------------------------------------------------------------
// changeLog.ts — the ONE logic + words layer behind the go-live change log.
//
// The owner asked for it on 2026-09-08, when he opened sales orders, delivery
// orders, purchase orders and goods receipts to his staff: 「做可以监督到这期间我们
// 打开系统的数据跟之前谁改了东西 谁改了」. He wants to be able to open a page and read
// who changed which document, and to what.
//
// Desktop is pages/ChangeLog.tsx, phone is mobile/MobileChangeLog.tsx. They
// share this file entirely — the hook, the labels and every decision — and
// differ only in presentation, which is the owner's standing rule for the two
// surfaces (「電話電腦的權限應該一樣的」).
//
// NOTHING HERE DECIDES WHO IS A PERSON. The server does, in
// backend/src/scm/shared/audit-author.ts, which is also what the delta sync and
// the migrated-lock check read. A second opinion on this side is exactly the
// duplicated decision check-duplicated-decisions.mjs exists to fail — and the
// wrong answer is expensive: a check that got it wrong reported "50 staff
// actions on migrated orders" when all fifty were the stock-allocation cron.
// ---------------------------------------------------------------------------

import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
import { fmtDateTime } from "../vendor/shared/format";

export type ChangeLogDocType = "SO" | "PO" | "DO" | "GRN";
export type ChangeLogAuthor = "person" | "machine";
export type ChangeLogAuthorFilter = ChangeLogAuthor | "all";

export interface ChangeLogFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ChangeLogChange {
  id: string;
  at: string;
  author: ChangeLogAuthor;
  who: string | null;
  action: string;
  source: string | null;
  status: string | null;
  fields: ChangeLogFieldChange[];
}

export interface ChangeLogDocument {
  docType: ChangeLogDocType;
  docNo: string;
  entityId: string | null;
  lastChangeAt: string;
  changeCount: number;
  people: string[];
  changes: ChangeLogChange[];
}

export interface ChangeLogResponse {
  window: { since: string; until: string; hours: number };
  filters: { author: ChangeLogAuthorFilter; docTypes: ChangeLogDocType[] };
  totals: {
    changesByPerson: number;
    changesBySystem: number;
    documents: number;
    documentsShown: number;
    people: number;
    truncated: boolean;
  };
  documents: ChangeLogDocument[];
}

export interface ChangeLogFilters {
  hours: number;
  author: ChangeLogAuthorFilter;
  docType: ChangeLogDocType | "all";
}

/** The windows offered, in the owner's terms. He opened the system on a day,
 *  not N hours ago, so the labels say days. */
export const CL_WINDOWS: Array<{ hours: number; label: string }> = [
  { hours: 24, label: "Today" },
  { hours: 24 * 3, label: "3 days" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
];

export const CL_DEFAULT_FILTERS: ChangeLogFilters = {
  hours: 24 * 7,
  author: "person",
  docType: "all",
};

/** The four document kinds the owner opened, in the order the chips show them.
 *  ONE home on this side: both surfaces import it rather than each writing the
 *  list out, which is the shape check-duplicated-decisions.mjs exists to catch.
 *  The server keeps its own list because it is the boundary — a client that
 *  asked for a type the server does not serve gets everything, by design. */
export const CL_DOC_TYPES: ChangeLogDocType[] = ["SO", "PO", "DO", "GRN"];

/** What each document type is called on screen. */
export const CL_DOC_TYPE_LABEL: Record<ChangeLogDocType, string> = {
  SO: "Sales order",
  PO: "Purchase order",
  DO: "Delivery order",
  GRN: "Goods receipt",
};

/**
 * The verbs, in words rather than in the audit table's vocabulary. Both tables
 * are covered: so-audit.ts uses per-module verbs (UPDATE_LINE, ADD_PAYMENT),
 * entity-audit.ts uses one stable set across five document types.
 *
 * An UNKNOWN verb is NOT hidden and NOT rewritten into a guess: it renders as
 * itself. A renderer that silently swallows a verb it has not met is how a new
 * kind of change becomes invisible on the one page that exists to show changes.
 */
const CL_ACTION_LABEL: Record<string, string> = {
  CREATE: "Created",
  UPDATE: "Changed",
  UPDATE_DETAILS: "Changed details",
  UPDATE_STATUS: "Changed status",
  UPDATE_LINE: "Changed a line",
  ADD_LINE: "Added a line",
  DELETE_LINE: "Removed a line",
  ADD_PAYMENT: "Added a payment",
  UPDATE_PAYMENT: "Changed a payment",
  DELETE_PAYMENT: "Removed a payment",
  POST: "Posted",
  CANCEL: "Cancelled",
  REVERSE: "Reversed",
  DELETE: "Deleted",
  SEND: "Sent to the supplier",
  STATUS: "Changed status",
  AMENDMENT_PO_APPROVED: "Approved a purchase-order amendment",
  SUBMIT_FOR_APPROVAL: "Sent for approval",
  WITHDRAW_FROM_APPROVAL: "Withdrew from approval",
  APPROVE: "Approved",
  REJECT: "Rejected",
  CHECK: "Checked",
  RECOUNT_FAILED: "A recount failed",
  BIND_SHADOW: "Shadow allocation note",
};

export function clActionLabel(action: string): string {
  return CL_ACTION_LABEL[action] ?? action;
}

/** Who to credit. `null` on a person row means the audit write lost the name;
 *  it is shown as unknown rather than dropped, because an unattributed change
 *  is the one the owner most wants to see. */
export function clWhoLabel(change: ChangeLogChange): string {
  if (change.author === "machine") return change.who ?? "System";
  return change.who ?? "Unknown user";
}

/** A field value for display. Money is stored as integer sen and dates as ISO
 *  text; neither is reformatted here — inventing a currency or a locale on this
 *  side would be a second opinion about a value the server already holds. An
 *  empty value reads as a word, never as a blank cell that looks like a bug. */
export function clValueLabel(v: unknown): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "string") return v.trim() === "" ? "(empty)" : v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Field keys as they land in field_changes, in the owner's words where we know
 *  them. Anything unmapped renders as its own key — see clActionLabel. */
const CL_FIELD_LABEL: Record<string, string> = {
  status: "Status",
  qty: "Quantity",
  unitPrice: "Unit price",
  unit_price_sen: "Unit price",
  totalSen: "Total",
  total_sen: "Total",
  paidSen: "Paid",
  balanceSen: "Balance",
  depositSen: "Deposit",
  itemCode: "Item code",
  item_code: "Item code",
  description: "Description",
  description2: "Build text",
  deliveryAddress: "Delivery address",
  delivery_address: "Delivery address",
  customerDeliveryDate: "Delivery date",
  processingDate: "Processing date",
  salesperson_id: "Salesperson",
  remark2: "Remark 2",
  remark3: "Remark 3",
  remark4: "Remark 4",
  note: "Note",
  stockStatus: "Stock status",
  variants: "Variants",
};

export function clFieldLabel(field: string): string {
  return CL_FIELD_LABEL[field] ?? field;
}

/**
 * When a change happened, in THE repo's one date format — `fmtDateTime`,
 * "08/09/2026 14:00".
 *
 * IT IS ALREADY MALAYSIA LOCAL. `dateParts` in vendor/shared/format.ts converts
 * a zoned instant through `mytParts`, which is the whole reason that module
 * exists. A second formatter here would be a second date format, and this repo
 * gates against exactly that (`check-date-formatting.mjs`) after paying for it
 * more than once — the first draft of this file hand-rolled an
 * `Intl.DateTimeFormat` and the gate caught it. The surfaces say MYT once, in
 * the column heading, rather than on every row.
 */
export function clWhen(iso: string): string {
  return fmtDateTime(iso);
}

/** One line saying what is on screen and what is NOT, in the owner's terms.
 *  Every number carries its denominator, because a bare count on a filtered
 *  page is how a filtered view gets read as the whole truth. */
export function clVerdict(r: ChangeLogResponse | null): string {
  if (!r) return "";
  const t = r.totals;
  const days = Math.round(r.window.hours / 24);
  const span = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${r.window.hours} hours`;
  if (t.changesByPerson === 0) {
    return `Nobody changed anything in the last ${span}. The system itself made ${t.changesBySystem} automatic change(s) — those are not staff edits.`;
  }
  return `${t.changesByPerson} change(s) by ${t.people} person/people across ${t.documents} document(s) in the last ${span}.`
    + ` The system itself made another ${t.changesBySystem}, counted separately.`;
}

/** The warning that must never be silent: the read hit its ceiling, so the
 *  numbers above are floors, not totals. */
export function clTruncationNote(r: ChangeLogResponse | null): string | null {
  if (!r?.totals.truncated) return null;
  return "This window holds more changes than one read returns, so every count above is a floor, not a total. Narrow the window or the document type to see all of it.";
}

export function buildChangeLogQs(f: ChangeLogFilters): string {
  const p = new URLSearchParams();
  p.set("hours", String(f.hours));
  p.set("author", f.author);
  if (f.docType !== "all") p.set("docType", f.docType);
  return `?${p.toString()}`;
}

/**
 * The change log for the ACTIVE COMPANY. The company is never a parameter — the
 * client stamps X-Company-Id and the route's own predicate is the boundary,
 * exactly as on the AutoCount Sync page.
 */
export function useChangeLog(filters: ChangeLogFilters, enabled = true) {
  const qs = buildChangeLogQs(filters);
  return useQuery<ChangeLogResponse>(
    "/api/scm/change-log",
    () => api.get<ChangeLogResponse>(`/api/scm/change-log${qs}`),
    [qs],
    { staleTime: 30_000, keepPreviousData: true, enabled },
  );
}
