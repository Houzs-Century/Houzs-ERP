// Carriers & Rates (restyle + audit 2026-11-07): every carrier is listed, a card
// whose 3PL company was deleted is not passed off as own fleet, a rule amount is
// edited in place, the card has a minimum charge, the calculator prices a
// supplier pickup, and Reconciliation reads the bills the 3PL invoices tab keeps.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (...a: unknown[]) => fetchMock(...a) }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => false }) }));

import { DeliveryRateCards } from './DeliveryRateCards';
import { ConfirmProvider } from '../../vendor/scm/components/ConfirmDialog';

afterEach(() => { cleanup(); fetchMock.mockReset(); });

const card = (over: Record<string, unknown>) => ({
  id: 'card-msj', name: 'MSJ OLD NAME', carrierLorryId: null, carrierCompanyId: 'msj', carrierLabel: null, isOwnFleet: false,
  basis: 'SET', aggregation: 'UNIT', minChargeSen: 5000, capSen: null, rounding: 'NONE', isActive: true, notes: null, ruleCount: 1, ...over,
});
const CARDS = [
  card({}),
  card({ id: 'card-own', name: 'Own fleet cost', carrierCompanyId: null, isOwnFleet: true, ruleCount: 0 }),
  card({ id: 'card-gone', name: 'GONE TRANSPORT', carrierCompanyId: null, isOwnFleet: false, ruleCount: 2 }),
];
const RULE = { id: 'r1', cardId: 'card-msj', ruleType: 'POSITIONAL_TIER', tierPosition: 1, bracketMin: null, bracketMax: null, zone: null, amountSen: 8000, params: null, sortOrder: 0 };
const CHARGE = {
  id: 'c1', doId: 'd1', doNumber: 'HC-DO-1', doDate: '2026-11-01', doStatus: 'DELIVERED', customer: 'Tan', doCompanyCode: 'HOUZS', carrierId: 'msj',
  carrierName: 'MSJ TRANSPORT', cardName: 'MSJ', invoiceNo: 'INV9', invoiceDate: '2026-11-02', billedSen: 12000, expectedSen: 10000, varianceSen: 2000, note: null,
};

function api(path: string, init?: RequestInit) {
  if (init?.method && init.method !== 'GET') return Promise.resolve({ rule: RULE, card: CARDS[0] });
  if (path === '/delivery-rate-cards') return Promise.resolve({ cards: CARDS });
  if (path === '/delivery-rate-cards/meta') {
    return Promise.resolve({ carriers: [], companies: [{ id: 'msj', name: 'MSJ TRANSPORT' }, { id: 'eu', name: 'EU LOGISTICS' }], ruleTypes: [], zones: ['KL', 'MELAKA'] });
  }
  if (path.startsWith('/delivery-rate-cards/reconcile')) return Promise.resolve({ rows: [] });
  if (path.startsWith('/delivery-rate-cards/card-')) {
    const id = path.split('/')[2];
    return Promise.resolve({ card: CARDS.find((c) => c.id === id), rules: id === 'card-msj' ? [RULE] : [] });
  }
  if (path.startsWith('/threepl-do-charges')) return Promise.resolve({ rows: [CHARGE], invoices: [] });
  return Promise.resolve({});
}

const mount = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ConfirmProvider><DeliveryRateCards /></ConfirmProvider>
  </QueryClientProvider>,
);

describe('Carriers & Rates', () => {
  it('lists every carrier, and a card whose carrier was deleted under Needs a carrier, not Own fleet', async () => {
    fetchMock.mockImplementation(api);
    mount();
    expect(screen.getByRole('heading', { name: 'Carriers & Rates' })).toBeTruthy();
    expect(await screen.findByText('SET · per unit · 1 rule')).toBeTruthy();
    expect(screen.getByText('No rate card yet. Click to add')).toBeTruthy();
    expect(screen.getByText('Needs a carrier')).toBeTruthy();
    expect(screen.getByText(/Carrier removed · SET/)).toBeTruthy();
    expect(screen.getByText('Own fleet cost')).toBeTruthy();
  });

  it('shows the carrier\'s current name, a minimum charge, edits a rule amount in place, and prices a supplier pickup', async () => {
    fetchMock.mockImplementation(api);
    mount();
    fireEvent.click(await screen.findByText('SET · per unit · 1 rule'));
    expect(await screen.findByRole('heading', { name: 'MSJ TRANSPORT' })).toBeTruthy();
    expect((screen.getByLabelText(/Minimum charge \(RM\)/) as HTMLInputElement).value).toBe('50.00');

    fireEvent.click(screen.getByRole('button', { name: 'Edit amount for Positional tier' }));
    const amount = screen.getByLabelText('Amount for Positional tier');
    fireEvent.change(amount, { target: { value: '95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
      expect(patch?.[0]).toBe('/delivery-rate-cards/card-msj/rules/r1');
      expect(JSON.parse(String(patch?.[1].body))).toEqual({ amountSen: 9500 });
    });

    fireEvent.change(screen.getByLabelText('Supplier pickup'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compute cost' }));
    await waitFor(() => {
      const run = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/compute'));
      expect(JSON.parse(String(run?.[1].body)).supplierPickupCount).toBe(2);
    });
  });

  it('a card whose carrier was deleted can be moved to a carrier without a card', async () => {
    fetchMock.mockImplementation(api);
    mount();
    fireEvent.click(await screen.findByText(/Carrier removed · SET/));
    const move = await screen.findByLabelText('Move to carrier');
    expect(within(move).queryByRole('option', { name: 'MSJ TRANSPORT' })).toBeNull();
    fireEvent.change(move, { target: { value: 'eu' } });
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH');
      expect(patch?.[0]).toBe('/delivery-rate-cards/card-gone');
      expect(JSON.parse(String(patch?.[1].body))).toEqual({ carrierCompanyId: 'eu' });
    });
  });

  it('Reconciliation reads the 3PL bills, per 3PL and the DOs off the card', async () => {
    fetchMock.mockImplementation(api);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reconciliation' }));
    expect(await screen.findByRole('heading', { name: 'Per 3PL' })).toBeTruthy();
    expect(await screen.findAllByText('MSJ TRANSPORT')).toHaveLength(2);
    expect(screen.getByText('HC-DO-1')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /DOs that differ from the rate card/ }).textContent).toContain('(1)');
  });
});
