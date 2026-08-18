// ----------------------------------------------------------------------------
// DeliveryReturnDetailListing — Task #120 L2 page for Delivery Returns.
// One row per delivery_return_items line, with the DR header denormalised.
// "Outstanding" here means the return hasn't been settled
// (status is not REFUNDED / CREDIT_NOTED / REJECTED).
// ----------------------------------------------------------------------------

import { useCallback } from 'react';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { DetailListingShell } from '../../components/scm-v2/DetailListingShell';
import { useDeliveryReturnDetailListing, type DetailListingRow } from '../../vendor/scm/lib/reports-queries';
import type { DataGridColumn } from '../../vendor/scm/components/DataGrid';
import styles from './SalesOrderDetailListing.module.css';

type DrRow = DetailListingRow & {
  return_number?: string;
  return_date?: string | null;
  reason?: string | null;
  delivery_order_id?: string | null;
  sales_invoice_id?: string | null;
  received_at?: string | null;
  inspected_at?: string | null;
  refunded_at?: string | null;
  qty_returned?: number;
  condition?: string | null;
  line_refund_sen?: number;
  refund_sen_header?: number;
};

const fmtRm = (centi: number | null | undefined): string => {
  const c = Number(centi ?? 0);
  return `MYR ${(c / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const DeliveryReturnDetailListing = () => {
  const buildColumns = useCallback((opts: { checked: Record<string, boolean>; onToggle: (id: string) => void }): DataGridColumn<DrRow>[] => [
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
      key: 'doc_no', label: 'Return No.', width: 120, sortable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.doc_no}</span>,
      searchValue: (r) => r.doc_no,
    },
    {
      key: 'return_date', label: 'Date', width: 100, sortable: true,
      accessor: (r) => fmtDateOrDash((r.return_date ?? r.line_date) as string | null),
      searchValue: (r) => String(r.return_date ?? r.line_date ?? ''),
      filterType: 'date', dateValue: (r) => (r.return_date ?? r.line_date) as string | null,
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
      key: 'reason', label: 'Reason', width: 200, sortable: true, groupable: true,
      accessor: (r) => r.reason ?? '—',
      searchValue: (r) => r.reason ?? '',
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
      key: 'condition', label: 'Condition', width: 110, sortable: true, groupable: true,
      accessor: (r) => r.condition ?? '—',
      searchValue: (r) => r.condition ?? '',
    },
    {
      key: 'qty_returned', label: 'Qty Returned', width: 100, align: 'right', sortable: true,
      accessor: (r) => String(r.qty_returned ?? 0),
      searchValue: (r) => String(r.qty_returned ?? 0),
      sortFn: (a, b) => Number(a.qty_returned ?? 0) - Number(b.qty_returned ?? 0),
    },
    {
      key: 'unit_price', label: 'Unit Price', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.unit_price_sen),
      searchValue: (r) => fmtRm(r.unit_price_sen),
      sortFn: (a, b) => Number(a.unit_price_sen ?? 0) - Number(b.unit_price_sen ?? 0),
    },
    {
      key: 'line_refund', label: 'Line Refund', width: 120, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.line_refund_sen ?? r.total_sen),
      searchValue: (r) => fmtRm(r.line_refund_sen ?? r.total_sen),
      sortFn: (a, b) => Number(a.line_refund_sen ?? a.total_sen ?? 0) - Number(b.line_refund_sen ?? b.total_sen ?? 0),
    },
    {
      key: 'received_at', label: 'Received', width: 130, sortable: true,
      accessor: (r) => fmtDateOrDash(r.received_at ?? null),
      searchValue: (r) => r.received_at ? String(r.received_at).slice(0, 10) : '',
      filterType: 'date', dateValue: (r) => r.received_at,
    },
    {
      key: 'refunded_at', label: 'Refunded', width: 130, sortable: true,
      accessor: (r) => fmtDateOrDash(r.refunded_at ?? null),
      searchValue: (r) => r.refunded_at ? String(r.refunded_at).slice(0, 10) : '',
      filterType: 'date', dateValue: (r) => r.refunded_at,
    },
    {
      key: 'balance', label: 'Pending Refund', width: 130, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.balance_sen),
      searchValue: (r) => fmtRm(r.balance_sen),
      sortFn: (a, b) => Number(a.balance_sen ?? 0) - Number(b.balance_sen ?? 0),
    },
    {
      key: 'status', label: 'Status', width: 130, sortable: true, groupable: true,
      accessor: (r) => (r.status ? String(r.status).replace(/_/g, ' ') : '—'),
      searchValue: (r) => r.status ?? '',
    },
  ], []);

  return (
    <DetailListingShell<DrRow>
      title="Delivery Return Detail Listing"
      storageKey="dr-detail-listing-grid"
      docNoPlaceholder="DR-2605-001"
      useDetailQuery={useDeliveryReturnDetailListing}
      buildColumns={buildColumns}
      kpiLabels={{
        revenue: 'Refund Value',
        uniqueDocs: 'Unique Returns',
        outstanding: 'Pending Refund',
      }}
      hideKpis={{ cost: true, margin: true }}
    />
  );
};
