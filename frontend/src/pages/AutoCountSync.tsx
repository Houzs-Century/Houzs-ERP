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
// (the reason, in three plain-language parts, on the row itself).
//
// REBUILT 2026-08-16 to the approved mockup. Three things changed and each was
// a complaint, not a preference:
//   - the five counts were TILES, which cannot be acted on. The counts are the
//     point of them, so they moved onto the filter chips, which can.
//   - the reason used to be the ERP's raw message. It is now a headline, a
//     sentence and a "To fix" line, none of them behind a click.
//   - the page printed the outbox's own vocabulary — a config key, raw
//     operation names, raw state names. Every word on screen now comes out of a
//     map in lib/autocountOutbox.
//
// Presentation only. The state, the reason kind and the remedy are decided by
// the server (backend/src/scm/lib/autocount-outbox-status.ts); the words are
// lib/autocountOutbox, keyed by what the server decided. The mobile twin is
// mobile/MobileAutoCountSync.tsx and renders the SAME hook and the SAME words.
//
// STILL READ-ONLY. There is no Send again button: the backend re-queue action
// has not merged, and a control that looks live and is not is the failure the
// owner once reported as "the button does nothing". Re-sending remains
// requeue-autocount-skipped.yml, which carries a deliberate includeFailed
// opt-in because a `failed` row WAS sent and the C# create has no duplicate
// guard (#2189).
// ---------------------------------------------------------------------------
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";

