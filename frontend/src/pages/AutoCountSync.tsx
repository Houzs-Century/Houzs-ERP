// ---------------------------------------------------------------------------
// AutoCount Sync — what the ERP has told the account book, and what came back.
//
// The owner asked for this in these words: "如果它是在排队、skip、planning 还是
// fail 等等，fail 的话是什么原因？everything 都要呈现出来，要不然我就不知道."
// Until it existed the only reader of scm.autocount_outbox was a GitHub Action
// whose output is a workflow log, which he cannot open.
//
// SO THE ORDER OF THE PAGE IS THE ORDER OF HIS QUESTION: is anything stuck (the
// verdict), then which documents (the two filter strips and the list), then why
// (the reason, on the row itself).
//
// SIMPLIFIED 2026-08-16, the same day it was rebuilt, because he read the
// rebuild at scale: "这一个东西下面的地方太复杂了，你尽量简单化一点。一个 sales
// order 那么宽，那如果我有一千个 sales order 的时候，我不是完蛋？" Four changes,
// and the reason each one is here rather than being a preference:
//   - the page OPENS on what needs attention, not on everything. The sales order
//     list alone is 2,726 documents; "what is stuck" is the question somebody
//     came here with, and Everything is one chip away.
//   - a row is ONE LINE. The headline of the reason stays on it — it is never
//     hidden, which was his earlier complaint — and the sentence, the To fix
//     line and the quoted machine reply go behind opening that row.
//   - a document already in the account book has nothing to open at all. Those
//     are the majority and they are now quiet.
//   - the strips are pinned and the list is WINDOWED (MobileVirtualList, the
//     component eight mobile screens and DataTable already use), so a thousand
//     rows are a thousand rows of scrolling, not a thousand rows of DOM.
//
// ONE ROW PER DOCUMENT, 2026-08-17. He read the page again: "为什么在 AutoCount
// 里面一张 Sales Order 会出现两次呢?" HC-SO-2608-002 took four of the six rows
// under In AutoCount / Sales orders — three changes and the create — while the
// account book holds exactly one of it. Nothing was duplicated; the list was one
// row per SEND. `acGroupByDocument` folds the sends into the document they
// belong to, the newest one draws the card, and the rest are the audit trail,
// one click down. Both chip strips and the "N of M documents" line count
// documents to match.
//
// Presentation only. The state, the reason kind and the remedy are decided by
// the server (backend/src/scm/lib/autocount-outbox-status.ts); the words, and
// how much of them is on screen before a click, are lib/autocountOutbox. The
// mobile twin is mobile/MobileAutoCountSync.tsx and renders the SAME hook, the
// SAME words and the SAME opener.
//
// SEND AGAIN, per row, since #2321 landed the backend action. Offered only
// where the server's `can_requeue` says an answer other than a flat no is
// possible, and the answer — accepted, refused, or never answered — is printed
// on the row that was pressed. `AC_REQUEUE_MEANING`'s sentence is shown
// verbatim: it comes from the module that produced the outcome, so a new
// outcome can never reach the owner as a bare hyphenated key.
// ---------------------------------------------------------------------------
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronRight, RefreshCw } from "lucide-react";

import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { ListSkeleton } from "../components/Skeleton";
import { MobileVirtualList } from "../mobile/MobileVirtualList";
import { cn } from "../lib/utils";
import {
  AC_COUNTS_PARTIAL_LINE,
  AC_DEFAULT_STATE,
  AC_DOC_TYPES,
  AC_EARLIER_SENDS_NOTE,
  AC_FILTER_STATES,
  AC_FILTER_STATE_LABEL,
  AC_LOAD_FAILED_LINE,
  AC_NOT_ASKED_NOTE,
  AC_ONLY_REPLACED_LINE,
  AC_REPLACED_GROUP_NOTE,
  AC_REPLACED_NOTE,
  AC_SEND_AGAIN_BUSY_LABEL,
  AC_SEND_NOW_LABEL,
  AC_SEND_NOW_BUSY_LABEL,
  AC_SEND_AGAIN_LABEL,
  AC_TECHNICAL_LABEL,
  acDocTypePlural,
  acDocTypeCounts,
  acEarlierSendsHeading,
  acEmptyLine,
  acGroupByDocument,
  acGroupsOfType,
  acHeadline,
  acListCountLine,
  acListTitle,
  acReplacedHeading,
  acRowDetail,
  acRowStandsAt,
  acSplitReplaced,
  acStateCount,
  acStateLabel,
  acStateTone,
  useAcExpandedRows,
  useAcReplacedGroup,
  useAcRequeue,
  useAcSendHistory,
  useAutoCountOutbox,
  type AcDocGroup,
  type AcDocType,
  type AcFilterState,
  type AcOutboxRow,
  type AcRequeueNote,
  type AcSaid,
  type AcTone,
} from "../lib/autocountOutbox";

