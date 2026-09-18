/* The monthly view (owner 2026-09-14, docs/bugs/0916: 能看每个月的). Pinned:
   one request per column, 累计 leftmost then newest → oldest; a line a month
   has and the range lacks still prints; the % toggle; the months buttons;
   the levels; Export writes the CSV. The lines themselves:
   vendor/scm/lib/report-monthly.test.ts. */

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
const download = vi.fn();
const useLedger = vi.fn();
vi.mock('../../vendor/scm/lib/ledger-queries', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useLedger: (...a: unknown[]) => useLedger(...a) }));
vi.mock('../../lib/csv', () => ({ downloadCSV: (...a: unknown[]) => download(...a) }));

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
    expect(within(rent).getAllByRole('cell').map(amountOf)).toEqual(['RENT', '—', 'RM 1000.00', 'RM 1000.00', 'RM 1000.00', '—', '—', '—']);
    const advert = screen.getByText('ADVERT').closest('tr')!;
    expect(within(advert).getAllByRole('cell').map(amountOf)).toEqual(['ADVERT', '—', '—', 'RM 50.00', '—', '—', '—', '—']);
    /* ADVERT sits after RENT, where August had it. */
    const rows = screen.getAllByRole('row').map((r) => String(r.textContent));
    expect(rows.findIndex((t) => t.startsWith('ADVERT'))).toBe(rows.findIndex((t) => t.startsWith('RENT')) + 1);
  });

  test('3 months makes the range 累计 of three; the % toggle prints each cell\'s %; L1 folds; Export writes the CSV', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(download).toHaveBeenCalledTimes(1);
    expect(String(download.mock.calls[0]![0])).toBe('pnl-monthly-2026-07-2026-09.csv');
    expect(String(download.mock.calls[0]![1])).toContain('RENT,30.0%,25.0%,40.0%,20.0%');
  });

  test('a category folds and unfolds by its chevron past the level; an account name opens its lines for the whole range', () => {
    treeMode = true;
    useLedger.mockReturnValue({ data: { blocks: [{ code: '900-A001', name: 'RENT', type: 'EXPENSE', openingSen: 0, debitSen: 300_000, creditSen: 0, closingSen: 300_000, lines: [
      { lineId: 'l1', date: '2026-08-05', jeNo: 'JE-1', journal: 'BANK', counter: { code: '310-0010', name: 'MAYBANK', more: 0 }, doc: 'PV-1', doc2: null, description: 'Rent August', who: null, debitSen: 100_000, creditSen: 0, balanceSen: 100_000, reversal: '' },
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
    /* The amount keeps its % under it on the opened rows too. */
    expect(within(screen.getByText('900-A001 — RENT').closest('tr')!).getAllByRole('cell').map(pctBeside)).toEqual(['', '10.0%', '10.0%', '10.0%', '10.0%']);
    fireEvent.click(screen.getByRole('button', { name: 'Lines of 900-A001 — RENT' }));
    expect(useLedger).toHaveBeenLastCalledWith({ from: '2026-07-01', to: '2026-09-30', accounts: ['900-A001'] });
    const drill = document.querySelector('tr[data-lines-of="900-A001"]') as HTMLElement;
    expect(within(drill).getByText('Rent August')).toBeTruthy();
    expect(within(drill).getByText(/共 1 笔/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse OPERATING EXPENSE' }));
    expect(screen.queryByText('900-A001 — RENT')).toBeNull();
    treeMode = false;
  });
});
