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
//
// WHAT THIS FILE DOES DO IS TRANSLATE. Every string below is keyed by a value
// the SERVER decided — a `state`, an `op`, a `doc_type`, a `reason_kind` — and
// turns it into words an owner reads. That is the same job AC_STATE_LABEL has
// always done; it is not a second opinion about which key a row has.
//
// NO CODING WORDS ON THIS SCREEN (owner, 2026-08-16). The page used to print
// `scm.autocount_writeback = "1"`, the raw operation names, the raw state names
// and the ERP's own refusal text, which carries class names and SDK method
// names. Everything a reader sees now comes from a map in this file. Where the
// exact technical note still matters — an unrecognised refusal — it is shown as
// a QUOTE of what a machine wrote, never as the page's own voice.
// ----------------------------------------------------------------------------
import { useCallback, useState } from "react";

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

/**
 * The six document types, in the order the owner asked for them on the strip.
 *
 * The order IS the display order — one list, not a list plus a separate
 * ordering. The server validates membership and does not care about order.
 */
export const AC_DOC_TYPES = ["SO", "DO", "IV", "PO", "GR", "PI"] as const;
export type AcDocType = (typeof AC_DOC_TYPES)[number];

/**
 * The type in words, singular and plural, both SPELLED OUT.
 *
 * The plural is a second map rather than `label + "s"`, because "Goods received"
 * has no plural and an appended "s" produced "GOODS RECEIVEDS" on the first
 * mockup. A rule that is right five times out of six is a bug with good odds.
 */
export const AC_DOC_TYPE_LABEL: Record<AcDocType, string> = {
  SO: "Sales order",
  DO: "Delivery order",
  IV: "Invoice",
  PO: "Purchase order",
  GR: "Goods received",
  PI: "Supplier invoice",
};

export const AC_DOC_TYPE_PLURAL: Record<AcDocType, string> = {
  SO: "Sales orders",
  DO: "Delivery orders",
  IV: "Invoices",
  PO: "Purchase orders",
  GR: "Goods received",
  PI: "Supplier invoices",
};

/* `in` rather than `?? t`: both maps are keyed by the six literal types, so the
   compiler knows the lookup cannot be undefined and a `??` there is dead code
   the linter is right to refuse. An unknown code still falls through to itself
   — a doc_type this build has never heard of should read as itself, not as a
   blank. */
export const acDocTypeLabel = (t: string): string =>
  t in AC_DOC_TYPE_LABEL ? AC_DOC_TYPE_LABEL[t as AcDocType] : t;
export const acDocTypePlural = (t: string): string =>
  t in AC_DOC_TYPE_PLURAL ? AC_DOC_TYPE_PLURAL[t as AcDocType] : t;

/**
 * What the SERVER is asked for.
 *
 * The document type is deliberately NOT in here. The type strip carries a count
 * per type, and a count per type cannot be computed from a list the server has
 * already narrowed to one type — every other chip would read zero. So the type
 * is a lens applied to the rows on this side (acDocTypeCounts / acRowsOfType)
 * while the state and the document number stay server-side, where they belong:
 * the state counts are exact and whole-company, and a document-number search
 * has to reach rows the 200-row page never loaded.
 */
export interface AcOutboxFilters {
  state: AcFilterState;
  docNo: string;
}

export const AC_DEFAULT_FILTERS: AcOutboxFilters = { state: "all", docNo: "" };

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
  /**
   * Whether to OFFER this row a "Send again" button. Decided by the SERVER
   * (backend scm/lib/autocount-outbox-status.ts) for the same reason nothing
   * else here is decided locally, and it is a HINT: the POST re-reads the row
   * and can still refuse, with a code and a sentence.
   */
  can_requeue: boolean;
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

/**
 * What POST /autocount-outbox/:id/requeue answers.
 *
 * `code` is the stable key to branch on; `message` is the sentence to show. The
 * sentence comes from the SERVER (AC_REQUEUE_MEANING in
 * backend/src/scm/lib/autocount-requeue.ts) and is never rewritten here — a
 * dictionary on this side would be a second set of words for the same event,
 * and the first outcome added would render on the owner's page as a bare
 * hyphenated key. The catalogue of codes is docs/autocount-sync-reasons.md.
 */
