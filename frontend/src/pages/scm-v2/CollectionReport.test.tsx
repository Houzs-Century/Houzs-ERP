/* The Collection tab (owner 2026-09-12, docs/bugs/0825): two views over the
   orders of a period — deposit against order value per salesman with the
   under-threshold count, and the balance collected on the delivered ones. A
   salesman opens to the orders; "only below" narrows to the orders under the
   line. In the owner's Claude Design (batch 6 step 13): the shared range as
   the SO date, the threshold 10%–90% or Other…, the tiles of the view, the
   grid, an order opening its sales order, Excel / PDF / Print as shown and the
   CSV under ⋯. The server half is backend/tests/collectionReport.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CollectionReport } from '../../vendor/scm/lib/collection-report-queries';


const order = (docNo: string, over: Partial<CollectionReport['rows'][number]['sos'][number]> = {}) => ({
  docNo, soDate: '2026-07-02', status: 'CONFIRMED', customer: 'Ah Meng',
  totalSen: 500000, depositSen: 200000, balancePaidSen: 0, collectedSen: 200000, outstandingSen: 300000,
  depositPct: 40, balanceDueSen: 300000, balancePct: 0, delivered: false, belowThreshold: true, invoiceNumber: null, billedSen: 500000, ...over,
});
const report: CollectionReport = {
  from: '2026-07-01', to: '2026-07-31', thresholdPct: 50,
  rows: [
    {
      salespersonId: 'A', salesperson: 'Scarlett Chong Kar Yin', orders: 2, totalSen: 800000, depositSen: 350000, depositPct: 43.8, belowCount: 1,
      delivered: { orders: 1, totalSen: 300000, billedSen: 300000, depositSen: 150000, balanceDueSen: 150000, balancePaidSen: 100000, balancePct: 66.7, outstandingSen: 50000 },
      sos: [
        order('SO-1'),
        order('SO-2', { status: 'DELIVERED', totalSen: 300000, billedSen: 300000, invoiceNumber: '2990-SI-2607-004', depositSen: 150000, balancePaidSen: 100000, collectedSen: 250000, outstandingSen: 50000, depositPct: 50, balanceDueSen: 150000, balancePct: 66.7, delivered: true, belowThreshold: false }),
      ],
    },
    {
      salespersonId: 'B', salesperson: 'Kah Wai', orders: 1, totalSen: 200000, depositSen: 200000, depositPct: 100, belowCount: 0,
      delivered: { orders: 1, totalSen: 200000, billedSen: 200000, depositSen: 200000, balanceDueSen: 0, balancePaidSen: 0, balancePct: 0, outstandingSen: 0 },
      sos: [order('SO-4', { status: 'DELIVERED', totalSen: 200000, billedSen: 200000, depositSen: 200000, collectedSen: 200000, outstandingSen: 0, depositPct: 100, balanceDueSen: 0, delivered: true, belowThreshold: false })],
    },
  ],
  totals: {
    salespersonId: null, salesperson: 'Total', orders: 3, totalSen: 1000000, depositSen: 550000, depositPct: 55, belowCount: 1,
    delivered: { orders: 2, totalSen: 500000, billedSen: 500000, depositSen: 350000, balanceDueSen: 150000, balancePaidSen: 100000, balancePct: 66.7, outstandingSen: 50000 },
    sos: [],
  },
};
const lastPath = { value: '' };

vi.mock('../../vendor/scm/lib/collection-report-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useCollectionReport: (from: string, to: string, threshold: number, salesperson: string | null) => {
    lastPath.value = `${from}|${to}|${threshold}|${salesperson ?? ''}`;
    return { data: report, isLoading: false, isError: false };
  },
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));

const { CollectionTab, collectionCsv, collectionTiles } = await import('./CollectionReport');

const draw = () => render(
  <MemoryRouter initialEntries={['/scm/accounting?tab=collection&from=2026-07-01&to=2026-07-31']}><CollectionTab /></MemoryRouter>,
);
const grid = () => within(screen.getByRole('table', { name: /^Collection · / }));
const rowOf = (re: RegExp) => grid().getAllByRole('row').find((r) => re.test(r.textContent))!;

beforeEach(() => { xlsx.mockClear(); });

describe('the Collection tab', () => {
  test('opens on the deposit view, the range as the SO date: a salesman a line, the under-threshold count in red, totals below', () => {
    draw();
    expect(lastPath.value).toBe('2026-07-01|2026-07-31|50|');
    const scarlett = rowOf(/^Scarlett Chong Kar Yin/);
    expect(within(scarlett).getByText('8,000.00')).toBeTruthy();
    expect(within(scarlett).getByText('3,500.00')).toBeTruthy();
    expect(within(scarlett).getByText('43.8%')).toBeTruthy();
    expect(grid().getByText('Below 50%')).toBeTruthy();
    const total = rowOf(/^Total · 2 salesmen/);
    expect(within(total).getByText('10,000.00')).toBeTruthy();
    expect(within(total).getByText('55.0%')).toBeTruthy();
    const tiles = screen.getByRole('group', { name: 'Collection figures' });
    expect(tiles.textContent).toContain('Orders3Opened 2026/07/01 – 2026/07/31');
    expect(tiles.textContent).toContain('Deposit collected5,500.0055.0% of order value');
    expect(tiles.textContent).toContain('Below 50%1orders under the line');
  });

  test('a salesman opens to the orders — each opening its sales order — and "only below" keeps the ones under the line', () => {
    draw();
    fireEvent.click(screen.getByLabelText('Show the orders of Scarlett Chong Kar Yin'));
    expect(screen.getByText('SO-1').getAttribute('href')).toBe('/scm/sales-orders/SO-1');
    expect(screen.getByText('SO-2')).toBeTruthy();
    expect(rowOf(/^SO-1/).textContent).toContain('Ah Meng · 2026/07/02 · confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'Only below 50%' }));
    expect(screen.getByText('SO-1')).toBeTruthy();
    expect(screen.queryByText('SO-2')).toBeNull();
  });

  test('the balance view reads the delivered orders: due, paid, %, outstanding', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Balance' }));
    expect(grid().getByText('Balance due')).toBeTruthy();
    const scarlett = rowOf(/^Scarlett Chong Kar Yin/);
    expect(within(scarlett).getAllByText('1,500.00')).toHaveLength(2);   // deposit and balance due, both 1,500
    expect(within(scarlett).getByText('1,000.00')).toBeTruthy();   // balance paid
    expect(within(scarlett).getByText('66.7%')).toBeTruthy();
    expect(within(scarlett).getByText('500.00')).toBeTruthy();     // outstanding
    fireEvent.click(screen.getByLabelText('Show the orders of Scarlett Chong Kar Yin'));
    expect(screen.getByText('SO-2')).toBeTruthy();
    expect(screen.getByText(/2990-SI-2607-004/)).toBeTruthy();    // the final invoice it is measured against
    expect(screen.queryByText('SO-1')).toBeNull();                 // not delivered
    const tiles = collectionTiles(report, 'balance', 'July');
    expect(tiles.map((t) => [t.label, t.value, t.sub])).toEqual([
      ['Delivered orders', '2', 'Delivered or invoiced'],
      ['Invoiced value', '5,000.00', 'Against the final invoice'],
      ['Balance paid', '1,000.00', '66.7% of 1,500.00 due'],
      ['Outstanding', '500.00', 'Balance still to come in'],
    ]);
  });

  test('the threshold — a choice or Other… — travels to the server; the CSV writes the open view', () => {
    draw();
    fireEvent.change(screen.getByLabelText('Threshold'), { target: { value: '60' } });
    expect(lastPath.value).toMatch(/\|60\|$/);
    fireEvent.change(screen.getByLabelText('Threshold'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Deposit threshold percent'), { target: { value: '35' } });
    expect(lastPath.value).toMatch(/\|35\|$/);
    const csv = collectionCsv(report, 'deposit', true);
    expect(csv.split('\n')[0]).toBe('"Salesman","Orders","Order value","Deposit","Deposit %","Below 50%"');
    expect(csv).toContain('"Scarlett Chong Kar Yin","2","8,000.00","3,500.00","43.8%","1"');
    expect(csv).toContain('"SO-1"');
    expect(csv).not.toContain('"SO-2"');
    const balance = collectionCsv(report, 'balance', false);
    expect(balance).toContain('"Balance due"');
    expect(balance).toContain('"SO-2"');
    expect(balance).not.toContain('"SO-1"');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'CSV' })).toBeTruthy();
  });

  test('Excel draws the view as shown — the opened salesman\'s orders included', async () => {
    draw();
    fireEvent.click(screen.getByLabelText('Show the orders of Kah Wai'));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0]! as [{ title: string; tables: Array<{ columns: Array<{ label: string }>; rows: Array<{ label: string }> }> }, string];
    expect(file).toBe('collection-deposit-2026-07-01-2026-07-31.xlsx');
    expect(sheet.title).toBe('Collection · Deposit');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Orders', 'Order value', 'Deposit', 'Deposit %', 'Below 50%']);
    expect(sheet.tables[0]!.rows.map((r) => r.label.split(' · ')[0])).toEqual(['Scarlett Chong Kar Yin', 'Kah Wai', 'SO-4', 'Total']);
  });
});
