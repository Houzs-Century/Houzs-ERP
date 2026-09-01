// ---------------------------------------------------------------------------
// AutoCount Sync — what the ERP has told the account book, and what came back.
//
// The owner asked for this in these words: "如果它是在排队、skip、planning 还是
// fail 等等，fail 的话是什么原因？everything 都要呈现出来，要不然我就不知道."
// Until it existed the only reader of scm.autocount_outbox was a GitHub Action
// whose output is a workflow log, which he cannot open.
//
// SO THE ORDER OF THE PAGE IS THE ORDER OF HIS QUESTION: is anything stuck (the
// verdict), then which documents (the filter strips and the register), then why
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
// belong to, the newest one draws the row, and the rest are the audit trail,
// one click down. Both chip strips and the "N of M documents" line count
// documents to match.
//
// A REGISTER, NOT A LIST OF CARDS — 2026-08-21. He reviewed a mockup at the real
// size and chose the dense-table direction. Eight columns, every one of them a
// field the payload already carries, so no endpoint changed. What the table buys
// that a card list could not:
//   - **In the book as.** `HC-PO-2608-001` is in AED_HOUZS as `PO-009968` and
//     nobody saw it for three days, because no screen held the ERP's number and
//     the account book's number up against each other. A match is silent; a
//     mismatch is FLAGGED on the row, unclicked, and that is the column that
//     earns the table its keep (docs/modules/autocount-writeback.md §7g).
//   - **What was sent.** A create, a change and a cancellation are three
//     different events on one document and the page could not say which.
//   - **Sends.** One row per document means a document sent four times has to
//     say so; the cell IS the opener for its own history, so the row stays one
//     line either way. Blank at one — the common case adds no ink.
//   - **A day separator** every time the date changes, and a footer saying how
//     much of the company is on screen.
// Four things are deliberately NOT columns and must not be "restored": the try
// count (it reads as a dash on nearly every row and it belongs inside the
// problem row's reason block, where it means something), the reason SENTENCE (a
// paragraph in a cell wrecks the row height for every row), the raw op /
// reason_kind / remedy strings (column names and an SDK primitive — they stay in
// the API and out of the operator's table), and the company (this endpoint is
// already scoped to one, so the column would be identical on every row).
//
// Presentation only. The state, the reason kind and the remedy are decided by
// the server (backend/src/scm/lib/autocount-outbox-status.ts); the words, and
// how much of them is on screen before a click, are lib/autocountOutbox and
// lib/autocountRegister. The mobile twin is mobile/MobileAutoCountSync.tsx: it
// KEEPS its cards, because a table does not fit 375 px, and renders the SAME
// hook, the SAME words and the SAME verdicts.
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
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, RefreshCw } from "lucide-react";

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
  AC_RELINK_LABEL,
  AC_RELINK_BUSY_LABEL,
  AC_SEND_AGAIN_LABEL,
  AC_TECHNICAL_LABEL,
  acDocTypeLabel,
  acDocTypePlural,
  acDocTypeCounts,
  acEarlierSendsHeading,
  acEmptyLine,
  acGroupByDocument,
  acGroupsOfType,
  acHeadline,
  acListCountLine,
  acListTitle,
  acOpLabel,
  acReplacedHeading,
  acRowDetail,
  acRowStandsAt,
  acRowStatusLine,
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
import {
  AC_BOOK_DIFFERENT_FLAG,
  AC_BOOK_NOT_RECORDED_NOTE,
  AC_DATE_RANGES,
  AC_DATE_RANGE_LABEL,
  AC_DEFAULT_DATE_RANGE,
  AC_DEFAULT_SORT,
  AC_NO_VALUE,
  AC_REGISTER_COLUMNS,
  AC_SORTED_BY_LINE,
  AC_SORTS,
  acBookDifferentNote,
  acBookNumber,
  acGroupsInRange,
  acRegisterItems,
  acSendsMark,
  acShowingLine,
  acSortGroups,
  acWhenText,
  type AcBookNumber,
  type AcDateRange,
  type AcRegisterItem,
  type AcSort,
} from "../lib/autocountRegister";

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

