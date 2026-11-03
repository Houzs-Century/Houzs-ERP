/* The formal AR / AP aging (owner 2026-10-02) in the owner's Claude Design
   report shell (batch 6 step 6, question g1's default). Pinned: As at is the
   shared range's end; one row per debtor with its balance, five columns and
   Unapplied, in English; the tiles are the five columns, Unapplied and Total,
   and a tile filters the rows; a row opens its bills and its unapplied money
   (the order links); Detail / Summary; the choices ask the server again; the
   By invoice view lists each open bill with its days overdue and the design's
   age tag; the foot prints the books' figure and the difference, AutoCount
   bills apart and the orders AutoCount took a deposit on; Excel draws what is
   shown, in either view. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgingReportData } from '../../vendor/scm/lib/aging-queries';

const state = vi.hoisted(() => ({ fail: false }));
let data: AgingReportData;
const asked: Array<Record<string, string>> = [];
vi.mock('../../vendor/scm/lib/aging-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/aging-queries')>()),
  useAging: (_side: string, p: Record<string, string>) => {
    asked.push(p);
    return state.fail
      ? { data: undefined, isLoading: false, isError: true, error: new Error('the aging read failed') }
      : { data, isLoading: false, isError: false, error: null };
  },
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: vi.fn() }));

import { AgingReport, agingSheet } from './AgingReport';

beforeEach(() => {
  asked.length = 0;
  state.fail = false;
  xlsx.mockClear();
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

const Where = () => {
  const l = useLocation();
  return <output aria-label="address">{`${l.pathname}${l.search}`}</output>;
};
const draw = (side: 'ar' | 'ap' = 'ar') => render(
  <MemoryRouter initialEntries={[`/scm/accounting?tab=${side}&from=2026-09-01&to=2026-09-30`]}>
    <Routes><Route path="*" element={<><AgingReport side={side} /><Where /></>} /></Routes>
  </MemoryRouter>,
);
const parties = () => screen.getByRole('region', { name: 'AR aging by debtor' });
const tile = (name: RegExp) => within(screen.getByRole('group', { name: 'AR aging figures' })).getByRole('button', { name });
/* A Finance table prints its heads in title case: "This month" reads "This Month". */
const head = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

