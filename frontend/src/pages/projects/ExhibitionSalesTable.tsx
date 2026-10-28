import { CheckSquare, Pencil, Send, Trash2, X } from "lucide-react";
import { DataTable, type Column } from "../../components/DataTable";
import { cn, formatCurrency, formatDate } from "../../lib/utils";
import { formatPhone } from "../../vendor/shared/phone";
import {
  STATUS_BADGE as SALES_STATUS_BADGE,
  PAYMENT_TYPE_LABEL,
  type SalesEntry,
  type EntryStatus as SalesEntryStatus,
} from "../Sales";

/* An exhibition's sales on the project page. Lives outside Projects.tsx, which
   sits at its file-size ceiling. */

const depositOf = (e: SalesEntry) => e.deposit_amount ?? e.amount;
const balanceOf = (e: SalesEntry) => Math.max(0, e.amount - depositOf(e));
const salesPersonOf = (e: SalesEntry) =>
  e.sales_person_name || e.sales_person_email || e.created_by_name || e.created_by_email || "—";

export function ExhibitionSalesTable({
  rows, meId, canManage, canLogSale, onEdit, onSubmit, onVoid, onDelete,
}: {
  rows: SalesEntry[];
  meId: number | string | null | undefined;
  canManage: boolean;
  canLogSale: boolean;
  onEdit: (e: SalesEntry) => void;
  onSubmit: (e: SalesEntry) => void;
  onVoid: (e: SalesEntry) => void;
  onDelete: (e: SalesEntry) => void;
}) {
  const columns: Column<SalesEntry>[] = [
    {
      key: "date", label: "Date", getValue: (e) => e.occurred_at, exportFormat: "date",
      render: (e) => <span className="font-mono text-ink-secondary">{formatDate(e.occurred_at)}</span>,
    },
    {
      key: "ref", label: "Ref No.", getValue: (e) => e.ref_no ?? "",
      render: (e) => <span className="font-mono text-[10.5px] text-ink-secondary">{e.ref_no || "—"}</span>,
    },
    {
      key: "customer", label: "Customer", getValue: (e) => e.customer_name,
      render: (e) => (e.customer_name === "(quick log)" ? (
        <div className="flex items-center gap-1.5">
          <span className="rounded-full border border-amber-500/40 bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-800">
            Quick log
          </span>
          {canLogSale && (
            <button onClick={() => onEdit(e)} className="text-[10px] font-semibold text-accent hover:underline">
              Complete
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="font-semibold text-ink">{e.customer_name}</div>
          {e.customer_phone && <div className="font-mono text-[9.5px] text-ink-muted">{formatPhone(e.customer_phone)}</div>}
        </>
      )),
    },
    {
      key: "amount", label: "Amount", align: "right", getValue: (e) => e.amount, exportFormat: "money",
      render: (e) => <span className="font-mono font-semibold">{formatCurrency(e.amount)}</span>,
    },
    {
      key: "deposit", label: "Deposit", align: "right", getValue: depositOf, exportFormat: "money",
      render: (e) => (
        <span className="font-mono">
          <div>{formatCurrency(depositOf(e))}</div>
          {e.deposit_payment_type && <div className="mt-0.5 text-[9px] text-ink-muted">{PAYMENT_TYPE_LABEL[e.deposit_payment_type]}</div>}
        </span>
      ),
    },
    {
      key: "balance", label: "Balance", align: "right", getValue: balanceOf, exportFormat: "money",
      render: (e) => (
        <span
          className={cn("font-mono", balanceOf(e) > 0 ? "font-semibold text-amber-700" : "text-ink-muted")}
          title={balanceOf(e) > 0 ? "Balance to chase post-event" : "Settled in full"}
        >
          {formatCurrency(balanceOf(e))}
        </span>
      ),
    },
    {
      key: "salesPerson", label: "Sales Person", getValue: salesPersonOf,
      render: (e) => <span className="text-[10.5px] text-ink-muted">{salesPersonOf(e)}</span>,
    },
    {
      key: "status", label: "Status", getValue: (e) => SALES_STATUS_BADGE[e.status as SalesEntryStatus].label,
      render: (e) => {
        const badge = SALES_STATUS_BADGE[e.status as SalesEntryStatus];
        return (
          <span className={cn("inline-flex rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider", badge.cls)}>
            {badge.label}
          </span>
        );
      },
    },
    {
      key: "actions", label: "", exportLabel: "Actions",
      render: (e) => {
        const canEdit = canManage || (e.created_by === meId && e.status === "draft");
        return (
          <div className="flex items-center gap-0.5">
            {canEdit && e.status === "draft" && (
              <button onClick={() => onSubmit(e)} className="rounded p-1 text-ink-muted hover:bg-accent-soft hover:text-accent" title="Submit">
                <CheckSquare size={12} />
              </button>
            )}
            {canEdit && (
              <button onClick={() => onEdit(e)} className="rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink" title="Edit">
                <Pencil size={12} />
              </button>
            )}
            {canManage && e.status === "submitted" && (
              <button disabled className="rounded p-1 text-ink-muted opacity-50" title="Push to AutoCount (disabled until integration is enabled)">
                <Send size={12} />
              </button>
            )}
            {canManage && e.status !== "void" && (
              <button onClick={() => onVoid(e)} className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err" title="Void">
                <X size={12} />
              </button>
            )}
            {canEdit && e.status === "draft" && (
              <button onClick={() => onDelete(e)} className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err" title="Delete">
                <Trash2 size={12} />
              </button>
            )}
          </div>
        );
      },
    },
  ];
  return (
    <DataTable<SalesEntry>
      tableId="project-exhibition-sales"
      exportName="exhibition-sales"
      exportXlsx
      columns={columns}
      rows={rows}
      getRowKey={(e) => e.id}
    />
  );
}
