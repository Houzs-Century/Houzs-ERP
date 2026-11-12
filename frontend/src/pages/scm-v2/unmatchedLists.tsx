// ----------------------------------------------------------------------------
// unmatchedLists — the three lists on Payments not matched yet (owner
// 2026-11-10: 关于那个unmatch payment 我要优化 … → 做), each with its words, its
// filter chips and its columns, so the screen, its Excel and its PDF say the
// same thing:
//   reports  — a merchant report line nobody has reconciled to its sale, read
//              exactly as Merchant Recon reads it (merchantReconExport);
//   payments — money recorded on an order or invoice that is not matched
//              (backend acc/unmatched-payments);
//   bank     — money the bank shows coming in that no entry is matched to
//              (backend acc/unmatched-bank-lines).
// ----------------------------------------------------------------------------

import { Link } from 'react-router-dom';
import type { Column } from '../../components/DataTable';
import { fmtDate } from '../../vendor/shared/format';
import { danger, fmt, good, softText } from './settlement-ui';
import styles from './Suppliers.module.css';
import { lineTab } from './MerchantReportsTop';
import { isOpenLine, isQrLine, lineStatus, ordersOf, QR_REF_WORDS, statusWordsOf, type LineStatus } from './merchantReconExport';
import type { SettlementBatch, SettlementRow } from './settlement-queries';
import type { BankLineWhat, UnmatchedBankLine, UnmatchedPayment, UnmatchedState } from './unmatched-payments-queries';

export type ListKey = 'reports' | 'payments' | 'bank';

/** The three lists, in the owner's order (2026-11-11: Merchant Report Line -> Bank Money
    In -> Payment), each with what its export is called — the owner's own words (export
    出来时注明是 …) — and the short name its Excel sheet takes (a sheet name holds 31
    characters). The screen keeps `label`. */
export const LISTS: ReadonlyArray<{ key: ListKey; label: string; sub: string; exportTitle: string; sheet: string; file: string }> = [
  { key: 'reports', label: 'Merchant report lines', sub: 'on a merchant report, no sale reconciled',
    exportTitle: 'Merchant RECEIVED, CANNOT MATCHED Which Sales Order', sheet: 'Merchant received', file: 'merchant-received' },
  { key: 'bank', label: 'Bank money in', sub: 'in the bank, no entry matched',
    exportTitle: 'Bank Received, CANNOT MATCHED Which Sales Order', sheet: 'Bank received', file: 'bank-received' },
  { key: 'payments', label: 'Payments', sub: 'money recorded, not matched',
    exportTitle: 'Record Payment Received, Bank CANNOT Found', sheet: 'Payment recorded', file: 'payment-recorded' },
];

const dayGap = (from: string, to: string): number =>
  Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));

/* ── Shared cells ─────────────────────────────────────────────────────────── */

/** Money in RM, totalled at the foot, exported in ringgit. */
export const moneyColumn = <T,>(key: string, label: string, sen: (r: T) => number, over: Partial<Column<T>> = {}): Column<T> => ({
  key, label, align: 'right',
  render: (r) => fmt(sen(r)),
  getValue: sen, exportValue: (r) => sen(r) / 100, exportFormat: 'money',
  total: (rows) => fmt(rows.reduce((s, r) => s + sen(r), 0)),
  ...over,
});

/** How long it has waited — red past two weeks. */
const daysColumn = <T,>(key: string, age: (r: T) => number): Column<T> => ({
  key, label: 'Days', align: 'right',
  render: (r) => {
    const d = age(r);
    return <span style={{ color: d > 14 ? danger : undefined, fontWeight: d > 14 ? 700 : undefined }}>{d}</span>;
  },
  getValue: age, exportFormat: 'number',
});

/** An order opens its own page; an invoice's number is shown as it is. */
export const docLink = (source: string | null | undefined, docNo: string) =>
  (source === 'SOPAY' ? <Link to={`/scm/sales-orders/${encodeURIComponent(docNo)}`}>{docNo}</Link> : docNo);