export interface AcRequeueResult {
  /** True only when the document is now queued and will be sent. */
  accepted: boolean;
  code: string;
  message: string;
  row_id: string;
  doc_type: string;
  doc_no: string;
  op: string;
  /** The live attempt this created, when it created one. */
  new_row_id: string | null;
  /** The ERP's own words, present only when the composer refused it again. */
  reason: string | null;
}

/**
 * Send one refused document again.
 *
 * THROWS on 403 / 409 / 500 like every other api.post, and RESOLVES with
 * `accepted: false` on a refusal — those are two different things and the
 * caller must show both. A refusal is the server answering the question ("that
 * one is already in AutoCount"); a throw is the call never being answered. A
 * component that renders only the resolved branch is the silent-mutation shape
 * frontend/scripts/check-silent-mutations.mjs exists to catch.
 */
export async function requeueAcOutboxRow(rowId: string): Promise<AcRequeueResult> {
  return api.post<AcRequeueResult>(
    `/api/scm/autocount-outbox/${encodeURIComponent(rowId)}/requeue`,
  );
}

/** The word on the button, in both places, so the two cannot drift apart. */
export const AC_SEND_AGAIN_LABEL = "Send again";
export const AC_SEND_AGAIN_BUSY_LABEL = "Sending";

/** What is shown on the row after Send again has been pressed. */
export interface AcRequeueNote {
  tone: AcTone;
  /** The SERVER's sentence, verbatim, or — on a throw — what went wrong. */
  text: string;
  /** The ERP's own words, when it refused the document a second time. */
  quote: string | null;
}

/**
 * Send again, for one row at a time, with the answer kept ON that row.
 *
 * A HOOK rather than two handlers, because the desktop page and the mobile
 * screen must not have separate opinions about what pressing this does — and
 * because the thing most easily got wrong here is the branch nobody sees:
 *
 * - a REFUSAL resolves. `accepted: false` with a code and a sentence is the
 *   server answering the question, and the sentence is the whole point of
 *   pressing the button when the answer is "AutoCount already has it".
 * - a THROW is the call never being answered at all.
 *
 * Both are shown. Rendering only the resolved branch is the silent-mutation
 * shape (`frontend/scripts/check-silent-mutations.mjs`), and rendering only the
 * accepted half of the resolved branch is the same bug one level in: the owner
 * would press a button, see nothing change, and be right to call it broken.
 *
 * The answer lands on the ROW, not in a toast: a toast about HC-SO-2608-004 is
 * gone by the time the reader has found HC-SO-2608-004.
 */
export function useAcRequeue(onAccepted: () => void) {
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, AcRequeueNote>>({});

  const sendAgain = useCallback(
    async (rowId: string) => {
      setSendingId(rowId);
      try {
        const r = await requeueAcOutboxRow(rowId);
        setNotes((prev) => ({
          ...prev,
          [rowId]: {
            /* `wait`, not `bad`: most refusals are the system protecting the
               account book ("AutoCount already accepted this one"), which is
               news, not a fault. A thrown call IS a fault. */
            tone: r.accepted ? "good" : "wait",
            text: r.message,
            quote: r.reason,
          },
        }));
        if (r.accepted) onAccepted();
      } catch (e) {
        setNotes((prev) => ({
          ...prev,
          [rowId]: {
            tone: "bad",
            text: `Nothing was sent — the request did not get through: ${e instanceof Error ? e.message : String(e)}`,
            quote: null,
          },
        }));
      } finally {
        setSendingId(null);
      }
    },
    [onAccepted],
  );

  return { sendingId, notes, sendAgain };
}

/**
 * The word on the badge — and, spread into the chip map below, the word on the
 * filter chip. ONE set of five, not two: the desktop page and the mobile screen
 * each carried their own copy of these labels until now, which is the
 * hand-copied-list class this repo records about thirty times.
 */
const STATE_WORDS = {
  pending: "Waiting",
  sent: "In AutoCount",
  failed: "Not accepted",
  skipped: "Held back",
  requeued: "Sent again",
} as const;

export const AC_STATE_LABEL: Record<string, string> = STATE_WORDS;

/** The word on a filter chip, including the two that are not row states. */
export const AC_FILTER_STATE_LABEL: Record<AcFilterState, string> = {
  all: "Everything",
  attention: "Needs attention",
  ...STATE_WORDS,
};

/**
 * What each state means, said to somebody who has never seen the queue.
 *
 * The server ships its own `meta.state_meaning` and this page no longer prints
 * it: those sentences were written for an engineer reading a workflow log and
 * say "the 5-minute cron will send it". Same facts, no machinery.
 */
