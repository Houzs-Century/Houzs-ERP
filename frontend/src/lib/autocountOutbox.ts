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
// ONE LINE PER ROW (owner, 2026-08-16, after reading the rebuilt page): *"这一个
// 东西下面的地方太复杂了，你尽量简单化一点。一个 sales order 那么宽，那如果我有一
// 千个 sales order 的时候，我不是完蛋？"* `acRowDetail` is where that lands — the
// headline stays on the row, everything else goes behind opening it, and a
// document already in the account book has nothing to open. `AC_DEFAULT_STATE`
// is the other half: the page opens on what is stuck, not on everything.
//
// NO CODING WORDS ON THIS SCREEN (owner, 2026-08-16). The page used to print
// `scm.autocount_writeback = "1"`, the raw operation names, the raw state names
// and the ERP's own refusal text, which carries class names and SDK method
// names. Everything a reader sees now comes from a map in this file. Where the
// exact technical note still matters — an unrecognised refusal — it is shown as
// a QUOTE of what a machine wrote, never as the page's own voice.
//
// AND THAT WAS NOT ENOUGH, 2026-08-16, read off the LIVE page. Quoting a machine
// is not the same as making it readable, and two of the strings the queue
// actually carries proved it:
//
//   • the ERP's own skip note for a parentless invoice was an English sentence
//     ending "(AddPartialTransferDetail is the SDK's only primitive)" — the very
//     identifier that had been taken out of this file's copy hours earlier,
//     arriving through the SERVER instead;
//   • a not-accepted delivery order's note was AutoCount's eleven-word refusal
//     followed by a per-line dump of the account book — `Qty=1.00000000
//     TransferedQty=0.00000000 Transferable=T docCancelled=F`, four lines of it.
//     Genuinely valuable, to an engineer. Not to a warehouse clerk.
//
// THE UNIT OF THIS SCREEN IS THE DOCUMENT, not the send (owner, 2026-08-16):
// *"为什么在 AutoCount 里面一张 Sales Order 会出现两次呢?"* `HC-SO-2608-002` took
// four of six rows under In AutoCount while the account book holds exactly one of
// it. `scm.autocount_outbox` is append-only and writes one row per intended
// operation, so a document that is created and then edited twice is three rows
// for good. `acGroupByDocument` is where that lands: one row per document, its
// newest send on the line, every earlier send kept and folded behind it. The
// counts follow — `acDocTypeCounts` counts documents here and the status chips
// count documents at the server, because two strips that count different things
// cannot be read side by side.
//
// So the rule is now structural rather than a promise about wording, and it is
// `acWhatWasSaid` below: NOTHING THE SERVER WROTE IS EVER THE PAGE'S OWN VOICE.
// It appears only under the label saying who wrote it, and the part a reader
// cannot act on — everything after the AutoCount service's own `||`, or the
// whole note where this file already has plain words for the row — goes behind a
// collapsed technical disclosure. The plain-language HEADLINE is untouched by
// all of this: it is on the row, always, unclicked. That was the owner's earlier
// complaint and moving machinery must never quietly re-take it.
// ----------------------------------------------------------------------------
import { useCallback, useState } from "react";

import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
import { fmtDateTime } from "../vendor/shared/format";

/**
 * The states the page can filter to. FOUR tabs (owner, 2026-08-21: *"4个"*, after
 * *"分成三个种类就可以了，不需要那么多"* about the earlier seven):
 *
 *   all        -> All            everything
 *   pending    -> Waiting        on its way, sent every five minutes
 *   attention  -> Not accepted   STUCK — in the ERP, not in the account book
 *   sent       -> In AutoCount   done, in the account book
 *
 * `attention` already merges the two "in ERP not in book" states (failed +
 * skipped) at the server, so the confusing "Needs attention / Held back /
 * Replaced" tabs collapse into one "Not accepted" the owner acts on. The row
 * STATES themselves are unchanged (a row still knows failed vs skipped vs
 * replaced — see STATE_WORDS); only the FILTER TABS are fewer. A stale
 * `?state=failed` link degrades to the default tab (AutoCountSync.tsx:435).
 */
export const AC_FILTER_STATES = [
  "all",
  "pending",
  "attention",
  "sent",
] as const;
export type AcFilterState = (typeof AC_FILTER_STATES)[number];

/**
 * WHERE THE PAGE LANDS when nobody has chosen a filter.
 *
 * `attention`, not `all` — owner, 2026-08-16: *"一个 sales order 那么宽，那如果我
 * 有一千个 sales order 的时候，我不是完蛋？"* Somebody opening this screen is
 * asking what is STUCK. Answering that with every document the company has ever
 * pushed buries the answer under thousands of rows that are already fine, and
 * the sales order list alone is 2,726 documents. Everything is one chip away.
 */
export const AC_DEFAULT_STATE: AcFilterState = "attention";

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
 * is a lens applied on this side (acDocTypeCounts / acGroupsOfType) while the
 * state and the document number stay server-side, where they belong: the state
 * counts are exact and whole-company, and a document-number search has to reach
 * rows the 200-row page never loaded.
 */
export interface AcOutboxFilters {
  state: AcFilterState;
  docNo: string;
}

export const AC_DEFAULT_FILTERS: AcOutboxFilters = { state: AC_DEFAULT_STATE, docNo: "" };

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
  /**
   * Whether to OFFER this row a "Send now" button — the WAITING row's control,
   * where `can_requeue` is the STOPPED row's. Decided by the server for the same
   * reason nothing else here is decided locally, and disjoint from `can_requeue`
   * by construction, so a row never shows two buttons that both mean "send it".
   */
  can_send_now: boolean;
  ac_doc_no: string | null;
  created_at: string | null;
  updated_at: string | null;
  sent_at: string | null;
}

export interface AcOutboxResponse {
  /**
   * `on` answers "is sending switched on FOR THE COMPANY I AM LOOKING AT", not
   * "for anybody" — the switch is a company allow-list ('off' / 'all' / a list
   * of ids) and until 2026-08-18 the server published the second question's
   * answer under the first question's name. `null` is its own state: the server
   * could not resolve which company this reader is in, so it declines to answer
   * rather than guessing "off". `scope` still carries what the switch SAYS, so
   * an admin can see the whole allow-list.
   */
  writeback: { value: string | null; on: boolean | null; scope: string };
  /**
   * DOCUMENTS, not sends, on every one of these — see the route's own comment.
   *
   * They do NOT sum to `total` and must not be made to: a document that arrived
   * and was later edited into a refusal is counted by `sent` and by `failed`,
   * because both are true of it and both chips would list it.
   */
  counts: {
    pending: number;
    sent: number;
    failed: number;
    skipped: number;
    requeued: number;
    attention: number;
    total: number;
  };
  /**
   * False when the server's count scan stopped before the end of the queue, so
   * every number above is a floor rather than a fact. Required in the type
   * rather than optional: a response that forgot it would render as "complete"
   * and the whole point of the flag is that an undercount must never read as a
   * count.
   */
  counts_complete: boolean;
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
  /**
   * The ancestors this press caused, in the order they were sent.
   *
   * The server has returned this since the cascade was written and NOTHING HERE
   * READ IT (#0552): pressing Send on an invoice could put a sales order and a
   * delivery order into the account book and the operator saw one line about the
   * invoice. `reason` says which of the two things happened to each — `missing`
   * (AutoCount did not have it) or `stale` (AutoCount had an older version) —
   * and those are different enough that a document number alone cannot carry it.
   */
  ancestors_sent?: AcAncestorSent[] | null;
}

