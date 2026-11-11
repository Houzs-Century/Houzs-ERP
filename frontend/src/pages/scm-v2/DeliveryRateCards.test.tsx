// Carriers & Rates (restyle + audit 2026-11-07; card redesign 2026-11-11): every
// carrier is listed, a card whose 3PL company was deleted is not passed off as
// own fleet, the card's settings read as one line and are edited in a drawer, a
// price is changed from its tile, the categories are tabs with outstation towns
// grouped by price, Price check prices a supplier pickup as you type, and
// Reconciliation reads the bills the 3PL invoices tab keeps.
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

const BREAKDOWN = {
  subtotalSen: 18000, totalSen: 18000,
  lines: [
    { ruleType: 'POSITIONAL_TIER', label: '1st set', amountSen: 8000, detail: { position: 1, tierPosition: 1 } },
    { ruleType: 'SUPPLIER_PICKUP', label: 'Supplier pickup x2', amountSen: 10000, detail: { count: 2, eachSen: 5000 } },
  ],
};

function api(path: string, init?: RequestInit) {
  if (path.endsWith('/compute')) return Promise.resolve({ card: CARDS[0], facts: {}, breakdown: BREAKDOWN });
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
    expect(await screen.findByText('1 price')).toBeTruthy();
    expect(screen.getByText('No rate card yet')).toBeTruthy();
    expect(screen.getByText('Needs a carrier')).toBeTruthy();
    expect(screen.getByText(/Carrier removed · 2 prices/)).toBeTruthy();
    expect(screen.getByText('Own fleet cost')).toBeTruthy();
  });

  it('says the settings in one line and edits them in a drawer, changes a price in its table, and price-checks a supplier pickup as you type', async () => {
    const rules = [RULE, { ...RULE, id: 'r9', ruleType: 'SUPPLIER_PICKUP', tierPosition: null, amountSen: 5000 }];
    fetchMock.mockImplementation((path: string, init?: RequestInit) => (path === '/delivery-rate-cards/card-msj' && !init?.method
      ? Promise.resolve({ card: CARDS[0], rules }) : api(path, init)));
    mount();
    fireEvent.click(await screen.findByText('1 price'));
    expect(await screen.findByRole('heading', { name: 'MSJ TRANSPORT' })).toBeTruthy();
    expect(screen.getByText('Charged per set (frame + mattress) · Minimum RM 50.00 · No cap · No rounding')).toBeTruthy();
    expect(screen.queryByLabelText(/Minimum charge \(RM\)/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit settings' }));
    const drawer = await screen.findByRole('dialog', { name: 'Card settings' });
    const min = within(drawer).getByLabelText(/Minimum charge \(RM\)/) as HTMLInputElement;
    expect(min.value).toBe('50.00');
    fireEvent.change(min, { target: { value: '60' } });
    fireEvent.blur(min);
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH' && c[0] === '/delivery-rate-cards/card-msj');
      expect(JSON.parse(String(patch?.[1].body))).toEqual({ minChargeSen: 6000 });
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Card settings' })).toBeNull());

    const delivery = screen.getByRole('tabpanel', { name: 'Delivery' });
    fireEvent.click(within(delivery).getByRole('button', { name: 'Edit Each set, RM 80.00' }));
    fireEvent.change(within(delivery).getByLabelText('Amount for Each set'), { target: { value: '95' } });
    fireEvent.click(within(delivery).getByRole('button', { name: 'Save Each set' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH' && String(c[0]).includes('/rules/'));
      expect(patch?.[0]).toBe('/delivery-rate-cards/card-msj/rules/r1');
      expect(JSON.parse(String(patch?.[1].body))).toEqual({ amountSen: 9500 });
    });

    fireEvent.click(screen.getByRole('tab', { name: /Price check/ }));
    const check = screen.getByRole('tabpanel', { name: 'Price check' });
    expect(within(check).queryByLabelText('Dispose')).toBeNull();
    expect(within(check).queryByRole('button', { name: /Compute/ })).toBeNull();
    fireEvent.change(within(check).getByLabelText('Supplier pickup'), { target: { value: '2' } });
    await waitFor(() => {
      const runs = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/compute')).map((c) => JSON.parse(String(c[1].body)));
      expect(runs.some((f) => f.supplierPickupCount === 2 && f.setCount === 1)).toBe(true);
    });
    expect(await within(check).findByText('This delivery should cost')).toBeTruthy();
    expect(within(check).getByText('Supplier pickup × 2')).toBeTruthy();
    expect(within(check).getByText('RM 180.00')).toBeTruthy();

    fireEvent.change(within(check).getByLabelText('Sets'), { target: { value: '1.5' } });
    expect(within(check).getByRole('alert').textContent).toContain('whole number');
  });

  it('a carrier with no card asks to create one, and opens the new card for it', async () => {
    fetchMock.mockImplementation(api);
    mount();
    fireEvent.click(await screen.findByText('EU LOGISTICS'));
    const prompt = await screen.findByRole('region', { name: 'No rate card yet' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Create rate card' }));
    const group = await screen.findByRole('group', { name: '3PL company' });
    expect(within(group).getByRole('button', { name: 'EU LOGISTICS' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows one category at a time: delivery prices in a ruled table, outstation towns by price with a per-trip price added, and service calls with Add rows', async () => {
    const rules = [
      RULE,
      { ...RULE, id: 'r2', tierPosition: 3, amountSen: 4000 },
      { ...RULE, id: 'r3', ruleType: 'OUTSTATION', tierPosition: null, zone: 'KUCHING', amountSen: 30000 },
      { ...RULE, id: 'r4', ruleType: 'OUTSTATION', tierPosition: null, zone: 'BAU', amountSen: 30000 },
      /* An area's own 1st-set price: the area's, never a second 1st set here. */
      { ...RULE, id: 'r5', tierPosition: 1, amountSen: 9900, areaId: 'area-kuching' },
    ];
    fetchMock.mockImplementation((path: string, init?: RequestInit) => (path === '/delivery-rate-cards/card-msj' && !init?.method
      ? Promise.resolve({ card: CARDS[0], rules }) : api(path, init)));
    mount();
    fireEvent.click(await screen.findByText('1 price'));
    const delivery = await screen.findByRole('tabpanel', { name: 'Delivery' });
    expect(within(delivery).getByText('1st set')).toBeTruthy();
    expect(within(delivery).getByText('3rd set and after')).toBeTruthy();
    expect(within(delivery).getByRole('button', { name: 'Add Dispose price' })).toBeTruthy();
    expect(within(delivery).queryByText('99.00')).toBeNull();
    expect(within(delivery).queryByText('Twice')).toBeNull();
    expect(screen.queryByRole('tabpanel', { name: 'Outstation' })).toBeNull();
    expect(screen.getByRole('tab', { name: /^Setup & dismantle/ }).textContent).toContain('—');

    fireEvent.keyDown(screen.getByRole('tab', { name: /^Delivery/ }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /^Outstation/ }).getAttribute('aria-selected')).toBe('true');
    const out = screen.getByRole('tabpanel', { name: 'Outstation' });
    expect(within(out).getByText('RM 300.00')).toBeTruthy();
    expect(within(out).getByRole('button', { name: 'Edit Bau per order, RM 300.00' })).toBeTruthy();
    expect(within(out).getByRole('button', { name: 'Edit Kuching per order, RM 300.00' })).toBeTruthy();

    fireEvent.click(within(out).getByRole('button', { name: 'Add a per-trip price' }));
    expect((within(out).getByLabelText('Rule type') as HTMLSelectElement).value).toBe('OUTSTATION_TRIP');
    fireEvent.change(within(out).getByLabelText('Town or area zone'), { target: { value: 'KUCHING' } });
    fireEvent.change(within(out).getByLabelText('Amount (RM)'), { target: { value: '120' } });
    fireEvent.click(within(out).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(post?.[0]).toBe('/delivery-rate-cards/card-msj/rules');
      expect(JSON.parse(String(post?.[1].body))).toMatchObject({ ruleType: 'OUTSTATION_TRIP', zone: 'KUCHING', amountSen: 12000 });
    });

    fireEvent.click(screen.getByRole('tab', { name: /^Service calls/ }));
    const svc = screen.getByRole('tabpanel', { name: 'Service calls' });
    expect(within(svc).getByText('This card has no service calls prices yet.')).toBeTruthy();
    expect(within(svc).getAllByRole('button').map((b) => b.getAttribute('aria-label')))
      .toEqual(['Add Service price', 'Add Pickup price', 'Add Inspection price', 'Add Supplier pickup price', 'Add Transfer price']);
    fireEvent.click(within(svc).getByRole('button', { name: 'Add Pickup price' }));
    fireEvent.change(within(svc).getByLabelText('Amount for Pickup'), { target: { value: '25' } });
    fireEvent.click(within(svc).getByRole('button', { name: 'Save Pickup price' }));
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST');
      expect(JSON.parse(String(posts[posts.length - 1]?.[1].body))).toEqual({ ruleType: 'PICKUP', amountSen: 2500 });
    });

    /* The open tab stays while another carrier is opened. */
    fireEvent.click(screen.getByText('Own fleet cost'));
    expect((await screen.findByRole('tab', { name: /^Service calls/ })).getAttribute('aria-selected')).toBe('true');
  });

  it('areas sit at the top of Outstation with their own prices; one is added, and Price check prices in it (mig 20261111T1000)', async () => {
    const AREA = { id: 'area-far', cardId: 'card-msj', name: 'Far towns', towns: ['BINTULU', 'LABUAN'], sortOrder: 0 };
    const rules = [
      RULE,
      { ...RULE, id: 'r2', tierPosition: 3, amountSen: 4000 },
      { ...RULE, id: 'ra1', tierPosition: 1, amountSen: 20000, areaId: 'area-far' },
      { ...RULE, id: 'r-lab', ruleType: 'OUTSTATION', tierPosition: null, zone: 'LABUAN', amountSen: 6000 },
    ];
    fetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/delivery-rate-cards/card-msj' && !init?.method) return Promise.resolve({ card: CARDS[0], rules, areas: [AREA] });
      if (path === '/delivery-rate-cards/card-msj/areas' && init?.method === 'POST') {
        return Promise.resolve({ area: { id: 'area-new', cardId: 'card-msj', name: 'Near towns', towns: ['MARUDI', 'SUBIS'], sortOrder: 0 } });
      }
      if (path.endsWith('/compute')) return Promise.resolve({ card: CARDS[0], facts: {}, breakdown: { ...BREAKDOWN, area: { id: 'area-far', name: 'Far towns' } } });
      return api(path, init);
    });
    mount();
    fireEvent.click(await screen.findByText('1 price'));
    const tab = await screen.findByRole('tab', { name: /^Outstation/ });
    expect(tab.textContent).toContain('2');
    fireEvent.click(tab);
    const out = screen.getByRole('tabpanel', { name: 'Outstation' });
    /* One ruled table: the card's own prices first, then a row per town with the area's prices merged down. */
    expect(within(out).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Area', 'Town', '1st set', '3rd set and after', 'Change the area']);
    const own = within(out).getByRole('rowgroup', { name: 'Everywhere else' });
    expect(within(own).getByText('80.00')).toBeTruthy();
    expect(within(own).getByText('40.00')).toBeTruthy();
    const far = within(out).getByRole('rowgroup', { name: 'Far towns' });
    expect(within(far).getAllByRole('row')).toHaveLength(2);
    expect(within(far).getByText('Bintulu')).toBeTruthy();
    expect(within(far).getByText('Labuan')).toBeTruthy();
    expect(within(out).getByText(/its town price adds on top of the area’s price/).textContent).toContain('Labuan (Far towns)');

    fireEvent.click(within(far).getByRole('button', { name: 'Edit 1st set for Far towns, RM 200.00' }));
    fireEvent.change(within(far).getByLabelText('Amount for 1st set for Far towns'), { target: { value: '250' } });
    fireEvent.click(within(far).getByRole('button', { name: 'Save 1st set for Far towns' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[1]?.method === 'PATCH' && String(c[0]).includes('/rules/'));
      expect(patch?.[0]).toBe('/delivery-rate-cards/card-msj/rules/ra1');
      expect(JSON.parse(String(patch?.[1].body))).toEqual({ amountSen: 25000 });
    });

    fireEvent.click(within(far).getByRole('button', { name: 'Add 3rd set and after price for Far towns' }));
    fireEvent.change(within(far).getByLabelText('Amount for 3rd set and after for Far towns'), { target: { value: '50' } });
    fireEvent.click(within(far).getByRole('button', { name: 'Save 3rd set and after price for Far towns' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST' && c[0] === '/delivery-rate-cards/card-msj/rules');
      expect(JSON.parse(String(post?.[1].body))).toEqual({ ruleType: 'POSITIONAL_TIER', tierPosition: 3, areaId: 'area-far', amountSen: 5000 });
    });

    fireEvent.click(within(out).getByRole('button', { name: 'Add area' }));
    fireEvent.change(within(out).getByLabelText('Area name'), { target: { value: 'Near towns' } });
    fireEvent.change(within(out).getByLabelText(/^Towns, separated by commas/), { target: { value: 'marudi, Subis' } });
    fireEvent.change(within(out).getByLabelText('1st set (RM)'), { target: { value: '150' } });
    fireEvent.click(within(out).getByRole('button', { name: 'Add area' }));
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST');
      const areaPost = posts.find((c) => c[0] === '/delivery-rate-cards/card-msj/areas');
      expect(JSON.parse(String(areaPost?.[1].body))).toEqual({ name: 'Near towns', towns: ['MARUDI', 'SUBIS'] });
      const last = posts[posts.length - 1];
      expect(last[0]).toBe('/delivery-rate-cards/card-msj/rules');
      expect(JSON.parse(String(last[1].body))).toEqual({ ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 15000, areaId: 'area-new' });
    });

    fireEvent.click(screen.getByRole('tab', { name: /Price check/ }));
    const check = screen.getByRole('tabpanel', { name: 'Price check' });
    const dest = within(check).getByLabelText('Destination') as HTMLSelectElement;
    expect(within(dest).getByRole('group', { name: 'Far towns' })).toBeTruthy();
    expect(within(dest).queryByRole('group', { name: 'Other towns' })).toBeNull();
    fireEvent.change(dest, { target: { value: 'BINTULU' } });
    await waitFor(() => {
      const runs = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/compute')).map((c) => JSON.parse(String(c[1].body)));
      expect(runs.some((f) => f.areaId === 'area-far' && f.destinationZone === 'BINTULU')).toBe(true);
    });
    expect(await within(check).findByText('Priced in the area Far towns.')).toBeTruthy();
  });

  it('an add form opened on one tab does not follow to the next', async () => {
    fetchMock.mockImplementation(api);
    mount();
    fireEvent.click(await screen.findByText('1 price'));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a Delivery rule' }));
    expect(screen.getByLabelText('Rule type')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Setup & dismantle/ }));
    expect(screen.queryByLabelText('Rule type')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Setup price' })).toBeTruthy();
  });

  it('a card whose carrier was deleted can be moved to a carrier without a card', async () => {
    fetchMock.mockImplementation(api);
    mount();
    fireEvent.click(await screen.findByText(/Carrier removed · 2 prices/));
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