export const AC_STATE_PLAIN_MEANING: Record<string, string> = {
  pending:
    "On its way. It is sent every five minutes, and it is only a problem if it stays here.",
  sent: "In the AutoCount account book, under the number shown on the row.",
  failed:
    "AutoCount would not take it, or it ran out of tries. The document is in the ERP and not in the account book.",
  skipped:
    "The ERP stopped it on purpose and never offered it to AutoCount. The row says why.",
  requeued:
    "A refusal that has already been sent again. It is queued or in AutoCount under a newer row, so there is nothing to do here.",
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
  create_so: "New sales order",
  create_po: "New purchase order",
  so_to_do: "Delivery order from a sales order",
  po_to_gr: "Goods received from a purchase order",
  do_to_iv: "Invoice from a delivery order",
  gr_to_pi: "Supplier invoice from goods received",
  cancel: "Cancellation",
  edit: "Change to the document",
};

export const acOpLabel = (op: string): string => OP_LABEL[op] ?? op;

/**
 * The one line on a row that says WHAT this is.
 *
 * `edit` and `cancel` happen to every type, so those two take the type into the
 * sentence; the six others already name both documents themselves and would
 * otherwise read "Delivery order · Delivery order from a sales order".
 */
export function acRowKind(docType: string, op: string): string {
  if (op === "edit") return `Change to the ${acDocTypeLabel(docType).toLowerCase()}`;
  if (op === "cancel") return `Cancellation of the ${acDocTypeLabel(docType).toLowerCase()}`;
  return OP_LABEL[op] ?? acDocTypeLabel(docType);
}

// ── the refusal, in three parts ─────────────────────────────────────────────

/**
 * A refusal said three ways, because a reason a reader cannot act on is not a
 * reason. The owner's complaint about the first draft was that the "why" sat
 * behind a click; all three of these are rendered inline on the row.
 */
export interface AcReasonCopy {
  /** What happened, in one plain-language line. */
  headline: string;
  /** One sentence of explanation. */
  explain: string;
  /** What the human should actually go and do. */
  toFix: string;
}

/**
 * What a refusal nobody has words for yet gets told to the reader.
 *
 * Named rather than inlined, because it is also the fallback for a code this
 * map has never seen — a new refusal class on the server reaches the page
 * before anybody writes copy for it, and "we do not have words for this, here
 * is exactly what was written down" is the honest answer.
 */
export const AC_UNRECOGNISED_COPY: AcReasonCopy = {
  headline: "This one was held back for a reason the ERP has no wording for yet",
  explain:
    "The ERP stopped the document on purpose but has no plain explanation on file for this case. What it wrote down is quoted below, word for word.",
  toFix: "Show the quoted note to whoever looks after the AutoCount link.",
};

/**
 * Keyed by the server's own `reason_kind`, which is a STABLE CODE
 * (backend/src/scm/lib/autocount-outbox-status.ts — `kind`, never the needle).
 * The server also ships a `remedy` for each of these and this page does not
 * print it: those strings name columns, tables and SDK primitives
 * ("backfill linked_ac_dtlkey", "AddPartialTransferDetail is the SDK's only
 * primitive"), which is exactly the vocabulary the owner asked to have taken
 * off this screen. The remedy stays where it is useful — the workflow log.
 *
 * A code with no entry falls through to `unrecognised`, which says so rather
 * than guessing at a neighbour. That is the same rule the server's own
 * classifier follows, and for the same reason: a refusal nobody has words for
 * yet is a code path that grew a new refusal, and filing it under a lookalike
 * is how it stays invisible.
 */
