/* The Logistics cost tab as the owner approved it on 2026-11-05 (demo
   JoQSYerQXoWd7gQgWLrZQw). Pinned:
     • P&L: the regions across the top, a % beside every figure of its column's
       Delivery Order value, "Transport Income (1% of fair sales)" with its own rate;
     • By region & trip: one line per lorry and per carrier, the 3PL on no DO in
       Total only, and the check against the P&L's TOTAL EXPENSE with Difference 0;
       a lorry's figure opens its trips;
     • Setup & Dismantle: fair sales and events on top, income per fair, the fair's
       cost (closed, opens to its parts), the net and the books check;
     • By month: Total first, then a column per month; split by region on a switch;
     • the trips as a Finance list by region with its subtotal and the Ours tick;
     • the settings are saved; the header menu carries print, columns, sort, freeze.
   The server half is backend/tests/logisticsPnl.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => {
  const r4 = (PG: number | null, KL: number | null, EM: number | null, SG: number | null) => ({ PG, KL, EM, SG });
  const z = { PG: 0, KL: 0, EM: 0, SG: 0 };
  const rows = [
    { key: 'do_value', label: 'Delivery Order', sen: r4(57_434_400, 30_000_000, 0, 0), totalSen: 87_434_400 },
    { key: 'do_income', label: 'Transport Income (3% of DO)', sen: r4(1_723_032, 900_000, 0, 0), totalSen: 2_623_032 },
    { key: 'ti_houzs', label: 'Transport Income (Houzs)', sen: r4(0, 0, 0, 0), totalSen: 0 },
    { key: 'ti_conts', label: 'Transport Income (The Conts)', sen: r4(0, 0, 0, 0), totalSen: 0 },
    { key: 'ti_hookka', label: 'Transport Income (Hookka)', sen: r4(0, 0, 0, 0), totalSen: 0 },
    { key: 'sd_income', label: 'Set/Dismantle Income (In-house)', sen: r4(0, 40_000, 0, 0), totalSen: 40_000 },
    { key: 'fair_income', label: 'Transport Income (1% of fair sales)', sen: r4(0, 386_400, 0, 0), totalSen: 386_400 },
    { key: 'ti_2990', label: 'Transport Income (2990)', sen: r4(0, 444_210, 0, 0), totalSen: 444_210 },
    { key: 'total_income', label: 'TOTAL INCOME', sen: r4(1_723_032, 1_770_610, 0, 0), totalSen: 3_493_642 },
    { key: 'outsource', label: 'Outsource Expense', sen: r4(1_597_000, 138_000, 0, 0), totalSen: 1_735_000 },
    { key: 'petrol', label: 'Petrol Cost', sen: r4(0, 2_070_891, 0, 0), totalSen: 2_070_891 },
    { key: 'upkeep', label: 'Upkeep Cost', sen: r4(0, 0, 0, 0), totalSen: 0 },
    { key: 'instalment', label: 'Lorry Installment Cost', sen: r4(0, 0, 0, 0), totalSen: 0 },
    { key: 'roadtax', label: 'RoadTax & Insurance Cost', sen: r4(0, 0, 0, 0), totalSen: 0 },
    { key: 'manpower', label: 'Manpower Cost', sen: r4(0, 0, 0, 0), totalSen: 0 },
    { key: 'inhouse_total', label: 'Total In-house Expenses', sen: r4(0, 2_070_891, 0, 0), totalSen: 2_070_891 },
    { key: 'total_expense', label: 'TOTAL EXPENSE', sen: r4(1_597_000, 2_208_891, 0, 0), totalSen: 3_805_891 },
    { key: 'net', label: 'NET PROFIT', sen: r4(126_032, -438_281, 0, 0), totalSen: -312_249 },
    { key: 'cost_per_do', label: 'Cost per DO', sen: r4(1_597_000, 1_104_446, null, null), totalSen: 1_268_630 },
    { key: 'net_cost_per_do', label: 'Net cost per DO (after other income)', sen: r4(1_597_000, 664_140, null, null), totalSen: 978_760 },
  ];
  const month = (m: string) => ({
    month: m, rows, dos: { PG: 1, KL: 2, EM: 0, SG: 0, total: 3 },
    cost: {
      month: m, dos: { PG: 1, KL: 2, EM: 0, SG: 0 }, goodsSen: r4(57_434_400, 30_000_000, 0, 0), ownTrips: 2, inHouseSen: 2_070_891,
      lorries: [
        { plate: 'VNB9058', trips: 1, dos: 1, sen: { ...z, KL: 1_035_446 }, tripList: [{ day: `${m}-02`, dos: 1, doNumbers: ['HC-DO-1'], sen: { ...z, KL: 1_035_446 } }] },
        { plate: 'VPC9058', trips: 1, dos: 2, sen: { ...z, PG: 517_723, KL: 517_722 }, tripList: [{ day: `${m}-03`, dos: 2, doNumbers: ['HC-DO-2', 'HC-DO-3'], sen: { ...z, PG: 517_723, KL: 517_722 } }] },
      ],
      inHouseNoTripSen: 0,
      carriers: [{ name: 'MSJ TRANSPORT SERVICE', bills: 1, lines: 3, dos: 2, sen: { ...z, PG: 1_597_000, KL: 100_000 }, billList: [{ ref: 'HC-API-2610-004', day: `${m}-05`, sen: { ...z, PG: 1_597_000, KL: 100_000 }, noDoSen: 38_000 }] }],
      threeplNoDo: { lines: 1, sen: 38_000 }, outsourceSen: 1_735_000, noDeliverer: { ...z, KL: 1 },
    },
    costTotalSen: 3_805_891,
    fairs: [{
      id: 12, code: 'MV', name: '[AKEMI] REX @ MID VALLEY', venue: 'Mid Valley', startDate: `${m}-09`, endDate: `${m}-12`, region: 'KL',
      salesSen: 38_640_000, incomeSen: 386_400, chargeTrips: 2, chargeSen: 80_000, setupSen: 65_000, dismantleSen: 0, transportSen: 0, booksSen: 145_000, who: 'inhouse',
    }],
    noFair: { lines: 2, sen: 50_000 },
  });
  const pnlFor = (from: string, to: string) => {
    const months: string[] = [];
    for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
    return {
      from, to, months, doIncomeBp: 300, fairIncomeBp: 100, fairsProblem: null,
      dos: { PG: 1, KL: 2, EM: 0, SG: 0, total: 3 }, rows,
      perMonth: months.map(month),
      income: [{ lineId: 'bl2', billNo: 'HC-ODB-2610-001', billDate: '2026-10-23', debtorName: '2990 Home Sdn Bhd', description: "LOGISTICS CHARGES - SEP'26", accountCode: '599-0000', accountName: 'ADDITIONAL INCOME', amountSen: 444_210, month: '2026-10', row: '2990', region: 'KL', by: 'wording' }],
      trips: [
        { key: 'setup|MIDVALLEY|2026-10-11', kind: 'setup', day: '2026-10-11', venue: 'Mid Valley Exhibition Centre', area: 'kualalumpur', areaLabel: 'Kuala Lumpur', region: 'KL', fairs: [{ id: 12, code: 'MV', name: '[AKEMI] HOMEDEC @ MID VALLEY' }, { id: 13, code: 'MZ', name: '[ZANOTTI] HOMEDEC @ MID VALLEY' }], rateSen: 40_000, outsourced: false, mark: null, inHouse: true, amountSen: 40_000 },
        { key: 'dismantle|PWCC|2026-10-14', kind: 'dismantle', day: '2026-10-14', venue: 'PWCC', area: 'penang', areaLabel: 'Penang', region: 'PG', fairs: [{ id: 14, code: 'P', name: '[AKEMI] BIGHOME @ PWCC' }], rateSen: 60_000, outsourced: true, mark: null, inHouse: false, amountSen: 0 },
      ],
      spreads: [{ lineId: 'g-u2', kind: 'upkeep', accountCode: '900-U010', accountName: 'UPKEEP OF LORI - VPC 9058', day: '2026-10-14', docNo: 'JE-2610-1345', notes: 'LABOUR CHARGE TO FIX AWNING', amountSen: 30_000, months: 1, isDefault: true, perMonthSen: 30_000, inRangeSen: 30_000, lastMonth: '2026-10' }],
      ownTrips: 2, inHousePerTripSen: 1_035_446, tripsProblem: null,
      areaRates: [{ key: 'kualalumpur', label: 'Kuala Lumpur', region: 'KL', rateSen: 40_000, defaultRateSen: 40_000, isDefault: true }],
    };
  };
  return {
    fetchMock: vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && /^\/acc-events\/logistics\/(income-rate|fair-income-rate|area-rate|spread|trip)$/.test(path)) return { ok: true };
      const m = /^\/acc-events\/logistics\/pnl\?from=([\d-]+)&to=([\d-]+)/.exec(path);
      if (m) return pnlFor(m[1]!, m[2]!);
      throw new Error(`unexpected ${path}`);
    }),
  };
});
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: (path: string, init?: RequestInit) => fetchMock(path, init),
}));

import { LogisticsCostTab } from './LogisticsCost';

const draw = (search = '') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter initialEntries={[`/finance/reports${search}`]}><QueryClientProvider client={qc}><LogisticsCostTab /></QueryClientProvider></MemoryRouter>);
};
const putOf = (path: string) => fetchMock.mock.calls.filter(([p, i]) => p === path && i?.method === 'PUT').map(([, i]) => JSON.parse(String(i!.body)));
const rowText = (table: HTMLElement, label: string) => within(table).getAllByText(label)[0]!.closest('tr')!.textContent;

describe('P&L', () => {
  test('regions across the top; every figure with its % of that column\'s DO value; the fair-sales income row', async () => {
    draw();
    const table = await screen.findByRole('table', { name: 'Logistics P&L' });
    for (const h of ['Penang', 'KL', 'SBH & SWK', 'SGD', 'Total']) expect(within(table).getAllByText(h).length).toBeGreaterThan(0);
    /* Penang: 17,230.32 ÷ 574,344.00 = 3.0%. */
    expect(rowText(table, 'Transport Income (3% of DO)')).toContain('17,230.323.0%');
    expect(rowText(table, 'Transport Income (1% of fair sales)')).toContain('3,864.00');
    expect(rowText(table, 'Delivery Order')).toContain('574,344.00100.0%');
    expect(rowText(table, 'NET PROFIT')).toContain('(3,122.49)');
    fireEvent.change(screen.getByLabelText('Transport income percent of fair sales'), { target: { value: '1.5' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() => expect(putOf('/acc-events/logistics/fair-income-rate')).toEqual([{ pct: 1.5 }]));
  });

  test('the trips are a Finance list by region: a subtotal, a Setup pill, the booths, the Bill pill, the Ours tick', async () => {
    draw();
    const list = await screen.findByRole('table', { name: 'Setup and dismantle trips' });
    expect(within(list).getByText('Total KL · 1 of 1 trips ours')).toBeTruthy();
    expect(within(list).getByText('Total Penang · 0 of 1 trips ours')).toBeTruthy();
    expect(within(list).getByText('Setup')).toBeTruthy();
    expect(within(list).getByText('3PL bill')).toBeTruthy();
    expect(within(list).getByText('2 ·').closest('td')!.textContent).toBe('2 · AKEMI, ZANOTTI');
    fireEvent.click(within(list).getByLabelText('Ours: 2026-10-14 dismantle PWCC'));
    await waitFor(() => expect(putOf('/acc-events/logistics/trip')).toEqual([{ tripKey: 'dismantle|PWCC|2026-10-14', inHouse: true }]));
  });

  test('a right-click on a header opens print, sort, freeze, auto-fit, hide and the column chooser', async () => {
    draw();
    const table = await screen.findByRole('table', { name: 'Logistics P&L' });
    fireEvent.contextMenu(within(table).getByRole('columnheader', { name: /Penang/ }));
    const menu = screen.getByRole('menu', { name: 'Column menu' });
    for (const item of ['Print table', 'Sort ascending', 'Freeze up to this column', 'Auto-fit this column', 'Hide this column']) expect(within(menu).getByText(item)).toBeTruthy();
    fireEvent.click(within(menu).getByText('Hide this column'));
    expect(within(table).queryByRole('columnheader', { name: /Penang/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Reset layout' }).length).toBeGreaterThan(0);
  });
});

describe('By region & trip', () => {
  test('one line per lorry and per carrier; 3PL on no DO in Total only; the check against the P&L with Difference 0', async () => {
    draw('?lv=region');
    const table = await screen.findByRole('table', { name: 'Delivery cost by region and trip' });
    expect(rowText(table, 'VNB9058')).toContain('1 trip · 1 DO');
    expect(rowText(table, 'MSJ TRANSPORT SERVICE')).toContain('15,970.00');
    /* No region: four dashes, then the Total. */
    expect(rowText(table, '3PL bill lines on no DO yet')).toMatch(/----380\.00$/);
    expect(rowText(table, 'Total delivery cost')).toContain('38,058.91');
    expect(rowText(table, 'Logistics P&L · TOTAL EXPENSE (from the books)')).toContain('38,058.91');
    expect(rowText(table, 'Difference')).toMatch(/0\.00$/);
    /* A lorry's figure opens its trips. */
    fireEvent.click(within(within(table).getByText('VPC9058').closest('tr')!).getByRole('button', { name: '5,177.23' }));
    expect(within(table).getByText(new RegExp(`/03$`))).toBeTruthy();
  });

  test('By month: Total first, then one column per month; split each month by region on a switch', async () => {
    draw('?lv=region&lm=months');
    const table = await screen.findByRole('table', { name: 'Delivery cost by region and trip' });
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads[1]).toMatch(/^Total/);
    fireEvent.click(screen.getByRole('switch', { name: /Split each month by region/ }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Delivery cost by region and trip' })).getAllByRole('columnheader', { name: /Penang/ }).length).toBeGreaterThan(0));
  });
});

describe('Setup & Dismantle', () => {
  test('fair sales and events on top; income 1% per fair; the fair\'s cost opens to its parts; the books check', async () => {
    draw('?lv=events');
    const table = await screen.findByRole('table', { name: 'Setup and dismantle by fair' });
    expect(rowText(table, 'Fair sales')).toContain('386,400.00');
    expect(rowText(table, 'Total events')).toContain('1');
    expect(within(table).getAllByText('Mid Valley', { exact: false }).length).toBeGreaterThan(0);
    const open = within(table).getAllByRole('button', { name: 'Open [AKEMI] REX @ MID VALLEY' })[0]!;
    fireEvent.click(open);
    expect(rowText(table, 'Logistics setup / dismantle charge')).toContain('800.00');
    expect(rowText(table, 'Difference (the fairs’ cost less their books)')).toMatch(/0\.00/);
    expect(rowText(table, '3PL setup / dismantle lines with no fair picked')).toContain('500.00');
  });
});