/* ── reports: merchant report lines nobody reconciled ─────────────────────── */

export type ReportLineRow = {
  key: string;
  batchId: number;
  rowId: number;
  acquirerCode: string;
  fileName: string;
  txnDate: string;
  lineNo: number;
  reference: string | null;
  grossSen: number;
  feeSen: number;
  netSen: number;
  status: LineStatus;
  statusWords: string;
  /** The sale the line claims, or the system's guess — Merchant Recon's own columns. */
  orders: ReturnType<typeof ordersOf>;
  /** No sale shown: how many it could be. */
  possible: number;
  ageDays: number;
  /** Merchant Recon at this report, on the tab the line sits in. */
  to: string;
};

/** Every open line of these reports dated in the window, oldest first. `details[i]` is what `batches[i]` read. */
export function reportLinesOf(
  batches: readonly SettlementBatch[],
  details: ReadonlyArray<{ rows: SettlementRow[] } | undefined>,
  from: string, to: string, today: string,
): ReportLineRow[] {
  return batches.flatMap((b, i) => (details[i]?.rows ?? [])
    .filter((r) => isOpenLine(r) && r.txn_date >= from && r.txn_date <= to)
    .map((r): ReportLineRow => {
      const orders = ordersOf(r);
      return {
        key: `${b.id}:${r.id}`,
        batchId: b.id, rowId: r.id, acquirerCode: b.acquirer_code, fileName: b.file_name,
        txnDate: r.txn_date, lineNo: r.line_no, reference: isQrLine(r) ? QR_REF_WORDS : r.ref,
        grossSen: Number(r.gross_sen), feeSen: Number(r.fee_sen), netSen: Number(r.net_sen),
        status: lineStatus(r), statusWords: statusWordsOf(r),
        orders, possible: orders.length === 0 ? r.candidates.length : 0,
        ageDays: dayGap(r.txn_date, today),
        to: `/scm/merchant-recon?acq=${encodeURIComponent(b.acquirer_code)}&batch=${b.id}&tab=${lineTab(r)}`,
      };
    }))
    .sort((a, b) => b.ageDays - a.ageDays || a.fileName.localeCompare(b.fileName) || a.lineNo - b.lineNo);
}

/** The chips, most work first. "No sale in the ERP" is the owner's first ask. */
export const REPORT_STATUSES: ReadonlyArray<{ key: LineStatus; label: string }> = [
  { key: 'none', label: 'No sale in the ERP' },
  { key: 'guess', label: 'The system’s guess' },
  { key: 'choose', label: 'You choose' },
  { key: 'matched', label: 'Matched, waiting your confirm' },
];

const ordersText = (r: ReportLineRow, pick: (o: ReportLineRow['orders'][number]) => string | null): string =>
  r.orders.map((o) => pick(o) ?? '').filter(Boolean).join(', ');
const ordersCell = (r: ReportLineRow, pick: (o: ReportLineRow['orders'][number]) => string | null) =>
  (r.orders.length === 0 ? '—' : r.orders.map((o) => <div key={o.key}>{pick(o) ?? '—'}</div>));

