/* The Merchant charges tab (owner 2026-09-12, docs/bugs/0826): a month is a
   block — its line across every merchant, then a line per merchant — with
   fee % against the gross and the bank's payout charge beside it; a merchant
   opens to its reports; the filters reach the server; Export writes the
   table. Since docs/bugs/0900 the Cash and Online rows sit after the
   merchants at 0% and open to the payments. In the owner's Claude Design
   (batch 6 step 12): the shared range in whole months, Merchant and Lines in
   the toolbar, the tiles, the fee % chart, Excel / PDF / Print as shown and the
   CSV under ⋯. The server half is backend/tests/merchantChargesReport.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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
        /* The channels no merchant carries (docs/bugs/0900): at 0%, opening to the payments. */
        { month: '2026-06', acquirer: 'CASH', lines: 2, grossSen: 120000, feeSen: 0, netSen: 120000, feePct: 0, bankChargeSen: 0, chargeSen: 0, chargePct: 0, reports: [], payments: [
          { id: 'p1', docNo: '2990-SO-2606-001', paidOn: '2026-06-03', amountSen: 100000, subType: null },
          { id: 'p2', docNo: '2990-SO-2606-002', paidOn: '2026-06-18', amountSen: 20000, subType: null },
        ] },
        { month: '2026-06', acquirer: 'ONLINE', lines: 1, grossSen: 300000, feeSen: 0, netSen: 300000, feePct: 0, bankChargeSen: 0, chargeSen: 0, chargePct: 0, reports: [], payments: [
          { id: 'p3', docNo: '2990-SO-2606-002', paidOn: '2026-06-18', amountSen: 300000, subType: 'DuitNow' },
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
/* Every read asked, in order: the table's first, then the chart's months. */
const asked: string[] = [];

vi.mock('../../vendor/scm/lib/merchant-charges-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useMerchantChargesReport: (from: string, to: string, acquirer: string | null, confirmedOnly: boolean) => {
    asked.push(`${from}|${to}|${acquirer ?? ''}|${confirmedOnly}`);
    return { data: report, isLoading: false, isError: false };
  },
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));

const { MerchantChargesTab, merchantChargesCsv, chargeTileFigures, chargeChartMonths } = await import('./MerchantChargesReport');

const draw = () => render(
  <MemoryRouter initialEntries={['/scm/accounting?tab=charges&from=2026-06-01&to=2026-07-31']}><MerchantChargesTab /></MemoryRouter>,
);
const table = () => within(screen.getByRole('table', { name: 'Merchant charges' }));
const rowOf = (re: RegExp) => table().getAllByRole('row').find((r) => re.test(r.textContent))!;
const tableAsked = () => asked.filter((a) => a.startsWith('2026-06|')).at(-1);

beforeEach(() => { asked.length = 0; xlsx.mockClear(); });

