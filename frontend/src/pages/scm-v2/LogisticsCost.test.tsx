/* The Logistics cost tab (owner 2026-10-29: 物流报告 按地区、每趟、setup &
   dismantle —「都需要」; our lorries OVERALL —「trip 除成本」). Pinned:
     • it asks for the chosen months and shows the totals first: DOs and what
       they carried, delivery cost per DO and as a share of the goods, our
       lorries' trips, the 3PL lines, setup & dismantle;
     • what could not be counted is said above the views;
     • by region, per trip, setup & dismantle and own-lorry cost are views of
       the one answer;
     • the cost-account list saves what was ticked, and goes back to the default.
   The server half is backend/tests/logisticsCost.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => {
  const report = {
    from: '2026-10-01', to: '2026-10-31',
    months: [{ month: '2026-10', ownCostSen: 90_000, trips: 2, perTripSen: 45_000, accounts: [{ code: '900-P015', name: 'PETROL, TOL AND PARKING - LORI VRH 9058', sen: 90_000 }] }],
    regions: [
      { code: 'PG', name: 'Penang', covers: 'Penang, Perlis, Kedah, Kelantan, Terengganu, Pahang', dos: 2, valueSen: 100_000, ownSen: 45_000, threeplSen: 30_000, totalSen: 75_000 },
      { code: 'KL', name: 'KL', covers: 'KL, Selangor, Putrajaya, Melaka, Johor, Negeri Sembilan, Perak, others', dos: 3, valueSen: 160_000, ownSen: 45_000, threeplSen: 15_000, totalSen: 60_000 },
      { code: 'EM', name: 'SBH & SWK', covers: 'Sabah, Sarawak, Labuan', dos: 0, valueSen: 0, ownSen: 0, threeplSen: 0, totalSen: 0 },
      { code: 'SG', name: 'SGD', covers: 'Singapore', dos: 0, valueSen: 0, ownSen: 0, threeplSen: 0, totalSen: 0 },
    ],
    trips: [
      { kind: 'own', day: '2026-10-05', who: 'VRH9058', ref: null, dos: 2, doNumbers: ['HC-DO-1', 'HC-DO-2'], regions: ['KL'], amountSen: 45_000 },
      { kind: 'own', day: '2026-10-06', who: 'VPC9058', ref: null, dos: 1, doNumbers: ['HC-DO-3'], regions: ['Penang'], amountSen: 45_000 },
      { kind: '3pl', day: '2026-10-07', who: 'MSJ TRANSPORT SERVICE', ref: 'HC-API-2610-009', dos: 1, doNumbers: ['HC-DO-4'], regions: ['Penang'], amountSen: 30_000 },
    ],
    events: [{ id: 7, code: 'P7', name: 'IOI CITY MALL FAIR', startDate: '2026-10-16', endDate: '2026-10-20', setupSen: 870_000, transportSen: 103_000, totalSen: 973_000 }],
    gaps: { dosNoDeliverer: 2, dosOutsideNoBill: 0, dosNoState: 1, unlistedPlates: ['ABC 123'], openLines: { count: 3, sen: 348_000 }, eventLinesNoFair: { count: 0, sen: 0 }, monthsWithoutTrips: [] },
    totals: { dos: 5, valueSen: 260_000, ownSen: 90_000, threeplSen: 45_000, totalSen: 135_000, setupSen: 870_000, transportSen: 103_000 },
    ownCostAccounts: ['900-P015'], ownCostDefault: true, eventsProblem: null,
  };
  const settings = {
    picked: null as string[] | null, defaults: ['900-P015'],
    candidates: [{ code: '900-P015', name: 'PETROL, TOL AND PARKING - LORI VRH 9058' }, { code: '900-S100', name: 'STAFF SALARIES & OVERTIME' }],
  };
  const r4 = (PG: number | null, KL: number | null, EM: number | null, SG: number | null) => ({ PG, KL, EM, SG });
  const pnl = {
    from: '2026-10-01', to: '2026-10-31', months: ['2026-10'], doIncomeBp: 300,
    dos: { PG: 1, KL: 2, EM: 0, SG: 0, total: 3 },
    rows: [
      { key: 'do_value', label: 'Delivery Order', sen: r4(10_000_000, 30_000_000, 0, 0), totalSen: 40_000_000 },
      { key: 'do_income', label: 'Transport Income (3% of DO)', sen: r4(300_000, 900_000, 0, 0), totalSen: 1_200_000 },
      { key: 'ti_2990', label: 'Transport Income (2990)', sen: r4(0, 444_210, 0, 0), totalSen: 444_210 },
      { key: 'total_income', label: 'TOTAL INCOME', sen: r4(300_000, 1_344_210, 0, 0), totalSen: 1_644_210 },
      { key: 'outsource', label: 'Outsource Expense', sen: r4(1_597_000, 138_000, 0, 0), totalSen: 1_735_000 },
      { key: 'petrol', label: 'Petrol Cost', sen: r4(0, 2_070_891, 0, 0), totalSen: 2_070_891 },
      { key: 'total_expense', label: 'TOTAL EXPENSE', sen: r4(1_597_000, 2_208_891, 0, 0), totalSen: 3_805_891 },
      { key: 'net', label: 'NET PROFIT', sen: r4(-1_297_000, -864_681, 0, 0), totalSen: -2_161_681 },
      { key: 'cost_per_do', label: 'Cost per DO', sen: r4(1_597_000, 1_104_446, null, null), totalSen: 1_268_630 },
    ],
    income: [{ lineId: 'bl2', billNo: 'HC-ODB-2610-001', billDate: '2026-10-23', debtorName: '2990 Home Sdn Bhd', description: "LOGISTICS CHARGES - SEP'26", accountCode: '599-0000', accountName: 'ADDITIONAL INCOME', amountSen: 444_210, month: '2026-10', row: '2990', region: 'KL', by: 'wording' }],
    trips: [{ key: 'setup|MIDVALLEY|2026-10-11', kind: 'setup', day: '2026-10-11', venue: 'Mid Valley', area: 'kualalumpur', areaLabel: 'Kuala Lumpur', region: 'KL', fairs: [{ id: 12, code: 'MV', name: '[AKEMI] REX @ MID VALLEY' }], rateSen: 40_000, outsourced: false, mark: null, inHouse: true, amountSen: 40_000 }],
    spreads: [{ lineId: 'g-u2', kind: 'upkeep', accountCode: '900-U010', accountName: 'UPKEEP OF LORI - VPC 9058', day: '2026-10-14', docNo: 'JE-2610-1345', notes: 'LABOUR CHARGE TO FIX AWNING', amountSen: 30_000, months: 1, isDefault: true, perMonthSen: 30_000, inRangeSen: 30_000, lastMonth: '2026-10' }],
    ownTrips: 2, inHousePerTripSen: 1_035_446, tripsProblem: null,
    areaRates: [
      { key: 'kualalumpur', label: 'Kuala Lumpur', region: 'KL', rateSen: 40_000, defaultRateSen: 40_000, isDefault: true },
      { key: 'johor', label: 'Johor', region: 'KL', rateSen: 120_000, defaultRateSen: 60_000, isDefault: false },
    ],
  };
  return {
    fetchMock: vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/acc-events/logistics/pnl')) return pnl;
      if (init?.method === 'PUT' && /^\/acc-events\/logistics\/(income-rate|area-rate|spread|trip)$/.test(path)) return { ok: true };
      if (path.startsWith('/acc-events/logistics/settings')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { accounts: string[] | null };
          settings.picked = body.accounts;
          return { ok: true, picked: body.accounts };
        }
        return settings;
      }
      if (path.startsWith('/acc-events/logistics')) return report;
      throw new Error(`unexpected ${path}`);
    }),
  };
});
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: (path: string, init?: RequestInit) => fetchMock(path, init),
}));

import { LogisticsCostTab } from './LogisticsCost';

const draw = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}><LogisticsCostTab /></QueryClientProvider></MemoryRouter>);
};
const thisMonth = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);

const putOf = (path: string) => fetchMock.mock.calls.filter(([p, i]) => p === path && i?.method === 'PUT').map(([, i]) => JSON.parse(String(i!.body)));

describe('the P&L view — the owner\'s Logistic Cost Report from the books', () => {
  test('comes first: this month, the four regions, the totals and the net', async () => {
    draw();
    await waitFor(() => expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith(`/acc-events/logistics/pnl?from=${thisMonth}-01&to=${thisMonth}-`))).toBe(true));
    const table = await screen.findByLabelText('Logistics P&L');
    for (const h of ['Penang', 'KL', 'SBH & SWK', 'SGD', 'Total']) expect(within(table).getAllByText(h).length).toBeGreaterThan(0);
    const net = within(table).getByText('NET PROFIT').closest('tr')!;
    expect(net.textContent).toContain('(12,970)');
    expect(net.textContent).toContain('(21,617)');
    expect(within(table).getByText('Transport Income (2990)').closest('tr')!.textContent).toContain('4,442');
    const totals = screen.getByLabelText('P&L totals');
    expect(totals.textContent).toContain('−RM 21,617');
    expect(totals.textContent).toContain('3 DOs');
    expect(screen.getByText(/In-house cost per trip: RM 10,354 — 2 trips of our lorries/)).toBeTruthy();
  });

  test('a trip unticked, an area rate, a spread and the income rate are saved', async () => {
    draw();
    fireEvent.click(await screen.findByLabelText('setup Mid Valley 2026-10-11 ours'));
    await waitFor(() => expect(putOf('/acc-events/logistics/trip')).toEqual([{ tripKey: 'setup|MIDVALLEY|2026-10-11', inHouse: false }]));

    const rates = screen.getByLabelText('Rates per trip by area');
    fireEvent.change(within(rates).getByLabelText('Kuala Lumpur rate per trip'), { target: { value: '450' } });
    fireEvent.click(within(rates).getByText('Save'));
    await waitFor(() => expect(putOf('/acc-events/logistics/area-rate')).toEqual([{ area: 'kualalumpur', rateRm: 450 }]));
    fireEvent.click(within(rates).getByText('Default (RM 600.00)'));
    await waitFor(() => expect(putOf('/acc-events/logistics/area-rate')[1]).toEqual({ area: 'johor', reset: true }));

    const spreads = screen.getByLabelText('Upkeep and road tax spread');
    fireEvent.change(within(spreads).getByLabelText('Months for LABOUR CHARGE TO FIX AWNING'), { target: { value: '6' } });
    fireEvent.click(within(spreads).getByText('Save'));
    await waitFor(() => expect(putOf('/acc-events/logistics/spread')).toEqual([{ lineId: 'g-u2', months: 6 }]));

    fireEvent.change(screen.getByLabelText('Transport income percent of DO value'), { target: { value: '2.5' } });
    fireEvent.click(within(screen.getByLabelText('Logistics P&L')).getByText('Save'));
    await waitFor(() => expect(putOf('/acc-events/logistics/income-rate')).toEqual([{ pct: 2.5 }]));
  });

  test('lists the bill lines it counted as transport income', async () => {
    draw();
    const card = await screen.findByLabelText('Transport income billed');
    expect(within(card).getByText('HC-ODB-2610-001')).toBeTruthy();
    expect(within(card).getByText(/by its words/)).toBeTruthy();
  });
});

describe('the Logistics cost tab', () => {
  test('asks for this month and leads with the totals', async () => {
    draw();
    fireEvent.click(await screen.findByRole('tab', { name: 'By region' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith(`/acc-events/logistics?from=${thisMonth}-01&to=${thisMonth}-`))).toBe(true));
    const totals = await screen.findByLabelText('Logistics totals');
    await waitFor(() => expect(totals.textContent).toContain('RM 1,350'));
    expect(totals.textContent).toContain('Goods RM 2,600');
    expect(totals.textContent).toContain('RM 270 per DO · 51.9% of goods');
    expect(totals.textContent).toContain('2 trips · RM 450 each');
    expect(totals.textContent).toContain('1 bill line');
    expect(totals.textContent).toContain('RM 9,730');
    expect(totals.textContent).toContain('1 fair');
  });

  test('says what could not be counted', async () => {
    draw();
    fireEvent.click(await screen.findByRole('tab', { name: 'By region' }));
    const box = await screen.findByLabelText('Not counted');
    expect(box.textContent).toContain('2 DOs have nobody on them');
    expect(box.textContent).toContain('ABC 123');
    expect(box.textContent).toContain('3 3PL bill lines not assigned yet (RM 3,480.00)');
  });

  test('by region, per trip, setup & dismantle and own-lorry cost are views of the one answer', async () => {
    draw();
    fireEvent.click(await screen.findByRole('tab', { name: 'By region' }));
    await screen.findByText('Penang, Perlis, Kedah, Kelantan, Terengganu, Pahang');
    expect(screen.getByText('SBH & SWK')).toBeTruthy();
    expect(screen.getByText(/KL includes 1 DO with no state/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Per trip' }));
    await screen.findByText('MSJ TRANSPORT SERVICE');
    expect(screen.getByText('VRH9058')).toBeTruthy();
    expect(screen.getByText('HC-API-2610-009')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Setup & Dismantle' }));
    await screen.findByText('IOI CITY MALL FAIR');
    fireEvent.click(screen.getByRole('tab', { name: 'Own-lorry cost' }));
    await screen.findByText('2026-10');
    expect(screen.getByText(/The accounts are the chart.s default/)).toBeTruthy();
  });

  test('the cost-account list saves what was ticked, and goes back to the default', async () => {
    draw();
    fireEvent.click(await screen.findByRole('tab', { name: 'Own-lorry cost' }));
    const card = await screen.findByLabelText('Own-lorry cost accounts');
    const salary = await within(card).findByLabelText('900-S100 STAFF SALARIES & OVERTIME');
    expect((within(card).getByLabelText('900-P015 PETROL, TOL AND PARKING - LORI VRH 9058') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(salary);
    fireEvent.click(within(card).getByText('Save the list'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([p, i]) => p === '/acc-events/logistics/settings' && i?.method === 'PUT'
      && JSON.parse(String(i.body)).accounts.join(',') === '900-P015,900-S100')).toBe(true));
    const back = await within(card).findByText('Back to the default');
    fireEvent.click(back);
    await waitFor(() => expect(fetchMock.mock.calls.some(([p, i]) => p === '/acc-events/logistics/settings' && i?.method === 'PUT'
      && JSON.parse(String(i.body)).accounts === null)).toBe(true));
  });
});
