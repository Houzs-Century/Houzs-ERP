/* The Collection tab (owner 2026-09-12, docs/bugs/0825): two views over the
   orders of a period — deposit against order value per salesman with the
   under-threshold count, and the balance collected on the delivered ones. A
   salesman opens to the orders; "only below" narrows to the orders under the
   line; Export writes the open view. The server half is
   backend/tests/collectionReport.test.ts. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
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

const { CollectionTab, collectionCsv } = await import('./CollectionReport');

describe('the Collection tab', () => {
  test('opens on the deposit view: a salesman a line, the under-threshold count in red, totals below', () => {
    render(<CollectionTab />);
    expect(lastPath.value).toMatch(/\|50\|$/);
    const rows = screen.getAllByRole('row');
    const scarlett = rows.find((r) => within(r).queryByText(/Scarlett Chong Kar Yin/))!;
    expect(within(scarlett).getByText('8,000.00')).toBeTruthy();
    expect(within(scarlett).getByText('3,500.00')).toBeTruthy();
    expect(within(scarlett).getByText('43.8%')).toBeTruthy();
    expect(screen.getByText('Below 50%')).toBeTruthy();
    const total = rows.find((r) => within(r).queryByText('Total'))!;
    expect(within(total).getByText('10,000.00')).toBeTruthy();
    expect(within(total).getByText('55.0%')).toBeTruthy();
  });

  test('a salesman opens to the orders, and "only below" keeps the ones under the line', () => {
    render(<CollectionTab />);
    fireEvent.click(screen.getByLabelText('Show the orders of Scarlett Chong Kar Yin'));
    expect(screen.getByText('SO-1')).toBeTruthy();
    expect(screen.getByText('SO-2')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Only orders below the threshold'));
    expect(screen.getByText('SO-1')).toBeTruthy();
    expect(screen.queryByText('SO-2')).toBeNull();
  });

  test('the balance view reads the delivered orders: due, paid, %, outstanding', () => {
    render(<CollectionTab />);
    fireEvent.click(screen.getByRole('tab', { name: 'Balance' }));
    expect(screen.getByText('Balance due')).toBeTruthy();
    const rows = screen.getAllByRole('row');
    const scarlett = rows.find((r) => within(r).queryByText(/Scarlett Chong Kar Yin/))!;
    expect(within(scarlett).getAllByText('1,500.00')).toHaveLength(2);   // deposit and balance due, both 1,500
    expect(within(scarlett).getByText('1,000.00')).toBeTruthy();   // balance paid
    expect(within(scarlett).getByText('66.7%')).toBeTruthy();
    expect(within(scarlett).getByText('500.00')).toBeTruthy();     // outstanding
    fireEvent.click(screen.getByLabelText('Show the orders of Scarlett Chong Kar Yin'));
    expect(screen.getByText('SO-2')).toBeTruthy();
    expect(screen.getByText('2990-SI-2607-004')).toBeTruthy();    // the final invoice it is measured against
    expect(screen.queryByText('SO-1')).toBeNull();                 // not delivered
  });

  test('the threshold travels to the server and the export writes the open view', () => {
    render(<CollectionTab />);
    fireEvent.change(screen.getByLabelText('Deposit threshold percent'), { target: { value: '60' } });
    expect(lastPath.value).toMatch(/\|60\|$/);
    const csv = collectionCsv(report, 'deposit', true);
    expect(csv.split('\n')[0]).toBe('"Salesman","Orders","Order value","Deposit","Deposit %","Below 50%"');
    expect(csv).toContain('"Scarlett Chong Kar Yin","2","8,000.00","3,500.00","43.8%","1"');
    expect(csv).toContain('"SO-1"');
    expect(csv).not.toContain('"SO-2"');
    const balance = collectionCsv(report, 'balance', false);
    expect(balance).toContain('"Balance due"');
    expect(balance).toContain('"SO-2"');
    expect(balance).not.toContain('"SO-1"');
  });
});
