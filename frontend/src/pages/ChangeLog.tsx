// ---------------------------------------------------------------------------
// Change Log — who changed which document since we opened the system to staff.
//
// The owner, 2026-09-08: 「做可以监督到这期间我们打开系统的数据跟之前谁改了东西 谁改了
// 都根据他们改的数据为最高标准 跟着」. He opened sales orders, delivery orders,
// purchase orders and goods receipts to his staff and wants to be able to WATCH
// what they change — and from that moment a person's change in the ERP is the
// highest authority, so the account book follows it rather than correcting it.
//
// THE ORDER OF THE PAGE IS THE ORDER OF HIS QUESTION. Did anybody change
// anything (the verdict), then which documents (the register), then what
// exactly (open the row). The SYSTEM's own automatic changes are counted on the
// verdict line and are one chip away, never mixed into the staff count — that
// mistake has already been made here once, when a check reported "50 staff
// actions on migrated orders" and all fifty were the stock-allocation cron.
//
// PRESENTATION ONLY. Every decision — who is a person, what a verb is called,
// what a window means — is lib/changeLog.ts, shared verbatim with the phone
// twin at mobile/MobileChangeLog.tsx.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { ListSkeleton } from "../components/Skeleton";
import {
  CL_DOC_TYPE_LABEL,
  CL_DOC_TYPES,
  CL_WINDOWS,
  clActionLabel,
  clFieldLabel,
  clMyt,
  clTruncationNote,
  clValueLabel,
  clVerdict,
  clWhoLabel,
  useChangeLog,
  type ChangeLogAuthorFilter,
  type ChangeLogDocType,
  type ChangeLogDocument,
} from "../lib/changeLog";

const AUTHORS: Array<{ value: ChangeLogAuthorFilter; label: string }> = [
  { value: "person", label: "People" },
  { value: "machine", label: "The system" },
  { value: "all", label: "Both" },
];


