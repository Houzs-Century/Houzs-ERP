// ----------------------------------------------------------------------------
// ledger-sheet — the General ledger as the report sheet its Excel draws (the
// owner's redesign, batch 6 §2.3 a7; the PDF and Print stay ledger-pdf, his
// layout): each account a bold row, its balance brought forward, its lines
// one step in with the running balance and its side, the account's total,
// and the grand total last. What the screen shows — a block it shows
// collapsed still exports whole, as the PDF prints it.
// ----------------------------------------------------------------------------

import { fmtDate } from '../../../vendor/shared/format';
import { counterLabel, journalLabel, type LedgerBlock, type LedgerReport } from '../../../vendor/scm/lib/ledger-queries';
import type { ReportSheet, SheetColumn, SheetRow } from '../../../vendor/scm/lib/report-sheet';

/** An account's natural side: debit for assets and expenses, credit for the rest. */
export const debitNatural = (type: string | null | undefined): boolean => {
  switch (String(type ?? '').toUpperCase()) {
    case 'ASSET':
    case 'EXPENSE':
      return true;
    default:
      return false;
  }
};

/** A natural-side balance as the screen prints it: the amount and Dr / Cr ('' at nil). */
export function balanceSide(type: string | null | undefined, sen: number): { sen: number; side: 'Dr' | 'Cr' | '' } {
  if (sen === 0) return { sen: 0, side: '' };
  const isDebit = debitNatural(type) ? sen > 0 : sen < 0;
  return { sen: Math.abs(sen), side: isDebit ? 'Dr' : 'Cr' };
}

const COLUMNS: SheetColumn[] = [
  { label: 'Date', kind: 'text' },
  { label: 'Journal', kind: 'text' },
  { label: 'Other side', kind: 'text' },
  { label: 'Ref. 1', kind: 'text' },
  { label: 'Ref. 2', kind: 'text' },
  { label: 'Description', kind: 'text' },
  { label: 'Debit', kind: 'amount' },
  { label: 'Credit', kind: 'amount' },
  { label: 'Balance', kind: 'amount' },
  { label: 'Side', kind: 'text' },
];

const side = (sen: number): number | string => (sen > 0 ? sen : '');

function blockRows(b: LedgerBlock, from: string): SheetRow[] {
  const bf = balanceSide(b.type, b.openingSen);
  const close = balanceSide(b.type, b.closingSen);
  return [
    { kind: 'category', depth: 0, label: `${b.code} ${b.name}`, cells: ['', '', '', '', '', '', b.debitSen, b.creditSen, close.sen, close.side] },
    { kind: 'row', depth: 1, label: 'Balance b/f', cells: [fmtDate(from), '', '', '', '', '', '', '', bf.sen, bf.side] },
    ...b.lines.map((l): SheetRow => {
      const bal = balanceSide(b.type, l.balanceSen);
      return {
        kind: l.reversal ? 'unassigned' : 'row', depth: 1, label: l.jeNo,
        cells: [fmtDate(l.date), journalLabel(l.journal), counterLabel(l.counter), l.doc ?? '', l.doc2 ?? '',
          `${l.description ?? ''}${l.reversal ? ` (${l.reversal})` : ''}`, side(l.debitSen), side(l.creditSen), bal.sen, bal.side],
      };
    }),
    { kind: 'total', depth: 0, label: `Total · ${b.code} ${b.name}`, cells: ['', '', '', '', '', '', b.debitSen, b.creditSen, close.sen, close.side] },
  ];
}

export function ledgerSheet(r: LedgerReport, accountsLabel: string): ReportSheet {
  const period = r.from === r.to ? fmtDate(r.from) : `${fmtDate(r.from)} – ${fmtDate(r.to)}`;
  const n = r.blocks.length;
  return {
    title: 'General ledger',
    subtitle: [period, accountsLabel, r.showReversed ? 'reversed entries listed, not counted' : 'reversed entries left out'].join(' · '),
    meta: [{ label: 'Period', value: period }, { label: 'Accounts', value: accountsLabel }],
    tables: [{
      columns: COLUMNS,
      rows: [
        ...r.blocks.flatMap((b) => blockRows(b, r.from)),
        { kind: 'net', depth: 0, label: `Grand total · ${n} ${n === 1 ? 'account' : 'accounts'}`, cells: ['', '', '', '', '', '', r.totals.debitSen, r.totals.creditSen, '', ''] },
      ],
    }],
  };
}