/**
 * THE COLUMN WIDTHS, one string, used by the heading row and by every body row.
 *
 * An inline `gridTemplateColumns` rather than a Tailwind arbitrary class, for
 * one reason that matters more than tidiness: the heading and the rows MUST
 * come from the same value. Two class names that happen to agree today are two
 * things to keep in step, and a register whose heading is one column out is
 * worse than no heading at all.
 *
 * Two tracks flex and six are fixed, so a column of document numbers, a column
 * of dates and a column of pills all line up down the page — which is the whole
 * reason for putting them in columns at all. *What was sent* takes slack up to
 * a cap, because past about 320 px the eye has to jump a gap to reach the next
 * cell; the ACTION column takes whatever is left over, which puts the buttons on
 * the right edge where a register keeps them.
 *
 * *In the book as* is the widest fixed track on purpose. It has to hold the
 * account book's number AND the flag beside it without clipping either, on the
 * one row in a thousand where the two numbers disagree — a flag that is cut off
 * is a flag nobody trusts, and every other width here was traded down to buy it.
 *
 * The minimums total 998 px as of 2026-08-21, which is what keeps the register
 * inside the content area of a 1280-wide laptop with no sideways scrollbar. That
 * total is the budget: widening any track means narrowing another.
 */
const AC_COLS = "118px 152px 126px minmax(110px,320px) 236px 60px 108px minmax(88px,1fr)";

/** A register cell: clipped, never wrapped. A cell that wraps is a row that is
 *  suddenly two rows tall, and at three thousand rows that is the whole page. */
function Cell(
  { className, title, children, ...rest }:
  { className?: string; title?: string; children?: React.ReactNode } & Record<string, unknown>,
) {
  return (
    <div className={cn("flex min-w-0 items-center px-2.5", className)} title={title} {...rest}>
      {children}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
        TONE_BADGE[acStateTone(state)],
      )}
    >
      {acStateLabel(state)}
    </span>
  );
}

/**
 * WHAT THE ACCOUNT BOOK ANSWERED WITH — and the one cell allowed to shout.
 *
 * Quiet three ways out of four, which is what makes the fourth readable. The
 * verdict is `acBookNumber`'s, in the shared layer, so the phone flags exactly
 * the same rows; this component only decides how loud the flag looks.
 *
 * The whole sentence is the cell's `title` rather than a second line of text:
 * the row has to stay 36 px tall on three thousand rows, and the flag plus the
 * two numbers beside it already say the thing. The sentence is for the reader
 * who stops on the row and wants it spelled out.
 */
