/* The PDF a Finance report exports prints the sheet the screen shows (owner
   2026-09-19: pdf 不好看，就应该和原本的一样) — pure here: the printed columns
   (a % beside its amount merges into one cell, one line under the other),
   the head and body as text, each row kind's dress, the page's orientation. */
import { describe, expect, it } from 'vitest';
import type { ReportSheet, SheetTable } from './report-sheet';
import { isLandscape, printedColumns, printedStyle, printedTable } from './report-sheet-pdf';

const monthly: SheetTable = {
  columns: [
    { label: '累计 08/2026 – 09/2026', kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: true },
    { label: '09/2026', kind: 'amount' }, { label: '%', kind: 'pct', beside: true },
  ],
  rows: [
    { kind: 'block', depth: 0, label: 'Expenses', cells: [] },
    { kind: 'row', depth: 1, label: 'RENT', cells: [200_000, 20, null, null] },
    { kind: 'net', depth: 0, label: 'NET PROFIT', cells: [-41_500, -6.9, 100, 0.1] },
  ],
};

describe('the printed table', () => {
  it('merges a % beside its amount into one printed column, keeps the 累计 edge, prints a dash pair for nothing and blanks for a block', () => {
    expect(printedColumns(monthly)).toEqual([
      { label: '累计 08/2026 – 09/2026', cols: [0, 1], edge: true },
      { label: '09/2026', cols: [2, 3], edge: false },
    ]);
    const p = printedTable(monthly);
    expect(p.head).toEqual(['', '累计 08/2026 – 09/2026', '09/2026']);
    expect(p.body).toEqual([
      ['Expenses', '', ''],
      ['RENT', '2,000.00\n20.0%', '-\n-'],
      ['NET PROFIT', '(415.00)\n-6.9%', '1.00\n0.1%'],
    ]);
  });

  it('prints a statement\'s two columns as they are, in the report\'s own money dress', () => {
    const t: SheetTable = { columns: [{ label: 'Amount', kind: 'amount' }, { label: '% of sales', kind: 'pct' }], rows: [{ kind: 'total', depth: 0, label: 'Total', cells: [5, 50] }] };
    expect(printedTable(t, (sen) => `RM ${sen}`).body).toEqual([['Total', 'RM 5', '50.0%']]);
    expect(printedTable(t).head).toEqual(['', 'Amount', '% of sales']);
  });

  it('dresses each row kind as the screen does — bold, the two shades, a rule above a total and a heavier one above a net line', () => {
    expect(printedStyle('block')).toMatchObject({ bold: true, fill: null, rule: 0 });
    expect(printedStyle('category')).toMatchObject({ bold: true, fill: null });
    expect(printedStyle('row')).toMatchObject({ bold: false, italic: false, fill: null, rule: 0 });
    expect(printedStyle('unassigned')).toMatchObject({ italic: true, soft: true });
    expect(printedStyle('total')).toEqual({ bold: true, italic: false, soft: false, fill: [236, 238, 234], rule: 0.2 });
    expect(printedStyle('net')).toEqual({ bold: true, italic: false, soft: false, fill: [227, 230, 224], rule: 0.4 });
  });

  it('turns the page sideways once a table prints more than four figure columns', () => {
    const base: ReportSheet = { title: 'P&L', subtitle: '', meta: [], tables: [] };
    const cols = (n: number): SheetTable => ({ columns: Array.from({ length: n }, (_, i) => ({ label: `c${i}`, kind: 'amount' as const })), rows: [] });
    expect(isLandscape({ ...base, tables: [cols(2)] })).toBe(false);
    expect(isLandscape({ ...base, tables: [cols(4)] })).toBe(false);
    expect(isLandscape({ ...base, tables: [cols(5)] })).toBe(true);
    /* Twelve months with a % beside each still print as thirteen columns — sideways. */
    expect(isLandscape({ ...base, tables: [monthly] })).toBe(false);
  });
});
