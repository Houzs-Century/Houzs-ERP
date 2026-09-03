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

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { usePaymentVouchers, useCancelPaymentVoucher, useSubmitPaymentVoucher, useCheckPaymentVoucher, useApprovePaymentVoucher, type PaymentVoucherRow } from '../../vendor/scm/lib/payment-voucher-queries';
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

/* The owner's four layers as chips (2026-09-02). The enum underneath stays
   DRAFT/POSTED/CANCELLED — Prepared and Checked are DRAFTs wearing marks, so
   the chip filter reads the marks, not just the status. */
const STATUS_CHIPS = ['all', 'DRAFT', 'PREPARED', 'CHECKED', 'POSTED', 'CANCELLED'] as const;

const chipMatches = (chip: string, r: PaymentVoucherRow): boolean => {
  switch (chip) {
    case 'DRAFT':    return r.status === 'DRAFT' && r.submitted_at == null;
    case 'PREPARED': return r.status === 'DRAFT' && r.submitted_at != null && r.checked_at == null;
    case 'CHECKED':  return r.status === 'DRAFT' && r.checked_at != null;
    default:         return r.status === chip;
  }
};

const CHIP_LABELS: Record<string, string> = {
  all: 'All', DRAFT: 'Draft', PREPARED: 'Prepared', CHECKED: 'Checked',
  POSTED: 'Approved', CANCELLED: 'Cancelled',
};

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
    /* The four layers' marks ride BESIDE the pill, never inside the status
       enum (the 0324 lesson). A checked DRAFT reads differently from a
       prepared one, and the list is where each layer finds what is waiting
       for them. */
    accessor: (r) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <StatusPill docType="pv" status={r.status} />
        {r.status === 'DRAFT' && r.checked_at != null && (
          <span style={{ fontSize: 'var(--fs-12, 12px)', color: 'var(--c-green, #2c7a3f)' }}>checked — awaiting approval</span>
        )}
        {r.status === 'DRAFT' && r.submitted_at != null && r.checked_at == null && (
          <span style={{ fontSize: 'var(--fs-12, 12px)', color: 'var(--c-orange, #b06000)' }}>prepared — awaiting check</span>
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
   splits the layers the same way the eye does. */
function queueLabel(r: { status: string; submitted_at?: string | null; checked_at?: string | null; approved_at?: string | null }): string {
  if (r.status !== 'DRAFT') return statusLabel('pv', r.status);
  if (r.checked_at != null) return `${statusLabel('pv', r.status)} · checked`;
  if (r.submitted_at != null) return `${statusLabel('pv', r.status)} · prepared`;
  return statusLabel('pv', r.status);
}

/* Batch eligibility — the same questions the detail page's buttons ask, so
   the tick can never offer what the door would refuse. Approvable includes
   the approved-but-still-DRAFT row: that is a post that died halfway, and
   re-approve resumes it (§0b). */
const isPreparable = (r: PaymentVoucherRow): boolean =>
  r.status === 'DRAFT' && r.submitted_at == null;
const isCheckable = (r: PaymentVoucherRow): boolean =>
  r.status === 'DRAFT' && r.submitted_at != null && r.checked_at == null;
const isApprovable = (r: PaymentVoucherRow): boolean =>
  r.status === 'DRAFT' && r.checked_at != null;

/* MYR-equivalent for the approve dialog — the same conversion Daily Bank and
   posting use: round(total_sen × exchange_rate). */
const myrSen = (r: PaymentVoucherRow): number => {
  const raw = Number(r.exchange_rate ?? 1);
  const rate = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return Math.round(Number(r.total_sen ?? 0) * rate);
};

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
  const preparePv = useSubmitPaymentVoucher();
  const checkPv = useCheckPaymentVoucher();
  const approvePv = useApprovePaymentVoucher();

  const canCreate = can('scm.payment_voucher.create');
  const canCancel = can('scm.payment_voucher.cancel');
  const canWrite = can('scm.payment_voucher.write');
  const canCheck = can('scm.payment_voucher.check');
  const canApprove = can('scm.payment_voucher.approve');

  const allRows = useMemo<PaymentVoucherRow[]>(() => (data?.paymentVouchers ?? []) as PaymentVoucherRow[], [data]);
  const rows = useMemo<PaymentVoucherRow[]>(
    () => (statusChip === 'all' ? allRows : allRows.filter((r) => chipMatches(statusChip, r))),
    [allRows, statusChip],
  );
  const columns = useMemo(() => buildPvColumns(), []);

  /* ── 批量tick yes (the owner, 2026-09-02) — tick the rows whose yes is
     yours to give, one button stamps them one by one. Each voucher still
     walks through its OWN door (permission, gate, audit, and for approve
     the whole post) — a failure names itself and the rest carry on. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const byId = useMemo(() => new Map(allRows.map((r) => [r.id, r])), [allRows]);
  const rowEligible = (r: PaymentVoucherRow): boolean =>
    (canWrite && isPreparable(r)) || (canCheck && isCheckable(r)) || (canApprove && isApprovable(r));
  const tickedRows = useMemo(
    () => [...selected].map((k) => byId.get(k)).filter((r): r is PaymentVoucherRow => Boolean(r)),
    [selected, byId],
  );
  const prepareTargets = canWrite ? tickedRows.filter(isPreparable) : [];
  const checkTargets = canCheck ? tickedRows.filter(isCheckable) : [];
  const approveTargets = canApprove ? tickedRows.filter(isApprovable) : [];

  const runBatch = async (kind: 'prepare' | 'check' | 'approve') => {
    const targets = kind === 'prepare' ? prepareTargets : kind === 'check' ? checkTargets : approveTargets;
    if (targets.length === 0) return;
    /* Prepare is freely reversible (withdraw, and the voucher stays editable)
       so it runs without a dialog — same as the detail page's button. The two
       yeses move money standing, so they keep theirs. */
    if (kind !== 'prepare') {
      const verb = kind === 'check' ? 'Check' : 'Approve & post';
      const totalMyr = targets.reduce((s, r) => s + myrSen(r), 0);
      const ok = await askConfirm({
        title: `${verb} ${targets.length} voucher(s)?`,
        body: kind === 'check'
          ? `The first yes on each: they lock, and ≈ ${fmtMoney(totalMyr)} reserves against Daily Bank's available money.`
          : `The second yes on each posts its journal entry to the GL — ≈ ${fmtMoney(totalMyr)} leaves the books now.`,
        confirmLabel: verb,
      });
      if (!ok) return;
    }
    setBatchRunning(true);
    const failures: string[] = [];
    let done = 0;
    const mut = kind === 'prepare' ? preparePv : kind === 'check' ? checkPv : approvePv;
    for (const r of targets) {
      try {
        await mut.mutateAsync(r.id);
        done += 1;
      } catch (e) {
        failures.push(`${r.pv_number}: ${e instanceof Error ? e.message : 'Something went wrong.'}`);
      }
    }
    setBatchRunning(false);
    setSelected(new Set());
    void notify({
      title: `${done} of ${targets.length} ${kind === 'prepare' ? 'prepared' : kind === 'check' ? 'checked' : 'approved & posted'}`,
      body: failures.length > 0 ? failures.join('\n') : 'Nothing refused.',
      tone: failures.length > 0 ? 'error' : 'info',
    });
  };

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
                {/* The bill pile: drop many bills, they come back read and
                    grouped by supplier (owner's three cases, 2026-09-02). */}
                <Button variant="ghost" size="sm" onClick={() => navigate('/scm/payment-vouchers/scan')}>
                  <span>📷 Scan bills</span>
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
        options={STATUS_CHIPS.map((s) => ({ value: s as string, label: CHIP_LABELS[s] ?? s }))}
        value={statusChip}
        onChange={(v) => setStatusChip(v)}
      />

      {/* The batch bar — appears once something eligible is ticked. Each
          button says how many of the ticked rows ITS yes applies to. */}
      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', padding: '6px 10px', border: '1px solid var(--c-secondary-a, #2F5D4F)', borderRadius: 8, background: 'rgba(47,93,79,0.08)', fontSize: 'var(--fs-13)' }}>
          <span>{selected.size} ticked</span>
          {prepareTargets.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => void runBatch('prepare')} disabled={batchRunning}>
              Prepare {prepareTargets.length}
            </Button>
          )}
          {checkTargets.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => void runBatch('check')} disabled={batchRunning}>
              Check {checkTargets.length}
            </Button>
          )}
          {approveTargets.length > 0 && (
            <Button variant="primary" size="sm" onClick={() => void runBatch('approve')} disabled={batchRunning}>
              Approve & post {approveTargets.length}
            </Button>
          )}
          {batchRunning && <span style={{ color: 'var(--fg-muted)' }}>stamping…</span>}
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={batchRunning}>
            Clear
          </Button>
        </div>
      )}

      <DataGrid<PaymentVoucherRow>
        rows={rows}
        columns={columns}
        storageKey={PV_LIST_STORAGE_KEY}
        exportName="Payment Vouchers"
        rowKey={(r) => r.id}
        selectable={(canWrite || canCheck || canApprove) ? {
          selectedKeys: selected,
          onToggle: (k) => setSelected((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAll: (keys, allSel) => setSelected((p) => {
            const n = new Set(p);
            if (allSel) { for (const k of keys) n.delete(k); } else { for (const k of keys) n.add(k); }
            return n;
          }),
          /* Only rows whose yes is YOURS to give can be ticked — the header
             checkbox never sweeps in a row the door would refuse. */
          isDisabled: (k) => { const r = byId.get(k); return !r || !rowEligible(r); },
        } : undefined}
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
          /* Copy as new (the owner, 2026-09-03: 我 right click 就能直接 copy) —
             any status, cancelled included: the CONTENT is the template, the
             identity is fresh. An AP Payment copies to an AP Payment. */
          menu.push({
            label: 'Copy as new',
            onClick: () => navigate(`/scm/payment-vouchers/new?copyFrom=${r.id}${(r as Record<string, unknown>).purpose === 'SUPPLIER_PAYMENT' ? '&type=ap' : ''}`),
          });
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
