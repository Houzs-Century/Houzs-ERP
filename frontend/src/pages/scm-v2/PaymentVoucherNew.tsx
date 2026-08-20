// ----------------------------------------------------------------------------
// PaymentVoucherNew — full-page Create Payment Voucher at /scm/payment-vouchers/new.
//
// A "very plain" cash-out voucher to pay a vendor that is NOT a goods invoice
// (freight forwarder, one-off service):
//   • Payee (free text) + optional supplier link (auto-fills payee)
//   • Credit account — the bank / cash / AP the money is paid FROM
//   • Lines — description + debit account (the expense/charge) + amount
//   • Purpose — SUPPLIER_PAYMENT opens "Apply to PI" (settle the supplier's
//     outstanding invoices at face value); FREIGHT / OTHER are plain cash-out.
//
// Saves as DRAFT (POST /payment-vouchers); the user posts to the GL from the
// detail page. STANDALONE — no PO / landed-cost allocation here.
//
// HOUZS VENDOR — port of 2990's apps/backend/src/pages/PaymentVoucherNew.tsx,
// Phase 1-B MYR: the foreign-currency selection UI (currency picker, exchange
// rate, MYR-equivalent) is DROPPED (that is phase A) — the PV is always MYR. The
// "Apply to PI" picker derives the supplier's outstanding PIs client-side from
// the PI list (Houzs has no supplier-filtered outstanding endpoint yet).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Save, Trash2, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useCreatePaymentVoucher } from '../../vendor/scm/lib/payment-voucher-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useAccounts, type Account } from '../../vendor/scm/lib/accounting-queries';
import { usePurchaseInvoices } from '../../vendor/scm/lib/purchase-invoice-queries';
import { useSuppliers, useSupplierDetail } from '../../vendor/scm/lib/suppliers-queries';
import { useActiveCurrencies, rateFor } from '../../vendor/scm/lib/currencies-queries';
import { CurrencySelect } from '../../vendor/scm/components/CurrencySelect';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { DateField } from '../../vendor/scm/components/DateField';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { resolveFxRate, deriveRateFromMyrPaid } from './fx-rate';

const ICON    = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string => {
  const v = centi ?? 0;
  return `${currency} ${(v / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/* Migration 0202 — what this voucher is FOR. SUPPLIER_PAYMENT settles a
   supplier's outstanding PIs at face value (the "Apply to PI" section);
   FREIGHT / OTHER are plain cash-out vouchers (lines only, no settlement). */
type PvPurpose = 'SUPPLIER_PAYMENT' | 'FREIGHT' | 'OTHER';

type DraftLine = {
  rid:              string;
  description:      string;
  debitAccountCode: string;
  amountSen:      number;
};

const newLine = (): DraftLine => ({
  rid:              `l${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  description:      '',
  debitAccountCode: '',
  amountSen:      0,
});

/* One outstanding-PI row in the "Apply to PI" picker, with the amount the
   operator chooses to apply (centi, MYR). */
type PiAlloc = {
  piId:               string;
  invoiceNumber:      string;
  supplierInvoiceRef: string | null;
  outstandingSen:   number;
  amountSen:        number;
};

