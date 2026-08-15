// ---------------------------------------------------------------------------
// AutoCount Sync — what the ERP has told the account book, and what came back.
//
// The owner asked for this in these words: "如果它是在排队、skip、planning 还是
// fail 等等，fail 的话是什么原因？everything 都要呈现出来，要不然我就不知道."
// Until now the only reader of scm.autocount_outbox was a GitHub Action whose
// output is a workflow log, which he cannot open.
//
// SO THE ORDER OF THE PAGE IS THE ORDER OF HIS QUESTION: is anything stuck
// (the headline and the tiles), then which documents (the list), then why (the
// reason, in full, on every row).
//
// Presentation only. The state, the reason and the remedy are decided by the
// server (lib/autocountOutbox is the shared layer; the classification itself is
// backend/src/scm/lib/autocount-outbox-status.ts, which the health-check
// workflow also reads). The mobile twin is mobile/MobileAutoCountSync.tsx and
// renders the SAME hook and the SAME words.
//
// READ-ONLY. There is no re-queue button: re-sending is
// requeue-autocount-skipped.yml and it carries a deliberate includeFailed
// opt-in, because a `failed` row WAS sent and the C# create has no duplicate
// guard (#2189).
// ---------------------------------------------------------------------------
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";

import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { StatCard } from "../components/StatCard";
import { ListSkeleton } from "../components/Skeleton";
import { cn } from "../lib/utils";
import { fmtDateTime } from "../vendor/shared/format";
import {
  AC_DOC_TYPES,
  AC_FILTER_STATES,
  acAge,
  acHeadline,
  acOpLabel,
  acStateLabel,
  acStateTone,
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

const STATE_LABEL: Record<AcFilterState, string> = {
  all: "Everything",
  attention: "Needs attention",
  pending: "Queued",
  sent: "In AutoCount",
  failed: "Failed",
  skipped: "Skipped",
  requeued: "Re-queued",
};

function StateBadge({ state }: { state: string }) {
  const tone = acStateTone(state);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        TONE_BADGE[tone],
      )}
    >
      {acStateLabel(state)}
    </span>
  );
}

/**
 * One document, with its reason.
 *
 * The reason is rendered WHOLE and wrapped, never clipped. The health check
 * truncates at 300-400 characters because a workflow annotation has to; a page
 * does not, and the tail of an AutoCount foreign-key message is routinely the
 * half that names the column.
 */
