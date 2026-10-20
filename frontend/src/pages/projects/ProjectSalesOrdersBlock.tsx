/* The Sales Orders written at this exhibition, inside the project's Sales
 * section (owner 2026-10-13). An order opened in the SO module carries the
 * fair it was written at (`scm.mfg_sales_orders.project_id`); until now the
 * section listed only the project's own sales-entry drafts, so an event with
 * sixty orders keyed in still read "No sales drafted yet" and its Total was
 * the lump sum typed into Total Sales. This block lists those orders and sets
 * their sum against that lump sum, so the office can see per event how much
 * is still on paper slips.
 *
 * Own module: Projects.tsx is at its file-size ceiling. The hook is exported
 * separately so the section can put the order count in its title.
 */
import { Link } from "react-router-dom";
import { markWorkspaceOpenIntent } from "../../lib/workspaceTabs";
import { api } from "../../api/client";
import { useQuery, type QueryState } from "../../hooks/useQuery";
import { cn, formatCurrency, formatDate } from "../../lib/utils";
import { fmtSen } from "../../vendor/shared/format";
import { formatPhone } from "../../vendor/shared/phone";
import {
  normalizeProjectSalesOrders,
  soStatusLabel,
  summarizeProjectSalesOrders,
  type ProjectSalesOrdersResponse,
  type ProjectSalesOrdersSummary,
} from "./projectSalesOrders";

export function useProjectSalesOrders(
  projectId: number,
  enabled: boolean,
): QueryState<ProjectSalesOrdersResponse> {
  return useQuery<ProjectSalesOrdersResponse>(
    "/api/project-sales-orders/:",
    () => api.get<unknown>(`/api/project-sales-orders/${projectId}`).then(normalizeProjectSalesOrders),
    [projectId],
    { enabled },
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</span>
      <span className={cn("text-[12.5px] font-medium leading-none", accent ? "text-accent" : "text-ink")}>{value}</span>
    </div>
  );
}

/* The one sentence the owner asked for: how much of the final total is still
 * not opened as an order. Signed — a negative gap means the orders already
 * exceed the typed total, which is worth seeing rather than clamping away. */
function GapPill({ s }: { s: ProjectSalesOrdersSummary }) {
  if (s.notOpenedRm == null) return null;
  const pct = s.notOpenedPct != null ? ` (${Math.abs(s.notOpenedPct)}%)` : "";
  if (s.notOpenedRm > 0) {
    return (
      <span
        className="rounded border border-amber-500/40 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
        title="Final total minus the sales orders opened so far — the amount still not keyed into the SO module"
      >
        Not yet opened {formatCurrency(s.notOpenedRm)}{pct}
      </span>
    );
  }
  if (s.notOpenedRm < 0) {
    return (
      <span
        className="rounded border border-sky-500/40 bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800"
        title="The sales orders opened add up to more than the final total typed for this event"
      >
        Orders exceed final total by {formatCurrency(-s.notOpenedRm)}{pct}
      </span>
    );
  }
  return (
    <span className="rounded border border-emerald-600/40 bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
      Opened orders match the final total
    </span>
  );
}

export function ProjectSalesOrdersBlock({
  query,
  finalTotalRm,
}: {
  query: QueryState<ProjectSalesOrdersResponse>;
  /** project_finance.total_sales (RM) — the lump sum typed into Total Sales. */
  finalTotalRm: number | null;
}) {
  const rows = query.data?.data ?? [];
  const summary = query.data ? summarizeProjectSalesOrders(query.data.totals, finalTotalRm) : null;

  return (
    <div className="mb-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-border-subtle bg-bg/30 px-3 py-2 text-[10.5px]">
        <span className="font-semibold uppercase tracking-brand text-ink-secondary">Sales orders (SO module)</span>
        {summary && (
          <>
            <Tile label="Opened" value={`${summary.count} · ${formatCurrency(summary.openedRm)}`} accent />
            {/* The same split as the Financial Snapshot's By Sales Orders column
                (owner 2026-10-20), so the two tally. */}
            <Tile label="Sales" value={formatCurrency(summary.salesRm)} />
            <Tile label="Service revenue" value={formatCurrency(summary.serviceRm)} />
            {summary.draftCount > 0 && (
              <span className="rounded-full border border-amber-500/40 bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-800">
                {summary.draftCount} draft
              </span>
            )}
            <Tile label="Paid" value={formatCurrency(summary.paidRm)} />
            <Tile label="Balance" value={formatCurrency(summary.balanceRm)} />
            {summary.finalTotalRm != null && (
              <>
                <Tile label="Final total" value={formatCurrency(summary.finalTotalRm)} />
                <GapPill s={summary} />
              </>
            )}
            {query.data?.scoped && (
              <span
                className="text-[9.5px] italic text-ink-muted"
                title="You see your own and your team's orders; the fair's full total needs a director or view-all account"
              >
                your orders only
              </span>
            )}
          </>
        )}
      </div>

      {query.loading && rows.length === 0 && (
        <div className="text-[11px] text-ink-muted">Loading sales orders…</div>
      )}
      {query.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{query.error}</div>
      )}
      {!query.loading && !query.error && rows.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-ink-muted">
          No sales orders linked to this event were found in the SO module.
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full min-w-[760px]">
            <thead className="bg-bg/60">
              <tr className="text-left font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                <th className="px-2 py-1.5">Date</th>
                <th className="px-2 py-1.5">SO No</th>
                <th className="px-2 py-1.5">Ref No.</th>
                <th className="px-2 py-1.5">Customer</th>
                <th className="px-2 py-1.5 text-right">Amount</th>
                <th className="px-2 py-1.5 text-right">Paid</th>
                <th className="px-2 py-1.5 text-right">Balance</th>
                <th className="px-2 py-1.5">Sales Person</th>
                <th className="px-2 py-1.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isDraft = r.status === "DRAFT";
                return (
                  <tr key={r.doc_no} className="border-t border-border-subtle text-[11.5px] hover:bg-bg/40">
                    <td className="px-2 py-1.5 font-mono text-ink-secondary">{r.so_date ? formatDate(r.so_date) : "—"}</td>
                    <td className="px-2 py-1.5 font-mono text-[10.5px]">
                      <Link
                        to={`/scm/sales-orders/${encodeURIComponent(r.doc_no)}`}
                        // Open the SO in its own workspace tab, keeping the
                        // project open (owner 2026-10-15; see ProjectSalesBillsBlock).
                        onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) markWorkspaceOpenIntent(true); }}
                        className="font-semibold text-accent hover:underline"
                      >
                        {r.doc_no}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10.5px] text-ink-secondary">{r.ref || "—"}</td>
                    <td className="px-2 py-1.5">
                      <div className="font-semibold text-ink">{r.customer_name || "—"}</div>
                      {r.customer_phone && (
                        <div className="font-mono text-[9.5px] text-ink-muted">{formatPhone(r.customer_phone)}</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmtSen(r.amount_sen)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmtSen(r.paid_sen)}</td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right font-mono",
                        r.balance_sen > 0 ? "font-semibold text-amber-700" : "text-ink-muted",
                      )}
                    >
                      {fmtSen(r.balance_sen)}
                    </td>
                    <td className="px-2 py-1.5 text-[10.5px] text-ink-muted">{r.salesperson_name || "—"}</td>
                    <td className="px-2 py-1.5">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider",
                          isDraft ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800",
                        )}
                      >
                        {soStatusLabel(r.status)}
                      </span>
                      {r.venue_differs && (
                        <span title={`Venue on the order: ${r.venue_differs}`} className="ml-1 inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-800">
                          Venue differs
                        </span>
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