const TONE_BANNER: Record<AcTone, string> = {
  good: "border-synced/40 bg-synced/5 text-synced",
  bad: "border-err/40 bg-err/5 text-err",
  wait: "border-amber-500/40 bg-amber-500/5 text-warning-text",
  muted: "border-border bg-surface text-ink-muted",
};

const TONE_BADGE: Record<AcTone, string> = {
  good: "border-synced/40 bg-synced/10 text-synced",
  bad: "border-err/40 bg-err/10 text-err",
  wait: "border-amber-500/40 bg-amber-500/10 text-warning-text",
  muted: "border-border bg-canvas text-ink-muted",
};

/** The rail down the left edge of a row — the state, readable at a glance. */
const TONE_RAIL: Record<AcTone, string> = {
  good: "border-l-synced",
  bad: "border-l-err",
  wait: "border-l-amber-500",
  muted: "border-l-border",
};

const TONE_WHY: Record<AcTone, string> = {
  good: "border-synced/25 bg-synced/5",
  bad: "border-err/25 bg-err/5",
  wait: "border-amber-500/25 bg-amber-500/5",
  muted: "border-border bg-canvas",
};

const TONE_TEXT: Record<AcTone, string> = {
  good: "text-synced",
  bad: "text-err",
  wait: "text-warning-text",
  muted: "text-ink-muted",
};

function StateBadge({ state }: { state: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        TONE_BADGE[acStateTone(state)],
      )}
    >
      {acStateLabel(state)}
    </span>
  );
}

/**
 * THE MACHINERY, one level further in than the reason.
 *
 * A separate, collapsed, labelled block — not a longer quote. The AutoCount
 * service started appending the account book's own numbers per line on
 * 2026-08-16 and the diagnostic is genuinely valuable: it is what refuted the
 * standing explanation for HC-DO-2608-001 and -002. It is also
 * `Qty=1.00000000 TransferedQty=0.00000000 Transferable=T docCancelled=F`,
 * four lines of it, on a screen a warehouse clerk opens to ask whether a
 * delivery went out. Both are true, so both get a place, and the label says
 * which reader each is for.
 */
function TechnicalNote({ text }: { text: string }) {
  return (
    <details
      data-ac-technical=""
      className="mt-1.5 rounded border border-dashed border-border bg-canvas px-2 py-1"
    >
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {AC_TECHNICAL_LABEL}
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-ink-muted">
        {text}
      </p>
    </details>
  );
}

/**
 * WHAT A MACHINE SAID, quoted.
 *
 * Separated from the plain-language reason above it on purpose. That is the
 * page speaking to the reader; this is evidence, and it is labelled with WHO
 * produced it — "AutoCount replied" and "AutoCount was not asked" are different
 * facts that change what the reader should go and do, and until the rebuild the
 * page could not tell them apart at all. Behind the opener since the rows had
 * to get short, never flattened into one label.
 *
 * It renders the shared layer's AcSaid rather than reading the row itself:
 * whether a note is a sentence worth showing or machinery to fold away is one
 * decision, made once, for both surfaces.
 */
function WhatWasSaid({ said }: { said: AcSaid }) {
  return (
    <div className="mt-2 border-t border-dashed border-border pt-2 text-[12px]">
      <span className="font-semibold uppercase tracking-wide text-ink-muted">{said.label}</span>
      {said.notAsked && <span className="ml-2 text-ink-muted">{AC_NOT_ASKED_NOTE}</span>}
      {said.silent && <span className="ml-2 italic text-ink-muted">Nothing came back with it.</span>}
      {said.said !== null && (
        <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink">
          {said.said}
        </p>
      )}
      {said.technical !== null && <TechnicalNote text={said.technical} />}
    </div>
  );
}

/**
 * A DOCUMENT'S EARLIER SENDS, folded under it.
 *
 * The audit trail, and it is why the page must not simply drop the extra rows:
 * the queue is the record of what the ERP told AutoCount and when. What it is
 * NOT is the list — one document is one line, and its history is one click.
 */
