// ----------------------------------------------------------------------------
// ledger-queries — the General Ledger the AutoCount way (owner 2026-09-14;
// docs/bugs/0924): GET /accounting/gl/ledger, its shape, and the pure helpers
// the screen, the CSV and the PDF share — so the three can never disagree.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { fmtDate } from '../../shared/format';
import { triggerDownload } from './fabric-csv';

export type LedgerJournal = 'SALES' | 'PURCHASE' | 'BANK' | 'CASH' | 'GENERAL';

export type LedgerLine = {
  lineId: string;
  date: string;
  jeNo: string;
  journal: LedgerJournal;
  counter: { code: string; name: string; more: number } | null;
  doc: string | null;
  doc2: string | null;
  description: string | null;
  who: string | null;
  debitSen: number;
  creditSen: number;
  balanceSen: number;
  reversal: 'reversed' | 'contra' | '';
};

export type LedgerBlock = {
  code: string;
  name: string;
  type: string;
  openingSen: number;
  lines: LedgerLine[];
  debitSen: number;
  creditSen: number;
  closingSen: number;
};

export type LedgerReport = {
  from: string;
  to: string;
  showReversed: boolean;
  scope: { codes: string[]; fromCode: string | null; toCode: string | null; all: boolean };
  blocks: LedgerBlock[];
  totals: { debitSen: number; creditSen: number };
};

export type LedgerParams = {
  from: string;
  to: string;
  /** Picked accounts — wins over the range when given. */
  accounts?: string[];
  fromAccount?: string;
  toAccount?: string;
  showReversed?: boolean;
};

/** The query string the ledger is asked with — one place, so the screen's
    URL, the hook and a test agree on it. */
export const ledgerQuery = (p: LedgerParams): string => {
  const q = new URLSearchParams();
  q.set('from', p.from);
  q.set('to', p.to);
  if (p.accounts && p.accounts.length > 0) q.set('accounts', p.accounts.join(','));
  else {
    if (p.fromAccount) q.set('fromAccount', p.fromAccount);
    if (p.toAccount) q.set('toAccount', p.toAccount);
  }
  if (p.showReversed) q.set('showReversed', '1');
  return q.toString();
};

export const fetchLedger = (p: LedgerParams) => authedFetch<LedgerReport>(`/accounting/gl/ledger?${ledgerQuery(p)}`);

export const useLedger = (p: LedgerParams, enabled = true) => useQuery({
  queryKey: ['gl-ledger', ledgerQuery(p)],
  queryFn: () => fetchLedger(p),
  enabled: enabled && Boolean(p.from && p.to),
  staleTime: 30_000,
});

/** 1,234.56, a contrary balance in brackets — the receipts & payments' own dress (docs/bugs/0910). */
export const fmtLedger = (sen: number): string => {
  const abs = Math.abs(sen) / 100;
  const s = abs.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${s})` : s;
};

/** A debit or credit cell: blank when nothing moved on that side. */
export const fmtSide = (sen: number): string => (sen > 0 ? fmtLedger(sen) : '');

/** The other side of the entry, as printed: "300-0000 ACCOUNT RECEIVEABLE", "+2" when more stand beside it. */
export const counterLabel = (c: LedgerLine['counter']): string =>
  c ? `${c.code} ${c.name}${c.more > 0 ? ` +${c.more}` : ''}` : '';

/** The journal type as AutoCount names it. */
export const journalLabel = (j: LedgerJournal): string =>
  ({ SALES: 'Sales', PURCHASE: 'Purchase', BANK: 'Bank', CASH: 'Cash', GENERAL: 'General' })[j];

/** The ledger's columns, the owner's order — ONE home for the screen, the CSV and the PDF. */
export const LEDGER_COLUMNS = ['Date', 'Entry', 'Journal', 'Other side', 'Ref. 1', 'Ref. 2', 'Description', 'Debit', 'Credit', 'Balance'] as const;

const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The ledger as a CSV — exactly the rows the screen shows: a heading row per
    account, its balance b/f, its lines, its totals, then the grand totals. */
export function ledgerCsv(r: LedgerReport): string {
  /* The account in front (a flat file has no block heading) and the reversal mark behind. */
  const head = ['Account', ...LEDGER_COLUMNS, 'Reversal'];
  const rows: string[][] = [head];
  for (const b of r.blocks) {
    rows.push([`${b.code} ${b.name}`, '', '', '', '', '', '', 'BALANCE B/F', '', '', fmtLedger(b.openingSen), '']);
    for (const l of b.lines) {
      rows.push([b.code, fmtDate(l.date), l.jeNo, journalLabel(l.journal), counterLabel(l.counter), l.doc ?? '', l.doc2 ?? '', l.description ?? '', fmtSide(l.debitSen), fmtSide(l.creditSen), fmtLedger(l.balanceSen), l.reversal]);
    }
    rows.push([b.code, '', '', '', '', '', '', 'TOTAL', fmtLedger(b.debitSen), fmtLedger(b.creditSen), fmtLedger(b.closingSen), '']);
  }
  rows.push(['', '', '', '', '', '', '', 'GRAND TOTAL', fmtLedger(r.totals.debitSen), fmtLedger(r.totals.creditSen), '', '']);
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

/** Hand the CSV to the browser as a download. */
export function downloadLedgerCsv(r: LedgerReport): void {
  triggerDownload(`general-ledger-${r.from}-to-${r.to}.csv`, '\ufeff' + ledgerCsv(r));
}