export const PaymentVoucherNew = () => {
  const navigate = useNavigate();
  const create   = useCreatePaymentVoucher();
  /* One key for the one voucher this page is open to raise (lib/idempotency.ts).
     Minted once by useState's lazy init: stable across re-renders and across a
     re-press after a stalled submit. Like GrnNew (which carries the full
     reasoning) this page shows a dialog instead of navigating, so the mount can
     outlive the document; the same trade applies and lands the same way — the
     lines are not reset on success, so a re-press submits the SAME voucher and
     replay is the right answer, and the dialog names the FIRST pvNumber rather
     than failing silently. */
  const idemKey  = useIdempotencyKey();
  const saving   = create.isPending;

  const accountsQ = useAccounts();
  const accounts  = useMemo<Account[]>(() => (accountsQ.data?.accounts ?? []).filter((a) => a.is_active), [accountsQ.data]);

  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  const [payeeName, setPayeeName]                 = useState<string>('');
  const [supplierId, setSupplierId]               = useState<string>('');
  const [purpose, setPurpose]                     = useState<PvPurpose>('SUPPLIER_PAYMENT');
  const [creditAccountCode, setCreditAccountCode] = useState<string>('');
  const [voucherDate, setVoucherDate]             = useState<string>(() => todayMyt());
  const [notes, setNotes]                         = useState<string>('');
  /* Multi-currency (Phase 1-A) — MYR per 1 unit of the PV currency, string-typed.
     Shown only for a foreign currency; MYR posts 1:1 (no-op). */
  const [exchangeRate, setExchangeRate]           = useState<string>('1');
  /* WHERE THE RATE CAME FROM. Three sources, and the effect below only overwrites
     the rate for the one that is still 'auto':
       'auto' — the currency master's rate_to_myr (the old rateTouched=false case);
       'myr'  — DERIVED from the ringgit the operator says actually left the bank;
       'rate' — typed straight into the rate field.
     The owner does not think in rates: he knows "I paid RM 13,404 for this ¥21,625
     invoice". 'myr' is that input; 'rate' stays as the fallback for anyone who does
     think in rates, and the rate field remains editable either way. */
  const [rateSource, setRateSource]               = useState<'auto' | 'rate' | 'myr'>('auto');
  /* The actual MYR paid, integer sen. null = not entered. */
  const [myrPaidSen, setMyrPaidSen]               = useState<number | null>(null);
  /* Multi-currency (Phase 1-A) — operator-chosen currency; defaults to the linked
     supplier's currency (below). */
  const [currencyOverride, setCurrencyOverride]   = useState<string | null>(null);
  const [lines, setLines]                         = useState<DraftLine[]>([newLine()]);
  const [dialog, setDialog] = useState<{ title: string; body: string; goTo?: string } | null>(null);

  // Supplier link is optional. When set, auto-fill the payee (if blank) + adopt
  // the supplier's default currency (e.g. a China vendor billing RMB).
  const supplierRow = useMemo(() => (suppliersQ.data ?? []).find((s) => s.id === supplierId) ?? null, [suppliersQ.data, supplierId]);
  const supplierDetailQ = useSupplierDetail(supplierId || null);
  const supplierDetail  = supplierDetailQ.data?.supplier ?? null;
  useEffect(() => {
    if (!supplierRow) return;
    setPayeeName((prev) => prev.trim() ? prev : supplierRow.name);
  }, [supplierRow]);

  /* Multi-currency (Phase 1-A) — the PV's currency defaults to the linked
     supplier's currency; MYR when unset (strict no-op, no rate field). The
     operator may override it. The rate converts the GL posting to MYR at
     post-time server-side. */
  const currency  = (currencyOverride ?? supplierDetail?.currency ?? supplierRow?.currency ?? 'MYR').toUpperCase();
  const isForeign = currency !== 'MYR';
  /* Auto-fill the rate from the currencies MASTER when the PV settles on a foreign
     currency (still editable). MYR resets to 1; a manual edit wins. */
  const currenciesQ = useActiveCurrencies();
  useEffect(() => {
    if (!isForeign) { setExchangeRate('1'); setRateSource('auto'); setMyrPaidSen(null); return; }
    if (rateSource !== 'auto') return;
    setExchangeRate(String(rateFor(currenciesQ.data, currency)));
  }, [isForeign, currency, currenciesQ.data, rateSource]);

  const setLine  = (rid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.rid !== rid)));
  const addLine  = () => setLines((prev) => [...prev, newLine()]);

  const totalSen = useMemo(() => lines.reduce((s, l) => s + l.amountSen, 0), [lines]);

  /* RINGGIT IN, RATE OUT. The rate is derived from the MYR actually paid divided by
     the foreign face total, and RE-derived when either side moves — editing a line
     amount after entering the ringgit must not leave a rate that no longer matches
     what was paid. deriveRateFromMyrPaid returns null for a zero/blank figure on
     EITHER side (the divide-by-zero included), and null leaves the rate alone rather
     than blanking it to something resolveFxRate would fold back to 1. */
  const derivedRate = useMemo(
    () => (isForeign ? deriveRateFromMyrPaid(myrPaidSen, totalSen) : null),
    [isForeign, myrPaidSen, totalSen],
  );
  useEffect(() => {
    if (rateSource !== 'myr' || derivedRate === null) return;
    setExchangeRate(String(derivedRate));
  }, [rateSource, derivedRate]);

  /* ── Apply to PI (migration 0202) ─────────────────────────────────────────
     Only for a SUPPLIER_PAYMENT voucher with a supplier chosen: list that
     supplier's outstanding PIs (derived client-side from the PI list — POSTED /
     PARTIALLY_PAID with total − paid > 0) and let the operator apply an amount
     per PI. The allocations settle AP at face value (MYR). */
  const applyToPi = purpose === 'SUPPLIER_PAYMENT' && !!supplierId;
  const piListQ = usePurchaseInvoices();
  const outstandingPiRows = useMemo(() => {
    if (!applyToPi) return [] as Array<Record<string, any>>;
    return ((piListQ.data?.purchaseInvoices ?? []) as Array<Record<string, any>>).filter((r) => {
      const sid = String(r.supplier_id ?? r.supplier?.id ?? '');
      if (sid !== supplierId) return false;
      const st = String(r.status ?? '').toUpperCase();
      if (st !== 'POSTED' && st !== 'PARTIALLY_PAID') return false;
      const outstanding = Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0);
      return outstanding > 0;
    });
  }, [applyToPi, piListQ.data, supplierId]);

  // The per-PI amounts the operator has entered, keyed by PI id. Seeded lazily
  // (defaults below) the first time a PI row renders, so a manual 0 sticks.
  const [allocAmounts, setAllocAmounts] = useState<Record<string, number>>({});
  // Wipe allocations whenever we leave SUPPLIER_PAYMENT or change supplier.
  useEffect(() => { setAllocAmounts({}); }, [purpose, supplierId]);

  // Default an unentered row to min(remaining PV total, this PI's outstanding).
  const allocations: PiAlloc[] = useMemo(() => {
    let remaining = totalSen;
    return outstandingPiRows.map((r) => {
      const piId = String(r.id ?? '');
      const outstanding = Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0);
      const entered = allocAmounts[piId];
      const dflt = Math.max(0, Math.min(remaining, outstanding));
      const amountSen = entered != null ? entered : dflt;
      remaining = Math.max(0, remaining - amountSen);
      return {
        piId,
        invoiceNumber:      String(r.invoice_number ?? piId),
        supplierInvoiceRef: (r.supplier_invoice_ref ?? null) as string | null,
        outstandingSen:   outstanding,
        amountSen,
      };
    });
  }, [outstandingPiRows, allocAmounts, totalSen]);

  const allocatedSen = useMemo(() => allocations.reduce((s, a) => s + a.amountSen, 0), [allocations]);
  const overAllocated  = applyToPi && allocatedSen > totalSen;

  const realLines = lines.filter((l) => l.debitAccountCode && l.amountSen > 0);
  const canSave = !!payeeName.trim() && !!creditAccountCode && realLines.length > 0 && !overAllocated;

  const onSave = async () => {
    if (!payeeName.trim()) { setDialog({ title: 'Enter a payee', body: 'Who is this voucher paying?' }); return; }
    if (!creditAccountCode) { setDialog({ title: 'Pick a “Paid From” account', body: 'Choose the bank / cash / payables account the money leaves.' }); return; }
    if (realLines.length === 0) { setDialog({ title: 'Add at least one line', body: 'Each line needs a debit account and an amount > 0.' }); return; }
    if (overAllocated) {
      setDialog({ title: 'Applied more than the voucher total', body: `You've applied ${fmtRm(allocatedSen)} to PIs but the voucher total is only ${fmtRm(totalSen)}. Reduce the applied amounts or raise the voucher total.` });
      return;
    }
    // Only send allocations for a SUPPLIER_PAYMENT voucher, and only rows the
    // operator actually applied (amount > 0). FREIGHT / OTHER send none.
    const sendAllocations = applyToPi
      ? allocations.filter((a) => a.amountSen > 0).map((a) => ({ piId: a.piId, amountSen: a.amountSen }))
      : [];
    try {
      const res = await create.mutateAsync({
        idempotencyKey:    idemKey,
        payeeName:         payeeName.trim(),
        supplierId:        supplierId || null,
        purpose,
        creditAccountCode,
        voucherDate,
        notes:             notes || undefined,
        // Multi-currency (Phase 1-A) — resolved currency + rate. MYR forces 1
        // (server enforces too); a blank/invalid foreign rate → 1.
        currency,
        exchangeRate:      isForeign
          ? resolveFxRate(exchangeRate)
          : 1,
        lines: realLines.map((l) => ({
          description:      l.description || undefined,
          debitAccountCode: l.debitAccountCode,
          amountSen:      l.amountSen,
        })),
        ...(sendAllocations.length > 0 ? { allocations: sendAllocations } : {}),
      });
      setDialog({
        title: `Voucher ${res.pvNumber} created`,
        body: 'Saved as a draft — open it to post to the GL.',
        goTo: `/scm/payment-vouchers/${res.id}`,
      });
    } catch (err) {
      setDialog({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.' });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Finance"
        title="New Payment Voucher"
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/payment-vouchers')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button variant="primary" size="md" onClick={onSave} disabled={saving || !canSave}>
              <Save {...ICON} />
              {saving ? 'Saving…' : 'Create Voucher'}
            </Button>
          </div>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Header</h2></div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Payee *</span>
              <input type="text" value={payeeName} onChange={(e) => setPayeeName(e.target.value)}
                placeholder="Who are we paying? (e.g. ABC Freight Forwarding)" className={styles.fieldInput} required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>PV #</span>
              <input type="text" readOnly value="(assigned on Save)" className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier {purpose === 'SUPPLIER_PAYMENT' ? '*' : '(optional)'}</span>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={styles.fieldInput} disabled={suppliersQ.isLoading}>
                <option value="">{suppliersQ.isLoading ? 'Loading suppliers…' : '— None (free-text payee) —'}</option>
                {sortByText(suppliersQ.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Purpose</span>
              <span className={styles.selectWrap}>
                <select className={styles.fieldSelect} value={purpose} onChange={(e) => setPurpose(e.target.value as PvPurpose)}>
                  <option value="SUPPLIER_PAYMENT">Supplier payment (settle PI)</option>
                  <option value="FREIGHT">Freight</option>
                  <option value="OTHER">Other</option>
                </select>
                <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Voucher Date *</span>
              <DateField fullWidth value={voucherDate ?? ''} onChange={(iso) => setVoucherDate(iso)} className={styles.fieldInput} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Paid From (Credit) *</span>
              <AccountSelect
                accounts={accounts}
                value={creditAccountCode}
                onChange={setCreditAccountCode}
                className={styles.fieldInput}
                placeholder={accountsQ.isLoading ? 'Loading accounts…' : '— Bank / cash / payables —'}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes" className={styles.fieldInput} rows={2} style={{ resize: 'vertical', minHeight: 60 }} />
            </label>

            {/* Multi-currency (Phase 1-A). Currency defaults to the linked
                supplier's currency (MYR = strict no-op, rate field hidden); a
                foreign currency reveals the auto-filled, editable exchange rate. */}
            <CurrencySelect
              currency={currency}
              onCurrencyChange={setCurrencyOverride}
              exchangeRate={exchangeRate}
              onRateChange={(v) => { setRateSource('rate'); setMyrPaidSen(null); setExchangeRate(v); }}
              rateHint={<>≈ {fmtRm(Math.round(totalSen * resolveFxRate(exchangeRate)), 'MYR')} posted to GL</>}
              styles={styles}
            />

            {/* ── Ringgit in, rate out ─────────────────────────────────────────
                The owner knows what left the bank, not what the rate was. Enter the
                actual MYR paid and the rate is worked out from it; the rate field
                above stays editable for anyone who does think in rates. This is also
                the figure the invoice adopts: posting this voucher writes the rate
                onto the foreign PI it knocks off and re-costs that PI's GRN. */}
            {isForeign && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Actual MYR paid (optional)</span>
                <MoneyInput bare valueSen={myrPaidSen ?? 0}
                  onCommit={(sen) => {
                    const v = sen ?? 0;
                    if (v > 0) { setMyrPaidSen(v); setRateSource('myr'); }
                    else { setMyrPaidSen(null); setRateSource('auto'); }
                  }}
                  inputClassName={styles.fieldInput} selectOnFocus />
                <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginTop: 2 }}>
                  {derivedRate !== null
                    ? <>Derived rate {derivedRate} MYR per 1 {currency} — the invoice you knock off will adopt it</>
                    : <>What actually left the bank for this {currency} payment. The rate is worked out from it.</>}
                </span>
              </label>
            )}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Lines</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {lines.length} line{lines.length === 1 ? '' : 's'} · total {fmtRm(totalSen)}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {lines.map((l, idx) => (
            <div key={l.rid} style={{
              background: 'var(--c-paper)', border: '1px solid var(--line)',
              borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)',
              display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                <span style={{ fontFamily: 'var(--font-button)', fontSize: 'var(--fs-12)', fontWeight: 700, letterSpacing: '0.10em', color: 'var(--fg-muted)' }}>LINE {idx + 1}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <span className={styles.previewPrice}>{fmtRm(l.amountSen)}</span>
                  {lines.length > 1 && (
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
                  <input type="text" value={l.description} onChange={(e) => setLine(l.rid, { description: e.target.value })}
                    placeholder="e.g. Sea freight — Shenzhen → Klang" className={styles.fieldInput} />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Account (Debit) *</span>
                  <AccountSelect
                    accounts={accounts}
                    value={l.debitAccountCode}
                    onChange={(v) => setLine(l.rid, { debitAccountCode: v })}
                    className={styles.fieldInput}
                    placeholder={accountsQ.isLoading ? 'Loading accounts…' : '— Expense / charge account —'}
                  />
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
            + Add another line
          </button>
        </div>
      </section>

      {/* ── Apply to PI (migration 0202) — settle the supplier's outstanding PIs
          at face value. Only for a SUPPLIER_PAYMENT voucher with a supplier
          chosen; the operator applies an amount per PI (defaults to the lesser
          of the remaining voucher total and that PI's outstanding balance). ── */}
      {purpose === 'SUPPLIER_PAYMENT' && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Apply to PI</h2>
            <span style={{ fontSize: 'var(--fs-12)', color: overAllocated ? 'var(--c-festive-b, #B8331F)' : 'var(--fg-muted)' }}>
              {applyToPi
                ? `Allocated ${fmtRm(allocatedSen)} / PV total ${fmtRm(totalSen)}`
                : 'Pick a supplier above to list outstanding invoices'}
            </span>
          </div>
          <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {!applyToPi ? (
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>
                Choose a supplier in the header to settle their outstanding purchase invoices with this voucher.
              </p>
            ) : piListQ.isLoading ? (
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>Loading outstanding invoices…</p>
            ) : allocations.length === 0 ? (
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>This supplier has no outstanding purchase invoices.</p>
            ) : (
              <>
                {overAllocated && (
                  <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-festive-b, #B8331F)' }}>
                    You've applied more than the voucher total — reduce the amounts below or raise the voucher total before saving.
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
                    {allocations.map((a) => (
                      <tr key={a.piId} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>{a.invoiceNumber}</td>
                        <td style={{ padding: '6px 8px', color: a.supplierInvoiceRef ? 'var(--fg)' : 'var(--fg-muted)' }}>{a.supplierInvoiceRef || '—'}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>{fmtRm(a.outstandingSen)}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                          <MoneyInput bare valueSen={a.amountSen}
                            onCommit={(sen) => {
                              const v = Math.max(0, Math.min(a.outstandingSen, sen ?? 0));
                              setAllocAmounts((prev) => ({ ...prev, [a.piId]: v }));
                            }}
                            inputClassName={styles.fieldInput} selectOnFocus />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </section>
      )}

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
                <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtRm(Math.round(totalSen * resolveFxRate(exchangeRate)), 'MYR')}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          primaryLabel={dialog.goTo ? 'Open Voucher' : undefined}
          onPrimary={dialog.goTo ? () => { const g = dialog.goTo!; setDialog(null); navigate(g); } : undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
