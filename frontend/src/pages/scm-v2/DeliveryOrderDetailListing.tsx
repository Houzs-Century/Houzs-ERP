// ----------------------------------------------------------------------------
// DeliveryOrderDetailListing — Task #120 L2 page for Delivery Orders.
// One row per delivery_order_items line, with the DO header denormalised.
// Mirrors the SalesOrderDetailListing structure via DetailListingShell.
// ----------------------------------------------------------------------------

import { useCallback } from 'react';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { DetailListingShell } from '../../components/scm-v2/DetailListingShell';
import { useDeliveryOrderDetailListing, type DetailListingRow } from '../../vendor/scm/lib/reports-queries';
import type { DataGridColumn } from '../../vendor/scm/components/DataGrid';
import styles from './SalesOrderDetailListing.module.css';
import { transferFromColumnLabel } from "../../lib/convertScope";

type DoRow = DetailListingRow & {
  do_number?: string;
  so_doc_no?: string | null;
  do_date?: string | null;
  expected_delivery_at?: string | null;
  driver_name?: string | null;
  vehicle?: string | null;
  m3_milli?: number;
  city?: string | null;
  state?: string | null;
  line_total_sen?: number;
  discount_sen?: number;
  uom?: string;
  item_group?: string | null;
};

const fmtRm = (centi: number | null | undefined): string => {
  const c = Number(centi ?? 0);
  return `MYR ${(c / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtM3 = (milli: number | null | undefined): string =>
  ((Number(milli ?? 0)) / 1000).toFixed(3);

export const DeliveryOrderDetailListing = () => {
  const buildColumns = useCallback((opts: { checked: Record<string, boolean>; onToggle: (id: string) => void }): DataGridColumn<DoRow>[] => [
    {
      key: 'check', label: 'Check', width: 50, align: 'left', sortable: false, groupable: false,
      accessor: (r) => (
        <input
          type="checkbox"
          aria-label={`Toggle ${r.doc_no} / ${r.item_code}`}
          checked={!!opts.checked[r.id]}
          onChange={() => opts.onToggle(r.id)}
          onClick={(e) => e.stopPropagation()}
        />
      ),
      searchValue: () => '',
    },
    {
      key: 'doc_no', label: 'DO No.', width: 120, sortable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.doc_no}</span>,
      searchValue: (r) => r.doc_no,
    },
    {
      key: 'do_date', label: 'Date', width: 100, sortable: true,
      accessor: (r) => fmtDateOrDash((r.do_date ?? r.line_date) as string | null),
      searchValue: (r) => String(r.do_date ?? r.line_date ?? ''),
      filterType: 'date', dateValue: (r) => (r.do_date ?? r.line_date) as string | null,
    },
    {
      key: 'so_doc_no', label: transferFromColumnLabel('so'), width: 110, sortable: true, groupable: true,
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
      key: 'driver_name', label: 'Driver', width: 140, sortable: true, groupable: true,
      accessor: (r) => r.driver_name ?? '—',
      searchValue: (r) => r.driver_name ?? '',
    },
    {
      key: 'vehicle', label: 'Vehicle', width: 110, sortable: true,
      accessor: (r) => (r.vehicle ?? '—') as string,
      searchValue: (r) => r.vehicle ?? '',
    },
    {
      key: 'city', label: 'City', width: 130, sortable: true, groupable: true,
      accessor: (r) => r.city ?? '—',
      searchValue: (r) => r.city ?? '',
    },
    {
      key: 'state', label: 'State', width: 130, sortable: true, groupable: true,
      accessor: (r) => r.state ?? '—',
      searchValue: (r) => r.state ?? '',
    },
    {
      key: 'expected_delivery_at', label: 'Expected', width: 110, sortable: true,
      accessor: (r) => fmtDateOrDash(r.expected_delivery_at ?? null),
      searchValue: (r) => r.expected_delivery_at ?? '',
      filterType: 'date', dateValue: (r) => r.expected_delivery_at,
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
      key: 'm3_milli', label: 'm³', width: 80, align: 'right', sortable: true,
      accessor: (r) => fmtM3(r.m3_milli),
      searchValue: (r) => fmtM3(r.m3_milli),
      sortFn: (a, b) => Number(a.m3_milli ?? 0) - Number(b.m3_milli ?? 0),
    },
    {
      key: 'unit_price', label: 'Unit Price', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.unit_price_sen),
      searchValue: (r) => fmtRm(r.unit_price_sen),
      sortFn: (a, b) => Number(a.unit_price_sen ?? 0) - Number(b.unit_price_sen ?? 0),
    },
    {
      key: 'discount', label: 'Discount', width: 100, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.discount_sen),
      searchValue: (r) => fmtRm(r.discount_sen),
      sortFn: (a, b) => Number(a.discount_sen ?? 0) - Number(b.discount_sen ?? 0),
    },
    {
      key: 'line_total', label: 'Line Total', width: 110, align: 'right', sortable: true,
      accessor: (r) => fmtRm(r.total_sen),
      searchValue: (r) => fmtRm(r.total_sen),
      sortFn: (a, b) => Number(a.total_sen ?? 0) - Number(b.total_sen ?? 0),
    },
    {
      key: 'status', label: 'Status', width: 120, sortable: true, groupable: true,
      accessor: (r) => (r.status ? String(r.status).replace(/_/g, ' ') : '—'),
      searchValue: (r) => r.status ?? '',
    },
  ], []);

  return (
    <DetailListingShell<DoRow>
      title="Delivery Order Detail Listing"
      storageKey="do-detail-listing-grid"
      docNoPlaceholder="DO-2605-001"
      useDetailQuery={useDeliveryOrderDetailListing}
      buildColumns={buildColumns}
      // Delivery Orders have no payment ledger — "Outstanding" here is
      // doc-level: a DO whose status hasn't reached DELIVERED / INVOICED.
      // We compute it as undelivered lines × line_total.
      computeKpis={(rows) => {
        const totalLines = rows.length;
        const uniqueDocs = new Set<string>();
        let revenue = 0;
        const outstandingByDoc = new Map<string, number>();
        const docStatuses = new Map<string, string>();
        for (const r of rows) {
          uniqueDocs.add(r.doc_no);
          revenue += Number(r.total_sen ?? 0);
          docStatuses.set(r.doc_no, String(r.status ?? ''));
        }
        // Sum the LINE totals per doc whose status is still in-flight.
        for (const r of rows) {
          const status = docStatuses.get(r.doc_no) ?? '';
          if (status === 'DELIVERED' || status === 'INVOICED' || status === 'CANCELLED') continue;
          const cur = outstandingByDoc.get(r.doc_no) ?? 0;
          outstandingByDoc.set(r.doc_no, cur + Number(r.total_sen ?? 0));
        }
        const outstanding = [...outstandingByDoc.values()].reduce((s, v) => s + v, 0);
        return {
          totalLines, uniqueDocs: uniqueDocs.size,
          revenue, cost: 0, margin: 0, marginPct: 0, outstanding,
        };
      }}
      hideKpis={{ cost: true, margin: true }}
      kpiLabels={{ uniqueDocs: 'Unique DOs', outstanding: 'Not Delivered' }}
    />
  );
};
