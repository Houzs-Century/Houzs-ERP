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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Save, Trash2, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useCreatePaymentVoucher, usePaymentVoucherDetail, useSupplierAdvances, useExtractBills, useUploadPvFile, fileToBase64, type BillExtraction, type VendorMemory, type PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { takePvFiles } from '../../vendor/scm/lib/pv-file-handoff';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useAccounts, useAccountRoles, type Account } from '../../vendor/scm/lib/accounting-queries';
import { usePurchaseInvoices } from '../../vendor/scm/lib/purchase-invoice-queries';
import { useApInvoices } from '../../vendor/scm/lib/ap-invoice-queries';
import { useSuppliers, useSupplierDetail } from '../../vendor/scm/lib/suppliers-queries';
import { useActiveCurrencies, rateFor } from '../../vendor/scm/lib/currencies-queries';
import { CurrencySelect } from '../../vendor/scm/components/CurrencySelect';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { DateField } from '../../vendor/scm/components/DateField';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { fmtDate } from '../../vendor/shared/format';
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
  /** The row's id — a purchase invoice's, or (kind API) an AP invoice's. */
  piId:               string;
  /** A purchase invoice (stock) or an AP invoice (the non-stock bill, owner
      2026-09-06) — both settle here, the payload names which. */
  kind:               'PI' | 'API';
  invoiceNumber:      string;
  supplierInvoiceRef: string | null;
  invoiceDate:        string | null;
  outstandingSen:   number;
  amountSen:        number;
};