/** One ancestor the press sent, as the server names it. */
export interface AcAncestorSent {
  doc_type: string;
  doc_no: string;
  /** The outcome code, from the same catalogue as the pressed row's. */
  code: string;
  /** Why it had to go first: `missing` or `stale`. */
  reason?: string;
}

/**
 * What the page SAYS about each ancestor, in the operator's words.
 *
 * The reason and the outcome are two facts and they are combined here rather
 * than in the component, so the mobile and desktop pages cannot come to word
 * this differently — the same argument `AC_SEND_NOW_LABEL` and `useAcRequeue`
 * already make for the button and the note.
 */
export function acAncestorLine(a: AcAncestorSent): string {
  const what = a.reason === 'stale'
    ? 'AutoCount had an older version'
    : 'AutoCount did not have it yet';
  const ok = a.code === 'sent' || a.code === 'accepted';
  const how = ok ? 'sent' : `not sent — ${a.code}`;
  return `${a.doc_no} — ${what}, ${how}.`;
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

/**
 * Send one WAITING document to AutoCount now, instead of waiting for the sweep.
 *
 * SAME CONTRACT AS `requeueAcOutboxRow` in every respect that matters to a
 * caller — it THROWS on 403 / 409 / 500 and RESOLVES with `accepted: false` on a
 * refusal, and both have to be rendered. A different endpoint because the two
 * acts have different concurrency contracts on the server (this one takes an
 * exclusive claim on the row; a re-queue must not), never because the page
 * wanted a second way to say the same thing.
 */
export async function sendNowAcOutboxRow(rowId: string): Promise<AcRequeueResult> {
  return api.post<AcRequeueResult>(
    `/api/scm/autocount-outbox/${encodeURIComponent(rowId)}/send-now`,
  );
}

/** The word on the button, in both places, so the two cannot drift apart. */
export const AC_SEND_AGAIN_LABEL = "Send again";
export const AC_SEND_AGAIN_BUSY_LABEL = "Sending";

/* "SEND NOW", NOT "SEND AGAIN", and the difference is the whole point of the
   button. The row it sits on has not been refused — it is queued and on its way
   — so "again" would be false about it. What the operator is buying is TIME:
   the five-minute sweep, now. */
export const AC_SEND_NOW_LABEL = "Send now";
export const AC_SEND_NOW_BUSY_LABEL = "Sending";

/**
 * What to DO about each answer, keyed by the outcome code verbatim.
 *
 * TWO INSTRUCTIONS MET, NOT ONE OVERRIDDEN — worth spelling out, because they
 * read like they conflict. `requeueAcOutboxRow`'s own header (#2321) says the
 * server's `message` is "never rewritten here", and it is not: the sentence
 * above this line on the row is `AC_REQUEUE_MEANING`'s, verbatim. What is here
 * is the OTHER column of docs/autocount-sync-reasons.md §1 — "what the person
 * should do" — which the API does not carry at all. `message` says what
 * happened; this says what to do next, and the codes are the join between them.
 *
 * A code with no entry shows NOTHING rather than a bare hyphenated key. That is
 * the failure the same header warns about, and it is why this map is additive:
 * a new outcome still renders its server sentence in full, it simply has no
 * follow-up line until somebody writes one.
 */
export const AC_REQUEUE_TODO: Record<string, string> = {
  requeued: "Nothing more to do. It goes out with the next five-minute send.",
  "requeued-as-recorded":
    "Nothing more to do. One thing to know: this kind is sent exactly as it was first written down, so if you changed the document after it was refused, that change is not in what goes out.",
  "already-sent":
    "Nothing, and do not look for a way round it. A second copy in the account book is worse than this row.",
  "already-in-autocount":
    "Nothing. The account book already has this document under its own number.",
  "row-pending":
    "Wait. If it is still here in half an hour, the AutoCount computer is not answering.",
  "already-queued":
    "Nothing here. There is a live attempt for this document already — work that one.",
  "already-requeued":
    "Find the newer send for this document. This one is only the record of what happened.",
  "still-refused":
    "Read the reason below. It is what is blocking the document NOW, which may not be what you just put right.",
  "not-recoverable":
    "Send again cannot help this one. The reason on the row says what to do instead.",
  "switch-off":
    "Sending to AutoCount has to be switched back on first, which is not something this screen can do.",
  "document-gone":
    "Nothing to send. If this document ought to still exist, that is the thing worth looking into.",
  declined:
    "Press it once more. If the same thing happens again, it needs somebody to look at the code.",
  "row-not-found": "Refresh the page — this row is not in this company's list.",
  "read-failed": "Nothing was tried. Give it a moment and press again.",
  /* The batch workflow's DRY-RUN success. The button never returns it, and if
     it ever did, reading it as "queued" would tell somebody a document had been
     sent when nothing was written. */
  "would-requeue": "Nothing was written — this was a rehearsal, not a send.",
  /* ── SEND NOW ──────────────────────────────────────────────────────────── */
  "sent-now": "Nothing more to do — it is in the account book already, not just queued.",
  "send-now-refused":
    "Read what AutoCount said below. This row has now used all its tries, so once you have put that right it is Send again, not Send now.",
  "send-now-retrying":
    "Read what came back below. The document is still queued either way and will keep going out on its own.",
  "send-now-waiting":
    "Nothing to do. This document is made from an earlier one, and it goes across by itself once that one is in AutoCount.",
  "not-waiting":
    "Nothing to push — this row is not queued. If it was refused or held back, Send again is the one to use.",
  "already-in-flight":
    "Nothing, and nothing went wrong. It is being sent right this moment; give it a few seconds and look again.",
  "attempts-spent":
    "This one has used all its tries, so pushing it does nothing. Put right what AutoCount objected to, then use Send again.",
};

export const acRequeueTodo = (code: string): string | null => AC_REQUEUE_TODO[code] ?? null;

/** What is shown on the row after Send again has been pressed. */
export interface AcRequeueNote {
  tone: AcTone;
  /** The SERVER's sentence, verbatim, or — on a throw — what went wrong. */
  text: string;
  /** What to do next, from AC_REQUEUE_TODO. Null for a code with no entry. */
  todo: string | null;
  /**
   * The ERP's own words, when it refused the document a second time — and, on a
   * throw, whatever the transport said.
   *
   * A QUOTE, never spliced into `text`. The throw branch used to read
   * `the request did not get through: ${e.message}`, which makes the page's own
   * sentence and a machine's string one sentence and puts whatever a fetch layer
   * produced into the page's voice. Same rule as the row: the page says the
   * plain part, the machine is quoted under it.
   */
  quote: string | null;
  /** The quote's own machinery, behind the technical disclosure. */
  quoteTechnical: string | null;
  /**
   * The ancestors this press caused, already worded — one line each.
   *
   * ON THE ROW, like everything else here. A press on an invoice can move three
   * documents, and the operator has to be able to see which, on the row they
   * pressed, rather than by re-reading the whole table for what changed.
   */
  ancestors: string[];
  /**
   * The document is on its way again, so the OLD refusal on this row is no
   * longer true and comes off it.
   *
   * Immediately, not on the reload: the re-read is a round trip, and leaving
   * "To fix: go and change it in AutoCount" sitting on a document that has just
   * been re-sent is a false instruction for as long as it is on screen. The
   * server agrees a moment later — the old row becomes `requeued`, which
   * acReasonCopy already answers null for — so this only closes the window.
   */
  clearsReason: boolean;
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

  /* ONE PATH, TWO DOORS. `sendAgain` and `sendNow` differ only in which
     endpoint they call: the busy flag, the notes map, the accepted/refused
     split and the throw branch are shared, so the two buttons cannot drift into
     rendering their answers differently. Writing a second hook would have
     duplicated the one part of this file that has already been got wrong
     (a refusal reaching nobody) in the one place it was got right. */
  const run = useCallback(
    async (rowId: string, call: (id: string) => Promise<AcRequeueResult>) => {
      setSendingId(rowId);
      try {
        const r = await call(rowId);
        const quoted = r.reason === null ? null : acSplitMachineText(r.reason);
        setNotes((prev) => ({
          ...prev,
          [rowId]: {
            /* `wait`, not `bad`: most refusals are the system protecting the
               account book ("AutoCount already accepted this one"), which is
               news, not a fault. A thrown call IS a fault. */
            tone: r.accepted ? "good" : "wait",
            text: r.message,
            todo: acRequeueTodo(r.code),
            quote: quoted?.said ?? null,
            quoteTechnical: quoted?.detail ?? null,
            ancestors: (r.ancestors_sent ?? []).map(acAncestorLine),
            clearsReason: r.accepted,
          },
        }));
        if (r.accepted) onAccepted();
      } catch (e) {
        setNotes((prev) => ({
          ...prev,
          [rowId]: {
            tone: "bad",
            /* THE PAGE'S OWN SENTENCE, WHOLE. What the transport said is quoted
               under it rather than pasted into it — a fetch layer's string is
               not this page's voice, and on a bad day it is a status line and a
               URL. */
            text: "Nothing was sent — the request never got through.",
            /* No dictionary entry: there is no code, because the server never
               answered. The sentence above already says the only thing true. */
            todo: null,
            quote: e instanceof Error ? e.message : String(e),
            quoteTechnical: null,
            /* The call was never answered, so nothing is known to have been sent
               — an ancestor list here would be an invention. */
            ancestors: [],
            /* The old refusal still stands — nothing was sent. */
            clearsReason: false,
          },
        }));
      } finally {
        setSendingId(null);
      }
    },
    [onAccepted],
  );

  const sendAgain = useCallback((rowId: string) => run(rowId, requeueAcOutboxRow), [run]);
  const sendNow = useCallback((rowId: string) => run(rowId, sendNowAcOutboxRow), [run]);

  return { sendingId, notes, sendAgain, sendNow };
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
  /**
   * "REPLACED", NOT "SENT AGAIN" — owner, 2026-08-16, reading the live page:
   * *"你写 Send Again，明明都已经进去了，为什么还要 Send Again？"*
   *
   * `Send again` is the BUTTON on this same screen, and it is an instruction:
   * press me. The badge wearing the same two words read as that instruction on
   * seven of seventeen rows — on exactly the rows where pressing it is the one
   * thing a reader must not do, because the document is already through under a
   * newer send. The state is not an action anybody should take; it is something
   * that has already happened TO this record, so it is said in the passive and
   * in a word the button does not use. Everything else on the row agrees with
   * it: AC_REPLACED_LINE, acRowStatusLine and AC_STATE_PLAIN_MEANING below.
   */
  requeued: "Replaced",
} as const;

export const AC_STATE_LABEL: Record<string, string> = STATE_WORDS;

/**
 * The word on a filter TAB. Four now (owner 2026-08-21). "Not accepted" is the
 * merged stuck bucket (`attention` = failed + skipped): both mean the document
 * is in the ERP and not in the account book, which is the only thing the reader
 * acts on. Not built from STATE_WORDS — the tab set and the row-badge set are no
 * longer the same list, so listing the four here is clearer than a spread plus
 * two overrides.
 */
export const AC_FILTER_STATE_LABEL: Record<AcFilterState, string> = {
  all: "All",
  pending: "Waiting",
  attention: "Not accepted",
  sent: "In AutoCount",
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
    "A refusal a newer send has replaced. The document is queued or in AutoCount under that newer send, so there is nothing to do here and nothing to press.",
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
  /* THE MACHINE DID NOT ANSWER — and this is deliberately NOT worded as a
     refusal. AutoCount refused nothing; the request never arrived. It reached
     the operator as "masters not opened" for a day (2026-08-23) because the
     transport's own error text was pasted into that sentence, and it sent the
     investigation at AutoCount logins while a Windows service sat stopped. */
  "host-unreachable": {
    headline: "The AutoCount computer did not answer",
    explain:
      "The document never left the ERP — nothing was sent, nothing was refused, and nothing is wrong in the account book. The computer that runs the AutoCount link is not responding.",
    toFix:
      "Someone needs to check that machine: the sync service has to be running on it. Once it is, use Send again — the document is still here and nothing was lost.",
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
  /* THIS ROW IS HISTORY, and the words say so rather than repeating a limit
     that no longer holds. A merged conversion is sent now — the AutoCount side
     learned to take several sources on 2026-08-16 and the ERP followed — so
     nothing new lands in this class. What is still true of a row that CARRIES
     it: it was recorded before the change, the ERP composed nothing for it, and
     Send again therefore has nothing to send. */
  "no-autocount-shape": {
    headline: "Merged from several documents, and recorded before we could send that",
    explain:
      "This document was built from more than one earlier document at once. AutoCount would not take that when this row was written, so nothing was ever composed for it. It can take it now — but only documents raised since then are sent automatically.",
    toFix: "Raise the matching document in AutoCount by hand. Sending it again will not help, because nothing was composed to send.",
  },
  "mixed-source-lines": {
    headline: "Part of this invoice was never delivered on the document it follows",
    explain:
      "Some lines came across from the delivery order and some were added to the invoice on their own. AutoCount can only carry across the lines that came from the delivery order, so the invoice in the account book would be worth less than the one the customer holds.",
    toFix:
      "Raise the delivered lines from the delivery order, and the lines added on their own as a separate invoice. Sending it again will not help.",
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
  /*
   * IT DOES NOT ORDER ANYBODY TO FIX A FIELD, because half the time there is no
   * field. This line read "Put right whatever AutoCount named, in AutoCount,
   * then save the document in the ERP again so it is offered afresh" until
   * 2026-08-16, when the owner read it on a delivery order whose whole refusal
   * was `Invalid transfer item.` — eleven words naming no field, no line and no
   * document. Worse, the lines HAD been measured against the live book that same
   * day and were correct on every count the book keeps
   * (docs/autocount-sync-reasons.md §4). The page was sending him to repair
   * something provably not broken, which is worse than saying nothing.
   *
   * So it says both halves and lets the reader see which one he is in. There is
   * no code here deciding that: the server classifies `skipped` rows and
   * deliberately does not classify `failed` ones, and pattern-matching
   * AutoCount's message on this side to pick a branch would be the third opinion
   * this whole file exists to avoid. Words can hold an honest either/or; a guess
   * dressed as a branch cannot.
   */
  toFix:
    "Read AutoCount's own words below. If they name something on the document — a customer, an item, a"
    + " salesperson, a warehouse — put that right in AutoCount and save the document here again. If they"
    + " name nothing you can act on, that is the answer and not a gap in it: there is nothing on this"
    + " document for you to change. Pass it to whoever looks after the AutoCount link, with the document"
    + " number, and leave the row alone.",
};

// ── what AUTOCOUNT said, in the reader's words ───────────────────────────────

/**
 * AutoCount's own refusals, translated into the same three parts the ERP's own
 * refusals get.
 *
 * WHY THIS EXISTS. The page had two classes of verdict and translated only one.
 * A row the ERP held back reads as a headline, a sentence and a **To fix**,
 * with the machine's note folded into *Technical detail*; a row AUTOCOUNT
 * refused read as a generic headline with a raw string pasted under it —
 * `Primary Key Error` and nothing else. The owner read that screen and asked
 * for the obvious thing: 「为什么写这种的呢？没有平时 autocount reject 的 reason
 * 直接过来？」 and 「就直接跟我们说什么被拒绝就可以了」. It was an oversight
 * rather than a design: the disclosure that the raw text belongs in already
 * existed on the other rows.
 *
 * ONLY STRINGS SOMEBODY HAS ACTUALLY SEEN GO IN HERE. A wrong plain-language
 * explanation is far more damaging than an untranslated one, because it sends
 * an operator to fix the wrong thing with total confidence — the exact failure
 * `AC_FAILED_COPY`'s own comment records, when the page told the owner to
 * repair a delivery order whose lines had been measured correct that same day.
 * So this list is short on purpose, every entry names where it was observed,
 * and anything unmatched falls through to `AC_FAILED_COPY`, which quotes
 * AutoCount verbatim and says plainly that the words are the account book's.
 * A thin dictionary with an honest fallback beats a broad one that guesses.
 *
 * NOT A MIRROR OF THE SERVER'S TAXONOMY, and deliberately not moved there.
 * `AC_SKIP_KINDS` lives on the backend because the backend WRITES those reasons
 * and two readers of one vocabulary drift (#2094). These strings are written by
 * neither side — they are AutoCount's — and nothing on the server reads them,
 * so a copy there would be a second home with no second reader. Same argument
 * `acRowIsRequeueable` makes for staying out of the `.mjs` mirror.
 */
export interface AcAutoCountSaid {
  /** A substring of AutoCount's reply that identifies this refusal. */
  needle: string;
  /** Where this string was OBSERVED, so the next reader can check it. */
  seen: string;
  copy: AcReasonCopy;
}

export const AC_AUTOCOUNT_SAID: readonly AcAutoCountSaid[] = [
  {
    needle: "Primary Key Error",
    seen:
      "production, 2026-08-20 (workflow run 32382073444): HC-SO-2608-001, "
      + "HC-SO-2608-002 and HC-PO-2608-001, every one of them sending its own "
      + "document number as DocNo and every one refused with these words.",
    copy: {
      /* THE BUSINESS EFFECT, NOT THE MECHANISM. "Primary key" is the database's
         word for it; what it MEANS is that the name is taken. Justified by what
         was actually proven: the payload carries `DocNo: HC-SO-2608-001`
         verbatim — no prefix is stripped — and a primary-key refusal on a create
         is the book saying that key is already in use. What is NOT claimed here
         is WHICH document holds it, because that lives in AED_HOUZS and nothing
         on this side can see inside it. */
      headline: "AutoCount already has a document with this number",
      explain:
        "The ERP files each document in AutoCount under its own number, and AutoCount answered that this number is already taken. It will answer the same way every time until either that number is free or this document is given a different one.",
      toFix:
        "This one cannot be put right from the ERP, and sending it again will not help. Somebody with the AutoCount account book has to look the number up there: if what they find is this same document, it is already filed and only the link back to the ERP is missing; if it belongs to a different document, then this one needs a new number.",
    },
  },
];

/**
 * The words for what AutoCount said, or null when nobody has written any.
 *
 * Null is the ordinary answer and must stay cheap: it is what keeps every
 * refusal this file has never seen showing its raw text instead of a guess.
 */
export function acAutoCountCopy(reason: string | null | undefined): AcReasonCopy | null {
  const text = reason ?? "";
  if (!text) return null;
  for (const entry of AC_AUTOCOUNT_SAID) {
    if (text.includes(entry.needle)) return entry.copy;
  }
  return null;
}

/**
 * The three-part reason for a row, or null when there is nothing to explain.
 *
 * `requeued` returns null ON PURPOSE. It carries a reason kind — the original
 * refusal is still behind the marker — but a "To fix" line on a row that has
 * already been sent again would send somebody to fix what is already fixed,
 * which is the whole reason `requeued` is a separate state.
 */
export function acReasonCopy(
  state: string,
  reasonKind: string | null,
  /**
   * What was written on the row — AutoCount's own answer, on the states where
   * the account book is who spoke.
   *
   * REQUIRED, never optional. It DECIDES whether this row gets the specific
   * translation or the generic one, and an optional parameter would let every
   * existing caller keep the old wording with no compile error and no failing
   * test — the repo's standing rule about a parameter that decides something.
   */
  reason: string | null,
): AcReasonCopy | null {
  if (state === "requeued") return null;
  /* THE ERP'S OWN CLASSIFICATION WINS. A `skipped` row carries a `reason_kind`
     because the ERP refused it and knows exactly why; AutoCount was never asked,
     so nothing on it can be AutoCount's words. */
  if (reasonKind) return AC_REASON_COPY[reasonKind] ?? AC_UNRECOGNISED_COPY;
  /* BOTH STATES WHERE THE BOOK IS THE SPEAKER, and `pending` is not an
     oversight. AcSyncService turns every exception into a 500 and a 500 is
     retryable, so a document AutoCount REFUSES sits at `pending` carrying the
     refusal until its sixth attempt — which is exactly where HC-SO-2608-002 was
     on 2026-08-20 while HC-SO-2608-001 beside it read `failed` with identical
     words. Translating only the failed one would explain a document to the
     operator half an hour after it stopped being actionable.

     It also settles the ambiguity `acReplySource` records for a pending row:
     that label claims neither speaker because nothing distinguishes them. A
     MATCH here is that distinction — these strings are AutoCount's. */
  if (state === "failed" || state === "pending") {
    const said = acAutoCountCopy(reason);
    if (said) return said;
  }
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

// ── the machine's words, split into the part a person can use ───────────────

/**
 * WHERE THE AUTOCOUNT SERVICE ENDS ITS SENTENCE AND STARTS ITS EVIDENCE.
 *
 * `AcSyncService.cs` appends its own diagnosis to whatever the SDK threw:
 *
 *     ex.Message.Trim() + " || source " + fromType + " lines as the book holds
 *     them: " + why
 *
 * (`backend/scripts/autocount-service/AcSyncService.cs`, in the transfer arm.)
 * That `||` is therefore a SEPARATOR the writer put there on purpose, not a
 * pattern guessed at on this side — which is the whole difference between
 * splitting a string and classifying a row. Nothing here reads what is on
 * either side of it.
 *
 * The evidence is worth having. On 2026-08-16 it is the only thing that refuted
 * the "two sales orders in one array" diagnosis for HC-DO-2608-001 and -002
 * (docs/autocount-sync-reasons.md §4). It is also four lines of
 * `Qty=1.00000000 TransferedQty=0.00000000 Transferable=T docCancelled=F`, and
 * the person who opens this page is checking whether a delivery went out.
 */
export const AC_MACHINE_DETAIL_MARK = " || ";

/** What goes on screen, and what goes behind the technical disclosure. */
export interface AcMachineText {
  /** The machine's own sentence. Stays in view, quoted and attributed. */
  said: string;
  /** Its evidence. Behind the disclosure, or null when it wrote none. */
  detail: string | null;
}

export function acSplitMachineText(text: string): AcMachineText {
  const at = text.indexOf(AC_MACHINE_DETAIL_MARK);
  if (at < 0) return { said: text, detail: null };
  return {
    said: text.slice(0, at).trim(),
    detail: text.slice(at + AC_MACHINE_DETAIL_MARK.length).trim(),
  };
}

/** What the collapsed block is called, so nobody opens it expecting an answer. */
export const AC_TECHNICAL_LABEL = "Technical detail, for whoever looks after the AutoCount link";

/**
 * WHO SPOKE, WHAT STAYS ON SCREEN, AND WHAT GOES BEHIND THE DISCLOSURE.
 *
 * The label is untouched by any of this: "AutoCount replied" and "AutoCount was
 * not asked" are different facts that change what the reader does, the owner
 * asked for the distinction by name, and flattening it would be tidying away the
 * thing he wanted. What moves is only the machinery under it.
 *
 * Two branches, and the split is on WHO WROTE THE NOTE, never on what it says:
 *
 * - **The ERP wrote it** and this file already has plain words for that row —
 *   the headline, the sentence and the To fix line are all saying the same thing
 *   in the reader's language, so the raw note adds nothing he can act on and
 *   everything he cannot. It goes behind the disclosure whole. This is the
 *   parentless-invoice row: its note was an English sentence carrying an SDK
 *   method name, and no amount of rewording the server makes an internal note
 *   into page copy.
 * - **Anybody else, or the ERP with no plain words yet** — AutoCount's own
 *   answer, a retry note, an `unrecognised` refusal. There the machine's
 *   sentence IS the diagnosis and nothing may take it off the screen; only the
 *   evidence after the service's own `||` moves.
 *
 * @param pageHasItsOwnWords does this file have plain-language copy for the row
 *   that says what the note says? REQUIRED, and not derived here: it is a fact
 *   about `acRowDetail`'s own dictionary, and a default either way would silently
 *   pick a branch for every future caller. Passing `false` is the safe direction
 *   — it shows more, never less.
 */
export interface AcSaid {
  /** WHO wrote it. Never null, never merged into the text. */
  label: string;
  /** The ERP stopped it itself, so nothing ever reached the account book. */
  notAsked: boolean;
  /** In view, quoted. Null when the whole note is machinery. */
  said: string | null;
  /** Behind the collapsed disclosure. Null when there is nothing to put there. */
  technical: string | null;
  /** Nothing was written down at all — which is itself worth printing. */
  silent: boolean;
}

export function acWhatWasSaid(row: AcOutboxRow, pageHasItsOwnWords: boolean): AcSaid {
  const source = acReplySource(row.state, row.reason);
  const base = { label: AC_REPLY_LABEL[source], notAsked: source === "erp" };
  if (row.reason === null) return { ...base, said: null, technical: null, silent: true };
  /* WAS `source === "erp" && pageHasItsOwnWords`, and the source half came off
     on 2026-08-20. The reasoning above explains the split as "who wrote the
     note, never what it says", and that was right while the ONLY notes this
     file had words for were the ERP's — AutoCount's answers were always raw, so
     the two conditions were the same condition. They stopped being the same the
     moment `AC_AUTOCOUNT_SAID` gave a refusal of AutoCount's plain words of its
     own, and keeping the source test would have printed the headline, the
     sentence, the To fix line AND the raw string, which is the pile the owner
     asked to have thinned.
     The rule underneath is unchanged and is what the caller passes: the machine
     text moves out of view only where this file says the same thing in the
     reader's language. Where it does not — the generic failed copy, an
     unrecognised refusal, a retry note — nothing may take the quote off screen,
     because there the machine's sentence IS the diagnosis. */
  if (pageHasItsOwnWords) {
    return { ...base, said: null, technical: row.reason, silent: false };
  }
  const { said, detail } = acSplitMachineText(row.reason);
  return { ...base, said, technical: detail, silent: false };
}

// ── how much of a row is on screen before anybody clicks ────────────────────

/**
 * The one line a replaced refusal gets. The rest of it is behind the opener.
 *
 * It used to read "Already sent again — this row is history", which is the badge
 * defect one line down: it put the button's own words on the row and then said
 * something a reader has to translate. Both halves are plainer now, and the
 * second half says what to DO (nothing) rather than what the record IS.
 */
export const AC_REPLACED_LINE = "Replaced by a newer send — nothing to do on this one";

export const AC_REPLACED_NOTE =
  "This is the record of the first refusal, not something to act on — the document is queued or in AutoCount under a newer send.";

/**
 * WHAT A ROW SAYS, split into the part that is always on screen and the part
 * behind the opener.
 *
 * The owner accepted the rebuilt page and then read it at scale: *"这一个东西下面
 * 的地方太复杂了 ... 如果我有一千个 sales order 的时候，我不是完蛋？"* Every
 * problem row was printing a headline, a sentence, a **To fix** line and a
 * quoted machine reply, all at once. At thirteen rows that reads well; at a
 * thousand it is unreadable, and the thousand is the real number.
 *
 * So ONE line stays: `line`, the plain-language headline. It is never hidden —
 * that was the owner's earlier complaint about a reason behind a "Why not"
 * click, and this does not undo it. `copy.explain`, `copy.toFix` and the quoted
 * reply move behind opening the row.
 *
 * A row with nothing to say — anything already in the account book — gets
 * `line: null` and `expandable: false`, which is what keeps the majority of a
 * long list quiet.
 */
export interface AcRowDetail {
  /** Always on screen. Null on a row with nothing to explain. */
  line: string | null;
  /** Behind the opener: the sentence and the To fix line. */
  copy: AcReasonCopy | null;
  /**
   * Behind the opener: who was asked, what they said, and — one level further
   * in — the machinery. Null when nothing was written down and nobody spoke.
   *
   * A SHAPE, not a boolean, since 2026-08-16. It used to be `showSaid: boolean`
   * and each surface then reached into the row and rebuilt the answer itself,
   * which is exactly how the desktop and the phone come to disagree about one
   * row. Both now render this.
   */
  said: AcSaid | null;
  /** Behind the opener: why a re-sent refusal is not something to act on. */
  showRequeuedNote: boolean;
  /** Whether the row has an opener at all. */
  expandable: boolean;
}

/**
 * @param reasonCleared the document has just been accepted back into the queue,
 *   so its old refusal is no longer true and comes off the row immediately —
 *   see AcRequeueNote.clearsReason. Required, not optional: forgetting it
 *   leaves a false instruction on screen for a whole round trip.
 */
export function acRowDetail(row: AcOutboxRow, reasonCleared: boolean): AcRowDetail {
  const copy = reasonCleared ? null : acReasonCopy(row.state, row.reason_kind, row.reason);
  const showSaid = !reasonCleared
    && (copy !== null || (row.reason !== null && row.state !== "sent"));
  const showRequeuedNote = !reasonCleared && row.state === "requeued";
  const expandable = copy !== null || showSaid || showRequeuedNote;
  /* DOES THIS FILE ALREADY SAY, IN THE READER'S WORDS, WHAT THE NOTE SAYS? The
     unrecognised copy is excluded on purpose: it does NOT explain the row, it
     says nobody has written an explanation yet and points at the quote as the
     whole answer. Treating it as plain words would hide the only thing the row
     has. A replaced row counts — AC_REPLACED_LINE and AC_REPLACED_NOTE say all
     of it, and the note under it is the first refusal's machinery. */
  /* AC_FAILED_COPY IS EXCLUDED FOR THE SAME REASON AC_UNRECOGNISED_COPY IS, and
     it has to be: it does not explain the row either. Its own To fix line reads
     "Read AutoCount's own words below" and then branches on whether those words
     name anything — so folding the quote behind the disclosure would leave an
     instruction pointing at something no longer on screen. Only a SPECIFIC
     translation counts as this file having said what the note says. */
  const specific = copy !== null && copy !== AC_UNRECOGNISED_COPY && copy !== AC_FAILED_COPY;
  const said = showSaid ? acWhatWasSaid(row, specific || showRequeuedNote) : null;
  const line = copy !== null
    ? copy.headline
    : showRequeuedNote
      ? AC_REPLACED_LINE
      /* No plain-language copy exists for this one — a pending row carrying its
         last attempt's note is the case — so the line says WHO spoke and the
         words themselves stay behind the opener. */
      : said !== null
        ? said.label
        : null;
  return { line, copy, said, showRequeuedNote, expandable };
}

// ── one line per DOCUMENT, not one line per SEND ────────────────────────────

/**
 * WHAT IDENTIFIES A DOCUMENT: its TYPE and its NUMBER, together.
 *
 * Not `doc_no` alone. Migration 0277's CHECK admits six types and the same
 * number can legitimately belong to two of them, so a bare number would fold a
 * delivery order into an invoice and show one row for two real documents —
 * losing a document is a worse defect than showing one twice.
 *
 * Not `doc_id`. 0277 declares it nullable and deliberately untyped, in its own
 * words: the six document tables do not share a key type and "an outbox row must
 * survive its document being reworked". A key that is allowed to be absent
 * cannot be the key.
 *
 * The pair is the TABLE'S own answer, not a choice made here:
 * `autocount_outbox_doc_idx` is `(company_id, doc_type, doc_no)`, created by
 * 0277 to answer "has this document been written to AutoCount, and as what".
 * `company_id` is not in the key because the whole response is one company —
 * every statement behind it carries the predicate. The backend's `acDocKey`
 * joins the same two columns for the counts.
 */
export const acDocumentKey = (row: AcOutboxRow): string =>
  `${row.doc_type}\u0000${row.doc_no}`;

/** Every send for ONE document, and the one that says where it stands now. */
export interface AcDocGroup {
  key: string;
  docType: string;
  docNo: string;
  /**
   * The NEWEST send, which is what the row shows. Under a status filter that is
   * the newest send MATCHING the filter, which is the honest answer to the
   * question the filter asked — "In AutoCount" showing a document's arrival is
   * right even if the document has since been edited into a refusal, and the
   * Needs attention chip is where that refusal is somebody's job.
   */
  current: AcOutboxRow;
  /** Every send, newest first. `current` is the first of them. */
  sends: AcOutboxRow[];
  /** The sends BEHIND the current one — the audit trail, kept, folded. */
  earlier: AcOutboxRow[];
}

/** Newest first, treating an unreadable or absent timestamp as oldest. */
const sendTime = (row: AcOutboxRow): number => {
  const t = row.created_at === null ? NaN : new Date(row.created_at).getTime();
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * ONE ROW PER DOCUMENT. The owner, 2026-08-16, on the live page:
 * *"为什么在 AutoCount 里面一张 Sales Order 会出现两次呢?"*
 *
 * `HC-SO-2608-002` took FOUR of the six rows under *In AutoCount → Sales
 * orders* — three changes and the original create — while `AED_HOUZS` holds
 * exactly one of it. Nothing was duplicated anywhere; the screen was listing one
 * row per SEND and calling the count documents. `scm.autocount_outbox` is
 * append-only and records one row per intended operation (0277's own words), so
 * an ordinary document that is created and then edited twice is three rows
 * forever, and the busier the document the louder it shouts.
 *
 * The sends are the AUDIT TRAIL and none of them is dropped — they move behind
 * the document, which is `earlier`.
 *
 * Group order is FIRST APPEARANCE, so the server's ordering survives: the route
 * returns `created_at` descending, which puts the document with the newest send
 * first. The sends inside a group are sorted here rather than assumed, because a
 * caller that hands over rows in another order must still get a truthful
 * `current` — that is the field the whole row is drawn from.
 */
export function acGroupByDocument(rows: AcOutboxRow[]): AcDocGroup[] {
  const byKey = new Map<string, AcOutboxRow[]>();
  const order: string[] = [];
  for (const r of rows) {
    const key = acDocumentKey(r);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else {
      byKey.set(key, [r]);
      order.push(key);
    }
  }
  return order.map((key) => {
    /* Non-null by construction — the key came out of the same loop that filled
       the map — and asserted rather than defaulted, because a `?? []` here would
       silently produce a group with no `current` to draw. */
    const bucket = byKey.get(key)!;
    const sends = [...bucket].sort((a, b) => sendTime(b) - sendTime(a));
    const current = sends[0]!;
    return {
      key,
      docType: current.doc_type,
      docNo: current.doc_no,
      current,
      sends,
      earlier: sends.slice(1),
    };
  });
}

/** What the fold over a document's earlier sends is called. */
export function acEarlierSendsHeading(n: number): string {
  return n === 1
    ? "1 earlier send for this document"
    : `${n} earlier sends for this document`;
}

export const AC_EARLIER_SENDS_NOTE =
  "Every time this document was offered to AutoCount, oldest last. They are the record of what"
  + " was sent and what came back; the line above is where the document stands now.";

/**
 * Which documents have their send history open.
 *
 * Keyed by the document rather than by a row id, and lifted out of the card for
 * the same two reasons `useAcExpandedRows` is: the list is windowed, so a card
 * that scrolls out of view is unmounted and would forget, and a fold that
 * behaves differently on the phone is the split this shared layer exists to
 * stop.
 */
export function useAcSendHistory() {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (g: AcDocGroup): boolean => open[g.key] ?? false;
  const toggle = useCallback((g: AcDocGroup) => {
    setOpen((prev) => ({ ...prev, [g.key]: !(prev[g.key] ?? false) }));
  }, []);
  return { isOpen, toggle };
}

// ── history is not a task list ──────────────────────────────────────────────

/**
 * A document whose latest send has already been REPLACED by a newer one.
 *
 * It is a record. Nothing on it can be worked, `can_requeue` is false on it, and
 * `acReasonCopy` deliberately gives it no To fix line — the server has said so
 * three separate ways. The one thing left saying otherwise was its POSITION:
 * mixed in with live rows, at the same size, in the same list.
 *
 * Judged on `current`, not on any send: a document whose refusal was re-sent has
 * the LIVE row as its newest send, so grouping alone lifts it back into the list
 * where it belongs and files the refusal underneath it. Only a document with
 * nothing newer than a replaced send is a record.
 */
export const acIsReplaced = (group: AcDocGroup): boolean => group.current.state === "requeued";

export interface AcDocSplit {
  /** The documents that are somebody's job. These are the list. */
  live: AcDocGroup[];
  /** The documents that are a record. Folded away unless the reader asks. */
  replaced: AcDocGroup[];
}

/**
 * Split the loaded documents into work and record.
 *
 * Owner, 2026-08-16, reading the live page: fifteen rows, SIX of them replaced
 * refusals, with HC-DO-2608-001 and HC-DO-2608-002 each appearing twice. Nearly
 * half a screen of documents that are already in AutoCount or already queued,
 * sitting between him and the ones that are not. The table is append-only, so
 * this only gets worse — every refusal that is ever put right leaves one of
 * these behind forever.
 *
 * The 2026-08-21 four-tab change dropped the "requeued" tab, so there is no
 * longer a filter that asks for the replaced history AS a list. Replaced
 * documents always fold under their live row and are reached through the
 * Replaced disclosure, never a tab — so the split no longer depends on the
 * filter in force, and takes no state.
 */
export function acSplitReplaced(groups: AcDocGroup[]): AcDocSplit {
  return {
    live: groups.filter((g) => !acIsReplaced(g)),
    replaced: groups.filter(acIsReplaced),
  };
}

/**
 * What the folded group is called.
 *
 * Both forms written out. `document` + "s" is right here and wrong further up in
 * AC_DOC_TYPE_PLURAL ("GOODS RECEIVEDS"), and a rule applied only where it
 * happens to work is not a rule anybody can follow.
 */
export function acReplacedHeading(n: number): string {
  return n === 1
    ? "1 replaced document, kept as a record"
    : `${n} replaced documents, kept as a record`;
}

export const AC_REPLACED_GROUP_NOTE =
  "Each of these was refused once and a newer send has replaced it. Their documents are queued or"
  + " in AutoCount under that newer send, so there is nothing here to do — they are kept so the"
  + " refusal that happened can still be found.";

/**
 * What the list says when the filter matched documents and every one is history.
 *
 * Not `acEmptyLine`'s "try another status": there IS something here, it is
 * folded, and telling somebody to go elsewhere while six documents sit under the
 * message is the kind of small lie that makes a screen untrustworthy.
 */
export const AC_ONLY_REPLACED_LINE =
  "Nothing live here. Every document the filters matched has been replaced by a newer send, and is"
  + " folded below.";

/**
 * The folded group, FOLDED on arrival, on both surfaces.
 *
 * A hook rather than a `useState(false)` in each file, for the reason
 * `useAcExpandedRows` gives one screen up: a default that differs between the
 * desktop and the phone is one of the two surfaces quietly deciding history is
 * work again, and nothing would fail.
 */
export function useAcReplacedGroup() {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => { setOpen((v) => !v); }, []);
  return { open, toggle };
}

/**
 * The page's own sentence when the queue cannot be read at all.
 *
 * Shared because both surfaces say it, and separated from whatever the
 * transport reported for the same reason the re-queue throw was: the error text
 * is QUOTED under this line, not spliced into it.
 */
export const AC_LOAD_FAILED_LINE =
  "The queue could not be read, so nothing below is the current picture.";

/**
 * The one row that arrives OPEN.
 *
 * A refusal nobody has plain words for yet is a code path that grew a new
 * refusal, and the quoted note is the entire answer — there is no headline to
 * read instead of it. #2323 made that note open itself for the same reason;
 * putting the whole reason behind an opener must not quietly take it back.
 */
export const acOpensItself = (row: AcOutboxRow): boolean => row.reason_kind === "unrecognised";

/**
 * Which rows are open.
 *
 * Lifted OUT of the row, for two reasons. The list is windowed now, so a row
 * that scrolls out of view is UNMOUNTED and state kept inside it would forget
 * itself on the way back. And a row that opens differently on the two surfaces
 * is exactly the split this shared layer exists to stop.
 */
export function useAcExpandedRows() {
  const [choice, setChoice] = useState<Record<string, boolean>>({});
  const isOpen = (row: AcOutboxRow): boolean => choice[row.id] ?? acOpensItself(row);
  const toggle = useCallback((row: AcOutboxRow) => {
    setChoice((prev) => ({ ...prev, [row.id]: !(prev[row.id] ?? acOpensItself(row)) }));
  }, []);
  return { isOpen, toggle };
}

// ── the type strip ──────────────────────────────────────────────────────────

/**
 * How many DOCUMENTS of each type are in the rows currently loaded, plus `all`.
 *
 * DOCUMENTS since 2026-08-17, and that is the second half of the owner's
 * duplicate report: the chip used to count rows, so one sales order sent four
 * times made *Sales orders 4*. Both strips now say the same kind of thing, which
 * is the only way a reader can compare them.
 *
 * Counted over the pool the STATE filter already produced, so the numbers move
 * when the state changes — which is the point of putting them on the chips.
 * These are counts of the LOADED page, unlike the state counts, which the
 * server computes exactly over the whole company; the page says so when the
 * list is truncated.
 */
export type AcDocTypeCounts = Record<AcDocType | "all", number>;

export function acDocTypeCounts(groups: AcDocGroup[]): AcDocTypeCounts {
  /* Written out rather than built in a loop so the COMPILER holds it to
     AcDocType: a seventh type added to AC_DOC_TYPES fails to compile here
     instead of quietly getting a chip that always reads zero. */
  const out: AcDocTypeCounts = { all: groups.length, SO: 0, DO: 0, IV: 0, PO: 0, GR: 0, PI: 0 };
  /* Everything is `groups.length`, so the six chips are allowed to sum to LESS
     than it: a doc_type 0277's CHECK does not admit is counted in `all` and
     nowhere else. That is the honest arithmetic — inventing a seventh chip for
     a value the database cannot hold would be worse. */
  for (const g of groups) {
    if ((AC_DOC_TYPES as readonly string[]).includes(g.docType)) out[g.docType as AcDocType] += 1;
  }
  return out;
}

/**
 * The number on a STATUS chip. The server's, exact and whole-company, unlike
 * the type counts above — and `all` is the total rather than a seventh count.
 *
 * Also DOCUMENTS since 2026-08-17: the route counts distinct `doc_type + doc_no`
 * rather than rows. The two strips therefore agree with one another and with the
 * list under them, which they did not before.
 */
export function acStateCount(d: AcOutboxResponse | null, s: AcFilterState): number {
  if (!d) return 0;
  return s === "all" ? d.counts.total : d.counts[s];
}

/** The documents the type lens leaves visible. An empty type means every type. */
export function acGroupsOfType(groups: AcDocGroup[], docType: AcDocType | ""): AcDocGroup[] {
  return docType ? groups.filter((g) => g.docType === docType) : groups;
}

/**
 * The line under the strips: how much of the company is on screen.
 *
 * Shared because it is a SENTENCE and because the two surfaces had already
 * drifted — the desktop wrote "6 of 17 documents" and the phone wrote "6 of 17",
 * two different claims from two hand-written template strings. Both halves are
 * documents now; the left is what the filters left on screen, the right is what
 * the whole company holds.
 */
export function acListCountLine(shown: number, total: number): string {
  return `${shown} of ${total} document${total === 1 ? "" : "s"}`;
}

/**
 * What to add when the server could not scan the whole queue for its counts.
 *
 * A separate sentence rather than a "+" on each chip: the numbers are still the
 * best answer available and are right for everything the scan reached, and the
 * one thing a reader must not conclude from them is "and that is all of it".
 */
export const AC_COUNTS_PARTIAL_LINE =
  "The queue is now too long to count in one pass, so the numbers on the chips are at least this"
  + " many and possibly more.";

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
      return "Replaced by a newer send";
    default:
      return "";
  }
}

/**
 * The one line of detail beside a document number: what it is, where it stands,
 * and when.
 *
 * ONE sentence, not five fragments. The rebuilt row printed the kind, the
 * queued-at, where it stands, how long it has waited and when it arrived, each
 * as its own piece of the row, and five fragments is how a row becomes four
 * lines. A thousand of those is the screen the owner called unusable.
 *
 * Ordered so that clipping loses the least: the type of document first, then
 * where it stands, then the timestamp — the part a reader can do without.
 */
export function acRowStandsAt(row: AcOutboxRow, maxAttempts: number): string {
  const parts = [acRowKind(row.doc_type, row.op), acRowStatusLine(row, maxAttempts)];
  if (row.state === "pending") parts.push(`waiting ${acAge(row.created_at)}`);
  parts.push(
    row.state === "sent" && row.sent_at
      ? `arrived ${fmtDateTime(row.sent_at)}`
      : `queued ${fmtDateTime(row.created_at ?? "")}`,
  );
  return parts.filter((p) => p !== "").join(" · ");
}

/** The heading over the list — which status, and which type, are in force. */
export function acListTitle(state: AcFilterState, docType: AcDocType | ""): string {
  const s = state === "all" ? "All documents" : AC_FILTER_STATE_LABEL[state];
  return docType ? `${s} · ${acDocTypePlural(docType)}` : s;
}

/** What an empty list MEANS — three different facts, never one sentence. */
export function acEmptyLine(d: AcOutboxResponse, state: AcFilterState): string {
  if (d.counts.total === 0) {
    return "Nothing has ever been queued for AutoCount in this company.";
  }
  /* The page now OPENS on this filter, so its empty case is the common one and
     "try another status" would read as a dead end on a healthy day. */
  if (state === "attention" && d.counts.attention === 0) {
    return "Nothing needs your attention. Every document is either in AutoCount or on its way.";
  }
  return "Nothing here. Try another status or another document type.";
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
  /* NULL IS NOT FALSE. `on` is company-aware and its third state means the
     server could not resolve this reader's company, so it declined to answer.
     Folding that into the OFF sentence would state as fact ("queues nothing and
     sends nothing") the very thing that could not be established — the same
     shape of over-claim the switched-off/nothing-wrong collapse was corrected
     for in #2094, one step further back. */
  if (d.writeback.on === null) {
    return {
      tone: "muted",
      text:
        "Whether sending to AutoCount is switched on for this company could not be established,"
        + " so this list cannot say whether a save would queue anything.",
    };
  }
  if (!d.writeback.on) {
    return {
      tone: "muted",
      text:
        "Sending to AutoCount is switched off. Saving a document queues nothing and sends nothing"
        + (d.counts.total > 0 ? "; everything below already happened." : "."),
    };
  }
  if (d.counts.attention > 0) {
    /* One plain line (owner 2026-08-21, simplifying the page): the "X not
       accepted, Y held back" split it used to carry is the same distinction the
       four-tab change merged into "Not accepted", so the headline no longer
       breaks it down — both mean the document is in the ERP, not in the book. */
    const n = d.counts.attention;
    return {
      tone: "bad",
      text: `${n} document${n === 1 ? " is" : "s are"} not in the account book — ${n === 1 ? "it is" : "they are"} in the ERP and need${n === 1 ? "s" : ""} your attention.`,
    };
  }
  /* THE COUNTS THEMSELVES CAN BE A FLOOR. The server SAYS SO — it sets
     `counts_complete: false` when its scan stopped before the end of the queue
     (scm/routes/autocount-outbox.ts) — and both screens already render a
     separate banner for it. The HEADLINE ignored it, so the tone-setting line
     read "Everything is in AutoCount" in green while a note underneath said the
     numbers were incomplete: two contradictory statements on one screen, and
     the reassuring one is the one people act on.

     `attention > 0` is answered ABOVE this point and needs no such guard — a
     floor that is already non-zero is still non-zero. It is only the reassuring
     verdicts that a partial count cannot support (owner 2026-08-17: no empty
     state may claim the work is done). */
  if (!d.counts_complete) {
    return {
      tone: "muted",
      /* Deliberately NOT a repeat of AC_COUNTS_PARTIAL_LINE, which both screens
         already render beneath this. Saying the same sentence twice is how a
         reader learns to stop reading either one. */
      text:
        "The queue was too long to count in one pass, so this line cannot say whether everything"
        + " reached AutoCount. Filter to Not accepted or Held back to check the documents that matter.",
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
  if (d.writeback.on === null) {
    /* The server could not resolve which company this reader is in, so it
       declined to answer rather than guess. Saying "off" here would be the same
       false certainty in the other direction. */
    return "Sending to AutoCount could not be checked for this company — the switch itself reads as "
      + `${JSON.stringify(d.writeback.scope)}.`;
  }
  if (d.writeback.on) {
    return d.writeback.scope === "all"
      ? "Sending to AutoCount is switched on for every company."
      : "Sending to AutoCount is switched on for this company.";
  }
  /* OFF FOR THIS COMPANY IS NOT OFF ALTOGETHER, and the difference is the whole
     reason this branch exists. The switch is a company allow-list, so it can be
     on for the organisation next door and off here — and the old wording,
     `The switch is set to "1", which does not read as on`, would have told a
     reader in company 2 that a perfectly well-formed value was a typo. Name the
     real situation instead: it is on, just not for you. */
  if (d.writeback.scope !== "off") {
    return "Sending to AutoCount is switched off for this company — it is switched on for "
      + `${d.writeback.scope.includes(",") ? "other companies" : "another company"}, not this one.`;
  }
  return d.writeback.value === null
    ? "Sending to AutoCount is switched off — the switch has never been set."
    : `Sending to AutoCount is switched off. The switch is set to ${JSON.stringify(d.writeback.value)}, which does not read as on.`;
}