export const AC_REASON_COPY: Record<string, AcReasonCopy> = {
  "keyless-line": {
    headline: "The ERP cannot tell which lines AutoCount already has",
    explain:
      "A change only goes across if every line on the document can be matched to the same line in the account book, and at least one line here cannot be.",
    toFix:
      "The lines have to be matched up against AutoCount, and then the document saved again. Send again cannot do it — a change has nothing to re-create.",
  },
  "sofa-collapse": {
    headline: "This sofa build will not fit on one AutoCount line",
    explain:
      "AutoCount holds a sofa as a single line. This build cannot be folded into one without the ERP making up wording nobody chose.",
    toFix:
      "Fix the build in the ERP so it fits one line, save it, then use Send again. Failing that, enter this one in AutoCount by hand.",
  },
  "item-code": {
    headline: "An item on this document is not matched to AutoCount",
    explain:
      "One of the items does not point at exactly one item in AutoCount, and the ERP will not guess which of them was meant.",
    toFix: "Have the item matched to its AutoCount item, then use Send again.",
  },
  "desc2-too-long": {
    headline: "The further description on a line is too long for AutoCount",
    explain:
      "AutoCount keeps only 100 characters of further description on a line, and one line here is over that.",
    toFix:
      "Shorten the special order or the colour wording on that line, save it, then use Send again.",
  },
  "missing-location": {
    headline: "A line does not say which warehouse the stock comes from",
    explain:
      "AutoCount will not take a document whose lines carry no warehouse, so the ERP stopped it before sending.",
    toFix:
      "Set the warehouse on that line, then use Send again.",
  },
  "missing-sales-location": {
    headline: "The order does not say which warehouse it sells from",
    explain:
      "The order carries no stock location of its own and has no live line to take one from, and AutoCount will not accept it without one.",
    toFix:
      "Set the sales location on the order, or add a line that carries a warehouse, then use Send again.",
  },
  "missing-agent": {
    headline: "The order names no salesperson AutoCount knows",
    explain:
      "AutoCount will not take a sales order without a salesperson it has on file, so the ERP stopped it before sending.",
    toFix: "Assign a salesperson on the order, then use Send again.",
  },
  "missing-creditor": {
    headline: "The supplier on this order has no AutoCount code",
    explain:
      "AutoCount identifies a supplier by its own code, and the supplier named here does not have one recorded in the ERP.",
    toFix: "Give the supplier its AutoCount code, then use Send again.",
  },
  "dtlkey-subset": {
    headline: "Only part of the earlier document was taken, and AutoCount cannot be told which part",
    explain:
      "Some line on the document this came from is not matched to AutoCount, so the ERP cannot name the lines to carry across. Sending it anyway would move every outstanding line in the account book, including ones that never moved here.",
    toFix:
      "Have the earlier document's lines matched to AutoCount, then raise this document again.",
  },
  "cancelled-before-send": {
    headline: "It was cancelled before it ever went",
    explain:
      "The document was cancelled in the ERP while it was still queued, so the ERP withdrew it. Neither the document nor its cancellation ever reached the account book.",
    toFix: "Nothing. There is no difference between the two systems to put right.",
  },
  "edit-before-counterpart": {
    headline: "It was changed before AutoCount had it",
    explain:
      "The document that creates this one in AutoCount is still waiting to go, and it will carry the earlier document's lines across, not this change.",
    toFix: "Save this document again once the one before it has gone through.",
  },
  "grn-mislinked": {
    headline: "This goods received is filed under its purchase order's number",
    explain:
      "It carries the AutoCount number of the purchase order rather than its own, which is how the changeover recorded them. Sending anything for it would name the wrong document in the account book.",
    toFix:
      "The real receipt numbers are on the purchase order. Picking the right one is a judgement, so this needs a person who knows the delivery.",
  },
  "compose-failed": {
    headline: "The ERP could not read its own document",
    explain:
      "Something went wrong reading this document before anything was sent. AutoCount never saw it and nothing is wrong in the account book.",
    toFix:
      "Use Send again — this often clears by itself. If the same thing happens twice, it needs somebody to look at it.",
  },
  "masters-not-opened": {
    headline: "A customer, item or salesperson is not set up in AutoCount",
    explain:
      "AutoCount would not open one of the names on this document, so the whole document was left out.",
    toFix:
      "Add the missing customer, item or salesperson in AutoCount, then use Send again.",
  },
  "no-source-document": {
    headline: "There is no earlier document to carry across",
    explain:
      "AutoCount builds a delivery order, a goods received or an invoice only by carrying an earlier document into it, and this one was raised on its own.",
    toFix:
      "Raise it from the document it should follow. This one stays in the ERP only — sending it again will not help.",
  },
  "no-autocount-shape": {
    headline: "Several documents were merged into one, and AutoCount cannot hold that",
    explain:
      "This document was built from more than one earlier document at once, and AutoCount has no way to record that as a single document.",
    toFix: "Enter it in AutoCount by hand. Sending it again will not help.",
  },
  unrecognised: AC_UNRECOGNISED_COPY,
};

