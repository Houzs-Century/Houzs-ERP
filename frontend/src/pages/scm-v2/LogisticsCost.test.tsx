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
      { code: 'KL', name: 'KL/SEL', dos: 3, valueSen: 160_000, ownSen: 45_000, threeplSen: 15_000, totalSen: 60_000 },
      { code: 'NORTHERN', name: 'Northern', dos: 2, valueSen: 100_000, ownSen: 45_000, threeplSen: 30_000, totalSen: 75_000 },
    ],
    trips: [
      { kind: 'own', day: '2026-10-05', who: 'VRH9058', ref: null, dos: 2, doNumbers: ['HC-DO-1', 'HC-DO-2'], regions: ['KL/SEL'], amountSen: 45_000 },
      { kind: 'own', day: '2026-10-06', who: 'VPC9058', ref: null, dos: 1, doNumbers: ['HC-DO-3'], regions: ['Northern'], amountSen: 45_000 },
      { kind: '3pl', day: '2026-10-07', who: 'MSJ TRANSPORT SERVICE', ref: 'HC-API-2610-009', dos: 1, doNumbers: ['HC-DO-4'], regions: ['Northern'], amountSen: 30_000 },
    ],
    events: [{ id: 7, code: 'P7', name: 'IOI CITY MALL FAIR', startDate: '2026-10-16', endDate: '2026-10-20', setupSen: 870_000, transportSen: 103_000, totalSen: 973_000 }],
    gaps: { dosNoDeliverer: 2, dosOutsideNoBill: 0, unlistedPlates: ['ABC 123'], openLines: { count: 3, sen: 348_000 }, eventLinesNoFair: { count: 0, sen: 0 }, monthsWithoutTrips: [] },
    totals: { dos: 5, valueSen: 260_000, ownSen: 90_000, threeplSen: 45_000, totalSen: 135_000, setupSen: 870_000, transportSen: 103_000 },
    ownCostAccounts: ['900-P015'], ownCostDefault: true, eventsProblem: null,
  };
  const settings = {
    picked: null as string[] | null, defaults: ['900-P015'],
    candidates: [{ code: '900-P015', name: 'PETROL, TOL AND PARKING - LORI VRH 9058' }, { code: '900-S100', name: 'STAFF SALARIES & OVERTIME' }],
  };
  return {
    fetchMock: vi.fn(async (path: string, init?: RequestInit) => {
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

describe('the Logistics cost tab', () => {
  test('asks for this month and leads with the totals', async () => {
    draw();
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
    const box = await screen.findByLabelText('Not counted');
    expect(box.textContent).toContain('2 DOs have nobody on them');
    expect(box.textContent).toContain('ABC 123');
    expect(box.textContent).toContain('3 3PL bill lines not assigned yet (RM 3,480.00)');
  });

  test('by region, per trip, setup & dismantle and own-lorry cost are views of the one answer', async () => {
    draw();
    await screen.findByText('KL/SEL');
    expect(screen.getByText('Northern')).toBeTruthy();
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
