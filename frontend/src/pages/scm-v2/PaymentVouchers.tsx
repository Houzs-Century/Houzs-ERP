// ----------------------------------------------------------------------------
// PaymentVouchers — list of standalone Payment Vouchers (PV), cloned from the
// Purchase Invoices list UX (DataGrid, status chips, double-click → detail,
// right-click context menu).
//
// A Payment Voucher is a "very plain" cash-out document: pay a vendor that is
// NOT a goods invoice (freight forwarder, one-off service). Created at
// /scm/payment-vouchers/new, posted to the GL from the detail page.
//
// HOUZS VENDOR — port of 2990's apps/backend/src/pages/PaymentVouchers.tsx.
// Import boundary only: react-router → react-router-dom; flow-queries PV hooks →
// vendored payment-voucher-queries; components/lib → ../../vendor/scm/*; nav
// repointed to the parallel /scm/* routes.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { usePaymentVouchers, useCancelPaymentVoucher, type PaymentVoucherRow } from '../../vendor/scm/lib/payment-voucher-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { statusLabel } from '../../vendor/scm/lib/status-pill';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { fmtDateOrDash, fmtMoneySen } from '@2990s/shared';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import { FilterPills } from '../../components/FilterPills';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

// payment_voucher_status enum: DRAFT / POSTED / CANCELLED.
const STATUS_CHIPS = ['all', 'DRAFT', 'POSTED', 'CANCELLED'] as const;

const fmtMoney = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

const PV_LIST_STORAGE_KEY = 'pv-list.layout.v1';

const buildPvColumns = (): DataGridColumn<PaymentVoucherRow>[] => [
  {
    key: 'pv_number', label: 'Voucher No.', width: 150, sortable: true,
    accessor: (r) => <span style={{ fontWeight: 700, color: '#16695f', fontVariantNumeric: 'tabular-nums' }}>{r.pv_number}</span>,
    searchValue: (r) => r.pv_number,
    exportValue: (r) => r.pv_number,
    sortFn: (a, b) => a.pv_number.localeCompare(b.pv_number),
  },
  {
    key: 'payee_name', label: 'Payee', width: 240, sortable: true, groupable: true,
    accessor: (r) => r.payee_name || r.supplier?.name || '—',
    searchValue: (r) => `${r.payee_name ?? ''} ${r.supplier?.name ?? ''}`.trim(),
    groupValue: (r) => r.payee_name || r.supplier?.name || '(none)',
    sortFn: (a, b) => (a.payee_name ?? '').localeCompare(b.payee_name ?? ''),
  },
  {
    key: 'credit_account_code', label: 'Paid From', width: 120, sortable: true, groupable: true,
    accessor: (r) => r.credit_account_code ?? '—',
    searchValue: (r) => r.credit_account_code ?? '',
    groupValue: (r) => r.credit_account_code ?? '(none)',
  },
  {
    key: 'voucher_date', label: 'Date', width: 120, sortable: true,
    accessor: (r) => fmtDateOrDash(r.voucher_date),
    searchValue: (r) => r.voucher_date ?? '',
    sortFn: (a, b) => String(a.voucher_date ?? '').localeCompare(String(b.voucher_date ?? '')),
    filterType: 'date', dateValue: (r) => r.voucher_date,
  },
  {
    key: 'total_sen', label: 'Total', width: 130, sortable: true, align: 'right', groupable: false,
    accessor: (r) => (
      <span style={{ fontFamily: 'var(--font-mark)', color: '#16695f', fontWeight: 800 }}>
        {fmtMoney(Number(r.total_sen ?? 0), r.currency)}
      </span>
    ),
    searchValue: (r) => fmtMoney(Number(r.total_sen ?? 0), r.currency),
    exportValue: (r) => Number(r.total_sen ?? 0) / 100,
    sortFn: (a, b) => Number(a.total_sen ?? 0) - Number(b.total_sen ?? 0),
  },
  {
    key: 'status', label: 'Status', width: 160, sortable: true, groupable: true,
    /* Phase 3: the approval marks ride BESIDE the pill, never inside the
       status enum (the 0324 lesson). A DRAFT in the queue reads differently
       from a DRAFT still being written, and the list is where the approver
       finds what is waiting for them. */
    accessor: (r) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <StatusPill docType="pv" status={r.status} />
        {r.status === 'DRAFT' && r.approved_at != null && (
          <span style={{ fontSize: 'var(--fs-12, 12px)', color: 'var(--c-green, #2c7a3f)' }}>approved</span>
        )}
        {r.status === 'DRAFT' && r.submitted_at != null && r.approved_at == null && (
          <span style={{ fontSize: 'var(--fs-12, 12px)', color: 'var(--c-orange, #b06000)' }}>awaiting approval</span>
        )}
      </span>
    ),
    searchValue: (r) => queueLabel(r),
    groupValue: (r) => queueLabel(r),
    exportValue: (r) => queueLabel(r),
    sortFn: (a, b) => a.status.localeCompare(b.status),
  },
];

