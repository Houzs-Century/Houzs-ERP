// ----------------------------------------------------------------------------
// PaymentVoucherDetail — full-page route at /scm/payment-vouchers/:id.
//
// A View → Edit machine for a standalone Payment Voucher (PV):
//   • View: header (payee, supplier, "Paid From" account, date, notes) + a
//     read-only line table (description · debit account · amount) + total +
//     status pill + the PIs this voucher settles.
//   • Edit (DRAFT only): payee, supplier, purpose, credit account, date, notes,
//     editable lines, and the supplier's outstanding PIs to settle.
//   • Actions: Post (DRAFT → POSTED, writes the GL entry + settles PIs) and
//     Cancel (reverses the GL entry + PI settlement, → CANCELLED). A POSTED /
//     CANCELLED voucher is read-only.
//
// HOUZS VENDOR — port of 2990's apps/backend/src/pages/PaymentVoucherDetail.tsx,
// Phase 1-B MYR: the foreign-currency UI (currency / exchange-rate / MYR-equiv)
// is DROPPED (phase A). The "Apply to PI" picker derives the supplier's
// outstanding PIs client-side from the PI list. Post/Cancel/Edit are gated on
// the scm.payment_voucher.* flat permissions.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, ChevronDown, History, Pencil, Plus, RotateCcw, Save, Send, Ban, Trash2, X, XCircle } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { fmtDate, fmtDateOrDash } from '../../vendor/shared/format';
import {
  usePaymentVoucherDetail,
  useUpdatePaymentVoucher,
  useCancelPaymentVoucher,
  useSubmitPaymentVoucher,
  useWithdrawPaymentVoucher,
  useCheckPaymentVoucher,
  useApprovePaymentVoucher,
  useRejectPaymentVoucher,
  useSupplierAdvances, useApplyAdvance,
} from '../../vendor/scm/lib/payment-voucher-queries';
import { useAccounts, type Account } from '../../vendor/scm/lib/accounting-queries';
import { usePurchaseInvoices } from '../../vendor/scm/lib/purchase-invoice-queries';
import { useSuppliers, useSupplierDetail } from '../../vendor/scm/lib/suppliers-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { StatusPill } from '../../vendor/scm/components/StatusPill';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { EntityHistoryPanel } from './EntityHistoryPanel';
import { PAYMENT_VOUCHER_AUDIT_LABELS } from './entity-audit-labels';
import { resolveFxRate, deriveRateFromMyrPaid } from './fx-rate';

const ICON    = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/* Migration 0202 — human label for the PV purpose. */
const purposeLabel = (p: string | null | undefined): string =>
  p === 'FREIGHT' ? 'Freight'
  : p === 'OTHER' ? 'Other'
  : 'Supplier payment (settle PI)';

type EditLine = {
  rid:              string;
  description:      string;
  debitAccountCode: string;
  amountSen:      number;
};

