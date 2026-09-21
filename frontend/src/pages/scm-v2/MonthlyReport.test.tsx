/* The monthly view (owner 2026-09-14, docs/bugs/0916: 能看每个月的). Pinned:
   one request per column, 累计 leftmost then newest → oldest; a line a month
   has and the range lacks still prints, a dash in both slots where a month
   has nothing (owner 2026-09-18); the % toggle; the months buttons; the
   levels; Excel and PDF carry the table as shown; an account's lines open under its row in
   the month grid, each under its month, a month's figure alone; a total or
   subtotal row shaded apart from the account rows, the lines shaded lighter,
   cut at the column, their figures under the amount slot (2026-09-19). The
   lines themselves: vendor/scm/lib/report-monthly.test.ts. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { FlatLine, MonthColumn } from '../../vendor/scm/lib/report-monthly';

type Data = { period: string; lines: FlatLine[] };
const line = (id: string, label: string, amountSen: number, pct: number | null, depth = 1, kind: FlatLine['kind'] = 'row'): FlatLine =>
  ({ id, label, kind, depth, amountSen, pct });

/* Three months of a tiny P&L; ADVERT was booked in August alone. */
const DATA: Partial<Record<string, Data>> = {
  '2026-07-01..2026-09-30': { period: 'cumulative', lines: [line('blk', 'Expenses', 0, null, 0, 'block'), line('rent', 'RENT', 300_000, 30), line('tot', 'Total expenses', 300_000, 30, 0, 'total')] },
  '2026-09': { period: '2026-09', lines: [line('blk', 'Expenses', 0, null, 0, 'block'), line('rent', 'RENT', 100_000, 25), line('tot', 'Total expenses', 100_000, 25, 0, 'total')] },
  '2026-08': { period: '2026-08', lines: [line('blk', 'Expenses', 0, null, 0, 'block'), line('rent', 'RENT', 100_000, 40), line('advert', 'ADVERT', 5_000, 2), line('tot', 'Total expenses', 105_000, 42, 0, 'total')] },
  '2026-07': { period: '2026-07', lines: [line('blk', 'Expenses', 0, null, 0, 'block'), line('rent', 'RENT', 100_000, 20), line('tot', 'Total expenses', 100_000, 20, 0, 'total')] },
};
const TREE: Data = { period: 'tree', lines: [
  line('blk', 'Expenses', 0, null, 0, 'block'),
  line('opex', 'OPERATING EXPENSE', 130_000, 13, 1, 'category'),
  { ...line('rent', '900-A001 — RENT', 100_000, 10, 2), code: '900-A001' },
  { ...line('advert', '900-A014 — ADVERT', 30_000, 3, 2), code: '900-A014' },
  line('tot', 'Total expenses', 130_000, 13, 0, 'total'),
  line('net', 'NET PROFIT', -130_000, -13, 0, 'net'),
] };
let treeMode = false;
const seen: string[] = [];
vi.mock('@tanstack/react-query', () => ({
  useQueries: ({ queries }: { queries: Array<{ queryKey: unknown[] }> }) => queries.map((q) => {
    const key = String(q.queryKey[2]);
    seen.push(key);
    const data = treeMode ? TREE : DATA[key];
    return data ? { data, isLoading: false, isError: false } : { data: undefined, isLoading: false, isError: true };
  }),
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
const pdf = vi.fn(async (..._a: unknown[]) => {});
const useLedger = vi.fn();
vi.mock('../../vendor/scm/lib/ledger-queries', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useLedger: (...a: unknown[]) => useLedger(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: (...a: unknown[]) => pdf(...a) }));

import { MonthlyReport } from './MonthlyReport';

const draw = () => render(
  <MemoryRouter><MonthlyReport<Data> report="pnl" title="P&L" withCumulative fetchColumn={async (c: MonthColumn) => DATA[c.key]!} linesOf={(d) => d.lines} fmt={(sen) => `RM ${(sen / 100).toFixed(2)}`} pctTitle="% of sales" /></MemoryRouter>,
);

/** A cell's own first text (the amount) and the % line under it. */
const amountOf = (c: HTMLElement): string => (c.firstChild?.textContent ?? '');
const pctBeside = (c: HTMLElement): string => c.querySelector('span[data-pct]')?.textContent ?? '';

describe('the monthly view', () => {
  test('累计 leftmost, then the newest month on the left and older to the right; a month-only line still prints', () => {
    vi.useFakeTimers({ now: new Date('2026-09-15T04:00:00Z'), toFake: ['Date'] });
    try {
      draw();
    } finally { vi.useRealTimers(); }
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads.slice(0, 4)).toEqual(['P&L', '累计 04/2026 – 09/2026', '09/2026', '08/2026']);
    /* Six months by default: the range asks Apr..Sep; the fixture only knows three of them — those show, the rest report an error. */
    expect(seen).toContain('2026-04-01..2026-09-30');
    expect(screen.getByText(/did not load/).textContent).toContain('4 column(s)');
    const rent = screen.getByText('RENT').closest('tr')!;
    expect(within(rent).getAllByRole('cell').map(amountOf)).toEqual(['RENT', '-', 'RM 1000.00', 'RM 1000.00', 'RM 1000.00', '-', '-', '-']);
    /* Style one (owner 2026-09-18): every line wears the dashed row style and a frozen name cell; a block line does not. */
    expect(rent.className).toMatch(/row/);
    expect(within(rent).getAllByRole('cell')[0]!.className).toMatch(/name/);
    expect(screen.getByText('Expenses').closest('tr')!.className).toBe('');
    /* A total row wears a shade of its own, apart from the account rows (owner 2026-09-19). */
    expect(screen.getByText('Total expenses').closest('tr')!.className).toMatch(/total/);
    expect(rent.className).not.toMatch(/total/);
    const advert = screen.getByText('ADVERT').closest('tr')!;
    expect(within(advert).getAllByRole('cell').map(amountOf)).toEqual(['ADVERT', '-', '-', 'RM 50.00', '-', '-', '-', '-']);
    /* A dash in the % slot too — nothing is left blank (owner 2026-09-18, method B). */
    expect(within(advert).getAllByRole('cell').map(pctBeside)).toEqual(['', '-', '-', '2.0%', '-', '-', '-', '-']);
    /* ADVERT sits after RENT, where August had it. */
    const rows = screen.getAllByRole('row').map((r) => String(r.textContent));
    expect(rows.findIndex((t) => t.startsWith('ADVERT'))).toBe(rows.findIndex((t) => t.startsWith('RENT')) + 1);
  });

  test('3 months makes the range 累计 of three; the % toggle prints each cell\'s %; L1 folds; Excel and PDF carry the table as shown', () => {
    vi.useFakeTimers({ now: new Date('2026-09-15T04:00:00Z'), toFake: ['Date'] });
    try {
      draw();
      fireEvent.click(within(screen.getByRole('group', { name: 'Months' })).getByRole('button', { name: '3' }));
    } finally { vi.useRealTimers(); }
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['P&L', '累计 07/2026 – 09/2026', '09/2026', '08/2026', '07/2026']);
    expect(screen.queryByText(/did not load/)).toBeNull();
    const rent = () => within(screen.getByText('RENT').closest('tr')!).getAllByRole('cell').map(amountOf);
    expect(rent()).toEqual(['RENT', 'RM 3000.00', 'RM 1000.00', 'RM 1000.00', 'RM 1000.00']);
    /* The % rides under every amount (owner: by month 没有 percentage). */
    expect(within(screen.getByText('RENT').closest('tr')!).getAllByRole('cell').map(pctBeside)).toEqual(['', '30.0%', '25.0%', '40.0%', '20.0%']);
    /* On the same line as the amount, not under it (owner 2026-09-18). */
    expect(within(screen.getByText('RENT').closest('tr')!).getAllByRole('cell')[1]!.querySelector('div')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '%' }));
    expect(rent()).toEqual(['RENT', '30.0%', '25.0%', '40.0%', '20.0%']);
    expect(screen.getAllByRole('columnheader')[0]!.textContent).toBe('P&L · % of sales');
    /* The total line keeps its cells; a block line prints nothing. */
    expect(within(screen.getByText('Total expenses').closest('tr')!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Total expenses', '30.0%', '25.0%', '42.0%', '20.0%']);
    expect(within(screen.getByText('Expenses').closest('tr')!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Expenses', '', '', '', '']);
    /* One level deep: nothing to fold. */
    expect(screen.queryByRole('group', { name: 'Levels' })).toBeNull();
    /* Excel and PDF carry the table as shown — these columns; in % mode the % alone (owner 2026-09-19: 我这页显示什么就要 export 什么). */
    type Sheet = { title: string; subtitle: string; tables: Array<{ columns: Array<{ label: string; kind: string }>; rows: Array<{ label: string; kind: string; cells: unknown[] }> }> };
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    expect(xlsx).toHaveBeenCalledTimes(1);
    const [sheet, name] = xlsx.mock.calls[0]! as [Sheet, string];
    expect(name).toBe('pnl-monthly-2026-07-2026-09.xlsx');
    expect(sheet.title).toBe('P&L');
    expect(sheet.subtitle).toContain('07/2026 – 09/2026');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['累计 07/2026 – 09/2026', '09/2026', '08/2026', '07/2026']);
    expect(sheet.tables[0]!.columns.every((c) => c.kind === 'pct')).toBe(true);
    expect(sheet.tables[0]!.rows.find((r) => r.label === 'RENT')!.cells).toEqual([30, 25, 40, 20]);
    /* Amounts mode: an amount column with the % beside it per month; a block line carries no cells. */
    fireEvent.click(screen.getByRole('button', { name: 'RM' }));
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    expect(pdf).toHaveBeenCalledTimes(1);
    const [printed, o] = pdf.mock.calls[0]! as [Sheet, { fileName: string }];
    expect(o.fileName).toBe('pnl-monthly-2026-07-2026-09.pdf');
    expect(printed.tables[0]!.columns.map((c) => c.label)).toEqual(['累计 07/2026 – 09/2026', '%', '09/2026', '%', '08/2026', '%', '07/2026', '%']);
    expect(printed.tables[0]!.rows.find((r) => r.label === 'RENT')!.cells).toEqual([300_000, 30, 100_000, 25, 100_000, 40, 100_000, 20]);
    expect(printed.tables[0]!.rows.find((r) => r.label === 'Expenses')!.cells).toEqual([]);
  });

  test('a category folds and unfolds by its chevron past the level; an account name opens its lines under their months; a month\'s figure opens that month alone', () => {
    treeMode = true;
    useLedger.mockReturnValue({ data: { blocks: [{ code: '900-A001', name: 'RENT', type: 'EXPENSE', openingSen: 0, debitSen: 300_000, creditSen: 0, closingSen: 300_000, lines: [
      { lineId: 'l1', date: '2026-08-05', jeNo: 'JE-1', journal: 'BANK', counter: { code: '310-0010', name: 'MAYBANK', more: 0 }, doc: 'PV-1', doc2: null, description: 'Rent August', who: null, debitSen: 100_000, creditSen: 0, balanceSen: 100_000, reversal: '' },
      { lineId: 'l2', date: '2026-09-02', jeNo: 'JE-2', journal: 'BANK', counter: { code: '310-0010', name: 'MAYBANK', more: 0 }, doc: 'PV-2', doc2: null, description: 'Rent September', who: null, debitSen: 100_000, creditSen: 0, balanceSen: 200_000, reversal: '' },
    ] }], totals: { debitSen: 300_000, creditSen: 0 } }, isLoading: false, isError: false });
    vi.useFakeTimers({ now: new Date('2026-09-15T04:00:00Z'), toFake: ['Date'] });
    try {
      draw();
      fireEvent.click(within(screen.getByRole('group', { name: 'Months' })).getByRole('button', { name: '3' }));
      fireEvent.click(within(screen.getByRole('group', { name: 'Levels' })).getByRole('button', { name: 'L1' }));
    } finally { vi.useRealTimers(); }
    expect(screen.queryByText('900-A001 — RENT')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand OPERATING EXPENSE' }));
    expect(screen.getByText('900-A001 — RENT')).toBeTruthy();
    /* A subtotal (net) row wears the stronger shade (owner 2026-09-19). */
    expect(screen.getByText('NET PROFIT').closest('tr')!.className).toMatch(/(^|[\s_])net([\s_]|$)/);
    /* The amount keeps its % under it on the opened rows too. */
    expect(within(screen.getByText('900-A001 — RENT').closest('tr')!).getAllByRole('cell').map(pctBeside)).toEqual(['', '10.0%', '10.0%', '10.0%', '10.0%']);
    fireEvent.click(screen.getByRole('button', { name: 'Lines of 900-A001 — RENT' }));
    expect(useLedger).toHaveBeenLastCalledWith({ from: '2026-07-01', to: '2026-09-30', accounts: ['900-A001'] });
    /* Each line sits under its month (and under 累计), a dash elsewhere; the foot sums per column. */
    const lineRows = () => Array.from(document.querySelectorAll('tr[data-line-of="900-A001"]')) as HTMLElement[];
    expect(lineRows()).toHaveLength(2);
    const august = lineRows()[0]!;
    expect(within(august).getAllByRole('cell').map((c) => c.textContent)).toEqual(['05/08/2026 · Rent AugustPV-1', 'RM 1000.00', '-', 'RM 1000.00', '-']);
    expect(within(lineRows()[1]!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['02/09/2026 · Rent SeptemberPV-2', 'RM 1000.00', 'RM 1000.00', '-', '-']);
    const foot = () => document.querySelector('tr[data-lines-foot="900-A001"]') as HTMLElement;
    expect(within(foot()).getAllByRole('cell').map((c) => c.textContent)).toEqual(['共 2 笔在 GL 打开', 'RM 2000.00', 'RM 1000.00', 'RM 1000.00', '-']);
    /* The lines wear their own shade; the description is cut at the column, the whole text its tooltip; every figure keeps the % slot empty, so it sits under the amount, never under the % (owner 2026-09-19). */
    expect(august.className).toMatch(/lines/);
    expect(within(august).getAllByRole('cell')[0]!.className).toMatch(/clip/);
    expect(within(august).getAllByRole('cell')[0]!.getAttribute('title')).toBe('05/08/2026 · Rent August · PV-1');
    expect(within(august).getAllByRole('cell').slice(1).map((c) => c.querySelector('span[data-pct]')?.textContent)).toEqual(['', '', '', '']);
    expect(within(foot()).getAllByRole('cell').slice(1).every((c) => c.querySelector('span[data-pct]') !== null)).toBe(true);
    /* August's figure: that month's line alone; the same figure again closes; the name reopens the range. */
    fireEvent.click(screen.getByRole('button', { name: 'Lines of 900-A001 — RENT · 08/2026' }));
    expect(lineRows()).toHaveLength(1);
    expect(within(foot()).getAllByRole('cell')[0]!.textContent).toBe('共 1 笔 · 08/2026在 GL 打开');
    expect((screen.getByRole('button', { name: 'Lines of 900-A001 — RENT · 08/2026' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Lines of 900-A001 — RENT · 08/2026' }));
    expect(lineRows()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Lines of 900-A001 — RENT · 09/2026' }));
    expect(lineRows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Lines of 900-A001 — RENT' }));
    expect(lineRows()).toHaveLength(2);
    /* In % mode the account rows carry no % slot, so neither do the lines. */
    fireEvent.click(screen.getByRole('button', { name: '%' }));
    expect(within(lineRows()[0]!).getAllByRole('cell')[1]!.querySelector('span[data-pct]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'RM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse OPERATING EXPENSE' }));
    expect(screen.queryByText('900-A001 — RENT')).toBeNull();
    treeMode = false;
  });
});