export const REPORT_COLUMNS: Column<ReportLineRow>[] = [
  { key: 'merchant', label: 'Merchant', render: (r) => <span className={styles.codeChip}>{r.acquirerCode}</span>, getValue: (r) => r.acquirerCode },
  { key: 'file', label: 'Report', render: (r) => <span style={{ wordBreak: 'break-all' }}>{r.fileName}</span>, getValue: (r) => r.fileName },
  {
    key: 'date', label: 'Date',
    render: (r) => <>{fmtDate(r.txnDate)}<div style={softText}>line {r.lineNo}</div></>,
    getValue: (r) => r.txnDate, exportFormat: 'date',
  },
  { key: 'line', label: 'Line', defaultHidden: true, align: 'right', render: (r) => r.lineNo, getValue: (r) => r.lineNo, exportFormat: 'number' },
  { key: 'reference', label: 'Reference', render: (r) => r.reference ?? '—', getValue: (r) => r.reference ?? '' },
  moneyColumn<ReportLineRow>('gross', 'Gross', (r) => r.grossSen),
  moneyColumn<ReportLineRow>('fee', 'Fee', (r) => r.feeSen, { defaultHidden: true }),
  moneyColumn<ReportLineRow>('net', 'Net', (r) => r.netSen, { defaultHidden: true }),
  {
    key: 'document', label: 'Sale',
    render: (r) => (r.orders.length === 0
      ? <span style={softText}>{r.possible > 0 ? `${r.possible} possible` : '—'}</span>
      : r.orders.map((o) => <div key={o.key}><b>{docLink(o.source, o.docNo)}</b></div>)),
    getValue: (r) => ordersText(r, (o) => o.docNo) || (r.possible > 0 ? `${r.possible} possible` : ''),
  },
  { key: 'customer', label: 'Customer', render: (r) => ordersCell(r, (o) => o.customer), getValue: (r) => ordersText(r, (o) => o.customer) },
  { key: 'paid_on', label: 'Paid on', render: (r) => ordersCell(r, (o) => (o.paidOn ? fmtDate(o.paidOn) : null)), getValue: (r) => ordersText(r, (o) => o.paidOn) },
  { key: 'approval', label: 'Approval', defaultHidden: true, render: (r) => ordersCell(r, (o) => o.code), getValue: (r) => ordersText(r, (o) => o.code) },
  {
    key: 'status', label: 'Status',
    render: (r) => <span style={{ color: r.status === 'none' ? danger : r.status === 'matched' ? good : undefined }}>{r.statusWords}</span>,
    getValue: (r) => r.statusWords,
  },
  daysColumn<ReportLineRow>('age', (r) => r.ageDays),
  { key: 'go', label: '', render: (r) => <Link to={r.to}>Merchant reports</Link> },
];

/* ── payments: money recorded, not matched ────────────────────────────────── */

const reportLink = (r: UnmatchedPayment, tab?: string): string => (r.report
  ? `/scm/merchant-recon?acq=${encodeURIComponent(r.report.acquirerCode)}&batch=${r.report.batchId}${tab ? `&tab=${tab}` : ''}`
  : '/scm/merchant-recon');

/** Where it is stuck, in words, and the screen that unsticks it — one home for both.
    A card payment its merchant matched is not here at all (owner 2026-11-10: 已经match 了
    就不要出现): what is left of it is on Merchant report lines or Bank money in. */
export const STUCK: Record<UnmatchedState, { text: (r: UnmatchedPayment) => string; to: (r: UnmatchedPayment) => string; screen: (r: UnmatchedPayment) => string }> = {
  CARD_NOT_REPORTED: { text: () => 'Not on a merchant report yet', to: () => '/scm/merchant-recon', screen: () => 'Merchant reports' },
  CARD_TO_CONFIRM: { text: () => 'On a merchant report — waiting for you to confirm', to: (r) => reportLink(r, 'to-confirm'), screen: () => 'Merchant reports' },
  CARD_NO_MERCHANT: { text: (r) => `${r.channel ?? 'Its bank'} is not set up as a merchant`, to: () => '/scm/settlement-setup', screen: () => 'Merchant setup' },
  TRANSFER_NOT_BOOKED: { text: () => 'Not in the books — see Self-check', to: () => '/scm/accounting?tab=check', screen: () => 'Self-check' },
  TRANSFER_NOT_MATCHED: { text: () => 'Not matched to the bank statement yet', to: () => '/scm/bank-recon', screen: () => 'Bank statements' },
  TRANSFER_NO_STATEMENT: {
    text: (r) => (r.statementUpTo
      ? `Bank statement for this day not uploaded yet (uploaded to ${fmtDate(r.statementUpTo)})`
      : 'No bank statement uploaded yet'),
    to: () => '/scm/bank-recon',
    screen: () => 'Bank statements',
  },
};