export const PaymentVoucherNew = () => {
  const navigate = useNavigate();
  /* TWO DOCUMENTS, ONE PAGE (the owner, 2026-08-30, AutoCount in hand: 正常
     auto count是可以选payment voucher / AP Payment). ?type=ap is the AP
     Payment: supplier required, the PI list IS the document (tick to pay in
     full, type for partial), and the GL debit is the AP control account —
     written by the page, never picked by hand. Without ?type it is the plain
     Payment Voucher: expense lines only, no supplier, no PI section. */
  const [searchParams] = useSearchParams();
  const isAp = searchParams.get('type') === 'ap';
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
  /* Paid From offers MONEY only (owner: paid from 应该只能选cash 和银行) — the
     server refuses anything else anyway; the picker just stops offering it. */
  const moneyAccounts = useMemo<Account[]>(() => accounts.filter((a) => a.acc_money === true), [accounts]);
  const rolesQ = useAccountRoles();

  const suppliersQ = useSuppliers({ status: 'ACTIVE' });

  const [payeeName, setPayeeName]                 = useState<string>('');
  const [supplierId, setSupplierId]               = useState<string>('');
  /* Fixed by the document type — AP Payment settles PIs, Payment Voucher is
     plain cash-out. The old three-way dropdown is gone with the split. */
  const purpose: PvPurpose = isAp ? 'SUPPLIER_PAYMENT' : 'OTHER';
  const [creditAccountCode, setCreditAccountCode] = useState<string>('');
  /* Pre-fill Paid From with the company's own default bank (BANK_DEFAULT —
     the role the owner maintains in Recon Setup). Only while untouched. */
  useEffect(() => {
    const dflt = rolesQ.data?.roles.BANK_DEFAULT;
    if (!dflt || creditAccountCode) return;
    if (moneyAccounts.some((a) => a.account_code === dflt)) setCreditAccountCode(dflt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolesQ.data, moneyAccounts]);
  const [voucherDate, setVoucherDate]             = useState<string>(() => todayMyt());
  const [notes, setNotes]                         = useState<string>('');

  /* Internal transfer INSIDE the PV (GL redesign item 10, owner: 不能直接在
     pv 那边开转账就好吗) — same document, same Draft→Checked→Approved chain,
     same per-bank number series. The "payee" becomes one of our own money
     accounts and the lines collapse to a single Dr <destination> leg; the
     server refuses destination === Paid From (same_account). PV mode only —
     an AP Payment settles suppliers by definition. */
  const [isTransfer, setIsTransfer]               = useState(false);
  const [toAccountCode, setToAccountCode]         = useState<string>('');
  const [transferAmount, setTransferAmount]       = useState<string>('');
  const transferSen = Math.round((Number(transferAmount) || 0) * 100);
  const toAccount = moneyAccounts.find((a) => a.account_code === toAccountCode) ?? null;

  /* ── Bill OCR (2026-09-02) ──────────────────────────────────────────────
     "Scan bill": pick the bill's page(s) — MULTI-SELECT MEANS ONE BILL — and
     the reader pre-fills payee / date / lines. Everything stays editable;
     nothing saves until the person presses save. The batch screen
     (/scm/payment-vouchers/scan) hands its per-group prefill in via
     location.state through the same applyExtraction. */
  const location = useLocation();
  const extract = useExtractBills();
  const [scanNote, setScanNote] = useState<string | null>(null);
  /* The scanned bill's own bytes, waiting to ATTACH once the voucher exists
     (owner 2026-09-03: print pv include ocr 的文件一起 — so the file must
     live with the voucher, not die with this tab). Filled by the batch
     screen's hand-off or by this page's own Scan bill; uploaded after a
     successful save, in scan order. */
  const [pendingFiles, setPendingFiles] = useState<PvFilePayload[]>([]);
  const uploadPvFile = useUploadPvFile();
  const applyExtraction = (ex: BillExtraction, extras?: { lines?: Array<{ description: string | null; amountSen: number | null }>; memory?: VendorMemory | null }) => {
    /* Vendor memory FIRST for the payee — the operator's own casing beats the
       print ("TNB" over "TENAGA NASIONAL BERHAD"); the print fills the gap. */
    const payee = extras?.memory?.payeeName ?? ex.vendorName;
    if (payee) setPayeeName((prev) => prev.trim() ? prev : payee);
    if (ex.invoiceDate) setVoucherDate(ex.invoiceDate);
    const noteBits = [
      ex.invoiceNumber ? `Bill ${ex.invoiceNumber}` : null,
      ex.dueDate ? `due ${ex.dueDate}` : null,
    ].filter(Boolean).join(' · ');
    if (noteBits) setNotes((prev) => prev.trim() ? prev : noteBits);
    /* The account: ONLY what this operator saved for this vendor before
       (mig 0341) — never a model guess. Absent a memory it stays empty and a
       person picks it. */
    const rememberedAccount = extras?.memory?.debitAccountCode ?? '';
    const srcLines = extras?.lines ?? ex.lines;
    const drafts = srcLines
      .filter((l) => l.amountSen != null && l.amountSen > 0)
      .map((l) => ({ ...newLine(), description: l.description ?? '', amountSen: l.amountSen!, debitAccountCode: rememberedAccount }));
    /* A bill with no readable lines still carries its total — one line. */
    if (drafts.length === 0 && ex.totalSen != null && ex.totalSen > 0) {
      drafts.push({ ...newLine(), description: ex.invoiceNumber ? `Bill ${ex.invoiceNumber}` : 'As per bill', amountSen: ex.totalSen, debitAccountCode: rememberedAccount });
    }
    if (drafts.length > 0) setLines(drafts);
  };
  /* The batch screen's hand-off. Its files come via the module stash, not
     location.state (a big PDF would blow the history-entry size cap — see
     pv-file-handoff.ts); take() clears, so only set when something was
     actually taken (a double-run effect must not wipe the first take). */
  useEffect(() => {
    const st = location.state as { billPrefill?: { extraction: BillExtraction; lines?: Array<{ description: string | null; amountSen: number | null }>; memory?: VendorMemory | null } } | null;
    if (st?.billPrefill) {
      applyExtraction(st.billPrefill.extraction, { lines: st.billPrefill.lines, memory: st.billPrefill.memory });
      const carried = takePvFiles();
      if (carried.length > 0) setPendingFiles(carried);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onScanFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setScanNote('Reading the bill…');
    try {
      const files = await Promise.all([...list].map(async (f) => ({
        name: f.name, mime: f.type || 'application/pdf',
        dataBase64: await fileToBase64(f),
      })));
      const res = await extract.mutateAsync([{ files }]);
      const bill = res.bills[0];
      if (!bill) { setScanNote('The bill could not be read.'); return; }
      if (!bill.ok) { setScanNote(bill.reason); return; }
      applyExtraction(bill.extraction, { memory: bill.memory });
      /* The read pages become the voucher's attachments on save. The LAST
         successful read wins, matching applyExtraction overwriting the lines
         — this page reads ONE bill at a time. */
      setPendingFiles(files);
      setScanNote([
        'Read — check every figure before saving.',
        bill.supplierMatch ? `Looks like supplier ${bill.supplierMatch.name}.` : null,
        bill.memory?.debitAccountCode
          ? `Account ${bill.memory.debitAccountCode} filled from your last ${bill.memory.payeeName ?? 'same-vendor'} voucher — check it.`
          : null,
        bill.extraction.totalSen == null ? 'The TOTAL was not readable — enter it yourself.' : null,
      ].filter(Boolean).join(' '));
    } catch (e) {
      setScanNote(e instanceof Error ? e.message : 'The bill could not be read.');
    }
  };
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

  /* ── Copy as new (the owner, 2026-09-03, AutoCount in hand) ─────────────
     ?copyFrom=<pvId> pre-fills CONTENT from an existing voucher — payee,
     supplier, Paid From, lines, notes, currency+rate — and NOTHING with an
     identity: fresh number, today's date, approvals restart at raw Draft,
     no PI applied (the source's bills may already be knocked off). The list
     row / detail button choose ?type=ap when the source is an AP Payment,
     so an AP copies to an AP. */
  const copyFrom = searchParams.get('copyFrom');
  const copyQ = usePaymentVoucherDetail(copyFrom);
  const copyApplied = useRef(false);
  useEffect(() => {
    if (!copyFrom || copyApplied.current || !copyQ.data) return;
    copyApplied.current = true;
    const v = copyQ.data.paymentVoucher as Record<string, unknown>;
    setPayeeName(String(v.payee_name ?? ''));
    if (v.supplier_id) setSupplierId(String(v.supplier_id));
    if (v.credit_account_code) setCreditAccountCode(String(v.credit_account_code));
    if (v.notes) setNotes(String(v.notes));
    const cur = typeof v.currency === 'string' ? v.currency : null;
    if (cur && cur !== 'MYR') {
      setCurrencyOverride(cur);
      const rate = v.exchange_rate == null ? '' : String(v.exchange_rate);
      if (rate) { setExchangeRate(rate); setRateSource('rate'); }
    }
    const copied = copyQ.data.lines
      .map((l) => ({
        ...newLine(),
        description: String((l as Record<string, unknown>).description ?? ''),
        amountSen: Number((l as Record<string, unknown>).amount_sen ?? 0),
        debitAccountCode: String((l as Record<string, unknown>).debit_account_code ?? ''),
      }));
    if (copied.length > 0) setLines(copied);
    setScanNote(`Copied from ${String(v.pv_number ?? 'voucher')} — new number, today's date, approvals restart; nothing is applied to bills yet.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyFrom, copyQ.data]);

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

  const linesTotalSen = useMemo(() => lines.reduce((s, l) => s + l.amountSen, 0), [lines]);

  /* RINGGIT IN, RATE OUT. The rate is derived from the MYR actually paid divided by
     the foreign face total, and RE-derived when either side moves — editing a line
     amount after entering the ringgit must not leave a rate that no longer matches
     what was paid. deriveRateFromMyrPaid returns null for a zero/blank figure on
     EITHER side (the divide-by-zero included), and null leaves the rate alone rather
     than blanking it to something resolveFxRate would fold back to 1. */
  /* Defined below, after the voucher total exists (the total now follows the
     document type — see totalSen). */

  /* ── Apply to PI (migration 0202) ─────────────────────────────────────────
     Only for a SUPPLIER_PAYMENT voucher with a supplier chosen: list that
     supplier's outstanding PIs (derived client-side from the PI list — POSTED /
     PARTIALLY_PAID with total − paid > 0) and let the operator apply an amount
     per PI. The allocations settle AP at face value (MYR). */
  const applyToPi = isAp && !!supplierId;
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
    /* Oldest first — the order you settle a supplier in (the owner asked to
       SEE the dates; the list endpoint sends newest-first for browsing). */
    }).sort((a, b) => String(a.invoice_date ?? '').localeCompare(String(b.invoice_date ?? '')));
  }, [applyToPi, piListQ.data, supplierId]);

  // The per-PI amounts the operator has entered, keyed by PI id.
  const [allocAmounts, setAllocAmounts] = useState<Record<string, number>>({});
  // Wipe allocations whenever the supplier changes.
  useEffect(() => { setAllocAmounts({}); }, [supplierId]);

  /* AP Payment: every row starts at 0 — TICK pays an invoice in full, typing
     pays part of it, and the voucher total FOLLOWS the ticks (the reverse of
     the old cascade, where lines drove a guessed spread). */
  /* The supplier's open AP INVOICES (non-stock bills) list beside the PIs —
     the owner's 我想要两个都看到 — same tick, same partial, same clamp. */
  const apListQ = useApInvoices('API');
  const outstandingApiRows = useMemo(() => {
    if (!applyToPi) return [];
    return (apListQ.data?.rows ?? []).filter((r) =>
      String(r.supplierId ?? '') === supplierId
      && (r.status === 'POSTED' || r.status === 'PARTIALLY_PAID')
      && r.outstandingSen > 0);
  }, [applyToPi, apListQ.data, supplierId]);

  const allocations: PiAlloc[] = useMemo(() => {
    const fromPis: PiAlloc[] = outstandingPiRows.map((r) => {
      const piId = String(r.id ?? '');
      const outstanding = Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0);
      const amountSen = Math.max(0, Math.min(allocAmounts[piId] ?? 0, outstanding));
      return {
        piId,
        kind:               'PI' as const,
        invoiceNumber:      String(r.invoice_number ?? piId),
        supplierInvoiceRef: (r.supplier_invoice_ref ?? null) as string | null,
        invoiceDate:        (r.invoice_date ?? null) as string | null,
        outstandingSen:   outstanding,
        amountSen,
      };
    });
    const fromApis: PiAlloc[] = outstandingApiRows.map((r) => ({
      piId: r.id,
      kind: 'API' as const,
      invoiceNumber: r.invoiceNumber,
      supplierInvoiceRef: r.supplierInvoiceRef,
      invoiceDate: r.invoiceDate,
      outstandingSen: r.outstandingSen,
      amountSen: Math.max(0, Math.min(allocAmounts[r.id] ?? 0, r.outstandingSen)),
    }));
    /* Oldest first across both kinds — the order you settle a supplier in. */
    return [...fromPis, ...fromApis].sort((a, b) => String(a.invoiceDate ?? '').localeCompare(String(b.invoiceDate ?? '')));
  }, [outstandingPiRows, outstandingApiRows, allocAmounts]);

  const allocatedSen = useMemo(() => allocations.reduce((s, a) => s + a.amountSen, 0), [allocations]);

  /* 预付 — pay AHEAD of any invoice (owner, 2026-08-30: 也可以advance payment
     先). Typed under the PI table; it rides the same voucher, the same auto
     AP debit, and on post the server records it as this supplier's advance. */
  const [advanceSen, setAdvanceSen] = useState<number>(0);
  useEffect(() => { setAdvanceSen(0); }, [supplierId]);
  /* What this supplier is ALREADY owed from earlier prepayments — informational
     here; the knock-off lives on the voucher that holds the advance. */
  const advancesQ = useSupplierAdvances(isAp && supplierId ? supplierId : null);
  const existingAdvanceSen = advancesQ.data?.totalRemainingSen ?? 0;

  /* The voucher total: an AP Payment IS its ticks plus any prepay; a Payment
     Voucher is its lines. Nothing to over-allocate in either shape. */
  const totalSen = isAp ? allocatedSen + advanceSen : linesTotalSen;

  /* RINGGIT IN, RATE OUT — re-derived when either side moves (see the header
     comment on the MYR-paid field). */
  const derivedRate = useMemo(
    () => (isForeign ? deriveRateFromMyrPaid(myrPaidSen, totalSen) : null),
    [isForeign, myrPaidSen, totalSen],
  );
  useEffect(() => {
    if (rateSource !== 'myr' || derivedRate === null) return;
    setExchangeRate(String(derivedRate));
  }, [rateSource, derivedRate]);

  /* The AP split (owner 2026-09-03): a 405-x supplier is an OTHER CREDITOR —
     its payment debits AP_OTHER (405-0000), everyone else AP (400-0000). The
     authoritative prefix rule lives server-side (acc/rules.ts apControlRole;
     create refuses the wrong control) — this is the display mirror. */
  const apAccountCode = (supplierRow?.code.startsWith('405-')
    ? rolesQ.data?.roles.AP_OTHER
    : rolesQ.data?.roles.AP) ?? '';
  const realLines = lines.filter((l) => l.debitAccountCode && l.amountSen > 0);
  const canSave = isAp
    ? !!payeeName.trim() && !!supplierId && !!creditAccountCode && totalSen > 0 && !!apAccountCode
    : isTransfer
      ? !!creditAccountCode && !!toAccountCode && toAccountCode !== creditAccountCode && transferSen > 0
      : !!payeeName.trim() && !!creditAccountCode && realLines.length > 0;

  const transferMode = !isAp && isTransfer;
  const transferPayee = toAccount ? `Internal transfer to ${toAccount.account_code} ${toAccount.account_name}` : '';
  const onSave = async () => {
    if (transferMode) {
      if (!creditAccountCode) { setDialog({ title: 'Pick a “Paid From” account', body: 'Choose the account the money leaves.' }); return; }
      if (!toAccountCode) { setDialog({ title: 'Pick the destination', body: 'Choose which of our own accounts the money goes into.' }); return; }
      if (toAccountCode === creditAccountCode) { setDialog({ title: 'Same account both sides', body: 'A transfer needs two different accounts.' }); return; }
      if (transferSen <= 0) { setDialog({ title: 'Enter the amount', body: 'How much is moving?' }); return; }
    } else {
    if (!payeeName.trim()) { setDialog({ title: 'Enter a payee', body: 'Who is this voucher paying?' }); return; }
    if (!creditAccountCode) { setDialog({ title: 'Pick a “Paid From” account', body: 'Choose the bank / cash account the money leaves.' }); return; }
    if (isAp && !supplierId) { setDialog({ title: 'Pick a supplier', body: 'An AP Payment settles a supplier — choose whose invoices this pays.' }); return; }
    if (isAp && totalSen === 0) { setDialog({ title: 'Nothing to pay yet', body: 'Tick an invoice, type a partial amount, or enter a prepay figure.' }); return; }
    if (!isAp && realLines.length === 0) { setDialog({ title: 'Add at least one line', body: 'Each line needs a debit account and an amount > 0.' }); return; }
    }

    /* AP Payment: the ONE GL line is written here — Dr the AP control account
       for exactly what the ticks apply. The operator never touches a debit
       account on this document, so it cannot be mis-booked. */
    const sendLines = transferMode
      ? [{ description: 'Internal transfer', debitAccountCode: toAccountCode, amountSen: transferSen }]
      : isAp
      ? [{
        description: [
          allocations.filter((a) => a.amountSen > 0).length > 0 ? `Settle ${allocations.filter((a) => a.amountSen > 0).length} invoice(s)` : null,
          advanceSen > 0 ? `prepay ${(advanceSen / 100).toFixed(2)}` : null,
        ].filter(Boolean).join(' + ') + ` — ${payeeName.trim()}`,
        debitAccountCode: apAccountCode, amountSen: totalSen,
      }]
      : realLines.map((l) => ({
        description:      l.description || undefined,
        debitAccountCode: l.debitAccountCode,
        amountSen:      l.amountSen,
      }));
    const sendAllocations = applyToPi
      ? allocations.filter((a) => a.amountSen > 0).map((a) => (
        a.kind === 'API'
          ? { apInvoiceId: a.piId, amountSen: a.amountSen }
          : { piId: a.piId, amountSen: a.amountSen }))
      : [];
    try {
      const res = await create.mutateAsync({
        idempotencyKey:    idemKey,
        payeeName:         transferMode ? transferPayee : payeeName.trim(),
        supplierId:        transferMode ? null : (supplierId || null),
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
        lines: sendLines,
        ...(sendAllocations.length > 0 ? { allocations: sendAllocations } : {}),
      });
      /* Attach the scanned bill AFTER the voucher exists — sequentially, so
         sort_no (= print order) is the scan order. A failed upload never
         un-saves the voucher: the dialog says which files still need adding
         (the detail page's Files card takes them), and only the UNATTACHED
         remainder stays pending — a re-press replays the same voucher via the
         idempotency key and must not attach the first files twice. */
      let attached = 0;
      let attachErr: string | null = null;
      for (const f of pendingFiles) {
        try {
          await uploadPvFile.mutateAsync({ pvId: res.id, file: f });
          attached += 1;
        } catch (e) {
          attachErr = e instanceof Error ? e.message : 'The file could not be uploaded.';
          break;
        }
      }
      if (attached > 0) setPendingFiles((prev) => prev.slice(attached));
      setDialog({
        title: `Voucher ${res.pvNumber} created`,
        body: [
          'Saved as a draft — open it to post to the GL.',
          attached > 0 ? `${attached} scanned file(s) attached.` : null,
          attachErr ? `${pendingFiles.length - attached} file(s) did not attach (${attachErr}) — add them from the voucher's Files card.` : null,
        ].filter(Boolean).join(' '),
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
        title={isAp ? 'New AP Payment' : 'New Payment Voucher'}
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/payment-vouchers')}>
              <X {...ICON} /> Cancel
            </Button>
            <Button variant="primary" size="md" onClick={onSave} disabled={saving || !canSave}>
              <Save {...ICON} />
              {saving ? 'Saving…' : isAp ? 'Create AP Payment' : 'Create Voucher'}
            </Button>
          </div>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Header</h2></div>
        <div className={styles.cardBody}>
          {!isAp && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 'var(--space-3)' }}>
              {/* 付给供应商/其他 vs 内部转账 (item 10) — same paper, same chain. */}
              <Button variant={!isTransfer ? 'primary' : 'secondary'} onClick={() => setIsTransfer(false)}>付款 Payment</Button>
              <Button variant={isTransfer ? 'primary' : 'secondary'} onClick={() => setIsTransfer(true)}>内部转账 Transfer</Button>
            </div>
          )}
          <div className={styles.formGrid2}>
            {transferMode ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Transfer to *</span>
                <select value={toAccountCode} onChange={(e) => setToAccountCode(e.target.value)} className={styles.fieldInput}>
                  <option value="">— which of our accounts receives it —</option>
                  {moneyAccounts.filter((a) => a.account_code !== creditAccountCode).map((a) => (
                    <option key={a.account_code} value={a.account_code}>{a.account_code} · {a.account_name}</option>
                  ))}
                </select>
              </label>
            ) : (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Payee *</span>
              <input type="text" value={payeeName} onChange={(e) => setPayeeName(e.target.value)}
                placeholder="Who are we paying? (e.g. ABC Freight Forwarding)" className={styles.fieldInput} required />
            </label>
            )}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>PV #</span>
              <input type="text" readOnly value="(assigned on Save)" className={styles.fieldInput}
                style={{ background: 'var(--c-cream)', color: 'var(--fg-muted)' }} />
            </label>

            {/* Supplier: the WHOLE POINT of an AP Payment; gone from a plain
                voucher (expenses pay a free-text payee — a supplier bill is
                what the other document is for). */}
            {isAp && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Supplier *</span>
                <SearchCombo
                  options={sortByText(suppliersQ.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
                  value={supplierId}
                  onChange={setSupplierId}
                  className={styles.fieldInput}
                  placeholder={suppliersQ.isLoading ? 'Loading suppliers…' : 'Type to find the supplier this pays'}
                />
              </label>
            )}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Voucher Date *</span>
              <DateField fullWidth value={voucherDate} onChange={(iso) => setVoucherDate(iso)} className={styles.fieldInput} />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Paid From (Credit) *</span>
              <AccountSelect
                accounts={moneyAccounts}
                value={creditAccountCode}
                onChange={setCreditAccountCode}
                className={styles.fieldInput}
                placeholder={accountsQ.isLoading ? 'Loading accounts…' : '— Bank / cash —'}
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

      {/* Expense lines — the Payment Voucher's body. An AP Payment has no
          hand-written lines at all: its one GL line (Dr the AP control) is
          composed on save from the ticks below. */}
      {transferMode && (
        <section className={styles.card}>
          <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Amount</h2></div>
          <div className={styles.cardBody}>
            <label className={styles.field} style={{ maxWidth: 260 }}>
              <span className={styles.fieldLabel}>How much moves (RM) *</span>
              <input type="number" min="0" step="0.01" value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)} className={styles.fieldInput}
                placeholder="0.00" aria-label="Transfer amount" />
            </label>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              过账时:Dr {toAccountCode || '收方'} / Cr {creditAccountCode || 'Paid From'} — approve 才进 GL,和付款单同一条审批链。
            </div>
          </div>
        </section>
      )}
      {!isAp && !transferMode && (
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Lines</h2>
          {/* Scan bill — pick the bill's page(s); MULTI-SELECT = ONE BILL.
              A pile of different bills goes through the batch screen. */}
          <label style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)', cursor: 'pointer', fontWeight: 600 }}>
            📷 Scan bill (OCR)
            <input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf"
              aria-label="Scan bill files"
              style={{ display: 'none' }}
              onChange={(e) => { void onScanFiles(e.target.files); e.target.value = ''; }} />
          </label>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {lines.length} line{lines.length === 1 ? '' : 's'} · total {fmtRm(totalSen)}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {scanNote && (
            <div style={{ fontSize: 'var(--fs-12)', color: extract.isPending ? 'var(--fg-muted)' : 'var(--c-orange)' }}>{scanNote}</div>
          )}
          {pendingFiles.length > 0 && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              📎 {pendingFiles.length} scanned file(s) will be attached to this voucher on save:{' '}
              {pendingFiles.map((f) => f.name).join(', ')}
            </div>
          )}
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
      )}

      {/* ── Apply to PI — the AP Payment's body (migration 0202). Tick pays an
          invoice in full, a typed figure pays part of it, and the voucher
          total follows the ticks. ── */}
      {isAp && (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Apply to PI</h2>
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              {applyToPi
                ? `Applying ${fmtRm(allocatedSen)}`
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
            ) : (
              <>
                {/* No open invoice is NOT a dead end: the prepay box below
                    still books the money as this supplier's advance. It used
                    to hide behind this empty-list sentence — exactly when a
                    prepay is the whole point (owner 2026-09-06: AP payment 时
                    如何 advance pay). */}
                {allocations.length === 0 ? (
                  <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>This supplier has no outstanding invoices — a prepay below still books as their advance.</p>
                ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      <th style={{ padding: '6px 8px', width: 34 }} aria-label="Pay in full" />
                      <th style={{ padding: '6px 8px' }}>Invoice</th>
                      <th style={{ padding: '6px 8px' }}>Date</th>
                      <th style={{ padding: '6px 8px' }}>Supplier Ref</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Outstanding</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Apply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocations.map((a) => (
                      <tr key={a.piId} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ padding: '6px 8px' }}>
                          {/* Tick = pay this invoice in full; untick clears it.
                              A typed partial shows an indeterminate-looking
                              unchecked box — the AMOUNT is the truth. */}
                          <input
                            type="checkbox"
                            aria-label={`Pay ${a.invoiceNumber} in full`}
                            checked={a.amountSen === a.outstandingSen && a.outstandingSen > 0}
                            onChange={(e) => {
                              const v = e.target.checked ? a.outstandingSen : 0;
                              setAllocAmounts((prev) => ({ ...prev, [a.piId]: v }));
                            }}
                            style={{ width: 16, height: 16, accentColor: 'var(--c-orange)' }}
                          />
                        </td>
                        <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                          {a.invoiceNumber}
                          {a.kind === 'API' && (
                            <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', fontFamily: 'inherit', color: 'var(--fg-muted)' }} title="AP invoice — a non-stock supplier bill">AP</span>
                          )}
                        </td>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: 'var(--fg-muted)' }}>{fmtDate(a.invoiceDate)}</td>
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
                )}
                {/* 预付 — money for this supplier AHEAD of any invoice. Rides
                    the same voucher; the server records it as their advance,
                    knocked off later from the voucher that holds it. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', borderTop: '1px solid var(--line)', paddingTop: 'var(--space-3)' }}>
                  <b style={{ fontSize: 'var(--fs-13)' }}>Prepay (advance)</b>
                  <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>pay ahead of any invoice — hangs on this supplier until knocked off</span>
                  <span style={{ flex: 1 }} />
                  <label style={{ width: 160 }}>
                    <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Prepay amount</span>
                    <MoneyInput bare valueSen={advanceSen}
                      onCommit={(sen) => setAdvanceSen(Math.max(0, sen ?? 0))}
                      inputClassName={styles.fieldInput} selectOnFocus />
                  </label>
                </div>
                {existingAdvanceSen > 0 && (
                  <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                    This supplier already holds {fmtRm(existingAdvanceSen)} of unspent advance — knock it off from the voucher(s) that paid it
                    {(advancesQ.data?.advances ?? []).slice(0, 3).map((a) => (
                      <span key={a.pv_id}> · <a href={`/scm/payment-vouchers/${a.pv_id}`} style={{ color: 'var(--c-orange)' }}>{a.pv_number}</a></span>
                    ))}
                  </div>
                )}
                {/* What the save will book — spelled out so the automatic AP
                    debit is never a surprise. */}
                <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                  Books: Dr {apAccountCode || 'AP'} Account Payable {fmtRm(totalSen)}{advanceSen > 0 ? ` (incl. prepay ${fmtRm(advanceSen)})` : ''} · Cr {creditAccountCode || 'Paid From'} {fmtRm(totalSen)}
                </div>
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