/* The searchable/groupable text mirrors what the cell SHOWS — a grouped list
   splits queued drafts from plain ones the same way the eye does. */
function queueLabel(r: { status: string; submitted_at?: string | null; approved_at?: string | null }): string {
  if (r.status !== 'DRAFT') return statusLabel('pv', r.status);
  if (r.approved_at != null) return `${statusLabel('pv', r.status)} · approved`;
  if (r.submitted_at != null) return `${statusLabel('pv', r.status)} · awaiting approval`;
  return statusLabel('pv', r.status);
}

export const PaymentVouchers = () => {
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusChip = searchParams.get('status') ?? 'all';
  const setStatusChip = (s: string) => {
    const next = new URLSearchParams(searchParams);
    if (s === 'all') next.delete('status'); else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading, error } = usePaymentVouchers();
  const cancelPv = useCancelPaymentVoucher();

  const canCreate = can('scm.payment_voucher.create');
  const canCancel = can('scm.payment_voucher.cancel');

  const allRows = useMemo<PaymentVoucherRow[]>(() => (data?.paymentVouchers ?? []) as PaymentVoucherRow[], [data]);
  const rows = useMemo<PaymentVoucherRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((r) => r.status === statusChip)),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildPvColumns(), []);

  const doCancelPv = async (r: PaymentVoucherRow) => {
    if (!(await askConfirm({ title: `Cancel voucher ${r.pv_number}?`, body: 'This sets status to CANCELLED and reverses the GL entry if it was posted.', confirmLabel: 'Cancel voucher', danger: true }))) return;
    cancelPv.mutate(r.id, {
      onError: (e) => notify({ title: 'Cancel failed', body: `${e instanceof Error ? e.message : 'Something went wrong.'}`, tone: 'error' }),
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Payment Vouchers"
        actions={
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            {canCreate && (
              <>
                {/* Two documents, AutoCount-style (owner 2026-08-30): the AP
                    Payment settles a supplier's invoices with an automatic AP
                    debit; the Payment Voucher pays expenses, lines by hand. */}
                <Button variant="primary" size="sm" onClick={() => navigate('/scm/payment-vouchers/new?type=ap')}>
                  <Plus {...ICON} />
                  <span>New AP Payment</span>
                </Button>
                <Button variant="secondary" size="sm" onClick={() => navigate('/scm/payment-vouchers/new')}>
                  <Plus {...ICON} />
                  <span>New Payment Voucher</span>
                </Button>
              </>
            )}
          </div>
        }
      />

      <p className={styles.eyebrow}>
        {isLoading ? 'Loading vouchers…' : `${rows.length} payment vouchers`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load payment vouchers.</strong>{' '}
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      {/* The SO strip's own FilterPills slab (owner 2026-07-26). */}
      <FilterPills
        options={STATUS_CHIPS.map((s) => ({ value: s as string, label: s === 'all' ? 'All' : statusLabel('pv', s) }))}
        value={statusChip}
        onChange={(v) => setStatusChip(v)}
      />

      <DataGrid<PaymentVoucherRow>
        rows={rows}
        columns={columns}
        storageKey={PV_LIST_STORAGE_KEY}
        exportName="Payment Vouchers"
        rowKey={(r) => r.id}
        searchPlaceholder="Search voucher no, payee…"
        loadedSearchLimit={500}
        groupBanner={false}
        onRowDoubleClick={(r) => navigate(`/scm/payment-vouchers/${r.id}`)}
        rowStyle={(r) => r.status === 'CANCELLED'
          ? { opacity: 0.6, filter: 'grayscale(0.4)' }
          : undefined}
        contextMenu={(r) => {
          // DRAFT is editable; a POSTED / CANCELLED voucher is read-only. Cancel
          // is hidden once cancelled. View always available.
          const menu: Array<{ label?: string; onClick?: () => void; danger?: boolean; divider?: true }> = [
            { label: 'View', onClick: () => navigate(`/scm/payment-vouchers/${r.id}`) },
          ];
          if (r.status === 'DRAFT') {
            menu.push({ label: 'Edit', onClick: () => navigate(`/scm/payment-vouchers/${r.id}?edit=1`) });
          }
          if (r.status !== 'CANCELLED' && canCancel) {
            menu.push({ divider: true as const });
            menu.push({ label: 'Cancel', danger: true, onClick: () => doCancelPv(r) });
          }
          return menu;
        }}
        isLoading={isLoading}
        emptyMessage="No payment vouchers yet — create one with “New Payment Voucher”."
      />
    </div>
  );
};
