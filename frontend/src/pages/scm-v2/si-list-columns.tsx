/* The Sales Invoices grid's columns.
 *
 * Owner 2026-09-15 「默认跟我的data grid啊」: a fresh grid shows exactly the
 * list's own columns, unchanged. AutoCount's Sales Invoice Detail Listing
 * columns (SI_AC_COLUMN_KEYS, AutoCount's captions and values, the line columns
 * included) follow in the chooser, hidden. The export writes whatever is
 * visible, one row per line. Money columns export ringgit (exportValue) while
 * the grid keeps sen for sort and funnel. Its own module because
 * SalesInvoicesListV2.tsx sits at the 2,000-line cap. */

import { fmtSen } from "@2990s/shared";
import type { Column } from "../../components/DataTable";
import { cn } from "../../lib/utils";
import { isCancelledDocStatus } from "../../lib/scm";
import { SI_AC_COLUMN_KEYS, SI_LABELS, senToRinggit, type SiListLine } from "../../vendor/scm/lib/si-list-export";
import { siLineColumns } from "./si-list-line-columns";

export type SiColumnRow = {
  id: string;
  invoice_number: string;
  status: string;
  linked_ac_docno?: string | null;
  ac_agent?: string | null;
  currency?: string | null;
  subtotal_sen?: number | null;
  tax_sen?: number | null;
  total_sen?: number | null;
  local_total_sen?: number | null;
  lines?: SiListLine[];
};

/* The list's columns that hold SEN: exported as ringgit. */
const SEN_COLUMN_KEYS = new Set([
  "outstanding", "amount", "so_deposit", "paid",
  "mattress_sofa_sen", "bedframe_sen", "accessories_sen", "others_sen", "service_sen",
  "mattress_sofa_cost_sen", "bedframe_cost_sen", "accessories_cost_sen", "others_cost_sen", "service_cost_sen",
  "total_cost_sen", "total_margin_sen",
]);
const DATE_COLUMN_KEYS = new Set(["invoice_date", "due_date"]);

export function siGridColumns<T extends SiColumnRow>(erpColumns: Column<T>[]): Column<T, SiListLine>[] {
  const docNoOf = (r: T): string => r.linked_ac_docno?.trim() || r.invoice_number;
  const totalSenOf = (r: T): number => Number(r.total_sen || r.local_total_sen || 0);
  const moneyCell = (sen: number | null | undefined) => <span className="font-money text-[13px] text-ink">{fmtSen(Number(sen ?? 0))}</span>;
  const blankCol = (key: string, label: string): Column<T, SiListLine> => ({
    key, label, width: "90px", disableSort: true, getValue: () => "", render: () => <span className="text-[12.5px] text-ink-muted">—</span>,
  });

  const own = (erpColumns as Column<T, SiListLine>[]).map((col): Column<T, SiListLine> => ({
    ...col,
    ...(SEN_COLUMN_KEYS.has(col.key) && col.getValue
      ? { exportValue: (r: T) => senToRinggit(Number(col.getValue!(r) ?? 0), 2), exportFormat: "money" as const }
      : {}),
    ...(DATE_COLUMN_KEYS.has(col.key) ? { exportFormat: "date" as const } : {}),
  }));
  const ownKeys = new Set(own.map((c) => c.key));

  const ac: Record<string, Column<T, SiListLine>> = {
    ac_doc_no: {
      key: "ac_doc_no", label: SI_LABELS.docNo, width: "156px", disableSort: true,
      getValue: (r) => docNoOf(r),
      render: (r) => (
        <span className={cn("font-docno text-[12.5px] font-semibold text-ink", isCancelledDocStatus(r.status) && "dt-cancel-strike")}>
          {docNoOf(r)}
        </span>
      ),
    },
    agent: {
      key: "agent", label: SI_LABELS.agent, width: "140px", disableSort: true,
      getValue: (r) => r.ac_agent ?? "",
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{r.ac_agent || "—"}</span>,
    },
    currency: {
      key: "currency", label: SI_LABELS.currCode, width: "90px", disableSort: true,
      getValue: (r) => r.currency ?? "", render: (r) => <span className="text-[12.5px] text-ink-secondary">{r.currency || "—"}</span>,
    },
    /* A sales invoice here has no exchange rate on its header: ringgit at 1. */
    exchange_rate: {
      key: "exchange_rate", label: SI_LABELS.currRate, width: "90px", disableSort: true, exportFormat: "number",
      getValue: () => 1, render: () => <span className="text-[12.5px] text-ink-secondary">1</span>,
    },
    /* This ERP keeps no tax-inclusive flag on the document: blank, never a guess. */
    inclusive: blankCol("inclusive", SI_LABELS.inclusive),
    subtotal: {
      key: "subtotal", label: SI_LABELS.subTotalEx, width: "128px", align: "right", disableSort: true,
      getValue: (r) => r.subtotal_sen ?? 0, exportValue: (r) => senToRinggit(r.subtotal_sen ?? 0, 2), exportFormat: "money",
      render: (r) => moneyCell(r.subtotal_sen),
    },
    tax: {
      key: "tax", label: SI_LABELS.tax, width: "100px", align: "right", disableSort: true,
      getValue: (r) => r.tax_sen ?? 0, exportValue: (r) => senToRinggit(r.tax_sen ?? 0, 2), exportFormat: "money",
      render: (r) => moneyCell(r.tax_sen),
    },
    local_total: {
      key: "local_total", label: SI_LABELS.localTotal, width: "128px", align: "right", disableSort: true,
      getValue: (r) => totalSenOf(r), exportValue: (r) => senToRinggit(totalSenOf(r), 2), exportFormat: "money",
      render: (r) => moneyCell(totalSenOf(r)),
    },
    cancelled: {
      key: "cancelled", label: SI_LABELS.cancelled, width: "96px", disableSort: true,
      getValue: (r) => isCancelledDocStatus(r.status),
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{isCancelledDocStatus(r.status) ? "Yes" : "No"}</span>,
    },
    ...siLineColumns<T>(),
  };
  const acOrder = (SI_AC_COLUMN_KEYS as readonly string[]).filter((k) => !ownKeys.has(k) && k in ac);
  const extras = Object.keys(ac).filter((k) => !acOrder.includes(k) && !ownKeys.has(k));
  return [...own, ...[...acOrder, ...extras].map((k) => ({ ...ac[k]!, defaultHidden: true }))];
}