/** The chips, in the order the money moves: card first, then transfers. */
export const PAYMENT_STAGES: ReadonlyArray<{ key: UnmatchedState; label: string }> = [
  { key: 'CARD_NOT_REPORTED', label: 'Card · not on a report' },
  { key: 'CARD_TO_CONFIRM', label: 'Card · waiting your confirm' },
  { key: 'CARD_NO_MERCHANT', label: 'Card · no merchant' },
  { key: 'TRANSFER_NOT_MATCHED', label: 'Transfer · not matched' },
  { key: 'TRANSFER_NO_STATEMENT', label: 'Transfer · no statement' },
  { key: 'TRANSFER_NOT_BOOKED', label: 'Transfer · not in the books' },
];

/** "Card · GHL", "Card · 未标", "Transfer · TNG". */
export const methodText = (r: UnmatchedPayment): string =>
  (r.kind === 'card' ? `Card · ${r.channel ?? '未标'}` : `Transfer${r.channel ? ` · ${r.channel}` : ''}`);

/* ── The same money on another list (owner 2026-11-10: 会不会duplicate) ─────────
   A payment not matched yet is often the very money another list holds from its
   own side: the merchant report line that claims or guesses it, the bank line
   Bank money in offers its entry to. Those lists already name the payment (Sale;
   Why it is open); the payment names them back, so one task reads as one. Taken
   from what the two reconciliations decided — a line's own claim or guess, a bank
   line's own offers — never from an amount that merely agrees. */

/** Where the same money waits on another list, and the link there. */
export type SameMoney = { text: string; to: string };
export type PaymentRow = UnmatchedPayment & { same: SameMoney | null };

/** Bank statements at the month a bank line opens in. */
export const bankLineLink = (r: UnmatchedBankLine): string =>
  `/scm/bank-recon?account=${encodeURIComponent(r.accountCode)}&month=${r.month}`;

export function withSameMoney(
  payments: readonly UnmatchedPayment[],
  reports: readonly ReportLineRow[],
  bank: readonly UnmatchedBankLine[],
): PaymentRow[] {
  const onReport = new Map<string, ReportLineRow>();
  for (const r of reports) for (const o of r.orders) if (!onReport.has(o.key)) onReport.set(o.key, r);
  const onBank = new Map<string, UnmatchedBankLine>();
  for (const b of bank) for (const e of b.entries) if (!onBank.has(e.jeNo)) onBank.set(e.jeNo, b);
  return payments.map((p): PaymentRow => {
    /* A card's line — or the QR line of a DuitNow QR sale, keyed as a transfer (owner 2026-11-11). */
    const line = onReport.get(p.paymentId);
    if (line) return { ...p, same: { text: `Merchant report line · ${line.acquirerCode} · ${fmtDate(line.txnDate)} · line ${line.lineNo}`, to: line.to } };
    const credit = p.kind === 'transfer' && p.jeNo ? onBank.get(p.jeNo) : undefined;
    if (credit) return { ...p, same: { text: `Bank money in · ${fmtDate(credit.bookedOn)} · ${fmt(credit.amountSen)}`, to: bankLineLink(credit) } };
    return { ...p, same: null };
  });
}