/**
 * The copy for a row AutoCount itself refused.
 *
 * There is no per-reason breakdown here and there must not be one invented: the
 * server classifies `skipped` rows and deliberately does not classify `failed`
 * ones, because a failed row's reason is AutoCount's own message and there is
 * no generic remedy for "the account book refused it". Pattern-matching that
 * message on this side would be the third opinion this file exists to avoid.
 */
export const AC_FAILED_COPY: AcReasonCopy = {
  headline: "AutoCount would not take this document",
  explain:
    "It was offered to the account book and came back refused, or it ran out of tries. AutoCount's own words are quoted below.",
  toFix:
    "Put right whatever AutoCount named, in AutoCount, then save the document in the ERP again so it is offered afresh.",
};

/**
 * The three-part reason for a row, or null when there is nothing to explain.
 *
 * `requeued` returns null ON PURPOSE. It carries a reason kind — the original
 * refusal is still behind the marker — but a "To fix" line on a row that has
 * already been sent again would send somebody to fix what is already fixed,
 * which is the whole reason `requeued` is a separate state.
 */
export function acReasonCopy(state: string, reasonKind: string | null): AcReasonCopy | null {
  if (state === "requeued") return null;
  if (reasonKind) return AC_REASON_COPY[reasonKind] ?? AC_UNRECOGNISED_COPY;
  if (state === "failed") return AC_FAILED_COPY;
  return null;
}

/**
 * WHO said the thing quoted on the row. The distinction is real and currently
 * invisible, and it changes what the reader should do.
 *
 * - `erp` — the ERP stopped the document itself and AutoCount was never asked.
 *   PROVEN by tracing every `status: 'skipped'` write in
 *   backend/src/scm/lib/autocount-outbox.ts: all of them are decided at enqueue
 *   time or before `callAcService`, so no skipped row has ever reached the
 *   account book.
 * - `autocount` — the row went through `dispatchOne`, which calls the account
 *   book, and this is what came back.
 * - `attempt` — a row still being retried. Its note may be AutoCount's answer OR
 *   the ERP saying it is still waiting on a parent document, and nothing the
 *   server sends distinguishes the two. Claiming either would be a guess, so
 *   the label claims neither.
 * - `none` — nothing was written down.
 */
export type AcReplySource = "autocount" | "erp" | "attempt" | "none";

export function acReplySource(state: string, reason: string | null): AcReplySource {
  if (!reason) return "none";
  if (state === "skipped" || state === "requeued") return "erp";
  if (state === "pending") return "attempt";
  return "autocount";
}

export const AC_REPLY_LABEL: Record<AcReplySource, string> = {
  autocount: "AutoCount replied",
  erp: "AutoCount was not asked",
  attempt: "The last send attempt reported",
  none: "AutoCount said nothing",
};

/** The sentence that goes where a quote would, when there is no quote. */
export const AC_NOT_ASKED_NOTE = "The ERP stopped this before it was ever sent.";

// ── the type strip ──────────────────────────────────────────────────────────

/**
 * How many of each type are in the rows currently loaded, plus `all`.
 *
 * Counted over the pool the STATE filter already produced, so the numbers move
 * when the state changes — which is the point of putting them on the chips.
 * These are counts of the LOADED page, unlike the state counts, which the
 * server computes exactly over the whole company; the page says so when the
 * list is truncated.
 */
export type AcDocTypeCounts = Record<AcDocType | "all", number>;

export function acDocTypeCounts(rows: AcOutboxRow[]): AcDocTypeCounts {
  /* Written out rather than built in a loop so the COMPILER holds it to
     AcDocType: a seventh type added to AC_DOC_TYPES fails to compile here
     instead of quietly getting a chip that always reads zero. */
  const out: AcDocTypeCounts = { all: rows.length, SO: 0, DO: 0, IV: 0, PO: 0, GR: 0, PI: 0 };
  /* Everything is `rows.length`, so the six chips are allowed to sum to LESS
     than it: a doc_type 0277's CHECK does not admit is counted in `all` and
     nowhere else. That is the honest arithmetic — inventing a seventh chip for
     a value the database cannot hold would be worse. */
  for (const r of rows) {
    if ((AC_DOC_TYPES as readonly string[]).includes(r.doc_type)) out[r.doc_type as AcDocType] += 1;
  }
  return out;
}

/**
 * The number on a STATUS chip. The server's, exact and whole-company, unlike
 * the type counts above — and `all` is the total rather than a seventh count.
 */
