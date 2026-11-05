// The statement table (the owner's Claude Design, batch 6 §4.1) and the
// columns it draws: Compare's other period, By month's Total and months, the
// change computed once; the frozen account column with the code before the
// name, % beside every figure, the row dresses, an account's lines opened
// under its row (the name: the whole span; a figure: that column), a
// category's figure handed to the General ledger, and the widths a person
// drags — remembered per view, reset per column or all at once.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ calls: [] as Array<{ from: string; to: string; accounts?: string[] }> }));
vi.mock('../../../vendor/scm/lib/ledger-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLedger: (p: { from: string; to: string; accounts?: string[] }) => {
    ledger.calls.push(p);
    return {
      isLoading: false, isError: false,
      data: {
        blocks: [{
          code: p.accounts?.[0], name: 'X', type: 'EXPENSE', openingSen: 0, debitSen: 12_000, creditSen: 0, closingSen: 12_000,
          lines: [{ lineId: 'l1', date: p.from, jeNo: 'JE-1', journal: 'GENERAL', counter: { code: '310-0010', name: 'BANK', more: 0 }, doc: 'PV-1', doc2: null, description: 'Advert', who: null, debitSen: 12_000, creditSen: 0, balanceSen: 12_000, reversal: '' }],
        }],
      },
    };
  },
}));

import { useReportTree } from '../ReportLayoutTree';
import { linesVisible } from '../../../vendor/scm/lib/report-layout';
import type { FlatLine } from '../../../vendor/scm/lib/report-monthly';
import {
  compareRange, monthColumns, periodLabel, pnlColumns, statementLines, yearBack,
  type StatementColumn,
} from './statementColumns';
import { StatementTable, codesUnder, nameOf } from './StatementTable';

