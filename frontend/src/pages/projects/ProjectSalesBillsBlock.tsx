/* The sales report a project's chat carries, inside its Sales section (owner
 * 2026-10-14): every bill the evening reports named, whether it is opened as a
 * Sales Order yet, and — the number the owner asked for — how much is still
 * not opened, per event and per salesperson. The red number beside each name
 * under Sales Attending comes from the same read (lib/projectSalesBills.ts).
 * The report is the chat: a message counts when posted and stops counting when
 * voided (components/projectChatSalesReport.tsx), so there is nothing to edit
 * here.
 *
 * Own module: Projects.tsx is at its file-size ceiling.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { QueryState } from "../../hooks/useQuery";
import { cn, formatDate } from "../../lib/utils";
import { billStatusLabel, billsNeedingAction, fmtRmSen, type ProjectSalesBillsResponse } from "../../lib/projectSalesBills";

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
  query,
  finalTotalRm,
  canSetTotalSales,
  onSetTotalSales,
}: {
  query: QueryState<ProjectSalesBillsResponse>;
  /** project_finance.total_sales (RM) — the figure in Total Sales. */
  finalTotalRm: number | null;
  canSetTotalSales: boolean;
  onSetTotalSales: (rm: number) => Promise<void>;
}) {
  const [settingTotal, setSettingTotal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const data = query.data;
  /* Only the bills still to act on: one opened under this event is already in
     the Sales Orders list below (owner 2026-10-14). */
  const bills = billsNeedingAction(data?.bills ?? []);
  const totals = data?.totals;
  const summary = data?.summary ?? null;
  /* The summary's Total line is the event's Total Sales (owner 2026-10-14:
     "this format mention total sales so fill up by this total"). An EMPTY
     Total Sales (none, or 0) is filled from the latest summary in the chat the
     first time someone who may write it opens the event — summaries pasted
     before this existed included. A figure somebody already set is never
     overwritten here: a new summary posted in the chat sets it, or the offer
     below does on one click. */
  const totalEmpty = finalTotalRm == null || finalTotalRm === 0;
  const filledFor = useRef<number | null>(null);
  useEffect(() => {
    if (!canSetTotalSales || summary == null || !totalEmpty) return;
    if (filledFor.current === summary.activity_id) return;
    filledFor.current = summary.activity_id;
    void setTotal(summary.total_sen);
  }, [canSetTotalSales, summary?.activity_id, totalEmpty]);
  const offerTotal =
    canSetTotalSales && summary != null && finalTotalRm != null && finalTotalRm !== 0 && Math.round(finalTotalRm * 100) !== summary.total_sen;
  const daysDiffer = summary != null && summary.days_sen != null && summary.days_sen !== summary.total_sen;

  async function setTotal(sen: number) {
    setSettingTotal(true);
    setActionError(null);
    try {
      await onSetTotalSales(sen / 100);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Could not update Total Sales.");
    } finally {
      setSettingTotal(false);
    }
  }

  return (
    <div className="mb-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-border-subtle bg-bg/30 px-3 py-2 text-[10.5px]">
        <span className="font-semibold uppercase tracking-brand text-ink-secondary">Sales report (chat)</span>
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
          </>
        )}
        {offerTotal && (
          <button
            onClick={() => void setTotal(summary.total_sen)}
            disabled={settingTotal}
            className="rounded-md border border-emerald-600/40 bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-200 disabled:opacity-50"
            title="Type the latest summary's Total from the chat into this event's Total Sales"
          >
            {settingTotal ? "Saving…" : `Set Total Sales = ${fmtRmSen(summary.total_sen)}`}
          </button>
        )}
        {offerTotal && daysDiffer && (
          <span className="text-[10px] font-semibold text-err" title="The summary's day lines do not add up to its Total line">
            its days add up to {fmtRmSen(summary.days_sen)}
          </span>
        )}
      </div>

      {query.loading && !data && <div className="text-[11px] text-ink-muted">Loading sales report…</div>}
      {query.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{query.error}</div>}
      {actionError && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{actionError}</div>}
      {data && totals && totals.count === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-ink-muted">
          No bills found in this event&apos;s chat. The evening report (one bill per line, e.g. 1. HC8993 RM6500 Jason) counts once the Owner, Ummu or Wei Siang posts it in the chat.
        </div>
      )}

      {/* No per-person row here: each rep's not-opened sum sits in red beside
          their name under Sales Attending, and the bills are listed below
          (owner 2026-10-14: a third copy was a duplicate). */}

      {totals && totals.count > 0 && bills.length === 0 && (
        <div className="rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800">
          All {totals.count} bill{totals.count === 1 ? "" : "s"} in the report are opened as Sales Orders under this event — listed below.
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
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => {
                const st = billStatusLabel(b.match);
                return (
                  <tr key={b.key} className="border-t border-border-subtle text-[11.5px] hover:bg-bg/40">
                    <td className="px-2 py-1.5 font-mono text-ink-secondary">{b.report_date ? formatDate(b.report_date) : "—"}</td>
                    <td className="px-2 py-1.5 font-mono">{b.ref_raw}</td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">
                      {fmtRmSen(b.amount_sen)}
                      {b.extra_sen != null && (
                        <span className="ml-1 text-[10px] font-normal text-ink-muted" title="Kept apart from the bill, as the report does; not counted in the amount">
                          + {fmtRmSen(b.extra_sen)}{b.extra_tag ? ` (${b.extra_tag})` : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-[10.5px]">{b.salesperson_name || "—"}</td>
                    <td className="px-2 py-1.5">
                      <span className={cn("inline-flex rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider", TONE[st.tone])}>
                        {st.text}
                      </span>
                      {b.match.so_doc_no && (
                        <Link
                          to={`/scm/sales-orders/${encodeURIComponent(b.match.so_doc_no)}`}
                          className="ml-1.5 font-mono text-[10.5px] font-semibold text-accent underline underline-offset-2 hover:text-accent/80"
                          title="Open this sales order"
                        >
                          {b.match.so_doc_no}
                        </Link>
                      )}
                      {b.other_event_name && (
                        <span className="ml-1.5 text-[10px] text-amber-800">under {b.other_event_name}</span>
                      )}
                    </td>
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