export function acStateCount(d: AcOutboxResponse | null, s: AcFilterState): number {
  if (!d) return 0;
  return s === "all" ? d.counts.total : d.counts[s];
}

/** The rows the type lens leaves visible. An empty type means every type. */
export function acRowsOfType(rows: AcOutboxRow[], docType: AcDocType | ""): AcOutboxRow[] {
  return docType ? rows.filter((r) => r.doc_type === docType) : rows;
}

/**
 * The short line under a document number that says where it stands.
 *
 * Here rather than on each surface because it is a SENTENCE, and the desktop
 * page and the mobile screen writing two different sentences about the same row
 * is the split this shared layer exists to prevent.
 */
export function acRowStatusLine(row: AcOutboxRow, maxAttempts: number): string {
  const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;
  switch (row.state) {
    case "sent":
      return row.ac_doc_no
        ? `In the account book as ${row.ac_doc_no}`
        : "In the account book";
    case "pending":
      return row.attempts > 0
        ? `Tried ${times(row.attempts)}, will keep trying up to ${maxAttempts}`
        : "Not tried yet, going out with the next send";
    case "failed":
      return `Tried ${times(row.attempts)}, then stopped`;
    case "skipped":
      return "Held back on purpose";
    case "requeued":
      return "Already sent again under a newer row";
    default:
      return "";
  }
}

/** The heading over the list — which status, and which type, are in force. */
export function acListTitle(state: AcFilterState, docType: AcDocType | ""): string {
  const s = state === "all" ? "All documents" : AC_FILTER_STATE_LABEL[state];
  return docType ? `${s} · ${acDocTypePlural(docType)}` : s;
}

// ── the sentences at the top ────────────────────────────────────────────────

/**
 * "4 minutes" / "2 hours" / "3 days" — how long a row has been waiting.
 *
 * Coarse on purpose. The number that matters is whether a pending row's age is
 * CLIMBING past the roughly 30 minutes MAX_ATTEMPTS on a 5-minute cycle allows,
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
 * Collapsing the first into the second would report a sync that is not running
 * as a sync with nothing wrong — which is the sentence the health check had to
 * be corrected for printing (#2094).
 */
export function acHeadline(d: AcOutboxResponse | null): { tone: AcTone; text: string } {
  if (!d) return { tone: "muted", text: "Reading the list…" };
  if (!d.writeback.on) {
    return {
      tone: "muted",
      text:
        "Sending to AutoCount is switched off. Saving a document queues nothing and sends nothing"
        + (d.counts.total > 0 ? "; everything below already happened." : "."),
    };
  }
  if (d.counts.attention > 0) {
    const bits: string[] = [];
    if (d.counts.failed > 0) {
      bits.push(`${d.counts.failed} ${d.counts.failed === 1 ? "was" : "were"} not accepted`);
    }
    if (d.counts.skipped > 0) bits.push(`${d.counts.skipped} held back`);
    return {
      tone: "bad",
      text: `${d.counts.attention} document${d.counts.attention === 1 ? "" : "s"} need${d.counts.attention === 1 ? "s" : ""} your attention — ${bits.join(", ")}. They are in the ERP and not in the account book.`,
    };
  }
  if (d.counts.total === 0) {
    return {
      tone: "muted",
      text:
        "Sending is switched on and nothing has ever been queued. Save a document and it will appear here.",
    };
  }
  return {
    tone: "good",
    text:
      d.counts.pending > 0
        ? `Everything is in AutoCount. ${d.counts.pending} still on the way, going out with the next five-minute send.`
        : "Everything is in AutoCount. Nothing is waiting and nothing was refused.",
  };
}

/**
 * The switch, said without naming the setting it lives in.
 *
 * The RAW value is still reported when the switch reads as OFF, because that is
 * the case where it matters: a typo like 'On ' is off, and a page that only
 * said "off" would leave somebody looking for a switch that already appears to
 * be on. The table and column name it lives under are gone — they told the
 * reader nothing he could act on.
 */
export function acWritebackLine(d: AcOutboxResponse): string {
  if (d.writeback.on) {
    return d.writeback.scope === "all"
      ? "Sending to AutoCount is switched on for every company."
      : "Sending to AutoCount is switched on for this company.";
  }
  return d.writeback.value === null
    ? "Sending to AutoCount is switched off — the switch has never been set."
    : `Sending to AutoCount is switched off. The switch is set to ${JSON.stringify(d.writeback.value)}, which does not read as on.`;
}
