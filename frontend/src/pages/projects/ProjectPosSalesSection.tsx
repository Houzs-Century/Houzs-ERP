/* POS Sales — the Houzs POS bills synced from the booth terminals of one
 * event, inside the project page (layout E9). A Cash & Carry project has no
 * Sales Order module, so this section stands where the Sales section does:
 * header tiles (bills, net total), Export (Excel) and Total Sales (writes the
 * booth's net takings into project_finance.total_sales, the figure the
 * Project List, the dashboard and the Google Sheet sync read), filters, and
 * the bills grouped by receipt with their item rows.
 *
 * Own module: Projects.tsx is at its file-size ceiling. The read, the labels
 * and the export rows live in lib/projectPosSales.ts, shared with the phone.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Download, Plus } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { canWriteProjectFinance } from "../../auth/salesAccess";
import { PanelSection } from "../../components/Panel";
import { useDialog } from "../../hooks/useDialog";
import { useCanViewProjectSales } from "../../hooks/useProjectSalesBills";
import { useProjectPosSales } from "../../hooks/useProjectPosSales";
import type { useToast } from "../../hooks/useToast";
import { cn, formatCurrency, formatDateTime } from "../../lib/utils";
import { fmtSen } from "../../vendor/shared/format";
import {
  EMPTY_POS_FILTER,
  POS_EXPORT_HEADERS,
  buildPosSalesExportRows,
  posMethodLabel,
  posNetRm,
  posReceiptStatusLabel,
  type PosReceipt,
  type PosSalesFilter,
  type ProjectPosSalesResponse,
} from "../../lib/projectPosSales";

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</span>
      <span className={cn("text-[12.5px] font-medium leading-none", accent ? "text-accent" : "text-ink")}>{value}</span>
    </div>
  );
}

const STATUS_PILL: Record<"PAID" | "VOID" | "RETURN", string> = {
  PAID: "bg-emerald-100 text-emerald-800",
  VOID: "bg-rose-100 text-rose-800",
  RETURN: "bg-sky-100 text-sky-800",
};

/** Write the filtered bills as one .xlsx sheet; the library loads lazily so
 *  it never touches the project page's bundle. */
async function exportPosSalesXlsx(res: ProjectPosSalesResponse): Promise<void> {
  const writeXlsxFile = (await import("write-excel-file")).default;
  const header = POS_EXPORT_HEADERS.map((h) => ({ value: h, fontWeight: "bold" as const }));
  const body = buildPosSalesExportRows(res.data).map((row) =>
    row.map((cell) => (typeof cell === "number" ? { value: cell, type: Number } : { value: cell ?? "", type: String })),
  );
  const name = (res.project?.name ?? "project").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
  await writeXlsxFile([header, ...body], {
    fileName: `POS_Sales_${name}.xlsx`,
    columns: POS_EXPORT_HEADERS.map((h) => ({ width: Math.max(10, Math.min(28, h.length + 4)) })),
    stickyRowsCount: 1,
  });
}

const selectCls = "h-6 rounded border border-border bg-surface px-1.5 text-[10.5px] text-ink";

function Filters({
  filter,
  setFilter,
  options,
}: {
  filter: PosSalesFilter;
  setFilter: (f: PosSalesFilter) => void;
  options: ProjectPosSalesResponse["options"];
}) {
  const active = filter.date || filter.terminal || filter.cashier_id != null || filter.method || filter.status;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10.5px]">
      <input
        type="date"
        value={filter.date ?? ""}
        onChange={(e) => setFilter({ ...filter, date: e.target.value || null })}
        className={selectCls}
        aria-label="Date"
      />
      <select value={filter.terminal ?? ""} onChange={(e) => setFilter({ ...filter, terminal: e.target.value || null })} className={selectCls} aria-label="Terminal">
        <option value="">All terminals</option>
        {options.terminals.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select value={filter.cashier_id ?? ""} onChange={(e) => setFilter({ ...filter, cashier_id: e.target.value ? Number(e.target.value) : null })} className={selectCls} aria-label="Cashier">
        <option value="">All cashiers</option>
        {options.cashiers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select value={filter.method ?? ""} onChange={(e) => setFilter({ ...filter, method: e.target.value || null })} className={selectCls} aria-label="Payment method">
        <option value="">All payment methods</option>
        {options.methods.map((m) => <option key={m} value={m}>{posMethodLabel(m)}</option>)}
      </select>
      <select value={filter.status ?? ""} onChange={(e) => setFilter({ ...filter, status: (e.target.value || null) as PosSalesFilter["status"] })} className={selectCls} aria-label="Status">
        <option value="">All statuses</option>
        <option value="PAID">Paid</option>
        <option value="VOID">Void</option>
        <option value="RETURN">Return</option>
      </select>
      {active && (
        <button type="button" onClick={() => setFilter(EMPTY_POS_FILTER)} className="text-[10.5px] font-semibold text-accent hover:underline">
          Clear
        </button>
      )}
    </div>
  );
}

