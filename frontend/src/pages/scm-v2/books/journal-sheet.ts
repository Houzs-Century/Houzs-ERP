
import { fmtDate } from '../../../vendor/shared/format';
import type { ReportSheet, SheetColumn, SheetRow } from '../../../vendor/scm/lib/report-sheet';
import type { JournalEntryGrouped } from '../accounting-phase1-queries';

export type JournalSheetInput = {
  rows: JournalEntryGrouped[];
  from: string;
  to: string;
  narrowedBy: string[];
  nameOf: (code: string) => string;
  journalWord: (cls: string) => string;
  statusWord: (r: JournalEntryGrouped) => string;
};

const COLUMNS: SheetColumn[] = [
  { label: 'Date', kind: 'text' },
  { label: 'Journal', kind: 'text' },
  { label: 'Ref. 1', kind: 'text' },
  { label: 'Ref. 2', kind: 'text' },
  { label: 'Description', kind: 'text' },
  { label: 'Debit', kind: 'amount' },
  { label: 'Credit', kind: 'amount' },
  { label: 'Status', kind: 'text' },
];

const side = (sen: number): number | string => (sen > 0 ? sen : '');

export function journalSheet(p: JournalSheetInput): ReportSheet {
  const period = p.from === p.to ? fmtDate(p.from) : `${fmtDate(p.from)} – ${fmtDate(p.to)}`;
  const rows: SheetRow[] = [];
  for (const r of p.rows) {
    rows.push({
      kind: 'category', depth: 0, label: r.je_no,
      cells: [fmtDate(r.entry_date), p.journalWord(r.journal_class), r.doc ?? '', r.doc2 ?? '', r.narration ?? r.who ?? '', r.total_debit_sen, r.total_credit_sen, p.statusWord(r)],
    });
    for (const l of r.lines) {
      const name = p.nameOf(l.account_code);
      rows.push({
        kind: 'row', depth: 1, label: name ? `${l.account_code} ${name}` : l.account_code,
        cells: ['', '', l.party_name ?? '', '', l.notes ?? '', side(l.debit_sen), side(l.credit_sen), ''],
      });
    }
  }
  return {
    title: 'Journal entries',
    subtitle: [period, ...p.narrowedBy, `${p.rows.length} ${p.rows.length === 1 ? 'entry' : 'entries'}`].join(' · '),
    meta: [{ label: 'Period', value: period }, { label: 'Entries', value: String(p.rows.length) }],
    tables: [{ columns: COLUMNS, rows }],
  };
}