describe('AR / AP aging — by party', () => {
  test('as at the range’s end: a row per debtor, the five columns and Unapplied in English; the tiles; the foot ties to the books', () => {
    draw();
    expect(asked.at(-1)).toMatchObject({ asOf: '2026-09-30', basis: 'invoice', buckets: 'month', control: 'all' });
    const t = within(parties());
    for (const h of ['Debtor', 'Balance', 'This month', '1 month', '2 months', '3 months', '4 months +', 'Unapplied']) {
      expect(t.getAllByText(head(h)).length).toBeGreaterThan(0);
    }
    const ali = t.getByText('ALI').closest('tr')!;
    expect(ali.textContent).toContain('C-1');
    expect(ali.textContent).toContain('(800.00)');
    expect(ali.textContent).toContain('(1,200.00)');
    expect(tile(/^1 month/).textContent).toBe('1 month400.001 debtor');
    expect(tile(/^3 months/).textContent).toBe('3 months600.001 debtor');
    expect(tile(/^Unapplied/).textContent).toBe('Unapplied(1,200.00)1 debtor');
    expect(tile(/^Total/).textContent).toBe('Total(200.00)2 debtors');
    const notes = within(screen.getByRole('list', { name: 'Aging notes' }));
    expect(notes.getByText(/In the books \(300-0000 \+ 305-0000\) as at 2026\/09\/30: \(200\.00\) · difference 0\.00\./)).toBeTruthy();
    expect(notes.getByText(/38 customer invoice\(s\) brought over from AutoCount/)).toBeTruthy();
    expect(notes.getByText(/161 order\(s\) show 869,302\.00 owed here although AutoCount took their deposit/)).toBeTruthy();
  });

  test('a tile narrows the table to the rows with money in it; pressed again, or Total, shows them all', () => {
    draw();
    fireEvent.click(tile(/^3 months/));
    expect(tile(/^3 months/).getAttribute('aria-pressed')).toBe('true');
    expect(within(parties()).queryByText('ALI')).toBeNull();
    expect(within(parties()).getByText('BEE')).toBeTruthy();
    fireEvent.click(tile(/^3 months/));
    expect(within(parties()).getByText('ALI')).toBeTruthy();
    fireEvent.click(tile(/^Unapplied/));
    expect(within(parties()).queryByText('BEE')).toBeNull();
    fireEvent.click(tile(/^Total/));
    expect(tile(/^Total/).getAttribute('aria-pressed')).toBe('true');
    expect(within(parties()).getByText('BEE')).toBeTruthy();
  });

  test('a row opens its bills and its unapplied money, the order one click away; Detail opens every row, Summary none', () => {
    draw();
    fireEvent.click(within(parties()).getByText('ALI'));
    const bills = within(screen.getByRole('table', { name: "ALI's bills" }));
    expect(bills.getByText('SI-A1').getAttribute('href')).toBe('/scm/sales-orders/SO-A');
    expect(bills.getByText('SI-A1').closest('tr')!.textContent).toContain('1 month');
    expect(bills.getByText('SO-B').closest('tr')!.textContent).toContain('Unapplied');
    fireEvent.click(within(parties()).getByText('ALI'));
    expect(screen.queryByRole('table', { name: "ALI's bills" })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Detail' }));
    expect(screen.getByRole('table', { name: "ALI's bills" })).toBeTruthy();
    expect(screen.getByRole('table', { name: "BEE's bills" })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    expect(screen.queryByRole('table', { name: "BEE's bills" })).toBeNull();
  });

  test('the choices ask again; the find narrows the rows', () => {
    draw('ap');
    expect(screen.getByRole('region', { name: 'AP aging by creditor' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Other creditors' }));
    expect(asked.at(-1)).toMatchObject({ control: 'other' });
    fireEvent.click(screen.getByRole('button', { name: 'By days' }));
    expect(asked.at(-1)).toMatchObject({ buckets: 'day' });
    expect(within(screen.getByRole('region', { name: 'AP aging by creditor' })).getAllByText(head('Over 120 days')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Due date' }));
    expect(asked.at(-1)).toMatchObject({ basis: 'due' });
    fireEvent.change(screen.getByLabelText('Find a creditor'), { target: { value: 'bee' } });
    expect(screen.queryByText('ALI')).toBeNull();
    expect(screen.getByText('BEE')).toBeTruthy();
  });

  test('As at writes the day into the address and asks as at it', () => {
    draw();
    fireEvent.change(screen.getByLabelText('AR aging as at'), { target: { value: '2026/08/31' } });
    fireEvent.blur(screen.getByLabelText('AR aging as at'));
    expect(screen.getByLabelText('address').textContent).toContain('to=2026-08-31');
    expect(asked.at(-1)).toMatchObject({ asOf: '2026-08-31' });
  });

  test('Excel draws what is shown: the rows, the opened bills, the total, the notes', async () => {
    draw();
    fireEvent.click(within(parties()).getByText('ALI'));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0]! as [ReturnType<typeof agingSheet>, string];
    expect(file).toBe('ar-aging-2026-09-30.xlsx');
    expect(sheet.title).toBe('AR aging');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Balance', 'This month', '1 month', '2 months', '3 months', '4 months +', 'Unapplied']);
    expect(sheet.tables[0]!.rows.map((r) => [r.kind, r.label.split(' · ')[0]])).toEqual([
      ['row', 'C-1'], ['memo', 'SI-A1'], ['memo', 'SO-B'], ['row', 'BEE'], ['total', 'Total'],
    ]);
    expect(sheet.tables[0]!.rows[1]!.cells).toEqual([null, null, 40_000, null, null, null, null]);
    expect(sheet.tables[0]!.rows[2]!.label).toContain('· Unapplied');
    expect(sheet.notes?.length).toBe(3);
  });

  test('narrowed by a tile, Excel totals the rows shown', () => {
    const sheet = agingSheet('ar', data, [data.rows[1]!], new Set());
    expect(sheet.tables[0]!.rows.at(-1)).toEqual({ kind: 'total', depth: 0, label: 'Total of the 1 shown', cells: [60_000, 0, 0, 0, 60_000, 0, 0] });
  });

  test('a read that failed says so, with no table and no figures', () => {
    state.fail = true;
    draw();
    expect(screen.getByRole('alert').textContent).toBe('The aging did not load — the aging read failed');
    expect(screen.queryByRole('region', { name: 'AR aging by debtor' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'AR aging figures' })).toBeNull();
  });
});

describe('AR / AP aging — by invoice', () => {
  test('each open bill, most overdue first, with its days overdue and the design’s age tag; then the unapplied money', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'By invoice' }));
    const table = within(screen.getByRole('region', { name: 'AR aging by invoice' }));
    for (const h of ['Invoice', 'Kind', 'Debtor', 'Debtor code', 'Date', 'Due', 'Outstanding', 'Days overdue', 'Age']) {
      expect(table.getAllByText(head(h)).length).toBeGreaterThan(0);
    }
    const order = ['SI-C1', 'SI-A1', 'SO-B'].map((n) => table.getByText(n).closest('tr')!);
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    /* Due 2026/07/20, as at 2026/09/30: 72 days, 61-90. */
    expect(order[0]!.textContent).toContain('2026/07/20');
    expect(order[0]!.textContent).toContain('72');
    expect(within(order[0]!).getByText('61-90')).toBeTruthy();
    /* No due date: due on its date, 2026/08/10 — 51 days, 31-60. */
    expect(within(order[1]!).getByText('51')).toBeTruthy();
    expect(within(order[1]!).getByText('31-60')).toBeTruthy();
    expect(table.getByText('SI-A1').getAttribute('href')).toBe('/scm/sales-orders/SO-A');
    expect(within(order[2]!).getByText('Unapplied')).toBeTruthy();
    expect(order[2]!.textContent).toContain('(1,200.00)');
  });

  test('a tile narrows the bills too; Excel draws the invoice table as shown', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'By invoice' }));
    fireEvent.click(tile(/^1 month/));
    const table = within(screen.getByRole('region', { name: 'AR aging by invoice' }));
    expect(table.queryByText('SI-C1')).toBeNull();
    expect(table.getByText('SI-A1')).toBeTruthy();
    fireEvent.click(tile(/^Total/));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0]! as [ReturnType<typeof agingSheet>, string];
    expect(file).toBe('ar-aging-by-invoice-2026-09-30.xlsx');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Kind', 'Debtor', 'Date', 'Due', 'Outstanding', 'Days overdue', 'Age']);
    expect(sheet.tables[0]!.rows.map((r) => r.label)).toEqual(['SI-C1', 'SI-A1', 'SO-B', 'Total']);
    expect(sheet.tables[0]!.rows[0]!.cells).toEqual(['Invoice', 'BEE', '2026/06/20', '2026/07/20', 60_000, '72', '61-90']);
    expect(sheet.tables[0]!.rows[2]!.cells).toEqual(['Payment', 'C-1 · ALI', '2026/09/15', null, -120_000, null, 'Unapplied']);
    expect(sheet.tables[0]!.rows[3]!.cells[4]).toBe(-20_000);
  });
});