function EarlierSends({ sends, maxAttempts }: { sends: AcOutboxRow[]; maxAttempts: number }) {
  return (
    <div className="border-t border-border bg-canvas px-2.5 py-2">
      <p className="mb-1.5 max-w-[84ch] text-[12px] text-ink-muted">{AC_EARLIER_SENDS_NOTE}</p>
      <ul className="space-y-1">
        {sends.map((s) => (
          <li key={s.id} data-ac-send="" className="flex items-center gap-x-2 text-[11.5px]">
            <StateBadge state={s.state} />
            <span className="min-w-0 flex-1 truncate text-ink-muted">
              {acRowStandsAt(s, maxAttempts)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * ONE DOCUMENT, ONE LINE — and since 2026-08-17 that is one line per DOCUMENT
 * rather than one per send.
 *
 * The card is drawn from `group.current`, the newest send, which is where the
 * document stands. Everything sent before it is behind the second opener.
 *
 * A document already in the account book is that line and nothing else. One with
 * a problem adds a second line — the plain-language headline, which is never
 * hidden — and that line is the button that opens the rest.
 */
function OutboxRowCard(
  { group, maxAttempts, sending, note, open, onToggle, historyOpen, onToggleHistory, onSendAgain, onSendNow }: {
    group: AcDocGroup;
    maxAttempts: number;
    sending: boolean;
    note: AcRequeueNote | undefined;
    open: boolean;
    onToggle: () => void;
    historyOpen: boolean;
    onToggleHistory: () => void;
    onSendAgain: () => void;
    onSendNow: () => void;
  },
) {
  const row = group.current;
  const tone = acStateTone(row.state);
  /* A re-sent document's old refusal is no longer true, and "To fix: change it
     in AutoCount" on a document that has just gone back into the queue is a
     false instruction. Off the row the moment the server accepts it, not on the
     re-read a round trip later. */
  const detail = acRowDetail(row, note?.clearsReason === true);

  return (
    <div
      data-ac-row=""
      className={cn(
        "overflow-hidden rounded-md border border-l-[3px] bg-surface",
        row.needs_attention ? "border-err/40" : "border-border",
        TONE_RAIL[tone],
      )}
    >
      <div className="flex items-center gap-x-2.5 px-2.5 py-1.5">
        <StateBadge state={row.state} />
        <span className="shrink-0 font-mono text-[13px] font-bold tracking-tight text-ink">
          {row.doc_no}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-ink-muted">
          {acRowStandsAt(row, maxAttempts)}
        </span>
        {/* Offered only where the SERVER says a re-send can mean anything
            (`can_requeue`). Everywhere else there is no button rather than a
            button that always answers no. */}
        {row.can_requeue && (
          /* `!h-7 !px-2 !text-[11.5px]`, with the important prefix, because
             Button hardcodes h-9/px-4/text-[13px] and `cn` is a plain join, not
             a Tailwind merge — a bare `h-7` loses to `h-9` on stylesheet order
             and the row silently stays 36 px tall. Measured in perf-lab at
             1440x900 on 2026-08-16: the row goes 77.8 px -> 69.8 px. */
          <Button
            variant="secondary"
            className="!h-7 shrink-0 !px-2 !text-[11.5px]"
            disabled={sending}
            onClick={onSendAgain}
          >
            {sending ? AC_SEND_AGAIN_BUSY_LABEL : AC_SEND_AGAIN_LABEL}
          </Button>
        )}
        {/* THE WAITING ROW'S CONTROL. Offered where the server says the row is
            still queued and has tries left (`can_send_now`) — the owner asked
            for a manual push beside the automatic sync, and until now a waiting
            row had no button at all because a RE-QUEUE of one would duplicate
            the document. This dispatches the row that is already there.

            Never rendered beside Send again: the two server predicates are
            disjoint, so at most one of these blocks is ever true for a row. */}
        {row.can_send_now && (
          <Button
            variant="secondary"
            className="!h-7 shrink-0 !px-2 !text-[11.5px]"
            disabled={sending}
            onClick={onSendNow}
          >
            {sending ? AC_SEND_NOW_BUSY_LABEL : AC_SEND_NOW_LABEL}
          </Button>
        )}
      </div>

      {/* THE REASON, ONE LINE, ALWAYS VISIBLE — and it is the opener. */}
      {detail.line !== null && (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={cn(
            "flex w-full items-center gap-1.5 border-t px-2.5 py-1 text-left text-[12.5px] font-semibold",
            TONE_WHY[tone],
            TONE_TEXT[tone],
          )}
        >
          <ChevronRight
            size={13}
            className={cn("shrink-0 transition-transform", open && "rotate-90")}
          />
          <span className="min-w-0 flex-1 truncate">{detail.line}</span>
        </button>
      )}

      {open && detail.expandable && (
        <div className={cn("border-t px-2.5 py-2", TONE_WHY[tone])}>
          {detail.copy && (
            <>
              <p className="max-w-[84ch] text-[13px] text-ink-muted">{detail.copy.explain}</p>
              <p className="mt-1.5 max-w-[84ch] text-[13px] text-ink">
                <span
                  className={cn(
                    "mr-2 text-[11px] font-bold uppercase tracking-wide",
                    TONE_TEXT[tone],
                  )}
                >
                  To fix
                </span>
                {detail.copy.toFix}
              </p>
            </>
          )}
          {detail.showRequeuedNote && (
            <p className="max-w-[84ch] text-[13px] text-ink-muted">{AC_REPLACED_NOTE}</p>
          )}
          {detail.said && <WhatWasSaid said={detail.said} />}
        </div>
      )}

      {/* THE SEND HISTORY, folded. Only where there IS one — the majority of
          documents were sent once and get no second opener. */}
      {group.earlier.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={onToggleHistory}
            className="flex w-full items-center gap-1.5 border-t border-border px-2.5 py-1 text-left text-[11.5px] font-semibold text-ink-muted"
          >
            <ChevronRight
              size={13}
              className={cn("shrink-0 transition-transform", historyOpen && "rotate-90")}
            />
            {acEarlierSendsHeading(group.earlier.length)}
          </button>
          {historyOpen && <EarlierSends sends={group.earlier} maxAttempts={maxAttempts} />}
        </>
      )}

      {/* The answer to Send again lands HERE, on the row that was pressed —
          accepted, refused or never answered at all. A refusal is the most
          useful of the three and is the one a toast would lose. Never behind
          the opener: nobody presses a button and then goes looking. */}
      {note && (
        <div className={cn("border-t px-2.5 py-2 text-[12.5px]", TONE_WHY[note.tone])}>
          <span className={cn("font-semibold", TONE_TEXT[note.tone])}>{note.text}</span>
          {note.todo && (
            <p className="mt-1 max-w-[84ch] text-ink">
              <span
                className={cn(
                  "mr-2 text-[11px] font-bold uppercase tracking-wide",
                  TONE_TEXT[note.tone],
                )}
              >
                To do
              </span>
              {note.todo}
            </p>
          )}
          {note.quote && (
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink">
              {note.quote}
            </p>
          )}
          {note.quoteTechnical && <TechnicalNote text={note.quoteTechnical} />}
        </div>
      )}
    </div>
  );
}

export function AutoCountSync() {
  const [params, setParams] = useSearchParams();

  /* URL IS STATE (CLAUDE.md). An unknown ?state= falls back to the default
     rather than being passed through — the server refuses it with a 400, and a
     hand-edited URL should not turn this page into an error message. */
  const rawState = params.get("state") ?? AC_DEFAULT_STATE;
  const state: AcFilterState = (AC_FILTER_STATES as readonly string[]).includes(rawState)
    ? (rawState as AcFilterState)
    : AC_DEFAULT_STATE;
  const rawDocType = params.get("docType") ?? "";
  const docType: AcDocType | "" = (AC_DOC_TYPES as readonly string[]).includes(rawDocType)
    ? (rawDocType as AcDocType)
    : "";
  const docNo = params.get("docNo") ?? "";

  /* The type is NOT sent to the server — see AcOutboxFilters. A server already
     narrowed to one type cannot answer "how many of each type", which is the
     whole reason the second strip exists. */
  const filters = useMemo(() => ({ state, docNo }), [state, docNo]);
  const q = useAutoCountOutbox(filters);
  const d = q.data;

  const setFilter = (key: "state" | "docType" | "docNo", value: string) => {
    const next = new URLSearchParams(params);
    /* The DEFAULT is the absent one, so the tidy URL is the one the page opens
       on. Choosing Everything is a decision and stays in the URL as `all`. */
    if (!value || (key === "state" && value === AC_DEFAULT_STATE)) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  /* An accepted re-send changes the queue, so the page re-reads it rather than
     patching the row it already has — the new row is a different row. */
  const reload = q.reload;
  const requeue = useAcRequeue(useCallback(() => { reload(); }, [reload]));
  const expanded = useAcExpandedRows();
  const sendHistory = useAcSendHistory();
  const history = useAcReplacedGroup();

  const headline = acHeadline(d);
  const maxAttempts = d?.meta.max_attempts ?? 6;
  /* ONE ROW PER DOCUMENT. The sends are folded into the document they belong to
     before anything else looks at them, so every count below — and the list
     itself — is about documents. `HC-SO-2608-002` was four of six rows here. */
  const loaded = acGroupByDocument(d?.rows ?? []);
  const typeCounts = acDocTypeCounts(loaded);
  const groups = acGroupsOfType(loaded, docType);
  /* HISTORY IS NOT A TASK LIST. Six of fifteen rows on the live page were
     replaced refusals, two documents appearing twice. They stay reachable —
     folded under the list, and the Replaced chip still shows them as the
     list — but they no longer stand between the reader and a live refusal. The
     counts on the chips are untouched: they are the server's. */
  const split = acSplitReplaced(groups);

  /* The state counts are the SERVER's, exact and whole-company. The type counts
     are of the rows actually loaded — a different kind of number, and the only
     one available, since the endpoint does not group by type. `truncated` is
     what tells the reader the second kind is a page and not a population. */
  const statePills = AC_FILTER_STATES.map((s) => ({
    value: s,
    label: AC_FILTER_STATE_LABEL[s],
    count: acStateCount(d ?? null, s),
  }));

  const typePills = [
    { value: "all" as const, label: "Every type", count: typeCounts.all },
    ...AC_DOC_TYPES.map((t) => ({ value: t, label: acDocTypePlural(t), count: typeCounts[t] })),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="System · AutoCount"
        title="AutoCount Sync"
        description="Every document this company has sent to AutoCount, whether it arrived, and — when it did not — what happened and what to do about it."
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={14} className={q.fetching ? "animate-spin" : undefined} />}
            onClick={() => q.reload()}
          >
            Refresh
          </Button>
        }
      />

      {/* THE ANSWER FIRST. */}
      <div className={cn("rounded-lg border p-3 text-[13px] font-semibold", TONE_BANNER[headline.tone])}>
        {headline.text}
      </div>

      {/* A failure that reaches nobody is worse than a crash — this page exists
          because a state went unseen, so its own load error is stated, not
          swallowed into an empty table. */}
      {q.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          <p className="font-semibold">{AC_LOAD_FAILED_LINE}</p>
          {/* QUOTED, not spliced into the sentence above. Whatever a transport
              layer produced is a machine's words like any other on this page. */}
          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">{q.error}</p>
        </div>
      )}

      {!d && q.loading ? (
        <ListSkeleton rows={4} />
      ) : (
        d && (
          <>
            {/* PINNED, under the page header, whose own height it reads out of
                --page-header-offset rather than guessing at a constant (the
                header publishes it for exactly this). A filter strip you have
                to scroll back up to reach is a filter strip nobody re-uses, and
                the whole point of a windowed thousand-row list is that you are
                a long way down it.

                z-[5] keeps this BELOW the page header (z-10, lg:z-20) — the
                tie that put a page-local strip on top of frozen chrome is
                written up in MfgSalesOrdersListV2. */}
            <div
              className="sticky z-[5] -mx-3 space-y-2 border-b border-border bg-bg px-3 pb-2 pt-1 sm:-mx-4 sm:px-4"
              style={{ top: "var(--page-header-offset, 7rem)" }}
            >
              {/* Both strips are <FilterPills>, the same component the Sales
                  Order list uses for ALL / DRAFT / CONFIRMED. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="w-[74px] shrink-0 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
                  Status
                </span>
                <FilterPills options={statePills} value={state} onChange={(v) => setFilter("state", v)} />
                <input
                  className="ml-auto w-48 rounded-md border border-border bg-canvas px-2 py-1 text-[12px] text-ink"
                  placeholder="Find a document number"
                  aria-label="Find a document number"
                  value={docNo}
                  onChange={(e) => setFilter("docNo", e.target.value)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="w-[74px] shrink-0 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
                  Document
                </span>
                <FilterPills
                  options={typePills}
                  value={docType === "" ? "all" : docType}
                  onChange={(v) => setFilter("docType", v === "all" ? "" : v)}
                />
                <span className="ml-auto text-[12px] text-ink-muted">
                  <span className="font-semibold text-ink">{acListTitle(state, docType)}</span>
                  <span className="mx-2 opacity-50">|</span>
                  <span className="tabular-nums">
                    {q.fetching ? "Loading…" : acListCountLine(groups.length, d.counts.total)}
                  </span>
                </span>
              </div>
            </div>

            {(d.truncated || !d.counts_complete) && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-[12px] text-warning-text">
                {d.truncated && (
                  <p>
                    Only the most recent documents are shown. The status counts above still cover
                    every one; the document-type counts cover what is on screen. Narrow the search
                    to see the rest.
                  </p>
                )}
                {/* A COUNT THAT DID NOT SEE EVERY ROW MUST NOT READ AS A FACT. */}
                {!d.counts_complete && <p>{AC_COUNTS_PARTIAL_LINE}</p>}
              </div>
            )}

            {groups.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface p-8 text-center text-[13px] text-ink-muted">
                {acEmptyLine(d, state)}
              </div>
            ) : split.live.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface p-8 text-center text-[13px] text-ink-muted">
                {AC_ONLY_REPLACED_LINE}
              </div>
            ) : (
              /* WINDOWED. The same component eight mobile screens and DataTable
                 already use, rather than a second mechanism: below its own
                 threshold it renders every row exactly as a plain map did, and
                 above it only the visible slice is in the DOM. */
              <MobileVirtualList
                items={split.live}
                getKey={(g) => g.key}
                gap={6}
                estimateHeight={52}
                ariaLabel={`${split.live.length} loaded documents. Only visible rows are mounted; scroll to browse this loaded set.`}
                renderItem={(g) => (
                  <OutboxRowCard
                    group={g}
                    maxAttempts={maxAttempts}
                    sending={requeue.sendingId === g.current.id}
                    note={requeue.notes[g.current.id]}
                    open={expanded.isOpen(g.current)}
                    onToggle={() => expanded.toggle(g.current)}
                    historyOpen={sendHistory.isOpen(g)}
                    onToggleHistory={() => sendHistory.toggle(g)}
                    onSendAgain={() => void requeue.sendAgain(g.current.id)}
                    onSendNow={() => void requeue.sendNow(g.current.id)}
                  />
                )}
              />
            )}

            {/* THE RECORD, FOLDED. Under the live list, never inside it. The
                rows are not rendered at all until it is opened — a replaced
                document costs nothing to keep and should cost nothing to
                ignore. */}
            {split.replaced.length > 0 && (
              <div className="rounded-lg border border-dashed border-border bg-surface">
                <button
                  type="button"
                  aria-expanded={history.open}
                  onClick={history.toggle}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-semibold text-ink-muted"
                >
                  <ChevronRight
                    size={13}
                    className={cn("shrink-0 transition-transform", history.open && "rotate-90")}
                  />
                  {acReplacedHeading(split.replaced.length)}
                </button>
                {history.open && (
                  <div className="border-t border-border px-3 py-2">
                    <p className="mb-2 max-w-[84ch] text-[12px] text-ink-muted">
                      {AC_REPLACED_GROUP_NOTE}
                    </p>
                    <MobileVirtualList
                      items={split.replaced}
                      getKey={(g) => g.key}
                      gap={6}
                      estimateHeight={52}
                      ariaLabel={`${split.replaced.length} replaced documents, kept as a record.`}
                      renderItem={(g) => (
                        <OutboxRowCard
                          group={g}
                          maxAttempts={maxAttempts}
                          sending={requeue.sendingId === g.current.id}
                          note={requeue.notes[g.current.id]}
                          open={expanded.isOpen(g.current)}
                          onToggle={() => expanded.toggle(g.current)}
                          historyOpen={sendHistory.isOpen(g)}
                          onToggleHistory={() => sendHistory.toggle(g)}
                          onSendAgain={() => void requeue.sendAgain(g.current.id)}
                          onSendNow={() => void requeue.sendNow(g.current.id)}
                        />
                      )}
                    />
                  </div>
                )}
              </div>
            )}

          </>
        )
      )}
    </div>
  );
}

export default AutoCountSync;