import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { ListSkeleton } from "../components/Skeleton";
import { cn } from "../lib/utils";
import { fmtDateTime } from "../vendor/shared/format";
import {
  AC_DOC_TYPES,
  AC_FILTER_STATES,
  AC_FILTER_STATE_LABEL,
  AC_NOT_ASKED_NOTE,
  AC_REPLY_LABEL,
  AC_STATE_PLAIN_MEANING,
  acAge,
  acDocTypePlural,
  acDocTypeCounts,
  acHeadline,
  acListTitle,
  acReasonCopy,
  acReplySource,
  acRowKind,
  acRowStatusLine,
  acRowsOfType,
  acStateCount,
  acStateLabel,
  acStateTone,
  acWritebackLine,
  useAutoCountOutbox,
  type AcDocType,
  type AcFilterState,
  type AcOutboxRow,
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
 * WHAT A MACHINE SAID, quoted.
 *
 * Separated from the plain-language reason above it on purpose. The three lines
 * above are the page speaking to the reader; this is evidence, and it is
 * labelled with WHO produced it — "AutoCount replied" and "AutoCount was not
 * asked" are different facts that change what the reader should go and do, and
 * until now the page could not tell them apart at all.
 *
 * The ERP's own note stays collapsed. It carries class names and SDK method
 * names, which is the vocabulary the owner asked to have off this screen — but
 * it is still the diagnosis when nobody has plain words for a refusal yet, so
 * it opens by itself in exactly that case.
 */
function WhatWasSaid({ row }: { row: AcOutboxRow }) {
  const source = acReplySource(row.state, row.reason);
  const label = AC_REPLY_LABEL[source];

  if (source === "erp") {
    return (
      <div className="mt-2.5 border-t border-dashed border-border pt-2 text-[12px]">
        <span className="font-semibold uppercase tracking-wide text-ink-muted">{label}</span>
        <span className="ml-2 text-ink-muted">{AC_NOT_ASKED_NOTE}</span>
        {row.reason && (
          <details className="mt-1.5" open={row.reason_kind === "unrecognised"}>
            <summary className="cursor-pointer text-ink-muted">
              Show the exact note the ERP wrote down
            </summary>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink">
              {row.reason}
            </p>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2.5 border-t border-dashed border-border pt-2 text-[12px]">
      <span className="font-semibold uppercase tracking-wide text-ink-muted">{label}</span>
      {row.reason ? (
        <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink">
          {row.reason}
        </p>
      ) : (
        <span className="ml-2 italic text-ink-muted">Nothing came back with it.</span>
      )}
    </div>
  );
}

/**
 * One document, with its reason on the row.
 *
 * The reason is never behind a click and never clipped. The whole job of this
 * screen is to say why a document is not in the account book, and a reason you
 * have to go looking for is a reason nobody reads.
 */
function OutboxRowCard({ row, maxAttempts }: { row: AcOutboxRow; maxAttempts: number }) {
  const tone = acStateTone(row.state);
  const why = acReasonCopy(row.state, row.reason_kind);
  const showSaid = why !== null || (row.reason !== null && row.state !== "sent");

  return (
    <li
      className={cn(
        "overflow-hidden rounded-lg border border-l-[3px] bg-surface shadow-stone",
        row.needs_attention ? "border-err/40" : "border-border",
        TONE_RAIL[tone],
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 sm:p-4">
        <StateBadge state={row.state} />
        <span className="font-mono text-[15px] font-bold tracking-tight text-ink">
          {row.doc_no}
        </span>
        <span className="text-[12.5px] text-ink-muted">{acRowKind(row.doc_type, row.op)}</span>
        <div className="basis-full text-[11.5px] text-ink-muted">
          Queued {fmtDateTime(row.created_at ?? "")}
          <span className="mx-2 opacity-50">|</span>
          {acRowStatusLine(row, maxAttempts)}
          {row.state === "pending" && (
            <>
              <span className="mx-2 opacity-50">|</span>
              <span className={cn(row.attempts >= maxAttempts - 1 && "text-err")}>
                Waiting {acAge(row.created_at)}
              </span>
            </>
          )}
          {row.sent_at && (
            <>
              <span className="mx-2 opacity-50">|</span>
              Arrived {fmtDateTime(row.sent_at)}
            </>
          )}
        </div>
      </div>

      {(why || showSaid) && (
        <div className={cn("border-t px-3 py-3 sm:px-4", TONE_WHY[tone])}>
          {why && (
            <>
              <div className={cn("text-[13.5px] font-bold", TONE_TEXT[tone])}>{why.headline}</div>
              <p className="mt-0.5 max-w-[84ch] text-[13px] text-ink-muted">{why.explain}</p>
              <p className="mt-1.5 max-w-[84ch] text-[13px] text-ink">
                <span
                  className={cn(
                    "mr-2 text-[11px] font-bold uppercase tracking-wide",
                    TONE_TEXT[tone],
                  )}
                >
                  To fix
                </span>
                {why.toFix}
              </p>
            </>
          )}
          {showSaid && <WhatWasSaid row={row} />}
        </div>
      )}

      {row.state === "requeued" && (
        <div className="border-t border-border bg-canvas px-3 py-2 text-[12px] text-ink-muted sm:px-4">
          Already sent again. This row is the record of the first refusal, not something to
          act on — the document is queued or in AutoCount under a newer row.
        </div>
      )}
    </li>
  );
}

export function AutoCountSync() {
  const [params, setParams] = useSearchParams();

  /* URL IS STATE (CLAUDE.md). An unknown ?state= falls back to `all` rather
     than being passed through — the server refuses it with a 400, and a
     hand-edited URL should not turn this page into an error message. */
  const rawState = params.get("state") ?? "all";
  const state: AcFilterState = (AC_FILTER_STATES as readonly string[]).includes(rawState)
    ? (rawState as AcFilterState)
    : "all";
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
    if (!value || (key === "state" && value === "all")) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const headline = acHeadline(d);
  const maxAttempts = d?.meta.max_attempts ?? 6;
  const loaded = d?.rows ?? [];
  const typeCounts = acDocTypeCounts(loaded);
  const rows = acRowsOfType(loaded, docType);

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
    <div className="space-y-5">
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
          The queue could not be read, so nothing below is the current picture: {q.error}
        </div>
      )}

      {!d && q.loading ? (
        <ListSkeleton rows={4} />
      ) : (
        d && (
          <>
            {/* Both strips are <FilterPills>, the same component the Sales Order
                list uses for ALL / DRAFT / CONFIRMED. Chips, not tiles: the
                counts were the only useful thing about the tiles and a tile
                cannot be clicked to mean anything. */}
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="w-[92px] shrink-0 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
                  Status
                </span>
                <FilterPills options={statePills} value={state} onChange={(v) => setFilter("state", v)} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="w-[92px] shrink-0 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
                  Document
                </span>
                <FilterPills
                  options={typePills}
                  value={docType === "" ? "all" : docType}
                  onChange={(v) => setFilter("docType", v === "all" ? "" : v)}
                />
              </div>
            </div>

            {/* The switch is not a detail: it decides what an empty queue MEANS. */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-ink-muted">
              <span className="font-semibold text-ink">{acWritebackLine(d)}</span>
              <span>Sent every five minutes</span>
              <span>
                {d.oldest_pending
                  ? `Oldest still waiting: ${d.oldest_pending.doc_no}, ${acAge(d.oldest_pending.created_at)}`
                  : "Nothing waiting"}
              </span>
              <input
                className="ml-auto w-48 rounded-md border border-border bg-canvas px-2 py-1 text-[12px] text-ink"
                placeholder="Find a document number"
                aria-label="Find a document number"
                value={docNo}
                onChange={(e) => setFilter("docNo", e.target.value)}
              />
            </div>

            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-display text-[17px] font-bold tracking-tight text-ink">
                {acListTitle(state, docType)}
              </h2>
              <span className="text-[12px] tabular-nums text-ink-muted">
                {q.fetching
                  ? "Loading…"
                  : `${rows.length} of ${d.counts.total} document${d.counts.total === 1 ? "" : "s"}`}
              </span>
            </div>

            {d.truncated && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-[12px] text-warning-text">
                Only the most recent documents are shown. The status counts above still cover
                every one; the document-type counts cover what is on screen. Narrow the search
                to see the rest.
              </div>
            )}

            {rows.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface p-8 text-center text-[13px] text-ink-muted">
                {d.counts.total === 0
                  ? "Nothing has ever been queued for AutoCount in this company."
                  : "Nothing here. Try another status or another document type."}
              </div>
            ) : (
              <ul className="space-y-2">
                {rows.map((r) => (
                  <OutboxRowCard key={r.id} row={r} maxAttempts={maxAttempts} />
                ))}
              </ul>
            )}

            {/* The five words on the badges, explained once. Taken from the
                shared layer rather than from meta.state_meaning: the server's
                sentences were written for a workflow log and talk about crons
                and attempt caps. */}
            <details className="rounded-lg border border-border bg-surface p-3 text-[12px]">
              <summary className="cursor-pointer font-semibold text-ink">
                What each of these words means
              </summary>
              <dl className="mt-2 space-y-1.5">
                {Object.entries(AC_STATE_PLAIN_MEANING).map(([k, v]) => (
                  <div key={k} className="flex flex-wrap gap-2">
                    <dt className="shrink-0">
                      <StateBadge state={k} />
                    </dt>
                    <dd className="min-w-[16rem] flex-1 text-ink-muted">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-ink-muted">
                A waiting document is sent every five minutes and gives up after {maxAttempts}{" "}
                tries, so about half an hour of the AutoCount computer being unreachable turns a
                waiting document into one that was not accepted. Sending a refused document again
                is not something this screen can do yet.
              </p>
            </details>
          </>
        )
      )}
    </div>
  );
}

export default AutoCountSync;