function BookCell({ book, docNo }: { book: AcBookNumber; docNo: string }) {
  if (book.number === null) {
    return (
      <Cell
        className="text-ink-muted"
        title={book.verdict === "not-recorded" ? AC_BOOK_NOT_RECORDED_NOTE : undefined}
      >
        {AC_NO_VALUE}
      </Cell>
    );
  }
  if (!book.flagged) {
    return (
      <Cell className="font-mono text-[12.5px] text-ink-secondary" title={book.number}>
        <span className="truncate">{book.number}</span>
      </Cell>
    );
  }
  return (
    <Cell className="gap-1.5" title={acBookDifferentNote(docNo, book.number)}>
      {/* The NUMBER never truncates — it is the thing the reader has to take to
          AutoCount and look up. The flag is what gives way if the column is
          squeezed, because by then the colour has already done its job. */}
      <span className="shrink-0 font-mono text-[12.5px] font-semibold text-warning-text">
        {book.number}
      </span>
      <span
        data-ac-book-flag=""
        className="flex min-w-0 items-center gap-1 truncate rounded-full border border-amber-500/40 bg-warning-bg px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-warning-text"
      >
        <AlertTriangle size={10} aria-hidden className="shrink-0" />
        {AC_BOOK_DIFFERENT_FLAG}
      </span>
    </Cell>
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
 * NOT is the register — one document is one line, and its history is one click,
 * on the Sends cell that says how many there are.
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
 * ONE DOCUMENT, ONE LINE OF THE REGISTER.
 *
 * The line is drawn from `group.current`, the newest send, which is where the
 * document stands. Everything sent before it is behind the Sends cell.
 *
 * A document already in the account book is that line and nothing else. One
 * with a problem adds a second line — the plain-language headline, which is
 * never hidden — and that line is the button that opens the rest. The try count
 * lives INSIDE that block, where "Tried 3 times, will keep trying up to 6" is a
 * sentence, rather than in a column where it is a dash on every healthy row.
 */
function RegisterRow(
  { group, maxAttempts, sending, note, open, onToggle, historyOpen, onToggleHistory, onSendAgain, onSendNow, onRelink }: {
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
    onRelink: () => void;
  },
) {
  const row = group.current;
  const tone = acStateTone(row.state);
  /* A re-sent document's old refusal is no longer true, and "To fix: change it
     in AutoCount" on a document that has just gone back into the queue is a
     false instruction. Off the row the moment the server accepts it, not on the
     re-read a round trip later. */
  const detail = acRowDetail(row, note?.clearsReason === true);
  const book = acBookNumber(row);
  const sends = acSendsMark(group.sends.length);

  return (
    <div
      data-ac-row=""
      className={cn(
        "border-b border-border-subtle bg-surface hover:bg-primary-soft/30",
        row.needs_attention && "bg-err/[0.03]",
      )}
    >
      <div
        className="grid min-h-[36px] items-center text-[13px]"
        style={{ gridTemplateColumns: AC_COLS }}
      >
        <Cell><StateBadge state={row.state} /></Cell>
        {/* `data-ac-doc` names the cell that holds the ERP's own number. It is
            a contract hook like `data-ac-row`, and it earns its place because
            the register prints a document number TWICE on a healthy row — here
            and, identically, in *In the book as* — so "the element with this
            text" stopped identifying a row the day the fifth column landed. */}
        <Cell
          data-ac-doc=""
          className="font-mono text-[12.5px] font-semibold text-ink"
          title={row.doc_no}
        >
          <span className="truncate">{row.doc_no}</span>
        </Cell>
        <Cell className="text-ink-secondary">
          <span className="truncate">{acDocTypeLabel(row.doc_type)}</span>
        </Cell>
        <Cell className="text-ink-secondary" title={acOpLabel(row.op)}>
          <span className="truncate">{acOpLabel(row.op)}</span>
        </Cell>
        <BookCell book={book} docNo={row.doc_no} />
        {/* THE SENDS CELL IS THE HISTORY OPENER, where there is a history. That
            keeps a document sent four times on ONE line — folding the audit
            trail behind its own row would have added a second line to exactly
            the rows the 2026-08-17 change was about. A document sent once has
            no control here at all. */}
        {group.earlier.length > 0 ? (
          <button
            type="button"
            aria-expanded={historyOpen}
            aria-label={acEarlierSendsHeading(group.earlier.length)}
            onClick={onToggleHistory}
            className="flex min-w-0 items-center justify-end px-2.5 text-[12px] tabular-nums text-primary hover:underline"
          >
            {sends}
          </button>
        ) : (
          <Cell className="justify-end text-[12px] tabular-nums text-ink-muted">{sends}</Cell>
        )}
        <Cell className="text-[12px] tabular-nums text-ink-muted">{acWhenText(row)}</Cell>
        <Cell className="justify-end">
          {/* Offered only where the SERVER says a re-send can mean anything
              (`can_requeue`). Everywhere else there is no button rather than a
              button that always answers no. */}
          {row.can_requeue && (
            /* `!h-7 !px-2 !text-[11.5px]`, with the important prefix, because
               Button hardcodes h-9/px-4/text-[13px] and `cn` is a plain join,
               not a Tailwind merge — a bare `h-7` loses to `h-9` on stylesheet
               order and the row silently grows past its 36 px line. */
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
              for a manual push beside the automatic sync, and until now a
              waiting row had no button at all because a RE-QUEUE of one would
              duplicate the document. This dispatches the row that is there.

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
          {/* THE KEYLESS ROW'S CONTROL, and the only one on this screen that
              SENDS NOTHING. The copy for this refusal has always ended "the
              lines have to be matched up against AutoCount, and then the
              document saved again" — an instruction nobody could carry out.
              This is it: it reads the document out of the account book and
              repairs the ERP's own line identity. Saving the document is still
              what queues a change, which is why the row's refusal stays put. */}
          {row.reason_kind === 'keyless-line' && (
            <Button
              variant="secondary"
              className="!h-7 shrink-0 !px-2 !text-[11.5px]"
              disabled={sending}
              onClick={onRelink}
            >
              {sending ? AC_RELINK_BUSY_LABEL : AC_RELINK_LABEL}
            </Button>
          )}
        </Cell>
      </div>

      {/* THE REASON, ONE LINE, ALWAYS VISIBLE — and it is the opener. */}
      {detail.line !== null && (
        <button
          type="button"
          data-ac-why=""
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
          {/* THE TRY COUNT, HERE AND NOWHERE ELSE. As a column it read as a dash
              on nearly every row; in the problem row's own block it is a
              sentence — "Tried 3 times, will keep trying up to 6" — that says
              whether the queue is still working on this or has given up. */}
          <p className="mt-1.5 text-[12px] text-ink-muted">
            {acRowStatusLine(row, maxAttempts)}
          </p>
          {detail.said && <WhatWasSaid said={detail.said} />}
        </div>
      )}

      {historyOpen && group.earlier.length > 0 && (
        <EarlierSends sends={group.earlier} maxAttempts={maxAttempts} />
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
          {/* WHAT ELSE THIS PRESS MOVED. One press can put three documents into
              the account book — the invoice and both its ancestors — and until
              #0552 the page reported one. An operator who cannot see that a
              sales order was sent on their behalf has no way to know it
              happened, and every one of those is a write to a licensed book. */}
          {note.ancestors.length > 0 && (
            <div className="mt-1.5">
              <p
                className={cn(
                  "text-[11px] font-bold uppercase tracking-wide",
                  TONE_TEXT[note.tone],
                )}
              >
                Sent first
              </p>
              <ul className="mt-0.5 max-w-[84ch] space-y-0.5 text-ink">
                {note.ancestors.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
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

/** The day a run of rows happened on. Cheap and quiet — a rule and six words. */
function DaySeparator({ label }: { label: string }) {
  return (
    <div data-ac-day="" className="flex items-center gap-2 bg-surface px-2.5 pb-1 pt-2">
      <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

/**
 * THE HEADING ROW.
 *
 * Sticky, and it lives inside the same pinned block as the filter strips rather
 * than sticking on its own at a computed offset: two sticky boxes whose offsets
 * are derived separately are two boxes that overlap the first time either one
 * changes height. One box cannot get out of step with itself.
 *
 * *When* is a button because it is the sort. Nothing else is sortable yet — the
 * default order is the one a register is read in, and a column that can be
 * clicked but has no second order is a control that lies.
 *
 * NO `role="table"` / `row` / `columnheader`, deliberately. The rows below are
 * inside `<MobileVirtualList>`, which publishes `role="list"` and `role="listitem"`
 * — declaring a table over the top would put a table's roles and a list's roles
 * in one tree and leave assistive technology reading neither. A half-built ARIA
 * table is worse than an honest strip of labels, which is what this is; the
 * sortable heading is a real `<button>` and carries `aria-sort` itself.
 */
function RegisterHead({ sort, onSort }: { sort: AcSort; onSort: () => void }) {
  return (
    <div
      className="grid h-[30px] items-center rounded-t-lg border-x border-t border-border bg-surface-2 text-[10px] font-bold uppercase tracking-brand text-ink-muted"
      style={{ gridTemplateColumns: AC_COLS }}
    >
      {AC_REGISTER_COLUMNS.map((c) => (
        c.key === "when" ? (
          <button
            key={c.key}
            type="button"
            onClick={onSort}
            aria-sort={sort === "newest" ? "descending" : "ascending"}
            className="flex min-w-0 items-center gap-1 px-2.5 text-left uppercase tracking-brand text-ink-muted hover:text-ink"
          >
            {c.label}
            {sort === "newest"
              ? <ChevronDown size={11} aria-hidden className="shrink-0" />
              : <ChevronUp size={11} aria-hidden className="shrink-0" />}
          </button>
        ) : (
          <Cell key={c.key} className={c.key === "sends" ? "justify-end" : undefined}>
            {c.label}
          </Cell>
        )
      ))}
    </div>
  );
}

export function AutoCountSync() {
  const [params, setParams] = useSearchParams();

  /* URL IS STATE (CLAUDE.md). An unknown ?state= falls back to the default
     rather than being passed through — the server refuses it with a 400, and a
     hand-edited URL should not turn this page into an error message. The same
     rule covers the two register controls, which are client-side lenses: an
     unreadable value is the default, never an empty register. */
  const rawState = params.get("state") ?? AC_DEFAULT_STATE;
  const state: AcFilterState = (AC_FILTER_STATES as readonly string[]).includes(rawState)
    ? (rawState as AcFilterState)
    : AC_DEFAULT_STATE;
  const rawDocType = params.get("docType") ?? "";
  const docType: AcDocType | "" = (AC_DOC_TYPES as readonly string[]).includes(rawDocType)
    ? (rawDocType as AcDocType)
    : "";
  const docNo = params.get("docNo") ?? "";
  const rawRange = params.get("range") ?? AC_DEFAULT_DATE_RANGE;
  const range: AcDateRange = (AC_DATE_RANGES as readonly string[]).includes(rawRange)
    ? (rawRange as AcDateRange)
    : AC_DEFAULT_DATE_RANGE;
  const rawSort = params.get("sort") ?? AC_DEFAULT_SORT;
  const sort: AcSort = (AC_SORTS as readonly string[]).includes(rawSort)
    ? (rawSort as AcSort)
    : AC_DEFAULT_SORT;

  /* The type, the date range and the sort are NOT sent to the server — see
     AcOutboxFilters. A server already narrowed to one type cannot answer "how
     many of each type", which is the whole reason the second strip exists, and
     the same argument covers the date lens. */
  const filters = useMemo(() => ({ state, docNo }), [state, docNo]);
  const q = useAutoCountOutbox(filters);
  const d = q.data;

  const setFilter = (key: "state" | "docType" | "docNo" | "range" | "sort", value: string) => {
    const next = new URLSearchParams(params);
    /* The DEFAULT is the absent one, so the tidy URL is the one the page opens
       on. Choosing Everything is a decision and stays in the URL as `all`. */
    const isDefault = (key === "state" && value === AC_DEFAULT_STATE)
      || (key === "range" && value === AC_DEFAULT_DATE_RANGE)
      || (key === "sort" && value === AC_DEFAULT_SORT);
    if (!value || isDefault) next.delete(key);
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
     before anything else looks at them, so every count below — and the register
     itself — is about documents. `HC-SO-2608-002` was four of six rows here. */
  const loaded = acGroupByDocument(d?.rows ?? []);
  const typeCounts = acDocTypeCounts(loaded);
  /* THE TWO LENSES, IN THIS ORDER, and the order is not arbitrary: the type
     chips count what the STATE filter left, and the date range narrows what
     both of them left. Putting the date first would make the type chips count a
     window rather than the loaded page and the two strips would disagree. */
  const groups = acGroupsInRange(acGroupsOfType(loaded, docType), range);
  /* HISTORY IS NOT A TASK LIST. Six of fifteen rows on the live page were
     replaced refusals, two documents appearing twice. They stay reachable —
     folded under the register — but they no longer stand between the reader and
     a live refusal. The counts on the chips are untouched: they are the
     server's. */
  const split = acSplitReplaced(groups);
  const live = acSortGroups(split.live, sort);
  const items = acRegisterItems(live);

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

  const rangePills = AC_DATE_RANGES.map((r) => ({ value: r, label: AC_DATE_RANGE_LABEL[r] }));

  const renderRow = (g: AcDocGroup) => (
    <RegisterRow
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
      onRelink={() => void requeue.relink(g.current.id, g.current.doc_type, g.current.doc_no)}
    />
  );

  const renderItem = (item: AcRegisterItem) => (
    item.kind === "day" ? <DaySeparator label={item.label} /> : renderRow(item.group)
  );

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

            {/* PINNED, under the page header, whose own height it reads out of
                --page-header-offset rather than guessing at a constant (the
                header publishes it for exactly this). A filter strip you have
                to scroll back up to reach is a filter strip nobody re-uses, and
                the whole point of a windowed thousand-row register is that you
                are a long way down it. The COLUMN HEADING is inside this same
                block, so the two cannot drift apart or overlap.

                z-[5] keeps this BELOW the page header (z-10, lg:z-20) — the
                tie that put a page-local strip on top of frozen chrome is
                written up in MfgSalesOrdersListV2. */}
            <div
              className="sticky z-[5] -mx-3 space-y-2 border-b border-border bg-bg px-3 pb-0 pt-1 sm:-mx-4 sm:px-4"
              style={{ top: "var(--page-header-offset, 7rem)" }}
            >
              {/* All three strips are <FilterPills>, the same component the
                  Sales Order list uses for ALL / DRAFT / CONFIRMED. */}
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
                {/* THE DATE LENS, beside the document chips — a lens on the
                    loaded page, like the type chips and for the same reason.
                    It defaults to All time on purpose: a register that opened
                    on This month would hide a document stuck since July from
                    the one screen whose job is finding it. */}
                <div className="ml-auto flex items-center gap-x-3">
                  <FilterPills
                    options={rangePills}
                    value={range}
                    onChange={(v) => setFilter("range", v)}
                  />
                  <span className="text-[12px] text-ink-muted">
                    <span className="font-semibold text-ink">{acListTitle(state, docType)}</span>
                    <span className="mx-2 opacity-50">|</span>
                    <span className="tabular-nums">
                      {q.fetching ? "Loading…" : acListCountLine(groups.length, d.counts.total)}
                    </span>
                  </span>
                </div>
              </div>

              {groups.length > 0 && split.live.length > 0 && (
                <RegisterHead
                  sort={sort}
                  onSort={() => setFilter("sort", sort === "newest" ? "oldest" : "newest")}
                />
              )}
            </div>

            {groups.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface p-8 text-center text-[13px] text-ink-muted">
                {acEmptyLine(d, state)}
              </div>
            ) : split.live.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface p-8 text-center text-[13px] text-ink-muted">
                {AC_ONLY_REPLACED_LINE}
              </div>
            ) : (
              <div className="-mt-4 overflow-hidden rounded-b-lg border-x border-b border-border bg-surface">
                {/* WINDOWED. The same component eight mobile screens and
                    DataTable already use, rather than a second mechanism: below
                    its own threshold it renders every row exactly as a plain
                    map did, and above it only the visible slice is in the DOM.
                    Day separators are IN the same flat list, so one never
                    scrolls away from the day it introduces. */}
                <MobileVirtualList
                  items={items}
                  getKey={(i) => i.key}
                  gap={0}
                  estimateHeight={36}
                  ariaLabel={`${live.length} loaded documents. Only visible rows are mounted; scroll to browse this loaded set.`}
                  renderItem={renderItem}
                />
                {/* THE LINE THAT CLOSES THE REGISTER. A windowed list draws its
                    scrollbar from estimates, so the scrollbar cannot honestly
                    answer "am I looking at all of it". This can. */}
                <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-muted">
                  <span className="tabular-nums">
                    {acShowingLine(live.length, d.counts.total)}
                  </span>
                  <span>{AC_SORTED_BY_LINE[sort]}</span>
                </div>
              </div>
            )}

            {/* THE RECORD, FOLDED. Under the register, never inside it. The
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
                    <div className="overflow-hidden rounded-md border border-border">
                      <MobileVirtualList
                        items={split.replaced}
                        getKey={(g) => g.key}
                        gap={0}
                        estimateHeight={36}
                        ariaLabel={`${split.replaced.length} replaced documents, kept as a record.`}
                        renderItem={renderRow}
                      />
                    </div>
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
