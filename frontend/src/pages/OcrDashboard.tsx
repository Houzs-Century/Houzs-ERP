import { Link, useSearchParams } from "react-router-dom";
import { ChevronRight, RefreshCw } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { ListSkeleton } from "../components/Skeleton";
import { DataTable, type Column } from "../components/DataTable";
import { TabStrip } from "../components/TabStrip";
import { ResizableDrawer } from "../components/ResizableDrawer";
import { OrderSlipPhoto } from "../vendor/scm/components/OrderSlipPhoto";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { monthLabel } from "./AiUsage";

type DocTypeStats = {
  documentType: string;
  label: string;
  scans: number;
  pending: number;
  failed: number;
  needsReview: number;
  discarded: number;
  awaiting: number;
  clean: number;
  corrected: number;
  imported: number;
  accuracy: { clean: number; reviewed: number } | null;
  fieldAccuracy: { correct: number; total: number; scans: number } | null;
  avgSec: number | null;
  p90Sec: number | null;
};
type FieldChange = { field: string; before: string; after: string };
type ProblemScan = {
  id: string;
  at: string;
  documentType: string;
  docNo: string | null;
  outcome: "failed" | "needsReview" | "corrected";
  detail: string | null;
  changes: FieldChange[] | null;
  fieldAccuracy: { correct: number; total: number } | null;
  slipImageKey: string | null;
};
export type OcrReport = {
  month: string;
  model: string;
  docTypes: DocTypeStats[];
  fieldMisses: { reviewed: number; fields: Array<{ field: string; count: number }> };
  problems: ProblemScan[];
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const MIN_SAMPLE = 5;

export const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;
const secs = (s: number | null) => (s === null ? "—" : `${s.toFixed(1)}s`);
const share = (n: number, d: number) => (d ? <>{pct(n, d)} <span className="text-ink-muted">{n}</span></> : "—");

function thisMonthMyt(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
}

const DOC_COLUMNS: Column<DocTypeStats>[] = [
  { key: "doc", label: "Document", getValue: (r) => r.documentType, render: (r) => <span className="font-semibold text-ink">{r.label}</span> },
  { key: "scans", label: "Scans", align: "right", getValue: (r) => r.scans, render: (r) => r.scans },
  {
    key: "accuracy", label: "Accuracy", align: "right", getValue: (r) => (r.accuracy?.reviewed ? r.accuracy.clean / r.accuracy.reviewed : -1),
    render: (r) =>
      !r.accuracy ? (
        <span className="text-ink-muted" title="Edits to this document are not recorded, so accuracy cannot be measured">not recorded</span>
      ) : r.accuracy.reviewed === 0 ? (
        "—"
      ) : (
        <span className="font-semibold text-ink">
          {pct(r.accuracy.clean, r.accuracy.reviewed)}
          {r.accuracy.reviewed < MIN_SAMPLE ? " *" : ""}{" "}
          <span className="font-normal text-ink-muted">{r.accuracy.clean}/{r.accuracy.reviewed}</span>
        </span>
      ),
  },
  {
    key: "fieldAccuracy", label: "Fields read right", align: "right",
    getValue: (r) => (r.fieldAccuracy?.total ? r.fieldAccuracy.correct / r.fieldAccuracy.total : -1),
    render: (r) =>
      !r.fieldAccuracy ? (
        <span className="text-ink-muted" title="Edits to this document are not recorded, so accuracy cannot be measured">not recorded</span>
      ) : r.fieldAccuracy.total === 0 ? (
        "—"
      ) : (
        <span className="font-semibold text-ink" title={`${r.fieldAccuracy.correct} of ${r.fieldAccuracy.total} fields, over ${plural(r.fieldAccuracy.scans, "reviewed slip")}`}>
          {pct(r.fieldAccuracy.correct, r.fieldAccuracy.total)}
          {r.fieldAccuracy.scans < MIN_SAMPLE ? " *" : ""}{" "}
          <span className="font-normal text-ink-muted">{r.fieldAccuracy.correct}/{r.fieldAccuracy.total}</span>
        </span>
      ),
  },
  {
    key: "failed", label: "Failed", align: "right", getValue: (r) => r.failed,
    render: (r) => <span className={r.failed > 0 ? "font-semibold text-err" : undefined}>{share(r.failed, r.scans)}</span>,
  },
  {
    key: "needsReview", label: "Needs review", align: "right", getValue: (r) => r.needsReview,
    render: (r) => (r.documentType === "SO" ? "—" : <span className={r.needsReview > 0 ? "font-semibold text-warning-text" : undefined}>{share(r.needsReview, r.scans)}</span>),
  },
  { key: "discarded", label: "Discarded", align: "right", getValue: (r) => r.discarded, render: (r) => r.discarded },
  { key: "awaiting", label: "Awaiting review", align: "right", getValue: (r) => r.awaiting, render: (r) => r.awaiting },
  { key: "avg", label: "Avg time", align: "right", getValue: (r) => r.avgSec ?? -1, render: (r) => <span className="font-semibold text-ink">{secs(r.avgSec)}</span> },
  { key: "p90", label: "Slowest 10%", align: "right", getValue: (r) => r.p90Sec ?? -1, render: (r) => secs(r.p90Sec) },
];

const scanTime = (at: string) =>
  new Date(at).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" });

const fieldsRight = ({ fieldAccuracy: fa }: ProblemScan): string =>
  fa?.total ? `${pct(fa.correct, fa.total)} of fields right (${fa.correct}/${fa.total})` : "";

function problemSummary(scan: ProblemScan): string {
  const { outcome, changes, detail } = scan;
  if (outcome !== "corrected") return detail ?? "No reason was recorded";
  if (changes?.length) return [plural(changes.length, "change"), fieldsRight(scan)].filter(Boolean).join(" · ");
  const fields = detail ? detail.split(", ") : [];
  return fields.length ? `${plural(fields.length, "field")} changed: ${detail}` : "Changed, no detail recorded";
}

function ChangeList({ changes }: { changes: FieldChange[] }) {
  return (
    <ul className="divide-y divide-border-subtle">
      {changes.map((change, index) => (
        <li key={`${change.field}-${index}`} className="grid gap-1 py-2 text-[12px] sm:grid-cols-[12rem_1fr]">
          <span className="font-semibold text-ink">{change.field}</span>
          <span className="break-words text-ink">
            <span className="text-ink-muted">{change.before}</span> → {change.after}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ProblemDetail({ scan }: { scan: ProblemScan }) {
  if (scan.changes?.length) return <ChangeList changes={scan.changes} />;
  if (scan.outcome !== "corrected") return <p className="break-words text-[12px] text-ink">{scan.detail ?? "No reason was recorded."}</p>;
  return (
    <p className="text-[12px] text-ink-muted">
      This slip was scanned before the before and after values were kept, so only the changed fields are known: {scan.detail ?? "none recorded"}.
    </p>
  );
}

const salesOrderPath = (docNo: string) => `/scm/sales-orders/${encodeURIComponent(docNo)}`;
const OUTCOME_LABEL: Record<ProblemScan["outcome"], string> = { failed: "Failed", needsReview: "Needs review", corrected: "Corrected" };
const outcomeLabel = (scan: ProblemScan) => OUTCOME_LABEL[scan.outcome];
const sectionTitle = "mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-muted";

function SlipPreviewDrawer({ scan, docNo, onClose }: { scan: ProblemScan; docNo: string; onClose: () => void }) {
  const changeCount = scan.changes?.length ?? 0;
  return (
    <ResizableDrawer
      onClose={onClose}
      storageKey="ocr-slip-preview-drawer"
      defaultWidth={1100}
      minWidth={720}
      maxWidth={1600}
      ariaLabel={`Slip check for ${docNo}`}
      title={docNo}
      subtitle={[outcomeLabel(scan), fieldsRight(scan), `scanned ${scanTime(scan.at)}`].filter(Boolean).join(" · ")}
      headerActions={
        <Link to={salesOrderPath(docNo)} className="rounded-md border border-white/40 px-3 py-1.5 text-[12.5px] font-semibold text-white">
          Open sales order
        </Link>
      }
    >
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-label="Scanned slip">
          <div className={sectionTitle}>Scanned slip</div>
          {scan.slipImageKey ? (
            <OrderSlipPhoto imageKey={scan.slipImageKey} title="Scanned slip" alt={`The scanned slip for ${docNo}`} maxWidth={1200} />
          ) : (
            <p className="text-[12px] text-ink-muted">No slip photo was kept for this scan.</p>
          )}
        </section>
        <section aria-label="What changed" className="lg:sticky lg:top-5 lg:self-start">
          <div className={sectionTitle}>{changeCount ? `What changed · ${plural(changeCount, "change")}` : "What changed"}</div>
          <ProblemDetail scan={scan} />
        </section>
      </div>
    </ResizableDrawer>
  );
}

function ProblemScanCard({ scan, onPreview }: { scan: ProblemScan; onPreview: (scanId: string) => void }) {
  const isFailed = scan.outcome === "failed";
  const hasReason = scan.outcome !== "corrected";
  return (
    <details className="group rounded-lg border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-start gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={16} aria-hidden className="mt-0.5 shrink-0 text-ink-muted transition-transform group-open:rotate-90" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
            <span className={cn("font-semibold", isFailed ? "text-err" : "text-warning-text")}>{outcomeLabel(scan)}</span>
            {!scan.docNo ? (
              <span className="text-ink-muted">none created</span>
            ) : scan.documentType === "SO" ? (
              <button
                type="button"
                onClick={(event) => { event.preventDefault(); onPreview(scan.id); }}
                className="rounded-sm font-semibold text-primary underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              >
                {scan.docNo}
              </button>
            ) : (
              <span className="font-semibold text-ink">{scan.docNo}</span>
            )}
            <span className="ml-auto whitespace-nowrap text-[11.5px] text-ink-muted">{scanTime(scan.at)}</span>
          </div>
          <div className={cn("mt-0.5 text-[12px] text-ink", "group-open:hidden", hasReason && "truncate")}>{problemSummary(scan)}</div>
        </div>
      </summary>
      <div className="border-t border-border-subtle px-3 pb-3 pl-9 pt-1">
        <ProblemDetail scan={scan} />
      </div>
    </details>
  );
}

const card = "rounded-lg border border-border bg-surface px-5 py-5 shadow-stone";
const cardTitle = "mb-1 text-[13px] font-bold text-ink";
const cardNote = "mb-4 text-[11px] text-ink-muted";

const problemTotal = (stats: DocTypeStats) => stats.failed + stats.needsReview + stats.corrected;

function ProblemScansByDocument({ report, selectedType, onSelectType, onPreview }: {
  report: OcrReport;
  selectedType: string | null;
  onSelectType: (documentType: string) => void;
  onPreview: (scanId: string) => void;
}) {
  const fallbackType = report.docTypes.find((stats) => problemTotal(stats) > 0)?.documentType ?? report.docTypes[0]?.documentType;
  const activeType = report.docTypes.some((stats) => stats.documentType === selectedType) ? selectedType : fallbackType;
  const scans = report.problems.filter((scan) => scan.documentType === activeType);
  return (
    <>
      {report.docTypes.length > 1 && activeType && (
        <TabStrip
          value={activeType}
          onChange={onSelectType}
          options={report.docTypes.map((stats) => ({ value: stats.documentType, label: stats.label, count: problemTotal(stats) }))}
        />
      )}
      {scans.length === 0 ? (
        <div className="py-6 text-center text-[12px] text-ink-muted">No problem scans this month.</div>
      ) : (
        <div className="space-y-2">
          {scans.map((scan) => <ProblemScanCard key={scan.id} scan={scan} onPreview={onPreview} />)}
        </div>
      )}
    </>
  );
}

export function OcrDashboard() {
  const [params, setParams] = useSearchParams();
  const month = params.get("month") ?? thisMonthMyt();
  const url = `/api/admin/ocr?month=${month}`;
  const q = useQuery<OcrReport>(url, () => api.get(url));
  const r = q.data;
  const reviewed = r?.fieldMisses.reviewed ?? 0;
  const previewScan = r?.problems.find((scan) => scan.id === params.get("slip"));
  const setPreview = (scanId: string | null) =>
    setParams((p) => { if (scanId) p.set("slip", scanId); else p.delete("slip"); return p; }, { replace: true });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="System · IT"
        title="OCR"
        description="How well the AI read scanned sales slips and supplier documents, for the company you are working in. Read-only."
        actions={
          <div className="flex items-center gap-2">
            <input
              type="month"
              aria-label="Month"
              value={month}
              max={thisMonthMyt()}
              onChange={(e) => e.target.value && setParams((p) => { p.set("month", e.target.value); return p; }, { replace: true })}
              className="h-9 rounded-md border border-border bg-surface px-2 text-[12px] text-ink"
            />
            <Button variant="secondary" icon={<RefreshCw size={14} className={q.loading ? "animate-spin" : undefined} />} onClick={() => q.reload()}>
              Refresh
            </Button>
          </div>
        }
      />

      {q.error && <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">Failed to load the OCR report: {q.error}</div>}

      {!r && q.loading ? (
        <ListSkeleton rows={4} />
      ) : (
        r && (
          <>
            <div className={card}>
              <div className={cardTitle}>Scans by document · {monthLabel(r.month)}</div>
              <div className={cardNote}>
                Every scan this month, including failed ones. Accuracy = sales slips confirmed with no edits, out of those reviewed.
                Fields read right = fields the person did not change, out of every filled field on those slips (a missed or extra line counts each of its fields).
                Both count only slips scanned once the draft was kept as the scan built it (from 17 Nov 2026 afternoon); older slips count the scan's own reformatting as edits.
                Supplier documents: Failed = the read itself broke; Needs review = read, but no document could be made (e.g. no matching PO or goods receipt);
                Awaiting review = waiting in the check queue; Discarded = removed from the check queue.
                * = fewer than {MIN_SAMPLE} reviewed, not enough to judge. Model: {r.model} (the same for every scan; it is not saved per scan).
              </div>
              {r.docTypes.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-ink-muted">No scans this month.</div>
              ) : (
                <DataTable<DocTypeStats> tableId="ocr-doc-types" columns={DOC_COLUMNS} rows={r.docTypes} getRowKey={(d) => d.documentType} />
              )}
            </div>

            <div className={card}>
              <div className={cardTitle}>Where it misses · sales slips</div>
              <div className={cardNote}>Share of the {reviewed} reviewed slips (scanned from 17 Nov 2026 afternoon) where the person confirming the order corrected this field.</div>
              {r.fieldMisses.fields.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-ink-muted">{reviewed ? "No field was corrected this month." : "No sales slip was reviewed this month."}</div>
              ) : (
                <table className="w-full text-[12px]">
                  <tbody>
                    {r.fieldMisses.fields.map((f) => (
                      <tr key={f.field} className="border-t border-border">
                        <td className="py-2 font-semibold text-ink">{f.field}</td>
                        <td className="w-1/2 py-2">
                          <div className="h-2 rounded-full bg-primary/10">
                            <div className="h-2 rounded-full bg-primary" style={{ width: `${(f.count / reviewed) * 100}%` }} />
                          </div>
                        </td>
                        <td className="w-28 py-2 text-right font-semibold text-ink">
                          {pct(f.count, reviewed)} <span className="font-normal text-ink-muted">{f.count}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className={card}>
              <div className={cardTitle}>Recent problem scans</div>
              <div className={cardNote}>
                The latest failed, needs-review or corrected scans. Tap a scan to see what changed. Tap the order number to see the slip beside the changes and judge whether it was the photo or the AI.
                Failed scans someone cleared with "Clear failed" are gone and not counted.
              </div>
              <ProblemScansByDocument
                report={r}
                selectedType={params.get("problems")}
                onSelectType={(documentType) => setParams((p) => { p.set("problems", documentType); return p; }, { replace: true })}
                onPreview={setPreview}
              />
            </div>
          </>
        )
      )}

      {previewScan?.docNo && <SlipPreviewDrawer scan={previewScan} docNo={previewScan.docNo} onClose={() => setPreview(null)} />}
    </div>
  );
}