const newLine = (): EditLine => ({
  rid:              `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  description:      '',
  debitAccountCode: '',
  amountSen:      0,
});

function InfoCell({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ color: value ? 'var(--fg)' : 'var(--fg-muted)' }}>{value || '—'}</div>
    </div>
  );
}

export const PaymentVoucherDetail = () => {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();

  /* History drawer. Stable close handler so the memoized panel does not
     re-render on every keystroke in the edit form. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const detailQ = usePaymentVoucherDetail(id || null);
  const pv    = detailQ.data?.paymentVoucher as Record<string, any> | undefined;
  const lines = (detailQ.data?.lines ?? []) as Array<Record<string, any>>;
  // Migration 0202 — PIs this voucher settles (camelCase from the API).
  const allocations = (detailQ.data?.allocations ?? []) as Array<Record<string, any>>;

  const update = useUpdatePaymentVoucher();
  const cancel = useCancelPaymentVoucher();
  const submit   = useSubmitPaymentVoucher();
  const withdraw = useWithdrawPaymentVoucher();
  const check    = useCheckPaymentVoucher();
  const approve  = useApprovePaymentVoucher();
  const reject   = useRejectPaymentVoucher();
  const busy   = update.isPending || cancel.isPending
    || submit.isPending || withdraw.isPending || check.isPending || approve.isPending || reject.isPending;

  const canWrite   = can('scm.payment_voucher.write');
  const canCancel  = can('scm.payment_voucher.cancel');
  const canCheck   = can('scm.payment_voucher.check');
  const canApprove = can('scm.payment_voucher.approve');

  /* The owner's four layers (2026-09-02) — where this voucher stands. No
     marks: raw Draft. Prepared: declared ready, STILL editable. Checked:
     first yes, locked, on Daily Bank's pending. Approve is the second yes
     and posts the GL itself. The server enforces all of it; these only
     decide which buttons are worth showing. */
  const isPrepared   = Boolean(pv?.submitted_at);
  const isChecked    = Boolean(pv?.checked_at);
  const isApprovedPv = Boolean(pv?.approved_at);
  /* Reject wants a why the submitter will read — an inline note swaps in
     for the approve/reject pair while it is being typed. */
  const [rejectNote, setRejectNote] = useState<string | null>(null);

  const accountsQ = useAccounts();
  const accounts  = useMemo<Account[]>(() => (accountsQ.data?.accounts ?? []).filter((a) => a.is_active), [accountsQ.data]);
  const accountLabel = (code: string | null | undefined): string => {
    if (!code) return '—';
    const a = accounts.find((x) => x.account_code === code);
    return a ? `${a.account_code} · ${a.account_name}` : code;
  };

  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  const isDraft = pv?.status === 'DRAFT';
  const [isEditing, setIsEditing] = useState(() => searchParams.get('edit') === '1');

  // Edit draft state.
  const [payeeName, setPayeeName]                 = useState('');
  const [supplierId, setSupplierId]               = useState('');
  const [purpose, setPurpose]                     = useState<'SUPPLIER_PAYMENT' | 'FREIGHT' | 'OTHER'>('SUPPLIER_PAYMENT');
  const [creditAccountCode, setCreditAccountCode] = useState('');
  const [voucherDate, setVoucherDate]             = useState('');
  const [notes, setNotes]                         = useState('');
  /* Multi-currency (Phase 1-A) — MYR per 1 unit of the PV currency, string-typed.
     Seeded from the voucher on enter-edit; shown only for a foreign currency. */
  const [exchangeRate, setExchangeRate]           = useState('1');
  /* RINGGIT IN, RATE OUT (2026-07-30) — the owner knows what left the bank, not
     what the rate was. When set, the rate is DERIVED from this; the rate field stays
     editable as the fallback. Mirrors PaymentVoucherNew. */
  const [myrPaidSen, setMyrPaidSen]               = useState<number | null>(null);
  const [editLines, setEditLines]                 = useState<EditLine[]>([]);
  // Migration 0202 — edit allocations: applied amount per PI id (centi).
  const [allocAmounts, setAllocAmounts]           = useState<Record<string, number>>({});

  // A POSTED/CANCELLED voucher can never enter edit mode.
  useEffect(() => { if (!isDraft && isEditing) setIsEditing(false); }, [isDraft, isEditing]);

  // Seed the draft from the loaded voucher whenever we enter edit mode.
  useEffect(() => {
    if (!isEditing || !pv) return;
    setPayeeName(pv.payee_name ?? '');
    setSupplierId(pv.supplier_id ?? '');
    setPurpose((pv.purpose ?? 'SUPPLIER_PAYMENT') as 'SUPPLIER_PAYMENT' | 'FREIGHT' | 'OTHER');
    setCreditAccountCode(pv.credit_account_code ?? '');
    setVoucherDate(pv.voucher_date ?? '');
    setNotes(pv.notes ?? '');
    setExchangeRate(String(pv.exchange_rate ?? '1'));
    /* Cleared on entering edit, never back-derived from the stored rate: the MYR
       field means "this is what I actually paid", and inventing it from a rate would
       put a figure nobody typed in front of the operator as if it were evidence. */
    setMyrPaidSen(null);
    // Seed the applied-amount map from the loaded allocations (keyed by PI id).
    setAllocAmounts(Object.fromEntries(
      allocations.map((a) => [String(a.piId ?? a.pi_id ?? ''), Number(a.amountSen ?? a.amount_sen ?? 0)]),
    ));
    setEditLines(
      lines.length > 0
        ? lines.map((l) => ({
            rid:              `l${l.id}`,
            description:      l.description ?? '',
            debitAccountCode: l.debit_account_code ?? '',
            amountSen:      Number(l.amount_sen ?? 0),
          }))
        : [newLine()],
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, pv?.id]);

  const setLine  = (rid: string, patch: Partial<EditLine>) =>
    setEditLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setEditLines((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.rid !== rid)));
  const addLine  = () => setEditLines((prev) => [...prev, newLine()]);

  const editTotalSen = useMemo(() => editLines.reduce((s, l) => s + l.amountSen, 0), [editLines]);
  const viewTotalSen = Number(pv?.total_sen ?? 0);
  const totalSen = isEditing ? editTotalSen : viewTotalSen;

  /* Multi-currency (Phase 1-A) — the PV keeps its own currency; the exchange
     rate converts the GL posting to MYR. In VIEW we show the stored currency; in
     EDIT it follows the chosen supplier's default (MYR = strict no-op). */
  const supplierDetailQ = useSupplierDetail(isEditing ? (supplierId || null) : null);
  const supplierDetail  = supplierDetailQ.data?.supplier ?? null;
  const supplierRow     = useMemo(() => (suppliersQ.data ?? []).find((s) => s.id === supplierId) ?? null, [suppliersQ.data, supplierId]);
  const viewCurrency = (pv?.currency ?? 'MYR').toUpperCase();
  const editCurrency = (supplierDetail?.currency ?? supplierRow?.currency ?? pv?.currency ?? 'MYR').toUpperCase();
  const currency  = isEditing ? editCurrency : viewCurrency;
  const isForeign = currency !== 'MYR';
  useEffect(() => { if (isEditing && !isForeign) { setExchangeRate('1'); setMyrPaidSen(null); } }, [isEditing, isForeign]);
  /* Derived from the ringgit actually paid over the foreign face total, re-derived
     when either moves. null (blank figure, or a zero total — the divide-by-zero)
     leaves the rate alone rather than blanking it. */
  const derivedRate = useMemo(
    () => (isEditing && isForeign ? deriveRateFromMyrPaid(myrPaidSen, editTotalSen) : null),
    [isEditing, isForeign, myrPaidSen, editTotalSen],
  );
  useEffect(() => {
    if (derivedRate === null) return;
    setExchangeRate(String(derivedRate));
  }, [derivedRate]);
  const rate = resolveFxRate(isEditing ? exchangeRate : pv?.exchange_rate);

  /* ── Edit allocations (migration 0202) ────────────────────────────────────
     In Edit mode on a SUPPLIER_PAYMENT voucher, list the supplier's outstanding
     PIs (derived client-side from the PI list) so the operator can add/adjust
     settlements. The already-allocated PIs stay listed (their outstanding
     excludes what this PV applies, so add it back). */
  const editApplyToPi = isEditing && purpose === 'SUPPLIER_PAYMENT' && !!supplierId;
  const piListQ = usePurchaseInvoices();
  const editAllocRows = useMemo(() => {
    if (!editApplyToPi) return [] as Array<{ piId: string; invoiceNumber: string; supplierInvoiceRef: string | null; outstandingSen: number }>;
    const appliedByThisPv = new Map<string, number>(
      allocations.map((a) => [String(a.piId ?? a.pi_id ?? ''), Number(a.amountSen ?? a.amount_sen ?? 0)]),
    );
    const byId = new Map<string, { piId: string; invoiceNumber: string; supplierInvoiceRef: string | null; outstandingSen: number }>();
    for (const r of ((piListQ.data?.purchaseInvoices ?? []) as Array<Record<string, any>>)) {
      const sid = String(r.supplier_id ?? r.supplier?.id ?? '');
      if (sid !== supplierId) continue;
      const st = String(r.status ?? '').toUpperCase();
      if (st !== 'POSTED' && st !== 'PARTIALLY_PAID') continue;
      const piId = String(r.id ?? '');
      if (!piId) continue;
      const baseOutstanding = Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0);
      const outstanding = baseOutstanding + (appliedByThisPv.get(piId) ?? 0);
      if (outstanding <= 0) continue;
      byId.set(piId, {
        piId,
        invoiceNumber:      String(r.invoice_number ?? piId),
        supplierInvoiceRef: (r.supplier_invoice_ref ?? null) as string | null,
        outstandingSen:   outstanding,
      });
    }
    // Ensure every already-allocated PI is present even if it dropped off.
    for (const a of allocations) {
      const piId = String(a.piId ?? a.pi_id ?? '');
      if (!piId || byId.has(piId)) continue;
      byId.set(piId, {
        piId,
        invoiceNumber:      String(a.invoiceNumber ?? a.invoice_number ?? piId),
        supplierInvoiceRef: (a.supplierInvoiceRef ?? a.supplier_invoice_ref ?? null) as string | null,
        outstandingSen:   Number(a.amountSen ?? a.amount_sen ?? 0),
      });
    }
    return [...byId.values()];
  }, [editApplyToPi, piListQ.data, allocations, supplierId]);

  const editAllocatedSen = useMemo(
    () => editAllocRows.reduce((s, r) => s + (allocAmounts[r.piId] ?? 0), 0),
    [editAllocRows, allocAmounts],
  );
  const editOverAllocated = editApplyToPi && editAllocatedSen > editTotalSen;

  if (detailQ.isLoading || !pv) return <SkeletonDetailPage />;

  const onSave = async () => {
    const realLines = editLines.filter((l) => l.debitAccountCode && l.amountSen > 0);
    if (!payeeName.trim()) { notify({ title: 'Enter a payee', body: 'Who is this voucher paying?', tone: 'error' }); return; }
    if (!creditAccountCode) { notify({ title: 'Pick a “Paid From” account', body: 'Choose the bank / cash / payables account.', tone: 'error' }); return; }
    if (realLines.length === 0) { notify({ title: 'Add at least one line', body: 'Each line needs a debit account and an amount > 0.', tone: 'error' }); return; }
    if (editOverAllocated) {
      notify({ title: 'Applied more than the voucher total', body: `You've applied ${fmtRm(editAllocatedSen)} to PIs but the voucher total is only ${fmtRm(editTotalSen)}.`, tone: 'error' });
      return;
    }
    // Migration 0202 — settled PIs (SUPPLIER_PAYMENT only). Send the full set of
    // applied rows (amount > 0) so the server replaces the prior allocations.
    const sendAllocations = editApplyToPi
      ? editAllocRows
          .map((r) => ({ piId: r.piId, amountSen: allocAmounts[r.piId] ?? 0 }))
          .filter((a) => a.amountSen > 0)
      : [];
    try {
      await update.mutateAsync({
        id,
        payeeName:         payeeName.trim(),
        supplierId:        supplierId || null,
        purpose,
        creditAccountCode,
        voucherDate,
        notes:             notes || null,
        // Multi-currency (Phase 1-A) — resolved currency + rate. MYR forces 1
        // (server enforces too); a blank/invalid foreign rate → 1.
        currency:          editCurrency,
        exchangeRate:      isForeign
          ? resolveFxRate(exchangeRate)
          : 1,
        lines: realLines.map((l) => ({
          description:      l.description || undefined,
          debitAccountCode: l.debitAccountCode,
          amountSen:      l.amountSen,
        })),
        // Always send allocations for a SUPPLIER_PAYMENT edit (empty clears
        // them); FREIGHT/OTHER omit the key so the server leaves them untouched.
        ...(editApplyToPi ? { allocations: sendAllocations } : {}),
      });
      setIsEditing(false);
    } catch (err) {
      notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* There is no standalone Post button any more — the second yes posts
     (owner 2026-09-02: 当approved 了才会进gl), and re-approving resumes a
     post that died halfway. */
  const onCancel = async () => {
    if (!(await askConfirm({ title: `Cancel voucher ${pv.pv_number}?`, body: 'This sets status to CANCELLED and reverses the GL entry if it was posted.', confirmLabel: 'Cancel voucher', danger: true }))) return;
    try {
      await cancel.mutateAsync(id);
    } catch (err) {
      notify({ title: 'Cancel failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* The four layers' actions. Prepare and withdraw are freely reversible so
     they carry no dialog; checking reserves money and approving posts it, so
     both do. */
  const onPrepare = async () => {
    try { await submit.mutateAsync(id); } catch (err) {
      void notify({ title: 'Prepare failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const onWithdraw = async () => {
    try { await withdraw.mutateAsync(id); } catch (err) {
      void notify({ title: 'Withdraw failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const onCheck = async () => {
    if (!(await askConfirm({ title: `Check ${pv.pv_number}?`, body: 'The first yes: the voucher locks, and the amount reserves against Daily Bank’s available money until it is approved or rejected.', confirmLabel: 'Check' }))) return;
    try { await check.mutateAsync(id); } catch (err) {
      void notify({ title: 'Check failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const onApprove = async () => {
    if (!(await askConfirm({ title: `Approve ${pv.pv_number}?`, body: 'The second yes posts the journal entry to the General Ledger in the same step — money leaves the books now.', confirmLabel: 'Approve & post' }))) return;
    try { await approve.mutateAsync(id); } catch (err) {
      void notify({ title: 'Approve failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const onRejectConfirm = async () => {
    try {
      await reject.mutateAsync({ id, note: rejectNote ?? '' });
      setRejectNote(null);
    } catch (err) {
      void notify({ title: 'Reject failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Finance"
        title={pv.pv_number}
        actions={
          <div className={styles.actions} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <StatusPill docType="pv" status={pv.status} />
            {/* History drawer toggle. Same header seat on every detail page, and
                ungated: whoever may open the voucher may see who changed it. */}
            <Button variant="ghost" size="md" onClick={() => setHistoryOpen(true)}>
              <History {...ICON} /> History
            </Button>
            {!isEditing ? (
              <>
                {/* The four layers: where the voucher stands, said once beside the pill. */}
                {isDraft && isPrepared && (
                  <span style={{ fontSize: 'var(--fs-13)', color: isChecked ? 'var(--c-green, #2c7a3f)' : 'var(--c-orange, #b06000)' }}>
                    {isChecked ? `Checked · ${String(pv.checked_by ?? '')} — awaiting approval` : `Prepared · ${String(pv.submitted_by ?? '')}`}
                  </span>
                )}
                {/* Editable until the FIRST YES — a merely prepared voucher
                    still takes corrections (owner: prepare 还可以改). */}
                {isDraft && canWrite && !isChecked && (
                  <Button variant="ghost" size="md" onClick={() => setIsEditing(true)} disabled={busy}>
                    <Pencil {...ICON} /> Edit
                  </Button>
                )}
                {isDraft && canWrite && !isPrepared && (
                  <Button variant="primary" size="md" onClick={() => void onPrepare()} disabled={busy}>
                    <Send {...ICON} /> Prepare
                  </Button>
                )}
                {isDraft && canWrite && isPrepared && !isChecked && (
                  <Button variant="ghost" size="md" onClick={() => void onWithdraw()} disabled={busy}
                    title="Back out of the cycle — it will need preparing again">
                    <RotateCcw {...ICON} /> Withdraw
                  </Button>
                )}
                {isDraft && canCheck && isPrepared && !isChecked && rejectNote === null && (
                  <Button variant="primary" size="md" onClick={() => void onCheck()} disabled={busy}>
                    <CheckCircle2 {...ICON} /> Check
                  </Button>
                )}
                {isDraft && canApprove && isChecked && !isApprovedPv && rejectNote === null && (
                  <Button variant="primary" size="md" onClick={() => void onApprove()} disabled={busy}>
                    <CheckCircle2 {...ICON} /> Approve & post
                  </Button>
                )}
                {/* Reject opens to EITHER key, at either layer — back to raw
                    draft with the why on the trail (一律退回 Draft). */}
                {isDraft && (canCheck || canApprove) && isPrepared && rejectNote === null && (
                  <Button variant="ghost" size="md" onClick={() => setRejectNote('')} disabled={busy}>
                    <XCircle {...ICON} /> Reject
                  </Button>
                )}
                {rejectNote !== null && (
                  <>
                    <input
                      value={rejectNote}
                      onChange={(e) => setRejectNote(e.target.value)}
                      placeholder="Why it goes back (the preparer reads this)"
                      aria-label="Rejection reason"
                      style={{ padding: '6px 10px', fontSize: 'var(--fs-13)', minWidth: 220 }}
                    />
                    <Button variant="primary" size="md" onClick={() => void onRejectConfirm()} disabled={busy}>
                      <XCircle {...ICON} /> Reject it
                    </Button>
                    <Button variant="ghost" size="md" onClick={() => setRejectNote(null)} disabled={busy}>
                      <X {...ICON} /> Back
                    </Button>
                  </>
                )}
                {pv.status !== 'CANCELLED' && canCancel && rejectNote === null && (
                  <Button variant="ghost" size="md" onClick={onCancel} disabled={busy}>
                    <Ban {...ICON} /> Cancel
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="ghost" size="md" onClick={() => setIsEditing(false)} disabled={busy}>
                  <X {...ICON} /> Back
                </Button>
                <Button variant="primary" size="md" onClick={onSave} disabled={busy}>
                  <Save {...ICON} /> {update.isPending ? 'Saving…' : 'Save'}
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* ── Header card ───────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Header</h2></div>
        <div className={styles.cardBody}>
          {!isEditing ? (
            <div className={styles.formGrid2}>
              <InfoCell label="Payee" value={pv.payee_name} />
              <InfoCell label="Supplier" value={pv.supplier?.name ?? null} />
              <InfoCell label="Purpose" value={purposeLabel(pv.purpose)} />
              <InfoCell label="Paid From" value={accountLabel(pv.credit_account_code)} />
              <InfoCell label="Voucher Date" value={pv.voucher_date ? fmtDateOrDash(pv.voucher_date) : null} />
              <InfoCell label="Currency" value={viewCurrency} />
              {viewCurrency !== 'MYR' && <InfoCell label="Exchange Rate" value={`${pv.exchange_rate} (MYR per 1 ${viewCurrency})`} />}
              <InfoCell label="Notes" value={pv.notes ?? null} />
            </div>
          ) : (
            <div className={styles.formGrid2}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Payee *</span>
                <input type="text" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} className={styles.fieldInput} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Supplier {purpose === 'SUPPLIER_PAYMENT' ? '*' : '(optional)'}</span>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={styles.fieldInput} disabled={suppliersQ.isLoading}>
                  <option value="">— None (free-text payee) —</option>
                  {sortByText(suppliersQ.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Purpose</span>
                <span className={styles.selectWrap}>
                  <select className={styles.fieldSelect} value={purpose} onChange={(e) => setPurpose(e.target.value as 'SUPPLIER_PAYMENT' | 'FREIGHT' | 'OTHER')}>
                    <option value="SUPPLIER_PAYMENT">Supplier payment (settle PI)</option>
                    <option value="FREIGHT">Freight</option>
                    <option value="OTHER">Other</option>
                  </select>
                  <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
                </span>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Paid From (Credit) *</span>
                <AccountSelect accounts={accounts} value={creditAccountCode} onChange={setCreditAccountCode} className={styles.fieldInput} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Voucher Date *</span>
                <DateField fullWidth value={voucherDate ?? ''} onChange={(iso) => setVoucherDate(iso)} className={styles.fieldInput} />
              </label>
              {/* Multi-currency (Phase 1-A) — exchange rate shown ONLY for a foreign
                  currency (the PV follows the chosen supplier's default). */}
              {isForeign && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Exchange rate (MYR per 1 {editCurrency})</span>
                  <input type="number" min={0} step="0.000001" inputMode="decimal"
                    value={exchangeRate}
                    onChange={(e) => { setMyrPaidSen(null); setExchangeRate(e.target.value); }}
                    className={styles.fieldInput} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }} />
                </label>
              )}
              {/* Ringgit in, rate out — see PaymentVoucherNew for the reasoning. Also
                  the figure the invoice adopts: posting this voucher writes the rate
                  onto the foreign PI it knocks off and re-costs that PI's GRN. */}
              {isForeign && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Actual MYR paid (optional)</span>
                  <MoneyInput bare valueSen={myrPaidSen ?? 0}
                    onCommit={(sen) => setMyrPaidSen((sen ?? 0) > 0 ? (sen as number) : null)}
                    inputClassName={styles.fieldInput} selectOnFocus />
                  <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginTop: 2 }}>
                    {derivedRate !== null
                      ? <>Derived rate {derivedRate} MYR per 1 {editCurrency} — the invoice you knock off will adopt it</>
                      : <>What actually left the bank for this {editCurrency} payment. The rate is worked out from it.</>}
                  </span>
                </label>
              )}
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Notes</span>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={styles.fieldInput} rows={2} style={{ resize: 'vertical', minHeight: 60 }} />
              </label>
            </div>
          )}
        </div>
      </section>

      {/* ── Lines ─────────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Lines ({isEditing ? editLines.length : lines.length})</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>total {fmtRm(totalSen, currency)}</span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {!isEditing ? (
            lines.length === 0 ? (
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>No lines.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    <th style={{ padding: '6px 8px' }}>#</th>
                    <th style={{ padding: '6px 8px' }}>Description</th>
                    <th style={{ padding: '6px 8px' }}>Account (Debit)</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l.id} style={{ borderTop: '1px solid var(--line)' }}>
                      <td style={{ padding: '6px 8px', color: 'var(--fg-muted)' }}>{idx + 1}</td>
                      <td style={{ padding: '6px 8px' }}>{l.description || '—'}</td>
                      <td style={{ padding: '6px 8px' }}>{accountLabel(l.debit_account_code)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtRm(Number(l.amount_sen ?? 0), currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            <>
              {editLines.map((l, idx) => (
                <div key={l.rid} style={{
                  background: 'var(--c-paper)', border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)',
                  display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'var(--font-button)', fontSize: 'var(--fs-12)', fontWeight: 700, letterSpacing: '0.10em', color: 'var(--fg-muted)' }}>LINE {idx + 1}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <span className={styles.previewPrice}>{fmtRm(l.amountSen, currency)}</span>
                      {editLines.length > 1 && (
                        <button type="button" onClick={() => dropLine(l.rid)} title="Remove line"
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--c-festive-b, #B8331F)', padding: 4, display: 'inline-flex' }}>
                          <Trash2 {...SM_ICON} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className={styles.formGrid2}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Description</span>
                      <input type="text" value={l.description} onChange={(e) => setLine(l.rid, { description: e.target.value })} className={styles.fieldInput} />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Account (Debit) *</span>
                      <AccountSelect accounts={accounts} value={l.debitAccountCode} onChange={(v) => setLine(l.rid, { debitAccountCode: v })} className={styles.fieldInput} />
                    </label>
                  </div>
                  <div className={styles.formGrid4} style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Amount (MYR)</span>
                      <MoneyInput bare valueSen={l.amountSen}
                        onCommit={(sen) => setLine(l.rid, { amountSen: sen ?? 0 })}
                        inputClassName={styles.fieldInput} selectOnFocus />
                    </label>
                  </div>
                </div>
              ))}
              <button type="button" onClick={addLine}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '12px 14px', border: '1px dashed var(--c-orange)', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--c-orange)', fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-13)', fontWeight: 600, cursor: 'pointer' }}>
                <Plus {...SM_ICON} /> Add another line
              </button>
            </>
          )}
        </div>
      </section>

      {/* ── Linked PIs (migration 0202) ─────────────────────────────────── */}
      {(purpose === 'SUPPLIER_PAYMENT' || allocations.length > 0) && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Linked Purchase Invoices</h2>
            {isEditing && editApplyToPi ? (
              <span style={{ fontSize: 'var(--fs-12)', color: editOverAllocated ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)' }}>
                Allocated {fmtRm(editAllocatedSen)} / PV total {fmtRm(editTotalSen)}
              </span>
            ) : (
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                {allocations.length} invoice{allocations.length === 1 ? '' : 's'} settled
              </span>
            )}
          </div>
          <div className={styles.cardBody}>
            {isEditing && editApplyToPi ? (
              !supplierId ? (
                <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>Pick a supplier to list outstanding invoices.</p>
              ) : piListQ.isLoading ? (
                <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>Loading outstanding invoices…</p>
              ) : editAllocRows.length === 0 ? (
                <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>This supplier has no outstanding purchase invoices.</p>
              ) : (
                <>
                  {editOverAllocated && (
                    <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-festive-b, #B8331F)', marginBottom: 'var(--space-2)' }}>
                      You've applied more than the voucher total — reduce the amounts below before saving.
                    </div>
                  )}
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        <th style={{ padding: '6px 8px' }}>Invoice</th>
                        <th style={{ padding: '6px 8px' }}>Supplier Ref</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right' }}>Outstanding</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right' }}>Apply</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editAllocRows.map((r) => (
                        <tr key={r.piId} style={{ borderTop: '1px solid var(--line)' }}>
                          <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>{r.invoiceNumber}</td>
                          <td style={{ padding: '6px 8px', color: r.supplierInvoiceRef ? 'var(--fg)' : 'var(--fg-muted)' }}>{r.supplierInvoiceRef || '—'}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>{fmtRm(r.outstandingSen)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                            <MoneyInput bare valueSen={allocAmounts[r.piId] ?? 0}
                              onCommit={(sen) => {
                                const v = Math.max(0, Math.min(r.outstandingSen, sen ?? 0));
                                setAllocAmounts((prev) => ({ ...prev, [r.piId]: v }));
                              }}
                              inputClassName={styles.fieldInput} selectOnFocus />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )
            ) : allocations.length === 0 ? (
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>No purchase invoices settled by this voucher.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    <th style={{ padding: '6px 8px' }}>Invoice</th>
                    <th style={{ padding: '6px 8px' }}>Supplier Ref</th>
                    <th style={{ padding: '6px 8px' }}>Status</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((a) => {
                    const piId = String(a.piId ?? a.pi_id ?? '');
                    return (
                      <tr key={a.id ?? piId} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                          {piId
                            ? <Link to={`/scm/purchase-invoices/${piId}`} style={{ color: 'var(--c-orange)' }}>{a.invoiceNumber ?? a.invoice_number ?? piId}</Link>
                            : (a.invoiceNumber ?? a.invoice_number ?? '—')}
                        </td>
                        <td style={{ padding: '6px 8px', color: (a.supplierInvoiceRef ?? a.supplier_invoice_ref) ? 'var(--fg)' : 'var(--fg-muted)' }}>{a.supplierInvoiceRef ?? a.supplier_invoice_ref ?? '—'}</td>
                        <td style={{ padding: '6px 8px' }}>
                          {a.status ? <StatusPill docType="pi" status={String(a.status)} /> : '—'}
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtRm(Number(a.amountSen ?? a.amount_sen ?? 0))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {/* ── The advance this voucher holds, and the knock-off that spends it
          (预付挂在 supplier, 2026-09-02). Rendered only when a posted supplier
          voucher paid ahead and money remains on it. */}
      {pv.status === 'POSTED' && pv.supplier_id && (
        <AdvanceCard pvId={String(pv.id)} supplierId={String(pv.supplier_id)} />
      )}

      {/* ── Totals ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <section className={styles.card} style={{ maxWidth: 360, width: '100%' }}>
          <div className={styles.cardBody}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-16)', fontWeight: 700 }}>
              <span>Total</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(totalSen, currency)}</span>
            </div>
            {/* Multi-currency (Phase 1-A) — MYR posted to GL for a foreign PV. */}
            {isForeign && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', marginTop: 'var(--space-2)' }}>
                <span>≈ posted to GL</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(Math.round(totalSen * rate), 'MYR')}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* History drawer — portals to <body>, so its position here is only
          about lifecycle, not layout. */}
      {historyOpen && (
        <EntityHistoryPanel
          entityType="PAYMENT_VOUCHER"
          entityId={String(pv.id)}
          recordLabel={pv.pv_number}
          entityName="Payment voucher"
          labels={PAYMENT_VOUCHER_AUDIT_LABELS}
          statusDocType="pv"
          onClose={closeHistory}
        />
      )}
    </div>
  );
};

/* ── The advance card — money this voucher paid ahead, spent from HERE ──────
   Knock-off only: applying settles the invoice's paid_sen and burns the
   advance; NOTHING posts, because both legs already live in AP. The card
   disappears when the advance is spent to zero. */
const AdvanceCard = ({ pvId, supplierId }: { pvId: string; supplierId: string }) => {
  const advancesQ = useSupplierAdvances(supplierId);
  const applyM = useApplyAdvance();
  const piListQ = usePurchaseInvoices();
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [note, setNote] = useState<string | null>(null);

  const mine = (advancesQ.data?.advances ?? []).find((a: { pv_id: string }) => a.pv_id === pvId) ?? null;

  const outstanding = useMemo(() => {
    return ((piListQ.data?.purchaseInvoices ?? []) as Array<{
      id: string; invoice_number?: string | null; supplier_id?: string | null;
      supplier?: { id?: string | null } | null; status?: string | null;
      total_sen?: number | null; paid_sen?: number | null; invoice_date?: string | null;
    }>)
      .filter((r) => {
        const sid = String(r.supplier_id ?? r.supplier?.id ?? '');
        const st = String(r.status ?? '').toUpperCase();
        return sid === supplierId && (st === 'POSTED' || st === 'PARTIALLY_PAID')
          && Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0) > 0;
      })
      .sort((a, b) => String(a.invoice_date ?? '').localeCompare(String(b.invoice_date ?? '')));
  }, [piListQ.data, supplierId]);

  if (!mine) return null;
  const remaining = mine.remaining_sen;
  const asked = Object.values(amounts).reduce((s, v) => s + v, 0);
  const over = asked > remaining;

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Advance on this voucher</h2>
        <span style={{ fontSize: 'var(--fs-12)', color: over ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)' }}>
          {fmtRm(remaining)} unspent{asked > 0 ? ` · applying ${fmtRm(asked)}` : ''}
        </span>
      </div>
      <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <p style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', margin: 0 }}>
          This voucher paid ahead of any invoice. Knock the remainder off the supplier&rsquo;s
          outstanding invoices below — no money moves; both legs are already in AP.
        </p>
        {outstanding.length === 0 ? (
          <p style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', margin: 0 }}>No outstanding invoice from this supplier yet — the advance waits.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <th style={{ padding: '6px 8px' }}>Invoice</th>
                <th style={{ padding: '6px 8px' }}>Date</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Outstanding</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Knock off</th>
              </tr>
            </thead>
            <tbody>
              {outstanding.map((r) => {
                const piId = String(r.id);
                const out = Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0);
                return (
                  <tr key={piId} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>{String(r.invoice_number ?? piId)}</td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: 'var(--fg-muted)' }}>{fmtDate(r.invoice_date as string | null)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>{fmtRm(out)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      <MoneyInput bare valueSen={amounts[piId] ?? 0}
                        onCommit={(sen) => setAmounts((prev) => ({ ...prev, [piId]: Math.max(0, Math.min(out, sen ?? 0)) }))}
                        inputClassName={styles.fieldInput} selectOnFocus />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span style={{ flex: 1, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{note}</span>
          <Button variant="primary" size="sm"
            disabled={applyM.isPending || asked === 0 || over}
            onClick={() => {
              setNote(null);
              const allocations = Object.entries(amounts)
                .filter(([, v]) => v > 0)
                .map(([piId, amountSen]) => ({ piId, amountSen }));
              applyM.mutate({ pvId, allocations }, {
                onSuccess: (d: { appliedSen: number; remainingSen: number }) => { setAmounts({}); setNote(`Knocked off ${fmtRm(d.appliedSen)} — ${fmtRm(d.remainingSen)} of the advance remains.`); },
                onError: (e) => setNote(e instanceof Error ? e.message : 'Not applied.'),
              });
            }}>
            {applyM.isPending ? 'Applying…' : 'Apply advance'}
          </Button>
        </div>
      </div>
    </section>
  );
};