function OutboxRowCard({ row, maxAttempts }: { row: AcOutboxRow; maxAttempts: number }) {
  const tone = acStateTone(row.state);
  return (
    <li
      className={cn(
        "rounded-lg border bg-surface p-3 shadow-stone sm:p-4",
        row.needs_attention ? "border-err/40" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StateBadge state={row.state} />
        <span className="font-display text-[15px] font-bold tracking-tight text-ink">
          {row.doc_no}
        </span>
        <span className="rounded border border-border px-1.5 py-px text-[11px] font-semibold text-ink-muted">
          {row.doc_type}
        </span>
        <span className="text-[12px] text-ink-muted">{acOpLabel(row.op)}</span>
        {row.ac_doc_no && (
          <span className="text-[12px] text-synced">AutoCount {row.ac_doc_no}</span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-ink-muted">
        <span>Queued {fmtDateTime(row.created_at ?? "")}</span>
        {row.state === "pending" && (
          <span className={cn(row.attempts >= maxAttempts - 1 && "text-err")}>
            Waiting {acAge(row.created_at)} · attempt {row.attempts} of {maxAttempts}
          </span>
        )}
        {row.state === "failed" && <span>Gave up after {row.attempts} attempt{row.attempts === 1 ? "" : "s"}</span>}
        {row.sent_at && <span>Sent {fmtDateTime(row.sent_at)}</span>}
      </div>

      {row.reason && (
        <div
          className={cn(
            "mt-2 whitespace-pre-wrap break-words rounded-md border px-3 py-2 text-[12px] leading-relaxed",
            tone === "bad" ? "border-err/30 bg-err/5 text-err" : "border-border bg-canvas text-ink",
          )}
        >
          {row.reason}
        </div>
      )}

      {row.remedy && (
        <div className="mt-2 text-[12px] text-ink">
          <span className="font-semibold">What to do: </span>
          {row.remedy}
        </div>
      )}

      {/* A skip whose wording nothing recognises is a code path that grew a new
          refusal. Saying so is the point — rolling it into a neighbour is how it
          would stay invisible. */}
      {row.reason_kind === "unrecognised" && (
        <div className="mt-2 text-[12px] text-warning-text">
          This refusal is not one the ERP has a named remedy for yet. The message above is
          exactly what it wrote down.
        </div>
      )}

      {row.state === "requeued" && (
        <div className="mt-2 text-[12px] text-ink-muted">
          Already asked again. Its document is queued or sent under a newer row — this is the
          record of the original refusal, not an open item.
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

  const filters = useMemo(() => ({ state, docType, docNo }), [state, docType, docNo]);
  const q = useAutoCountOutbox(filters);
  const d = q.data;

  const setFilter = (key: "state" | "docType" | "docNo", value: string) => {
    const next = new URLSearchParams(params);
    if (!value || (key === "state" && value === "all")) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const headline = acHeadline(d);
  const counts = d?.counts;
  const maxAttempts = d?.meta.max_attempts ?? 6;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="System · AutoCount"
        title="AutoCount Sync"
        description="Every document this company has asked AutoCount to record, what state it is in, and — when it failed or was skipped — exactly why. Read-only: re-sending a refused document is still the re-queue workflow."
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
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatCard
                label="Failed"
                value={counts!.failed}
                subtitle="In the ERP, not in AutoCount"
                tone={counts!.failed > 0 ? "error" : "default"}
                rail="bg-err"
                onClick={() => setFilter("state", state === "failed" ? "all" : "failed")}
                active={state === "failed"}
              />
              <StatCard
                label="Skipped"
                value={counts!.skipped}
                subtitle="Declined on purpose, remedy named"
                tone={counts!.skipped > 0 ? "error" : "default"}
                rail="bg-err"
                onClick={() => setFilter("state", state === "skipped" ? "all" : "skipped")}
                active={state === "skipped"}
              />
              <StatCard
                label="Queued"
                value={counts!.pending}
                subtitle={
                  d.oldest_pending
                    ? `Oldest waiting ${acAge(d.oldest_pending.created_at)}`
                    : "Nothing waiting"
                }
                tone={counts!.pending > 0 ? "warning" : "default"}
                rail="bg-amber-500"
                onClick={() => setFilter("state", state === "pending" ? "all" : "pending")}
                active={state === "pending"}
              />
              <StatCard
                label="In AutoCount"
                value={counts!.sent}
                subtitle="Recorded in the account book"
                tone={counts!.sent > 0 ? "success" : "default"}
                rail="bg-synced"
                onClick={() => setFilter("state", state === "sent" ? "all" : "sent")}
                active={state === "sent"}
              />
              <StatCard
                label="Re-queued"
                value={counts!.requeued}
                subtitle="Refusals already asked again"
                rail="bg-ink-muted"
                onClick={() => setFilter("state", state === "requeued" ? "all" : "requeued")}
                active={state === "requeued"}
              />
            </div>

            {/* The switch is not a detail: it decides what an empty queue MEANS.
                The raw value is shown too, so a typo like 'On ' is visible
                rather than hidden behind the word "off". */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px]">
              <span className="font-semibold text-ink">Write-back switch</span>
              <span className={d.writeback.on ? "text-synced" : "text-ink-muted"}>
                {d.writeback.on ? `ON for ${d.writeback.scope === "all" ? "every company" : `company ${d.writeback.scope}`}` : "OFF"}
              </span>
              <span className="text-ink-muted">
                (scm.autocount_writeback = {d.writeback.value === null ? "row absent" : JSON.stringify(d.writeback.value)})
              </span>
              {d.oldest_pending && (
                <span className="text-ink-muted">
                  · Oldest queued: {d.oldest_pending.doc_type} {d.oldest_pending.doc_no}, {acAge(d.oldest_pending.created_at)}, attempt {d.oldest_pending.attempts} of {maxAttempts}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
                State
                <select
                  className="rounded-md border border-border bg-canvas px-2 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink"
                  value={state}
                  onChange={(e) => setFilter("state", e.target.value)}
                >
                  {AC_FILTER_STATES.map((s) => (
                    <option key={s} value={s}>{STATE_LABEL[s]}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
                Document type
                <select
                  className="rounded-md border border-border bg-canvas px-2 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink"
                  value={docType}
                  onChange={(e) => setFilter("docType", e.target.value)}
                >
                  <option value="">All types</option>
                  {AC_DOC_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
                Document no.
                <input
                  className="rounded-md border border-border bg-canvas px-2 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink"
                  placeholder="HC-SO-2608-001"
                  value={docNo}
                  onChange={(e) => setFilter("docNo", e.target.value)}
                />
              </label>
              <div className="ml-auto text-[12px] text-ink-muted">
                {q.fetching ? "Loading…" : `${d.rows.length} of ${counts!.total} row${counts!.total === 1 ? "" : "s"}`}
              </div>
            </div>

            {d.truncated && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-[12px] text-warning-text">
                Only the most recent rows are shown. The counts above still cover every row.
                Narrow the filters to see the rest.
              </div>
            )}

            {d.rows.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface p-8 text-center text-[13px] text-ink-muted">
                {counts!.total === 0
                  ? "Nothing has ever been queued for AutoCount in this company."
                  : "No document matches these filters."}
              </div>
            ) : (
              <ul className="space-y-2">
                {d.rows.map((r) => (
                  <OutboxRowCard key={r.id} row={r} maxAttempts={maxAttempts} />
                ))}
              </ul>
            )}

            {/* The vocabulary, from the server, so the page holds no second copy
                of it. Five states and each means something different to the
                document, not to the row. */}
            <details className="rounded-lg border border-border bg-surface p-3 text-[12px]">
              <summary className="cursor-pointer font-semibold text-ink">What the states mean</summary>
              <dl className="mt-2 space-y-1.5">
                {Object.entries(d.meta.state_meaning).map(([k, v]) => (
                  <div key={k} className="flex flex-wrap gap-2">
                    <dt className="shrink-0">
                      <StateBadge state={k} />
                    </dt>
                    <dd className="min-w-[16rem] flex-1 text-ink-muted">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-ink-muted">
                A queued row is sent by a job that runs every 5 minutes and gives up after{" "}
                {maxAttempts} attempts, so roughly 30 minutes of the AutoCount host being
                unreachable turns a queued document into a failed one. Re-sending a refused
                document is the re-queue workflow, not a button here.
              </p>
            </details>
          </>
        )
      )}
    </div>
  );
}

export default AutoCountSync;
