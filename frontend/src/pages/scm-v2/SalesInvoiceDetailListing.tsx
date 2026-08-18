// ----------------------------------------------------------------------------
// SalesInvoiceDetailListing — Task #120 L2 page for Sales Invoices.
// One row per sales_invoice_items line, with the SI header denormalised.
// ----------------------------------------------------------------------------

import { useCallback } from 'react';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { DetailListingShell } from '../../components/scm-v2/DetailListingShell';
import { useSalesInvoiceDetailListing, type DetailListingRow } from '../../vendor/scm/lib/reports-queries';
import type { DataGridColumn } from '../../vendor/scm/components/DataGrid';
import styles from './SalesOrderDetailListing.module.css';

type SiRow = DetailListingRow & {
  invoice_number?: string;
  so_doc_no?: string | null;
  invoice_date?: string | null;
  due_date?: string | null;
  currency?: string;
  total_centi_header?: number;  // header.total_centi after flatten
  paid_centi?: number;
  uom?: string;
  item_group?: string | null;
  description2?: string | null;
  discount_centi?: number;
  tax_centi?: number;
  header_total_centi?: number;
  header_paid_centi?: number;
};

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const c = Number(centi ?? 0);
  return `${currency} ${(c / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const SalesInvoiceDetailListing = () => {
  const buildColumns = useCallback((opts: { checked: Record<string, boolean>; onToggle: (id: string) => void }): DataGridColumn<SiRow>[] => [
    {
      key: 'check', label: 'Check', width: 50, align: 'left', sortable: false, groupable: false,
      accessor: (r) => (
        <input type="checkbox" aria-label={`Toggle ${r.doc_no} / ${r.item_code}`}
          checked={!!opts.checked[r.id]} onChange={() => opts.onToggle(r.id)}
          onClick={(e) => e.stopPropagation()} />
      ),
      searchValue: () => '',
    },
    {
      key: 'doc_no', label: 'Invoice No.', width: 130, sortable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.doc_no}</span>,
      searchValue: (r) => r.doc_no,
    },
    {
      key: 'invoice_date', label: 'Date', width: 100, sortable: true,
      accessor: (r) => fmtDateOrDash((r.invoice_date ?? r.line_date) as string | null),
      searchValue: (r) => String(r.invoice_date ?? r.line_date ?? ''),
      filterType: 'date', dateValue: (r) => (r.invoice_date ?? r.line_date) as string | null,
    },
    {
      key: 'due_date', label: 'Due', width: 100, sortable: true,
      accessor: (r) => fmtDateOrDash(r.due_date ?? null),
      searchValue: (r) => r.due_date ?? '',
      filterType: 'date', dateValue: (r) => r.due_date,
    },
    {
      key: 'so_doc_no', label: 'Transfer From (SO)', width: 110, sortable: true, groupable: true,
      accessor: (r) => r.so_doc_no ?? '—',
      searchValue: (r) => r.so_doc_no ?? '',
    },
    {
      key: 'debtor_code', label: 'Debtor Code', width: 110, sortable: true, groupable: true,
      accessor: (r) => r.debtor_code ?? '—',
      searchValue: (r) => r.debtor_code ?? '',
    },
    {
      key: 'debtor_name', label: 'Customer', width: 200, sortable: true, groupable: true,
      accessor: (r) => r.debtor_name ?? '—',
      searchValue: (r) => r.debtor_name ?? '',
    },
    {
      key: 'item_code', label: 'Item Code', width: 120, sortable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.item_code}</span>,
      searchValue: (r) => r.item_code,
    },
    {
      key: 'description', label: 'Description', width: 240, sortable: true,
      accessor: (r) => (r.description ?? '—') as string,
      searchValue: (r) => r.description ?? '',
    },
    {
      key: 'item_group', label: 'Item Group', width: 110, sortable: true, groupable: true,
      accessor: (r) => r.item_group ?? '—',
      searchValue: (r) => r.item_group ?? '',
    },
    {
      key: 'uom', label: 'UOM', width: 70, sortable: true, groupable: true,
      accessor: (r) => r.uom ?? '—',
      searchValue: (r) => r.uom ?? '',
    },
    {
      key: 'qty', label: 'Qty', width: 70, align: 'right', sortable: true,
      accessor: (r) => String(r.qty ?? 0),
      searchValue: (r) => String(r.qty ?? 0),
      sortFn: (a, b) => Number(a.qty ?? 0) - Number(b.qty ?? 0),
    },
    {
      key: 'unit_price', label: 'Unit Price', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.unit_price_centi, r.currency),
      searchValue: (r) => fmtRm(r.unit_price_centi, r.currency),
      sortFn: (a, b) => Number(a.unit_price_centi ?? 0) - Number(b.unit_price_centi ?? 0),
    },
    {
      key: 'discount', label: 'Discount', width: 100, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.discount_centi, r.currency),
      searchValue: (r) => fmtRm(r.discount_centi, r.currency),
      sortFn: (a, b) => Number(a.discount_centi ?? 0) - Number(b.discount_centi ?? 0),
    },
    {
      key: 'line_total', label: 'Line Total', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.total_centi, r.currency),
      searchValue: (r) => fmtRm(r.total_centi, r.currency),
      sortFn: (a, b) => Number(a.total_centi ?? 0) - Number(b.total_centi ?? 0),
    },
    {
      key: 'header_total', label: 'Invoice Total', width: 130, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.header_total_centi, r.currency),
      searchValue: (r) => fmtRm(r.header_total_centi, r.currency),
      sortFn: (a, b) => Number(a.header_total_centi ?? 0) - Number(b.header_total_centi ?? 0),
    },
    {
      key: 'header_paid', label: 'Paid', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.header_paid_centi, r.currency),
      searchValue: (r) => fmtRm(r.header_paid_centi, r.currency),
      sortFn: (a, b) => Number(a.header_paid_centi ?? 0) - Number(b.header_paid_centi ?? 0),
    },
    {
      key: 'balance', label: 'Balance', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.balance_centi, r.currency),
      searchValue: (r) => fmtRm(r.balance_centi, r.currency),
      sortFn: (a, b) => Number(a.balance_centi ?? 0) - Number(b.balance_centi ?? 0),
    },
    {
      key: 'status', label: 'Status', width: 120, sortable: true, groupable: true,
      accessor: (r) => (r.status ? String(r.status).replace(/_/g, ' ') : '—'),
      searchValue: (r) => r.status ?? '',
    },
  ], []);

  return (
    <DetailListingShell<SiRow>
      title="Sales Invoice Detail Listing"
      storageKey="si-detail-listing-grid"
      docNoPlaceholder="SI-2605-001"
      useDetailQuery={useSalesInvoiceDetailListing}
      buildColumns={buildColumns}
      kpiLabels={{ uniqueDocs: 'Unique Invoices' }}
      hideKpis={{ cost: true, margin: true }}
    />
  );
};
