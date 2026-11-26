/* The Own fleet tab (owner 2026-11-24: our lorries priced like a 3PL), made-up
   figures. Pinned: the strip and the month table read the server's months;
   a trip opens the lines its card priced it with; with no own fleet card the
   tab says so and offers to make one; two active fleet cards are named and
   none is offered; a failed read shows the server's reason. */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { OwnFleetCosts } from '../../../vendor/scm/lib/delivery-rate-card-queries';

const state = vi.hoisted(() => ({ fail: false }));
let data: OwnFleetCosts;
vi.mock('../../../vendor/scm/lib/delivery-rate-card-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/delivery-rate-card-queries')>()),
  useOwnFleetCosts: () => (state.fail
    ? { data: undefined, isLoading: false, isError: true, error: new Error('Pick at most 186 days at a time.') }
    : { data, isLoading: false, isError: false, error: null }),
}));

import { OwnFleetView } from './OwnFleetView';

const month = {
  month: '2026-11', trips: 2, dos: 3, sets: 5, pricedTrips: 2, pricedDos: 3, costSen: 21_500, deliveryCostSen: 18_000,
  threePlDos: 2, threePlSets: 3, threePlBilledSen: 24_000, threePlPricedDos: 2, threePlBilledPricedSen: 24_000, threePlCardSen: 20_000,
};
beforeEach(() => {
  state.fail = false;
  data = {
    from: '2026-09-01', to: '2026-11-24',
    card: { id: 'card-own', name: 'Own fleet' }, severalCards: [], lorryCards: [],
    runs: [
      {
        key: '2026-11-10|lorry:l1', runDate: '2026-11-10', lorryId: 'l1', plate: 'TST1001', tripNos: ['TRIP-T1'],
        dos: [{ doId: 'a', doNumber: 'TEST-DO-1', companyCode: 'HOUZS' }, { doId: 'b', doNumber: 'TEST-DO-2', companyCode: '2990' }],
        setCount: 3, zones: ['KL', 'JOHOR'], jobs: { SUPPLIER_PICKUP: 1 }, cardName: 'Own fleet', costSen: 15_500, otherJobsSen: 3_500,
        lines: [{ label: '1st set', amountSen: 4_000 }, { label: 'Outstation JOHOR', amountSen: 8_000 }, { label: 'Supplier pickup', amountSen: 3_500 }],
      },
      {
        key: '2026-11-11|lorry:l2', runDate: '2026-11-11', lorryId: 'l2', plate: 'TST1002', tripNos: [],
        dos: [{ doId: 'c', doNumber: 'TEST-DO-3', companyCode: 'HOUZS' }],
        setCount: 2, zones: ['KL'], jobs: {}, cardName: 'Own fleet', costSen: 6_000, otherJobsSen: 0, lines: [],
      },
    ],
    months: [month],
  };
});
const show = () => {
  const onCreate = vi.fn();
  render(<MemoryRouter><OwnFleetView onCreateCard={onCreate} /></MemoryRouter>);
  return onCreate;
};

describe('the Own fleet tab', () => {
  test('the strip and the month table read the months; per DO leaves the other jobs out', () => {
    show();
    expect(screen.getAllByText('RM 215.00').length).toBe(2);
    expect(screen.getAllByText('RM 60.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RM 120.00').length).toBeGreaterThan(0);
    expect(screen.getByText('11/2026')).toBeTruthy();
    expect(screen.queryByText(/No own fleet rate card yet/)).toBeNull();
  });

  test('a trip lists whose orders it carried, and opens the lines its card priced it with', () => {
    show();
    expect(screen.getByText('2990 1 · HOUZS 1')).toBeTruthy();
    expect(screen.getByText('Supplier')).toBeTruthy();
    fireEvent.click(screen.getByText('TRIP-T1'));
    const drawer = screen.getByLabelText('Own fleet trip');
    expect(within(drawer).getByText('Outstation JOHOR')).toBeTruthy();
    expect(within(drawer).getByText('Trip cost, Own fleet')).toBeTruthy();
    expect(within(drawer).getByText('RM 155.00')).toBeTruthy();
  });

  test('no own fleet card: says so and offers to make one', () => {
    data = { ...data, card: null, runs: data.runs.map((r) => ({ ...r, cardName: null, costSen: null, otherJobsSen: null, lines: [] })), months: [{ ...month, pricedTrips: 0, pricedDos: 0, costSen: 0, deliveryCostSen: 0 }] };
    const onCreate = show();
    expect(screen.getByText(/No own fleet rate card yet/)).toBeTruthy();
    expect(screen.getByText('0 of 2 trips priced')).toBeTruthy();
    expect(screen.getAllByText('no card').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: /Create own fleet card/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  test('two active fleet cards: both named, none offered', () => {
    data = { ...data, card: null, severalCards: [{ id: 'x', name: 'Own fleet' }, { id: 'y', name: 'Own fleet copy' }] };
    show();
    expect(screen.getByText(/2 own fleet cards are active/)).toBeTruthy();
    expect(screen.getByText(/Own fleet, Own fleet copy/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Create own fleet card/ })).toBeNull();
  });

  test("a failed read shows the server's reason", () => {
    state.fail = true;
    show();
    expect(screen.getAllByText(/Pick at most 186 days at a time/).length).toBeGreaterThan(0);
  });
});
