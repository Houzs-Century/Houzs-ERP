/* The formal AR / AP Aging screen (owner 2026-10-02). Pinned: one row per
   debtor with its balance, five month columns and 未冲; ▸ opens its bills and
   its 未冲; the foot prints the books' figure and the difference, AutoCount
   bills apart and the orders AutoCount took a deposit on; the chips and the
   switches ask the server again; Excel draws what is shown. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgingReportData } from '../../vendor/scm/lib/aging-queries';

let data: AgingReportData;
const asked: Array<Record<string, string>> = [];
vi.mock('../../vendor/scm/lib/aging-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/aging-queries')>()),
  useAging: (_side: string, p: Record<string, string>) => { asked.push(p); return { data, isLoading: false, isError: false, error: null }; },
}));
const xlsx = vi.fn();
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: vi.fn() }));

import { AgingReport, agingSheet } from './AgingReport';

beforeEach(() => {
  asked.length = 0;
  xlsx.mockReset();
  data = {
    asOf: '2026-09-30', basis: 'invoice', buckets: 'month', control: 'all',
    rows: [
      {
        key: 'C-1', code: 'C-1', name: 'ALI', balanceSen: -80_000, cells: [0, 40_000, 0, 0, 0], unappliedSen: -120_000,
        items: [{ group: 'SO:SO-A', docNo: 'SI-A1', kind: 'Invoice', date: '2026-08-10', dueDate: null, amountSen: 120_000, openSen: 40_000, column: 1 }],
        unapplied: [{ docNo: 'SO-B', kind: 'Payment', date: '2026-09-15', amountSen: -120_000 }],
      },
      {
        key: 'cust-2', code: null, name: 'BEE', balanceSen: 60_000, cells: [0, 0, 0, 60_000, 0], unappliedSen: 0,
        items: [{ group: 'SO:SO-C', docNo: 'SI-C1', kind: 'Invoice', date: '2026-06-20', dueDate: '2026-07-20', amountSen: 90_000, openSen: 60_000, column: 3 }],
        unapplied: [],
      },
    ],
    totals: { balanceSen: -20_000, cells: [0, 40_000, 0, 60_000, 0], unappliedSen: -120_000 },
    controls: [{ code: '300-0000', balanceSen: -20_000 }, { code: '305-0000', balanceSen: 0 }],
    differenceSen: 0,
    outside: { count: 38, sen: 24_039_750 },
    paidBeforeErp: { orders: 161, sen: 86_930_200 },
  };
});

const draw = (side: 'ar' | 'ap' = 'ar') => render(<MemoryRouter><AgingReport side={side} /></MemoryRouter>);

describe('AR / AP Aging', () => {
  test('a row per debtor: balance, the month columns, 未冲; the foot ties to the books', () => {
    draw();
    const table = screen.getByRole('table', { name: 'AR Aging · 应收账龄' });
    const t = within(table);
    for (const h of ['Debtor', 'Balance', '本月', '1 个月', '2 个月', '3 个月', '4 个月以上', '未冲']) expect(t.getByText(h)).toBeTruthy();
    expect(t.getByText('ALI')).toBeTruthy();
    expect(t.getAllByText('(800.00)').length).toBeGreaterThan(0);
    expect(t.getAllByText('(1,200.00)').length).toBe(2);
    const notes = within(screen.getByRole('list', { name: 'Aging notes' }));
    expect(notes.getByText(/In the books \(300-0000 \+ 305-0000\) as at .*\(200\.00\) · difference 0\.00\./)).toBeTruthy();
    expect(notes.getByText(/38 customer invoice\(s\) brought over from AutoCount/)).toBeTruthy();
    expect(notes.getByText(/161 order\(s\) show 869,302\.00 owed here although AutoCount took their deposit/)).toBeTruthy();
  });

  test('▸ opens the bills and the 未冲; the order links', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: "Show ALI's bills" }));
    expect(screen.getByText('SI-A1').getAttribute('href')).toBe('/scm/sales-orders/SO-A');
    expect(screen.getByText(/Payment · .* · 未冲/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Hide ALI's bills" }));
    expect(screen.queryByText('SI-A1')).toBeNull();
  });

  test('the chips and switches ask again; the search narrows the rows', () => {
    draw('ap');
    expect(screen.getByRole('table', { name: 'AP Aging · 应付账龄' })).toBeTruthy();
    fireEvent.click(screen.getByText('Other creditors'));
    expect(asked.at(-1)).toMatchObject({ control: 'other' });
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: 'day' } });
    expect(asked.at(-1)).toMatchObject({ buckets: 'day' });
    fireEvent.change(screen.getByLabelText('Age by'), { target: { value: 'due' } });
    expect(asked.at(-1)).toMatchObject({ basis: 'due' });
    fireEvent.change(screen.getByLabelText('Find a creditor'), { target: { value: 'bee' } });
    expect(screen.queryByText('ALI')).toBeNull();
    expect(screen.getByText('BEE')).toBeTruthy();
  });

  test('Excel draws what is shown: the rows, the opened bills, the total, the notes', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: "Show ALI's bills" }));
    fireEvent.click(screen.getByText('Excel'));
    expect(xlsx).toHaveBeenCalledTimes(1);
    const [sheet, file] = xlsx.mock.calls[0]! as [ReturnType<typeof agingSheet>, string];
    expect(file).toMatch(/^ar-aging-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Balance', '本月', '1 个月', '2 个月', '3 个月', '4 个月以上', '未冲']);
    expect(sheet.tables[0]!.rows.map((r) => [r.kind, r.label.split(' · ')[0]])).toEqual([
      ['row', 'C-1'], ['memo', 'SI-A1'], ['memo', 'SO-B'], ['row', 'BEE'], ['total', 'Total'],
    ]);
    expect(sheet.tables[0]!.rows[1]!.cells).toEqual([null, null, 40_000, null, null, null, null]);
    expect(sheet.notes?.length).toBe(3);
  });
});