describe('the columns a statement shows', () => {
  test('a whole month reads as the month, any other range as its two days', () => {
    expect(periodLabel('2026-10-01', '2026-10-31')).toBe('October 2026');
    expect(periodLabel('2026-10-01', '2026-10-29')).toBe('2026/10/01 – 2026/10/29');
  });

  test('Compare: the previous period steps back by whole months from a 1st, else by its own length; last year by the calendar', () => {
    /* A month in progress is compared day for day with the month before. */
    expect(compareRange('2026-10-01', '2026-10-31', '2026-10-29', 'previous')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(compareRange('2026-07-01', '2026-09-30', '2026-10-29', 'previous')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(compareRange('2026-10-10', '2026-10-20', '2026-10-29', 'previous')).toEqual({ from: '2026-09-29', to: '2026-10-09' });
    expect(compareRange('2026-10-01', '2026-10-31', '2026-10-29', 'lastYear')).toEqual({ from: '2025-10-01', to: '2025-10-29' });
    expect(yearBack('2028-02-29')).toBe('2027-02-28');
  });

  test('By month: Total leftmost over the months, then each month newest first; the month still running says so', () => {
    const cols = monthColumns('2026-10-29', 3, '2026-10-29', true);
    expect(cols.map((c) => c.key)).toEqual(['total', '2026-10', '2026-09', '2026-08']);
    expect(cols[0]).toMatchObject({ label: 'Total', sub: '3 months', kind: 'total', from: '2026-08-01', to: '2026-10-31' });
    expect(cols[1]).toMatchObject({ label: 'Oct 2026', sub: 'to 2026/10/29 *', from: '2026-10-01', to: '2026-10-31' });
    expect(cols[2]!.sub).toBeUndefined();
    /* A balance sheet adds no months up: no Total. */
    expect(monthColumns('2026-10-29', 3, '2026-10-29', false).map((c) => c.key)).toEqual(['2026-10', '2026-09', '2026-08']);
  });

  test('Compare: this period, the other, and the change — computed once, on every line either names', () => {
    const cols = pnlColumns('compare', '2026-10-01', '2026-10-31', '2026-11-03', { compareWith: 'previous', months: 6 });
    expect(cols.map((c) => [c.key, c.sub])).toEqual([['cur', 'This period'], ['cmp', 'Previous period'], ['chg', 'This period less the other']]);
    const cur: FlatLine[] = [{ id: 'acc:a', label: 'a', kind: 'row', depth: 1, amountSen: 500, pct: 50 }, { id: 'blk:x', label: 'X', kind: 'block', depth: 0, amountSen: 0, pct: null }];
    const cmp: FlatLine[] = [{ id: 'acc:a', label: 'a', kind: 'row', depth: 1, amountSen: 200, pct: 20 }, { id: 'acc:b', label: 'b', kind: 'row', depth: 1, amountSen: 100, pct: 10 }];
    const lines = statementLines(cols, { cur, cmp });
    expect(lines.find((l) => l.id === 'acc:a')!.cells.chg).toEqual({ amountSen: 300, pct: null });
    expect(lines.find((l) => l.id === 'acc:b')!.cells.chg).toEqual({ amountSen: -100, pct: null });
    expect(lines.find((l) => l.id === 'blk:x')!.cells.chg).toBeUndefined();
  });

  test('an account line prints its code apart from its name; a category stands for every account under it', () => {
    expect(nameOf({ label: '900-A001 · ADVERT', code: '900-A001' })).toBe('ADVERT');
    expect(nameOf({ label: 'Lim Kah Hoe', code: '300-0000' })).toBe('Lim Kah Hoe');
    const lines = [
      { id: 'c', label: 'Ops', kind: 'category' as const, depth: 1, cells: {} },
      { id: 'a', label: '900-A001 · ADVERT', kind: 'row' as const, depth: 2, code: '900-A001', cells: {} },
      { id: 'b', label: '900-A002 · PRINT', kind: 'row' as const, depth: 2, code: '900-A002', cells: {} },
      { id: 't', label: 'Total', kind: 'total' as const, depth: 0, cells: {} },
    ];
    expect(codesUnder(lines, 0)).toEqual(['900-A001', '900-A002']);
  });
});

const COLS: StatementColumn[] = [
  { key: 'total', label: 'Total', sub: '2 months', kind: 'total', from: '2026-09-01', to: '2026-10-31', pct: true },
  { key: '2026-10', label: 'Oct 2026', kind: 'period', from: '2026-10-01', to: '2026-10-31', pct: true },
  { key: '2026-09', label: 'Sep 2026', kind: 'period', from: '2026-09-01', to: '2026-09-30', pct: true },
];
const LINES = [
  { id: 'blk:expenses', label: 'Expenses', kind: 'block' as const, depth: 0, cells: {} },
  { id: 'cat:ops', label: 'Operating expense', kind: 'category' as const, depth: 1, cells: { total: { amountSen: 30_000, pct: 30 }, '2026-10': { amountSen: 20_000, pct: 20 }, '2026-09': { amountSen: 10_000, pct: 10 } } },
  { id: 'acc:900-A001', label: '900-A001 · ADVERT', kind: 'row' as const, depth: 2, code: '900-A001', cells: { total: { amountSen: 30_000, pct: 30 }, '2026-10': { amountSen: 20_000, pct: 20 }, '2026-09': { amountSen: 10_000, pct: 10 } } },
  { id: 'acc:900-A014', label: '900-A014 · REFUND', kind: 'row' as const, depth: 2, code: '900-A014', cells: { total: { amountSen: -1_500, pct: -1.5 }, '2026-10': { amountSen: -1_500, pct: -1.5 } } },
  { id: 'tot:expenses', label: 'Total expenses', kind: 'total' as const, depth: 0, cells: { total: { amountSen: 28_500, pct: 28.5 } } },
  { id: 'net:net', label: 'NET PROFIT', kind: 'net' as const, depth: 0, cells: { total: { amountSen: 71_500, pct: 71.5 } } },
];

function Table({ showPct = true, onCategoryFigure = vi.fn() }: { showPct?: boolean; onCategoryFigure?: (codes: string[], col: StatementColumn) => void }) {
  const tree = useReportTree('all');
  return (
    <MemoryRouter initialEntries={['/scm/accounting?tab=pnl']}>
      <StatementTable
        widthsKey="month" head="Account" columns={COLS} lines={LINES} shown={linesVisible(LINES, 'all', tree.open)}
        level="all" tree={tree} showPct={showPct} finalId="net:net" onCategoryFigure={onCategoryFigure}
        note="A note." drillKey="k" ariaLabel="P&L"
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  ledger.calls = [];
  window.localStorage.removeItem('fin-reports-colw-v2');
});

describe('the statement table', () => {
  test('heads: each period with its sub-line and its % caption; the Total column tinted and ruled', () => {
    render(<Table />);
    const heads = screen.getAllByRole('columnheader');
    expect(heads.map((h) => h.textContent)).toEqual(['Account', 'Total2 months%', 'Oct 2026%', 'Sep 2026%']);
    expect(heads[1]!.className).toMatch(/colTotal/);
    render(<Table showPct={false} />);
    expect(screen.getAllByRole('columnheader').slice(4).map((h) => h.textContent)).toEqual(['Account', 'Total2 months', 'Oct 2026', 'Sep 2026']);
  });

  test('rows: the code before the name, % beside every figure, a dash where a month has nothing, brackets for a credit', () => {
    render(<Table />);
    const refund = screen.getByText('REFUND').closest('tr')!;
    expect(within(refund).getByText('900-A014')).toBeTruthy();
    expect(refund.textContent).toContain('(15.00)');
    expect(refund.textContent).toContain('-1.5%');
    expect([...refund.querySelectorAll('td')].at(-1)!.textContent).toBe('--');
    expect(screen.getByText('NET PROFIT').closest('tr')!.className).toMatch(/rowFinal/);
    expect(screen.getByText('Total expenses').closest('tr')!.className).toMatch(/rowSubtotal/);
  });

  test('an account’s name opens its lines for the whole span, a figure that column’s; again closes; several may be open', () => {
    render(<Table />);
    fireEvent.click(screen.getByRole('button', { name: 'Lines of 900-A001 · ADVERT' }));
    const lines = screen.getByRole('region', { name: 'Lines of 900-A001 ADVERT' });
    expect(ledger.calls.at(-1)).toMatchObject({ from: '2026-09-01', to: '2026-10-31', accounts: ['900-A001'] });
    expect(within(lines).getByText(/2026\/09\/01 – 2026\/10\/31/)).toBeTruthy();
    expect(within(lines).getByText('Advert')).toBeTruthy();
    const gl = within(lines).getByRole('link', { name: /Open in General ledger/ });
    expect(gl.getAttribute('href')).toBe('/scm/accounting?tab=gl&accounts=900-A001&from=2026-09-01&to=2026-10-31&in=reports');
    /* A figure switches the lines to that month, and pressed again closes them. */
    fireEvent.click(screen.getByRole('button', { name: '900-A001 · ADVERT · Oct 2026' }));
    expect(ledger.calls.at(-1)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    fireEvent.click(screen.getByRole('button', { name: '900-A014 · REFUND · Oct 2026' }));
    expect(screen.getAllByRole('region', { name: /^Lines of/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '900-A001 · ADVERT · Oct 2026' }));
    expect(screen.getAllByRole('region', { name: /^Lines of/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close the lines' }));
    expect(screen.queryByRole('region', { name: /^Lines of/ })).toBeNull();
  });

  test('a category folds by its chevron or its name; its figure hands its accounts to the General ledger', () => {
    const onCategoryFigure = vi.fn();
    render(<Table onCategoryFigure={onCategoryFigure} />);
    fireEvent.click(screen.getByRole('button', { name: 'Operating expense · Sep 2026' }));
    expect(onCategoryFigure).toHaveBeenCalledWith(['900-A001', '900-A014'], COLS[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Operating expense' }));
    expect(screen.queryByText('ADVERT')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Operating expense' }));
    expect(screen.getByText('ADVERT')).toBeTruthy();
  });

  test('a dragged edge keeps its width per view; a double-click puts that column back; Reset puts them all back', () => {
    render(<Table />);
    expect(screen.queryByRole('button', { name: 'Reset column widths' })).toBeNull();
    const [accEdge, totalEdge] = screen.getAllByRole('separator');
    expect(accEdge!.getAttribute('title')).toBe('Drag to resize · double-click to reset');
    fireEvent.mouseDown(accEdge!, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 360 });
    fireEvent.mouseUp(document);
    fireEvent.mouseDown(totalEdge!, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 150 });
    fireEvent.mouseUp(document);
    expect(JSON.parse(window.localStorage.getItem('fin-reports-colw-v2')!)).toEqual({ month: { acc: 260, total: 150 } });
    fireEvent.doubleClick(totalEdge!);
    expect(JSON.parse(window.localStorage.getItem('fin-reports-colw-v2')!)).toEqual({ month: { acc: 260 } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset column widths' }));
    expect(window.localStorage.getItem('fin-reports-colw-v2')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset column widths' })).toBeNull();
  });
});
