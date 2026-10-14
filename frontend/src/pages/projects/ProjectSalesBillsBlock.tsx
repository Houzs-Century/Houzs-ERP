/* The sales report a project keeps, inside its Sales section (owner
 * 2026-10-14): every bill the evening report named, whether it is opened as a
 * Sales Order yet, and — the number the owner asked for — how much is still
 * not opened, per event and per salesperson. The red number beside each name
 * under Sales Attending comes from the same read (lib/projectSalesBills.ts).
 *
 * Own module: Projects.tsx is at its file-size ceiling.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import type { QueryState } from "../../hooks/useQuery";
import { useInvalidateProjectSalesBills } from "../../hooks/useProjectSalesBills";
import { cn, formatCurrency, formatDate } from "../../lib/utils";
import { billStatusLabel, fmtRmSen, type ProjectSalesBillsResponse } from "../../lib/projectSalesBills";

const TONE: Record<"red" | "green" | "amber" | "grey", string> = {
  red: "bg-err/10 text-err",
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  grey: "bg-bg text-ink-muted",
};

function Tile({ label, value, tone }: { label: string; value: string; tone?: "accent" | "red" }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</span>
      <span className={cn("text-[12.5px] font-medium leading-none", tone === "accent" ? "text-accent" : tone === "red" ? "font-semibold text-err" : "text-ink")}>
        {value}
      </span>
    </div>
  );
}

export function ProjectSalesBillsBlock({
  projectId,
  query,
  finalTotalRm,
  canSetTotalSales,
  onSetTotalSales,
}: {
  projectId: number;
  query: QueryState<ProjectSalesBillsResponse>;
  /** project_finance.total_sales (RM) — the lump sum typed into Total Sales. */
  finalTotalRm: number | null;
  canSetTotalSales: boolean;
  onSetTotalSales: (rm: number) => Promise<void>;
}) {
  const dialog = useDialog();
  const invalidate = useInvalidateProjectSalesBills();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [settingTotal, setSettingTotal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const data = query.data;
  const bills = data?.bills ?? [];
  const totals = data?.totals;
  const reportRm = totals ? totals.amount_sen / 100 : null;
  /* Offer to type the report's sum into Total Sales when they differ — an
     offer, never automatic: Total Sales is the owner's figure. */
  const offerTotal =
    canSetTotalSales && reportRm != null && reportRm > 0 && Math.round((finalTotalRm ?? 0) * 100) !== Math.round(reportRm * 100);

  async function remove(id: number, ref: string) {
    if (!(await dialog.confirm(`Remove ${ref} from this event's sales report?`))) return;
    setBusyId(id);
    setActionError(null);
    try {
      await api.del(`/api/project-sales-bills/${projectId}/${id}`);
      invalidate();
      query.reload();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Could not remove the bill.");
    } finally {
      setBusyId(null);
    }
  }

  async function setTotal() {
    if (reportRm == null) return;
    setSettingTotal(true);
    setActionError(null);
    try {
      await onSetTotalSales(reportRm);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Could not update Total Sales.");
    } finally {
      setSettingTotal(false);
    }
  }

  return (
    <div className="mb-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-border-subtle bg-bg/30 px-3 py-2 text-[10.5px]">
        <span className="font-semibold uppercase tracking-brand text-ink-secondary">Sales report (pasted)</span>
        {totals && totals.count > 0 && (
          <>
            <Tile label="Bills" value={`${totals.count} · ${fmtRmSen(totals.amount_sen)}`} tone="accent" />
            <Tile label="Opened" value={`${totals.opened_count} · ${fmtRmSen(totals.opened_sen)}`} />
            <Tile label="Not opened" value={`${totals.not_opened_count} · ${fmtRmSen(totals.not_opened_sen)}`} tone={totals.not_opened_sen > 0 ? "red" : undefined} />
            {totals.other_event_count > 0 && (
              <span className="rounded border border-amber-500/40 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800" title="These orders exist but are linked to a different event; their salesperson has been asked to amend the fair">
                {totals.other_event_count} under another event
              </span>
            )}
            {offerTotal && (
              <button
                onClick={setTotal}
                disabled={settingTotal}
                className="rounded-md border border-emerald-600/40 bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-200 disabled:opacity-50"
                title="Type the report's sum into this event's Total Sales"
              >
                {settingTotal ? "Saving…" : `Set Total Sales = ${formatCurrency(reportRm)}`}
              </button>
            )}
          </>
        )}
      </div>

      {query.loading && !data && <div className="text-[11px] text-ink-muted">Loading sales report…</div>}
      {query.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{query.error}</div>}
      {actionError && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{actionError}</div>}
      {data && totals && totals.count === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-ink-muted">
          No sales report has been saved for this event. Paste the evening report (one bill per line) into the chat and press Save as sales report.
        </div>
      )}

      {data && data.persons.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {data.persons.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg/60 px-2 py-0.5 text-[11px]" title={`${p.count} bill${p.count === 1 ? "" : "s"} · ${fmtRmSen(p.amount_sen)} · opened ${p.opened_count}`}>
              <span className="font-medium text-ink">{p.name}</span>
              {p.not_opened_sen > 0 ? (
                <span className="font-mono text-[10px] font-semibold text-err">{fmtRmSen(p.not_opened_sen)}</span>
              ) : (
                <span className="font-mono text-[9px] uppercase text-emerald-700">all opened</span>
              )}
            </span>
          ))}
        </div>
      )}

      {bills.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full min-w-[640px]">
            <thead className="bg-bg/60">
              <tr className="text-left font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                <th className="px-2 py-1.5">Date</th>
                <th className="px-2 py-1.5">Ref No.</th>
                <th className="px-2 py-1.5 text-right">Amount</th>
                <th className="px-2 py-1.5">Sales Person</th>
                <th className="px-2 py-1.5">Status</th>
                {data?.can_save && <th className="w-px px-1 py-1.5" />}
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => {
                const st = billStatusLabel(b.match);
                return (
                  <tr key={b.id} className="border-t border-border-subtle text-[11.5px] hover:bg-bg/40">
                    <td className="px-2 py-1.5 font-mono text-ink-secondary">{b.report_date ? formatDate(b.report_date) : "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{b.ref_raw}</td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmtRmSen(b.amount_sen)}</td>
                    <td className="px-2 py-1.5 text-[10.5px]">{b.salesperson_name || "—"}</td>
                    <td className="px-2 py-1.5">
                      <span className={cn("inline-flex rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider", TONE[st.tone])}>
                        {st.text}
                      </span>
                      {b.match.so_doc_no && (
                        <Link to={`/scm/sales-orders/${encodeURIComponent(b.match.so_doc_no)}`} className="ml-1.5 font-mono text-[10px] text-accent hover:underline">
                          {b.match.so_doc_no}
                        </Link>
                      )}
                    </td>
                    {data?.can_save && (
                      <td className="px-1 py-1">
                        <button
                          onClick={() => remove(b.id, b.ref_raw)}
                          disabled={busyId === b.id}
                          className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err disabled:opacity-50"
                          title="Remove this bill from the report"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