describe('the Merchant charges tab', () => {
  test('a month is a block: all merchants first, then each merchant, fee % against the gross', () => {
    draw();
    const june = rowOf(/Jun 2026 · all merchants/);
    expect(within(june).getByText('3,500.00')).toBeTruthy();
    expect(within(june).getByText('1.3%')).toBeTruthy();
    expect(within(june).getByText('324.00')).toBeTruthy();   // the bank's payout charge
    expect(within(june).getByText('10.5%')).toBeTruthy();
    const pbb = rowOf(/^PBB · 2 reports/);
    expect(within(pbb).getByText('0.8%')).toBeTruthy();
    expect(within(pbb).getByText('11.6%')).toBeTruthy();
    const total = rowOf(/^Total · 2 months/);
    expect(within(total).getByText('4,500.00')).toBeTruthy();
    expect(within(total).getByText('8.6%')).toBeTruthy();
  });

  test('a merchant opens to its reports, with the file and the days swiped', () => {
    draw();
    fireEvent.click(screen.getByLabelText('Show the reports of PBB for 2026-06'));
    expect(screen.getByText('2990HOMESB_CSV_20260606.csv')).toBeTruthy();
    expect(rowOf(/2990HOMESB_CSV_20260606\.csv/).textContent).toContain('swiped 2026/06/05 – 2026/06/06');
    expect(screen.getByText('2990HOMESB_CSV_20260620.csv')).toBeTruthy();
    expect(screen.queryByText('2990HOMESB_CSV_20260712.csv')).toBeNull();   // July's, not opened
  });

  test('the range is whole months; Merchant and Lines reach the server; the merchants are named after the cards', () => {
    draw();
    expect(tableAsked()).toBe('2026-06|2026-07||false');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmed only' }));
    expect(tableAsked()).toBe('2026-06|2026-07||true');
    fireEvent.change(screen.getByLabelText('Merchant'), { target: { value: 'PBB' } });
    expect(tableAsked()).toBe('2026-06|2026-07|PBB|true');
    const options = [...screen.getByLabelText<HTMLSelectElement>('Merchant').options].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([['', 'Every merchant'], ['GHL', 'GHL'], ['PBB', 'PBB'], ['CASH', 'Cash'], ['ONLINE', 'Online']]);
  });

  test('the tiles: gross with cash and online apart, the fees against card sales, the bank charges, the charge %', () => {
    draw();
    const tiles = screen.getByRole('group', { name: 'Merchant charges figures' });
    expect(tiles.textContent).toContain('Gross received4,500.00Cash and online 0.00');
    expect(tiles.textContent).toContain('Merchant fees61.90');
    expect(tiles.textContent).toContain('Bank charges324.00Taken on payout days');
    expect(tiles.textContent).toContain('Charge %8.6%Cards only 8.6%');
    expect(chargeTileFigures(report)).toMatchObject({ grossSen: 450000, cashOnlineSen: 0, feeSen: 6190, bankChargeSen: 32400, chargePct: 8.6 });
  });

  test('Excel draws the grid as shown — an opened merchant\'s files included; the CSV stays', async () => {
    draw();
    fireEvent.click(screen.getByLabelText('Show the reports of GHL for 2026-06'));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0]! as [{ title: string; tables: Array<{ columns: Array<{ label: string }>; rows: Array<{ label: string; kind: string }> }> }, string];
    expect(file).toBe('merchant-charges-2026-06-2026-07.xlsx');
    expect(sheet.title).toBe('Merchant charges');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Lines', 'Gross', 'Merchant fee', 'Fee %', 'Bank charge', 'Total charge', 'Charge %', 'Net']);
    expect(sheet.tables[0]!.rows.map((r) => r.label.split(' · ')[0])).toEqual([
      'Jun 2026', 'GHL', 'StatementOfAccountDetails2026-06-29.csv', 'PBB', 'Cash', 'Online', 'Jul 2026', 'PBB', 'Total',
    ]);
    const csv = merchantChargesCsv(report);
    expect(csv.split('\n')[0]).toBe('"Month / merchant","Lines","Gross","Merchant fee","Fee %","Bank charge","Total charge","Charge %","Net"');
    expect(csv).toContain('"2026-06 · all merchants","3","3,500.00","44.00","1.3%","324.00","368.00","10.5%","3,456.00"');
    expect(csv).toContain('"2026-06 · PBB · 2990HOMESB_CSV_20260606.csv"');
    expect(csv).toContain('"Total","4","4,500.00"');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'CSV' })).toBeTruthy();
  });

  test('the chart: fee % by card merchant month by month, the charge % under each month', () => {
    const { series, months } = chargeChartMonths({ from: '2026-05-01', to: '2026-07-01' }, report);
    expect(series.map((x) => x.key)).toEqual(['GHL', 'PBB']);
    expect(months.map((m) => [m.month, m.values, m.under?.text])).toEqual([
      ['2026-05-01', {}, undefined],
      ['2026-06-01', { GHL: 4, PBB: 0.8 }, '10.5%'],
      ['2026-07-01', { PBB: 1.8 }, '1.8%'],
    ]);
    draw();
    expect(screen.getByText(/^Fee % by merchant, month by month/)).toBeTruthy();
  });
});

/* CASH AND ONLINE (owner 2026-09-14, docs/bugs/0900: 这个 merchant charge 其实会
   包括 cash online，只是 % 是 0 percent). */
describe('the Cash and Online rows', () => {
  test('sit after the merchants at 0%, and open to the payments rather than to files', () => {
    draw();
    const labels = table().getAllByRole('row').map((r) => r.textContent);
    const at = (re: RegExp) => labels.findIndex((t) => re.test(t));
    expect(at(/^PBB/)).toBeLessThan(at(/^Cash/));
    expect(at(/^Cash/)).toBeLessThan(at(/^Online/));
    const cash = rowOf(/^Cash · 2 payments/);
    expect(within(cash).getAllByText('1,200.00')).toHaveLength(2);   // gross and net, nothing taken between them
    expect(within(cash).getAllByText('0.0%')).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('Show the payments of Cash for 2026-06'));
    expect(screen.getByText('2990-SO-2606-001')).toBeTruthy();
    expect(screen.getByText(/2026\/06\/03/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show the payments of Online for 2026-06'));
    expect(screen.getByText(/DuitNow/)).toBeTruthy();
  });

  test('the export writes the channels and their payments', () => {
    const csv = merchantChargesCsv(report);
    expect(csv).toContain('"2026-06 · Cash","2","1,200.00","0.00","0.0%","0.00","0.00","0.0%","1,200.00"');
    expect(csv).toContain('"2026-06 · Cash · 2990-SO-2606-001 2026-06-03","1","1,000.00"');
    expect(csv).toContain('"2026-06 · Online · 2990-SO-2606-002 2026-06-18 DuitNow","1","3,000.00"');
  });
});
