// ----------------------------------------------------------------------------
// autocountOutbox — the ONE logic layer behind the AutoCount Sync page, shared
// by the desktop route and the mobile screen.
//
// CLAUDE.md's standing rule is one shared logic layer with the two surfaces
// differing only in presentation, and this file is that layer: the response
// shape, the filter shape, the query hook, and the words. What is deliberately
// NOT here is layout — the desktop keeps its filters in the URL
// (useSearchParams) and the mobile shell has no router, so each surface owns
// how a filter is CHOSEN while both agree on what a filter IS.
//
// NO POLICY, NO CLASSIFICATION. The server has already decided each row's state,
// its reason and its remedy (backend/src/scm/lib/autocount-outbox-status.ts,
// which the health-check workflow reads through its own mirror). Re-deriving any
// of that here would be a third opinion about the same row — the exact drift
// that made the health check tell an operator to backfill DtlKeys for an
// item-map problem (#2094).
// ----------------------------------------------------------------------------
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";

/** The states the page can filter to. `attention` is the owner's question. */
export const AC_FILTER_STATES = [
  "all",
  "attention",
  "pending",
  "sent",
  "failed",
  "skipped",
  "requeued",
] as const;
export type AcFilterState = (typeof AC_FILTER_STATES)[number];

export const AC_DOC_TYPES = ["SO", "PO", "DO", "IV", "GR", "PI"] as const;
export type AcDocType = (typeof AC_DOC_TYPES)[number];

export interface AcOutboxFilters {
  state: AcFilterState;
  docType: AcDocType | "";
  docNo: string;
}

export const AC_DEFAULT_FILTERS: AcOutboxFilters = { state: "all", docType: "", docNo: "" };

/** One row, exactly as the route presents it. */
export interface AcOutboxRow {
  id: string;
  op: string;
  doc_type: string;
  doc_no: string;
  doc_id: string | null;
  status: string;
  state: string;
  attempts: number;
  /** AutoCount's own words, or the ERP's refusal. Never truncated by the API. */
  reason: string | null;
  reason_kind: string | null;
  remedy: string | null;
  needs_attention: boolean;
  ac_doc_no: string | null;
  created_at: string | null;
  updated_at: string | null;
  sent_at: string | null;
}

export interface AcOutboxResponse {
  writeback: { value: string | null; on: boolean; scope: string };
  counts: {
    pending: number;
    sent: number;
    failed: number;
    skipped: number;
    requeued: number;
    attention: number;
    total: number;
  };
  oldest_pending: {
    doc_type: string;
    doc_no: string;
    op: string;
    attempts: number;
    reason: string | null;
    created_at: string | null;
  } | null;
  rows: AcOutboxRow[];
  truncated: boolean;
  meta: {
    max_attempts: number;
    state_meaning: Record<string, string>;
    skip_kinds: Array<{ kind: string; remedy: string }>;
  };
}

/** Only non-default values travel, so the cache key of an unfiltered page is
 *  stable no matter which surface asked. */
export function buildAcOutboxQs(f: AcOutboxFilters): string {
  const p = new URLSearchParams();
  if (f.state !== "all") p.set("state", f.state);
  if (f.docType) p.set("docType", f.docType);
  if (f.docNo.trim()) p.set("docNo", f.docNo.trim());
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * The queue for the ACTIVE COMPANY. The company is never a parameter here — the
 * client stamps X-Company-Id and the route's own predicate is the boundary
 * (backend scm/lib/companyScope.ts), so a page that passed one would be
 * inventing a second, weaker mechanism.
 *
 * Polled, because this is a status board and the drain runs every 5 minutes.
 * 30s is well inside that and matches the app's default staleTime.
 */
export function useAutoCountOutbox(filters: AcOutboxFilters, enabled = true) {
  const qs = buildAcOutboxQs(filters);
  return useQuery<AcOutboxResponse>(
    "/api/scm/autocount-outbox",
    () => api.get<AcOutboxResponse>(`/api/scm/autocount-outbox${qs}`),
    [qs],
    { staleTime: 30_000, keepPreviousData: true, enabled },
  );
}

/** The word on the badge. */
export const AC_STATE_LABEL: Record<string, string> = {
  pending: "Queued",
  sent: "In AutoCount",
  failed: "Failed",
  skipped: "Skipped",
  requeued: "Re-queued",
};

/**
 * How loud a state is.
 *
 * `bad` is only for the two that mean a document is in the ERP and not in the
 * book. `skipped` is one of them and reads like a shrug, which is why it is not
 * `warn`: a parentless delivery order will never exist in AutoCount, and that
 * is not a milder fact than a failure.
 */
export type AcTone = "good" | "bad" | "wait" | "muted";

export const AC_STATE_TONE: Record<string, AcTone> = {
  pending: "wait",
  sent: "good",
  failed: "bad",
  skipped: "bad",
  requeued: "muted",
};

export const acStateLabel = (state: string): string => AC_STATE_LABEL[state] ?? state;
export const acStateTone = (state: string): AcTone => AC_STATE_TONE[state] ?? "muted";

/** The eight operations, in the operator's words rather than the column's. */
const OP_LABEL: Record<string, string> = {
  create_so: "Create sales order",
  create_po: "Create purchase order",
  so_to_do: "SO to delivery order",
  po_to_gr: "PO to goods receipt",
  do_to_iv: "DO to invoice",
  gr_to_pi: "GRN to purchase invoice",
  cancel: "Cancel",
  edit: "Edit",
};

export const acOpLabel = (op: string): string => OP_LABEL[op] ?? op;

/**
 * "4 minutes" / "2 hours" / "3 days" — how long a row has been waiting.
 *
 * Coarse on purpose. The number that matters is whether a pending row's age is
 * CLIMBING past the roughly 30 minutes MAX_ATTEMPTS on a 5-minute cron allows,
 * and a seconds-accurate figure invites arithmetic the reader should not be
 * doing.
 */
export function acAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const mins = Math.max(0, Math.floor((now - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The one-line answer to "is anything stuck".
 *
 * Three distinct situations and they are NOT interchangeable: the switch is off
 * (nothing is even being queued), nothing needs attention, or something does.
 * Collapsing the first into the second would report a write-back that is not
 * running as a write-back with nothing wrong — which is the sentence the health
 * check had to be corrected for printing (#2094).
 */
export function acHeadline(d: AcOutboxResponse | null): { tone: AcTone; text: string } {
  if (!d) return { tone: "muted", text: "Loading the queue…" };
  if (!d.writeback.on) {
    return {
      tone: "muted",
      text:
        "Write-back is OFF. Saving a document queues nothing and sends nothing"
        + (d.counts.total > 0 ? "; the rows below are history." : "."),
    };
  }
  if (d.counts.attention > 0) {
    const bits: string[] = [];
    if (d.counts.failed > 0) bits.push(`${d.counts.failed} failed`);
    if (d.counts.skipped > 0) bits.push(`${d.counts.skipped} skipped`);
    return {
      tone: "bad",
      text: `${d.counts.attention} document${d.counts.attention === 1 ? "" : "s"} need attention (${bits.join(", ")}) — in the ERP and not in AutoCount.`,
    };
  }
  if (d.counts.total === 0) {
    return {
      tone: "muted",
      text: "Write-back is on and nothing has ever been queued. Save a document and it will appear here.",
    };
  }
  return {
    tone: "good",
    text:
      d.counts.pending > 0
        ? `Nothing is stuck. ${d.counts.pending} queued and waiting for the next 5-minute send.`
        : "Nothing is stuck. Everything the ERP has sent is in AutoCount.",
  };
}