function ReceiptRow({ r, open, onToggle }: { r: PosReceipt; open: boolean; onToggle: () => void }) {
  const status = posReceiptStatusLabel(r);
  const paidBy = r.payments.map((p) => `${posMethodLabel(p.method)} ${fmtSen(p.amount_sen)}`).join(" + ");
  return (
    <>
      <tr className="cursor-pointer border-t border-border-subtle text-[11.5px] hover:bg-bg/40" onClick={onToggle}>
        <td className="px-2 py-1.5 text-ink-muted">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</td>
        <td className="px-2 py-1.5 font-mono text-[10.5px] font-semibold text-accent">{r.receipt_no}</td>
        <td className="px-2 py-1.5 font-mono text-ink-secondary">{formatDateTime(r.sold_at)}</td>
        <td className="px-2 py-1.5 font-mono text-[10.5px] text-ink-secondary">{r.terminal_code}</td>
        <td className="px-2 py-1.5 text-[10.5px]">{r.cashier_name || "—"}</td>
        <td className="px-2 py-1.5 text-[10.5px]">
          {r.salesman_name ? (
            <>
              {r.salesman_name}{" "}
              <span className="rounded border border-violet-500/40 bg-violet-100 px-1 text-[9px] font-semibold text-violet-800" title="Part-timer credited with this bill">PT</span>
            </>
          ) : (
            <span className="text-ink-muted">Booth</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-[10.5px]">{r.customer_name || "—"}</td>
        <td className="px-2 py-1.5 text-[10.5px] text-ink-muted">{paidBy || "—"}</td>
        <td className="px-2 py-1.5">
          <span className={cn("inline-flex rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider", STATUS_PILL[status])}>
            {status}
          </span>
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono font-semibold", status === "VOID" && "text-ink-muted line-through")}>
          {r.type === "RETURN" && status !== "VOID" ? `-${fmtSen(r.total_sen)}` : fmtSen(r.total_sen)}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-border-subtle bg-bg/30">
          <td />
          <td colSpan={9} className="px-2 py-2">
            <table className="w-full">
              <thead>
                <tr className="text-left font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
                  <th className="px-1 py-0.5">Item</th>
                  <th className="px-1 py-0.5 text-right">Qty</th>
                  <th className="px-1 py-0.5 text-right">Unit Price</th>
                  <th className="px-1 py-0.5 text-right">Disc</th>
                  <th className="px-1 py-0.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.line_no} className="text-[11px]">
                    <td className="px-1 py-0.5">
                      <span className="font-mono text-[10px] text-ink-secondary">{l.item_code}</span> {l.description}
                      {l.original_price_sen != null && (
                        <span className="ml-1 text-[9.5px] text-amber-800" title={l.override_reason ?? "Price override"}>
                          (was {fmtSen(l.original_price_sen)})
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono">{l.qty} {l.uom}</td>
                    <td className="px-1 py-0.5 text-right font-mono">{fmtSen(l.unit_price_sen)}</td>
                    <td className={cn("px-1 py-0.5 text-right font-mono", l.disc_label !== "--" && "text-amber-800")}>{l.disc_label}</td>
                    <td className="px-1 py-0.5 text-right font-mono">{fmtSen(l.amount_sen)}</td>
                  </tr>
                ))}
                {r.lines.length === 0 && (
                  <tr><td colSpan={5} className="px-1 py-0.5 text-[10.5px] italic text-ink-muted">No item rows on this bill.</td></tr>
                )}
              </tbody>
            </table>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[10.5px] text-ink-secondary">
              <span>Sub total <b className="font-mono">{fmtSen(r.subtotal_sen)}</b></span>
              <span>Discount <b className="font-mono">{fmtSen(r.item_discount_sen + r.bill_discount_sen)}</b></span>
              <span>SST {r.sst_applied ? `${r.sst_rate}%` : ""} <b className="font-mono">{fmtSen(r.sst_amount_sen)}</b></span>
              {r.rounding_sen !== 0 && <span>Rounding <b className="font-mono">{fmtSen(r.rounding_sen)}</b></span>}
              <span>Total <b className="font-mono">{fmtSen(r.total_sen)}</b></span>
              {r.payments.map((p, i) => (
                <span key={i}>{posMethodLabel(p.method)} <b className="font-mono">{fmtSen(p.amount_sen)}</b>{p.reference ? ` (${p.reference})` : ""}</span>
              ))}
              {status === "VOID" && <span className="text-rose-800">Void: {r.void_reason || "no reason"}{r.void_by ? ` by ${r.void_by}` : ""}</span>}
              {r.customer_phone && <span>Phone {r.customer_phone}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function ProjectPosSalesSection({
  projectId,
  currentTotalSales,
  onTotalSaved,
  toast,
}: {
  projectId: number;
  /** project_finance.total_sales (RM) — what the Total Sales button last wrote. */
  currentTotalSales: number | null;
  onTotalSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const auth = useAuth();
  const dialog = useDialog();
  const { canViewSales } = useCanViewProjectSales();
  const canSetTotalSales = canWriteProjectFinance(auth.user, auth.can);
  const [filter, setFilter] = useState<PosSalesFilter>(EMPTY_POS_FILTER);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState<"export" | "total" | null>(null);
  const query = useProjectPosSales(projectId, filter, canViewSales);

  // Off, not hide: a user who can't see the Sales section neither renders
  // this one nor fires its read. All hooks above run first.
  if (!canViewSales) return null;

  const res = query.data;
  const rows = res?.data ?? [];
  const totals = res?.totals;
  const netRm = totals ? posNetRm(totals) : 0;
  const filtered = filter !== EMPTY_POS_FILTER && (filter.date || filter.terminal || filter.cashier_id != null || filter.method || filter.status);

  async function exportExcel() {
    if (!res) return;
    setBusy("export");
    try {
      await exportPosSalesXlsx(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function setTotalSales() {
    if (!totals) return;
    const ok = await dialog.confirm({
      title: "Set Total Sales from POS",
      message: `Write ${formatCurrency(netRm)} (net POS takings${filtered ? ", filtered view" : ""}: paid bills minus returns) as this project's Total Sales?${currentTotalSales != null ? ` It is ${formatCurrency(currentTotalSales)} now.` : ""}`,
      confirmLabel: "Set Total Sales",
    });
    if (!ok) return;
    setBusy("total");
    try {
      await api.patch(`/api/projects/${projectId}/finance`, { total_sales: netRm });
      toast.success("Total sales updated");
      onTotalSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <PanelSection title={`POS Sales (${totals?.count ?? 0})`}>
      <div className="mb-2 flex flex-col gap-3 rounded-md border border-border-subtle bg-bg/30 px-3 py-2 text-[10.5px] sm:flex-row sm:flex-wrap sm:items-center">
        {totals && (
          <div className="flex flex-wrap items-center gap-3">
            <Tile label="Bills" value={String(totals.paid_count)} />
            <Tile label="Total" value={fmtSen(totals.net_sen)} accent />
            {totals.discount_sen > 0 && <Tile label="Discount" value={fmtSen(totals.discount_sen)} />}
            {totals.return_count > 0 && <Tile label="Returns" value={`${totals.return_count} · ${fmtSen(totals.return_sen)}`} />}
            {totals.void_count > 0 && <Tile label="Void" value={`${totals.void_count} · ${fmtSen(totals.void_sen)}`} />}
            {Object.entries(totals.by_method).map(([m, sen]) => (
              <Tile key={m} label={posMethodLabel(m)} value={fmtSen(sen)} />
            ))}
            {currentTotalSales != null && <Tile label="Project total sales" value={formatCurrency(currentTotalSales)} />}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto sm:flex-nowrap">
          <button
            type="button"
            onClick={exportExcel}
            disabled={!res || rows.length === 0 || busy !== null}
            className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface px-2 text-[10.5px] font-semibold text-ink hover:bg-bg disabled:opacity-50"
            title="Download the bills shown as an Excel workbook, one row per item"
          >
            <Download size={11} /> Export
          </button>
          {canSetTotalSales && (
            <button
              type="button"
              onClick={setTotalSales}
              disabled={!totals || busy !== null}
              className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border border-emerald-600/40 bg-emerald-100 px-2 text-[10.5px] font-semibold text-emerald-800 hover:bg-emerald-200 disabled:opacity-50"
              title="Write the net POS takings as this project's Total Sales (Project List, dashboard and Google Sheet read it)"
            >
              <Plus size={11} /> Total Sales
            </button>
          )}
        </div>
      </div>

      {res && res.all_count > 0 && <Filters filter={filter} setFilter={setFilter} options={res.options} />}

      {query.loading && rows.length === 0 && <div className="text-[11px] text-ink-muted">Loading POS sales…</div>}
      {query.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{query.error}</div>}
      {res && !query.loading && !query.error && rows.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-ink-muted">
          {res.all_count === 0
            ? "No POS sales yet. Bills appear here once a booth terminal syncs."
            : "No bills match these filters."}
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full min-w-[860px]">
            <thead className="bg-bg/60">
              <tr className="text-left font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                <th className="w-6 px-2 py-1.5" />
                <th className="px-2 py-1.5">Receipt</th>
                <th className="px-2 py-1.5">Date / Time</th>
                <th className="px-2 py-1.5">Terminal</th>
                <th className="px-2 py-1.5">Cashier</th>
                <th className="px-2 py-1.5">Salesman</th>
                <th className="px-2 py-1.5">Customer</th>
                <th className="px-2 py-1.5">Paid by</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ReceiptRow key={r.id} r={r} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelSection>
  );
}