function DocumentRow({ doc }: { doc: ChangeLogDocument }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-canvas"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="w-[110px] shrink-0 text-[11px] uppercase tracking-brand text-ink-muted">
          {CL_DOC_TYPE_LABEL[doc.docType]}
        </span>
        <span className="w-[170px] shrink-0 font-mono font-semibold text-ink">{doc.docNo}</span>
        <span className="flex-1 truncate text-ink">
          {/* WHO, in front — it is the first half of his question. A document
              only the system touched says so rather than showing an empty
              name, which would read as a change nobody can account for. */}
          {doc.people.length > 0 ? doc.people.join(", ") : "The system only"}
        </span>
        <span className="w-[80px] shrink-0 text-right text-ink-muted">
          {doc.changeCount} change{doc.changeCount === 1 ? "" : "s"}
        </span>
        <span className="w-[190px] shrink-0 text-right text-ink-muted">{clMyt(doc.lastChangeAt)}</span>
      </button>

      {open && (
        <div className="space-y-2 bg-canvas px-3 pb-3 pl-10 pt-1">
          {doc.changes.map((ch) => (
            <div key={ch.id} className="rounded-md border border-border bg-bg p-2 text-[12px]">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-semibold text-ink">{clActionLabel(ch.action)}</span>
                <span className="text-ink">by {clWhoLabel(ch)}</span>
                <span className="text-ink-muted">{clMyt(ch.at)}</span>
                {ch.source && <span className="text-ink-muted">via {ch.source}</span>}
                {ch.author === "machine" && (
                  <span className="rounded bg-canvas px-1.5 py-0.5 text-[11px] text-ink-muted">
                    automatic
                  </span>
                )}
              </div>
              {ch.fields.length === 0 ? (
                /* NOT hidden. A row with no readable diff still records WHO and
                   WHEN, which is most of what this page is for. */
                <p className="mt-1 text-ink-muted">No field-by-field detail was recorded for this change.</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {ch.fields.map((f, i) => (
                    <li key={`${ch.id}-${f.field}-${i}`} className="text-ink">
                      <span className="text-ink-muted">{clFieldLabel(f.field)}:</span>{" "}
                      <span className="line-through decoration-ink-muted/60">{clValueLabel(f.from)}</span>{" "}
                      <span aria-hidden>-&gt;</span>{" "}
                      <span className="font-semibold">{clValueLabel(f.to)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChangeLog() {
  const [params, setParams] = useSearchParams();

  /* URL is state (repo rule), so a filtered view is a link he can keep. */
  const hours = Number(params.get("hours")) || CL_WINDOWS[2].hours;
  const rawAuthor = params.get("author");
  const author: ChangeLogAuthorFilter =
    rawAuthor === "machine" || rawAuthor === "all" ? rawAuthor : "person";
  const rawType = params.get("docType") ?? "all";
  const docType: ChangeLogDocType | "all" =
    (CL_DOC_TYPES as string[]).includes(rawType) ? (rawType as ChangeLogDocType) : "all";

  const filters = useMemo(() => ({ hours, author, docType }), [hours, author, docType]);
  const q = useChangeLog(filters);
  const d = q.data;

  const setFilter = (key: "hours" | "author" | "docType", value: string) => {
    const next = new URLSearchParams(params);
    const isDefault =
      (key === "hours" && Number(value) === CL_WINDOWS[2].hours)
      || (key === "author" && value === "person")
      || (key === "docType" && value === "all");
    if (isDefault) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const truncation = clTruncationNote(d ?? null);

  return (
    <div className="space-y-3 p-3 sm:p-4">
      <PageHeader
        title="Change Log"
        description="Who changed which document, when, and from what to what"
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

      {/* THE ANSWER FIRST, and both numbers in it. */}
      <div className="rounded-lg border border-border bg-canvas p-3 text-[13px] font-semibold text-ink">
        {d ? clVerdict(d) : "Reading the change log..."}
      </div>

      {/* A load failure reaches the reader. An empty table that means "we could
          not read it" is the failure mode this repo has already paid for. */}
      {q.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          <p className="font-semibold">The change log could not be read, so nothing below is complete.</p>
          <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">{q.error}</p>
        </div>
      )}

      {truncation && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-[12px] text-warning-text">
          {truncation}
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-border bg-bg p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="w-[74px] shrink-0 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
            Period
          </span>
          <FilterPills
            options={CL_WINDOWS.map((w) => ({ value: String(w.hours), label: w.label }))}
            value={String(hours)}
            onChange={(v) => setFilter("hours", v)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="w-[74px] shrink-0 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
            Changed by
          </span>
          <FilterPills
            options={AUTHORS.map((a) => ({ value: a.value, label: a.label }))}
            value={author}
            onChange={(v) => setFilter("author", v)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="w-[74px] shrink-0 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
            Document
          </span>
          <FilterPills
            options={[
              { value: "all", label: "Every type" },
              ...CL_DOC_TYPES.map((t) => ({ value: t, label: CL_DOC_TYPE_LABEL[t] })),
            ]}
            value={docType}
            onChange={(v) => setFilter("docType", v)}
          />
        </div>
      </div>

      {!d && q.loading ? (
        <ListSkeleton rows={5} />
      ) : (
        d && (
          <div className="rounded-lg border border-border bg-bg">
            {d.documents.length === 0 ? (
              <p className="p-4 text-[13px] text-ink-muted">
                {author === "person"
                  ? "No person changed a document in this period. The system's own automatic changes are under The system."
                  : "Nothing was changed in this period."}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
                  <span className="w-[14px] shrink-0" />
                  <span className="w-[110px] shrink-0">Type</span>
                  <span className="w-[170px] shrink-0">Document</span>
                  <span className="flex-1">Changed by</span>
                  <span className="w-[80px] shrink-0 text-right">Changes</span>
                  <span className="w-[190px] shrink-0 text-right">Last change</span>
                </div>
                {d.documents.map((doc) => (
                  <DocumentRow key={`${doc.docType}|${doc.docNo}`} doc={doc} />
                ))}
                <p className="px-3 py-2 text-[12px] text-ink-muted">
                  {d.totals.documentsShown} of {d.totals.documents} document(s) on screen.
                </p>
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}

export default ChangeLog;