export const PAYMENT_COLUMNS: Column<PaymentRow>[] = [
  { key: 'paidOn', label: 'Paid on', render: (r) => fmtDate(r.paidOn), getValue: (r) => r.paidOn, exportFormat: 'date' },
  { key: 'document', label: 'Document', render: (r) => docLink(r.source, r.docNo), getValue: (r) => r.docNo },
  { key: 'customer', label: 'Customer', render: (r) => r.customerName ?? '—', getValue: (r) => r.customerName ?? '' },
  /* Owner 2026-11-09 (sales person 应该不太对，应该是collected by 的人): who took the money,
     off the payment itself — the one to ask about it. The order's salesperson stays a
     choice under Columns. */
  { key: 'collectedBy', label: 'Collected by', render: (r) => r.collectedByName ?? '—', getValue: (r) => r.collectedByName ?? '' },
  { key: 'salesperson', label: 'Salesperson', defaultHidden: true, render: (r) => r.salespersonName ?? '—', getValue: (r) => r.salespersonName ?? '' },
  { key: 'method', label: 'Method', render: (r) => <span className={styles.codeChip}>{methodText(r)}</span>, getValue: (r) => methodText(r) },
  moneyColumn<PaymentRow>('amount', 'Amount', (r) => r.amountSen),
  { key: 'reference', label: 'Reference', render: (r) => r.reference ?? '—', getValue: (r) => r.reference ?? '' },
  { key: 'file', label: 'Report', defaultHidden: true, render: (r) => r.report?.fileName ?? '—', getValue: (r) => r.report?.fileName ?? '' },
  daysColumn<PaymentRow>('days', (r) => r.ageDays),
  { key: 'stuck', label: 'Where it is stuck', render: (r) => STUCK[r.state].text(r), getValue: (r) => STUCK[r.state].text(r) },
  {
    key: 'same', label: 'Possibly the same as',
    render: (r) => (r.same ? <Link to={r.same.to}>{r.same.text}</Link> : '—'),
    getValue: (r) => r.same?.text ?? '',
  },
  { key: 'go', label: '', render: (r) => <Link to={STUCK[r.state].to(r)}>{STUCK[r.state].screen(r)}</Link> },
];

/* ── bank: money in, no entry matched ─────────────────────────────────────── */

export const BANK_KINDS: ReadonlyArray<{ key: BankLineWhat; label: string }> = [
  { key: 'CARD', label: 'Card payout' },
  { key: 'QR', label: 'DuitNow QR' },
  { key: 'TRANSFER', label: 'Transfer' },
];

/** "Card payout · MBB", "DuitNow QR", "Transfer". */
export const bankWhatText = (r: UnmatchedBankLine): string =>
  (r.what === 'CARD' ? `Card payout${r.acquirerCode ? ` · ${r.acquirerCode}` : ''}` : r.what === 'QR' ? 'DuitNow QR' : 'Transfer');

const entriesText = (r: UnmatchedBankLine): string =>
  r.entries.map((e) => [e.doc ?? e.jeNo, e.who, fmtDate(e.entryDate)].filter(Boolean).join(' · ')).join('; ');

export const BANK_COLUMNS: Column<UnmatchedBankLine>[] = [
  { key: 'date', label: 'Date', render: (r) => fmtDate(r.bookedOn), getValue: (r) => r.bookedOn, exportFormat: 'date' },
  {
    key: 'account', label: 'Account',
    render: (r) => <>{r.accountCode}{r.bankName && <div style={softText}>{r.bankName}</div>}</>,
    getValue: (r) => (r.bankName ? `${r.accountCode} ${r.bankName}` : r.accountCode),
  },
  { key: 'description', label: 'Description', render: (r) => r.description || '—', getValue: (r) => r.description },
  { key: 'reference', label: 'Reference', render: (r) => r.reference ?? '—', getValue: (r) => r.reference ?? '' },
  moneyColumn<UnmatchedBankLine>('amount', 'Amount', (r) => r.amountSen),
  { key: 'kind', label: 'What it is', render: (r) => <span className={styles.codeChip}>{bankWhatText(r)}</span>, getValue: bankWhatText },
  { key: 'note', label: 'Why it is open', render: (r) => r.note ?? '—', getValue: (r) => r.note ?? '' },
  {
    key: 'entries', label: 'Entries of this amount', defaultHidden: true,
    render: (r) => (r.entries.length === 0 ? '—' : r.entries.map((e) => <div key={e.jeNo}>{[e.doc ?? e.jeNo, e.who].filter(Boolean).join(' · ')}</div>)),
    getValue: entriesText,
  },
  daysColumn<UnmatchedBankLine>('age', (r) => r.ageDays),
  {
    key: 'go', label: '',
    render: (r) => <Link to={bankLineLink(r)}>Bank statements</Link>,
  },
];
