// ---------------------------------------------------------------------------
// OCR — how well the AI read scanned documents this month, for the active
// company. IT pages only (ItPagesGuard + the server's requireItPages). Every
// number comes from GET /api/admin/ocr; the page only lays it out. Desktop only.
// ---------------------------------------------------------------------------
import { Link, useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { ListSkeleton } from "../components/Skeleton";
import { DataTable, type Column } from "../components/DataTable";
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
  discarded: number;
  awaiting: number;
  clean: number;
  corrected: number;
  imported: number;
  accuracy: { clean: number; reviewed: number } | null;
  avgSec: number | null;
  p90Sec: number | null;
};
type ProblemScan = {
  id: string;
  at: string;
  documentType: string;
  docNo: string | null;
  outcome: "failed" | "corrected";
  detail: string | null;
};
export type OcrReport = {
  month: string;
  model: string;
  docTypes: DocTypeStats[];
  fieldMisses: { reviewed: number; fields: Array<{ field: string; count: number }> };
  problems: ProblemScan[];
};

/** Fewer reviewed scans than this is not enough to judge. */
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
    key: "failed", label: "Failed", align: "right", getValue: (r) => r.failed,
    render: (r) => <span className={r.failed > 0 ? "font-semibold text-err" : undefined}>{share(r.failed, r.scans)}</span>,
  },
  { key: "discarded", label: "Discarded", align: "right", getValue: (r) => r.discarded, render: (r) => (r.documentType === "SO" ? r.discarded : "—") },
  { key: "awaiting", label: "Awaiting review", align: "right", getValue: (r) => r.awaiting, render: (r) => (r.documentType === "SO" ? r.awaiting : "—") },
  { key: "avg", label: "Avg time", align: "right", getValue: (r) => r.avgSec ?? -1, render: (r) => <span className="font-semibold text-ink">{secs(r.avgSec)}</span> },
  { key: "p90", label: "Slowest 10%", align: "right", getValue: (r) => r.p90Sec ?? -1, render: (r) => secs(r.p90Sec) },
];

const problemColumns = (docLabel: (t: string) => string): Column<ProblemScan>[] => [
  {
    key: "at", label: "When", getValue: (r) => r.at,
    render: (r) => <span className="whitespace-nowrap text-ink-muted">{new Date(r.at).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" })}</span>,
  },
  { key: "doc", label: "Document", getValue: (r) => r.documentType, render: (r) => docLabel(r.documentType) },
  {
    key: "docNo", label: "Doc no", getValue: (r) => r.docNo ?? "",
    render: (r) =>
      !r.docNo ? (
        <span className="text-ink-muted">none created</span>
      ) : r.documentType === "SO" ? (
        <Link to={`/scm/sales-orders/${encodeURIComponent(r.docNo)}`} className="text-primary underline">{r.docNo}</Link>
      ) : (
        r.docNo
      ),
  },
  {
    key: "outcome", label: "Outcome", getValue: (r) => r.outcome,
    render: (r) => <span className={cn("font-semibold", r.outcome === "failed" ? "text-err" : "text-warning-text")}>{r.outcome === "failed" ? "Failed" : "Corrected"}</span>,
  },
  { key: "detail", label: "Detail", getValue: (r) => r.detail ?? "", render: (r) => <span className="text-[11.5px] text-ink">{r.detail ?? "—"}</span> },
];

const card = "rounded-lg border border-border bg-surface px-5 py-5 shadow-stone";
const cardTitle = "mb-1 text-[13px] font-bold text-ink";
const cardNote = "mb-4 text-[11px] text-ink-muted";

export function OcrDashboard() {
  const [params, setParams] = useSearchParams();
  const month = params.get("month") ?? thisMonthMyt();
  const url = `/api/admin/ocr?month=${month}`;
  const q = useQuery<OcrReport>(url, () => api.get(url));
  const r = q.data;
  const reviewed = r?.fieldMisses.reviewed ?? 0;
  const labels = new Map(r?.docTypes.map((d) => [d.documentType, d.label]));
  const docLabel = (t: string) => labels.get(t) ?? t;

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
              <div className={cardNote}>Share of the {reviewed} reviewed slips where the person confirming the order corrected this field.</div>
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
                The latest failed or corrected scans. Open the sales order to see the slip photo and judge whether it was the photo or the AI.
                Failed scans someone cleared with "Clear failed" are gone and not counted.
              </div>
              {r.problems.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-ink-muted">No problem scans this month.</div>
              ) : (
                <DataTable<ProblemScan> tableId="ocr-problems" columns={problemColumns(docLabel)} rows={r.problems} getRowKey={(p) => p.id} />
              )}
            </div>
          </>
        )
      )}
    </div>
  );
}
