/* The Sales Invoices grid's columns in AutoCount's shape (owner 2026-09-15:
 * "exactly like AutoCount — a default export equals the AutoCount file").
 *
 * Takes the list's own ERP columns and returns the grid's full set: AutoCount's
 * Sales Invoice Detail Listing columns first, in SI_DEFAULT_COLUMN_KEYS order
 * with AutoCount's captions, then every ERP column hidden in the chooser. Money
 * columns export ringgit (exportValue) while the grid keeps sen for sort and
 * funnel. Its own module because SalesInvoicesListV2.tsx sits at the 2,000-line
 * cap. */

import { fmtSen } from "@2990s/shared";
import type { Column } from "../../components/DataTable";
import { cn } from "../../lib/utils";
import { isCancelledDocStatus } from "../../lib/scm";
import { SI_DEFAULT_COLUMN_KEYS, SI_LABELS, senToRinggit, type SiListLine } from "../../vendor/scm/lib/si-list-export";
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

export function siGridColumns<T extends SiColumnRow>(erpColumns: Column<T>[]): Column<T, SiListLine>[] {
  const docNoOf = (r: T): string => r.linked_ac_docno?.trim() || r.invoice_number;
  const totalSenOf = (r: T): number => Number(r.total_sen || r.local_total_sen || 0);
  const moneyCell = (sen: number | null | undefined) => <span className="font-money text-[13px] text-ink">{fmtSen(Number(sen ?? 0))}</span>;
  const blankCol = (key: string, label: string): Column<T, SiListLine> => ({
    key, label, width: "90px", disableSort: true, getValue: () => "", render: () => <span className="text-[12.5px] text-ink-muted">—</span>,
  });
  const acOverrides: Record<string, Partial<Column<T, SiListLine>>> = {
    invoice_number: {
      label: SI_LABELS.docNo,
      getValue: (r) => docNoOf(r),
      render: (r) => (
        <span className={cn("font-docno text-[12.5px] font-semibold text-ink", isCancelledDocStatus(r.status) && "dt-cancel-strike")}>
          {docNoOf(r)}
        </span>
      ),
    },
    invoice_date: { label: SI_LABELS.docDate, exportFormat: "date" },
    debtor_code: { label: SI_LABELS.debtorCode, defaultHidden: false },
    debtor_name: { label: SI_LABELS.debtorName },
    amount: { label: SI_LABELS.total },
  };
  const byKey: Record<string, Column<T, SiListLine>> = {};
  for (const col of erpColumns as Column<T, SiListLine>[]) {
    const ac = acOverrides[col.key] as (typeof acOverrides)[string] | undefined;
    const money = SEN_COLUMN_KEYS.has(col.key) && col.getValue
      ? { exportValue: (r: T) => senToRinggit(Number(col.getValue!(r) ?? 0), 2), exportFormat: "money" as const }
      : {};
    byKey[col.key] = ac ? { ...col, ...money, ...ac } : { ...col, ...money, defaultHidden: true };
  }
  const acHeader: Record<string, Column<T, SiListLine>> = {
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
    erp_doc_no: {
      key: "erp_doc_no", label: SI_LABELS.erpDocNo, width: "156px", disableSort: true, defaultHidden: true,
      getValue: (r) => r.invoice_number,
      render: (r) => <span className="font-docno text-[12.5px] text-ink-secondary">{r.invoice_number}</span>,
    },
  };
  Object.assign(byKey, siLineColumns<T>(), acHeader);
  return [
    ...SI_DEFAULT_COLUMN_KEYS.map((k) => byKey[k]!),
    ...Object.keys(byKey).filter((k) => !(SI_DEFAULT_COLUMN_KEYS as readonly string[]).includes(k)).map((k) => byKey[k]!),
  ];
}
