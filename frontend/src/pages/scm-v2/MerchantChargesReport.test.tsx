/* The Merchant charges tab (owner 2026-09-12, docs/bugs/0826): a month is a
   block — its line across every merchant, then a line per merchant — with
   fee % against the gross and the bank's payout charge beside it; a merchant
   opens to its reports; the filters reach the server; Export writes the
   table. The server half is backend/tests/merchantChargesReport.test.ts. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { MerchantChargesReport } from '../../vendor/scm/lib/merchant-charges-queries';

const report: MerchantChargesReport = {
  from: '2026-06', to: '2026-07', confirmedOnly: false, acquirer: null,
  months: [
    {
      month: '2026-06', lines: 3, grossSen: 350000, feeSen: 4400, netSen: 345600, feePct: 1.3, bankChargeSen: 32400, chargeSen: 36800, chargePct: 10.5,
      acquirers: [
        { month: '2026-06', acquirer: 'GHL', lines: 1, grossSen: 50000, feeSen: 2000, netSen: 48000, feePct: 4, bankChargeSen: 0, chargeSen: 2000, chargePct: 4, reports: [
          { batchId: 11, fileName: 'StatementOfAccountDetails2026-06-29.csv', periodFrom: '2026-06-02', periodTo: '2026-06-28', lines: 1, grossSen: 50000, feeSen: 2000, netSen: 48000, feePct: 4, bankChargeSen: 0, chargeSen: 2000, chargePct: 4 },
        ] },
        { month: '2026-06', acquirer: 'PBB', lines: 2, grossSen: 300000, feeSen: 2400, netSen: 297600, feePct: 0.8, bankChargeSen: 32400, chargeSen: 34800, chargePct: 11.6, reports: [
          { batchId: 9, fileName: '2990HOMESB_CSV_20260606.csv', periodFrom: '2026-06-05', periodTo: '2026-06-06', lines: 1, grossSen: 100000, feeSen: 800, netSen: 99200, feePct: 0.8, bankChargeSen: 32400, chargeSen: 33200, chargePct: 33.2 },
          { batchId: 10, fileName: '2990HOMESB_CSV_20260620.csv', periodFrom: '2026-06-20', periodTo: '2026-06-20', lines: 1, grossSen: 200000, feeSen: 1600, netSen: 198400, feePct: 0.8, bankChargeSen: 0, chargeSen: 1600, chargePct: 0.8 },
        ] },
      ],
    },
    {
      month: '2026-07', lines: 1, grossSen: 100000, feeSen: 1790, netSen: 98210, feePct: 1.8, bankChargeSen: 0, chargeSen: 1790, chargePct: 1.8,
      acquirers: [
        { month: '2026-07', acquirer: 'PBB', lines: 1, grossSen: 100000, feeSen: 1790, netSen: 98210, feePct: 1.8, bankChargeSen: 0, chargeSen: 1790, chargePct: 1.8, reports: [
          { batchId: 12, fileName: '2990HOMESB_CSV_20260712.csv', periodFrom: '2026-07-12', periodTo: '2026-07-12', lines: 1, grossSen: 100000, feeSen: 1790, netSen: 98210, feePct: 1.8, bankChargeSen: 0, chargeSen: 1790, chargePct: 1.8 },
        ] },
      ],
    },
  ],
  totals: { lines: 4, grossSen: 450000, feeSen: 6190, netSen: 443810, feePct: 1.4, bankChargeSen: 32400, chargeSen: 38590, chargePct: 8.6 },
};
const lastPath = { value: '' };

vi.mock('../../vendor/scm/lib/merchant-charges-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useMerchantChargesReport: (from: string, to: string, acquirer: string | null, confirmedOnly: boolean) => {
    lastPath.value = `${from}|${to}|${acquirer ?? ''}|${confirmedOnly}`;
    return { data: report, isLoading: false, isError: false };
  },
}));

const { MerchantChargesTab, merchantChargesCsv } = await import('./MerchantChargesReport');

describe('the Merchant charges tab', () => {
  test('a month is a block: all merchants first, then each merchant, fee % against the gross', () => {
    render(<MerchantChargesTab />);
    const rows = screen.getAllByRole('row');
    const june = rows.find((r) => within(r).queryByText(/2026-06 · all merchants/))!;
    expect(within(june).getByText('3,500.00')).toBeTruthy();
    expect(within(june).getByText('1.3%')).toBeTruthy();
    expect(within(june).getByText('324.00')).toBeTruthy();   // the bank's payout charge
    expect(within(june).getByText('10.5%')).toBeTruthy();
    const pbb = rows.find((r) => within(r).queryByText(/PBB/) && within(r).queryByText('3,000.00'))!;
    expect(within(pbb).getByText('0.8%')).toBeTruthy();
    expect(within(pbb).getByText('11.6%')).toBeTruthy();
    const total = rows.find((r) => within(r).queryByText('Total'))!;
    expect(within(total).getByText('4,500.00')).toBeTruthy();
    expect(within(total).getByText('8.6%')).toBeTruthy();
  });

  test('a merchant opens to its reports, with the file and the period', () => {
    render(<MerchantChargesTab />);
    fireEvent.click(screen.getByLabelText('Show the reports of PBB for 2026-06'));
    expect(screen.getByText('2990HOMESB_CSV_20260606.csv')).toBeTruthy();
    expect(screen.getByText('2990HOMESB_CSV_20260620.csv')).toBeTruthy();
    expect(screen.queryByText('2990HOMESB_CSV_20260712.csv')).toBeNull();   // July's, not opened
  });

  test('the filters reach the server, and the export writes the table', () => {
    render(<MerchantChargesTab />);
    fireEvent.click(screen.getByLabelText('Confirmed lines only'));
    expect(lastPath.value).toMatch(/\|true$/);
    fireEvent.change(screen.getByLabelText('Merchant'), { target: { value: 'PBB' } });
    expect(lastPath.value).toMatch(/\|PBB\|true$/);
    const csv = merchantChargesCsv(report);
    expect(csv.split('\n')[0]).toBe('"Month / merchant","Lines","Gross","Merchant fee","Fee %","Bank charge","Total charge","Charge %","Net"');
    expect(csv).toContain('"2026-06 · all merchants","3","3,500.00","44.00","1.3%","324.00","368.00","10.5%","3,456.00"');
    expect(csv).toContain('"2026-06 · PBB · 2990HOMESB_CSV_20260606.csv"');
    expect(csv).toContain('"Total","4","4,500.00"');
  });
});
