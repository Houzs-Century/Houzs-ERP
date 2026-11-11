// Places under a delivery zone (owner 2026-11-11: the 3PL rate cards use the
// same areas as Delivery Zones, 做): the towns a card prices, filed under the
// zone their postcodes fall in. The zone's panel lists them with the cards that
// price each, files a pasted list, moves a town to another zone, and removes
// only a town no card prices.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (...a: unknown[]) => fetchMock(...a) }));

import { UnplacedTowns, ZonePlaces } from './ZonePlaces';

afterEach(() => { cleanup(); fetchMock.mockReset(); });

const PLACES = {
  places: [
    { id: 'p-ipoh', name: 'IPOH', zone: 'PERAK', cards: ['CARRIER A', 'CARRIER B'] },
    { id: 'p-gerik', name: 'GERIK', zone: 'PERAK', cards: [] },
    { id: 'p-alor', name: 'ALOR SETAR', zone: 'KEDAH', cards: ['CARRIER A'] },
    { id: 'p-brunei', name: 'BRUNEI', zone: null, cards: [] },
  ],
  unplaced: [],
};

function api(path: string, init?: RequestInit) {
  if (path === '/delivery-places' && (!init?.method || init.method === 'GET')) return Promise.resolve(PLACES);
  if (init?.method === 'POST') return Promise.resolve({ places: [] });
  if (init?.method === 'PATCH') return Promise.resolve({ place: PLACES.places[1] });
  if (init?.method === 'DELETE') return Promise.resolve({ ok: true });
  return Promise.resolve({});
}

const mount = (zone: string | null) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ZonePlaces zone={zone} />
  </QueryClientProvider>,
);

const sent = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);

describe('places of a zone', () => {
  it('lists the zone\'s towns A–Z with the cards that price each', async () => {
    fetchMock.mockImplementation(api);
    mount('PERAK');
    const table = await screen.findByRole('table', { name: 'Places in Perak' });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('Gerik');
    expect(rows[0]).toContain('No rate card yet');
    expect(rows[1]).toContain('Ipoh');
    expect(rows[1]).toContain('CARRIER A, CARRIER B');
    expect(within(table).queryByText('Alor Setar')).toBeNull();
    /* A town a card prices cannot be removed; one no card prices can. */
    expect(screen.queryByRole('button', { name: 'Remove Ipoh' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Gerik' }));
    await waitFor(() => expect(sent('DELETE')).toHaveLength(1));
    expect(sent('DELETE')[0][0]).toBe('/delivery-places/p-gerik');
  });

  it('files a pasted list under the zone', async () => {
    fetchMock.mockImplementation(api);
    mount('PERAK');
    await screen.findByRole('table', { name: 'Places in Perak' });
    fireEvent.change(screen.getByLabelText('Add towns to Perak'), { target: { value: 'Taiping, kuala kangsar\nTaiping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sent('POST')).toHaveLength(1));
    expect(JSON.parse(String((sent('POST')[0][1] as RequestInit).body))).toEqual({ zone: 'PERAK', names: ['TAIPING', 'KUALA KANGSAR'] });
  });

  it('moves a town to another zone', async () => {
    fetchMock.mockImplementation(api);
    mount('PERAK');
    await screen.findByRole('table', { name: 'Places in Perak' });
    fireEvent.change(screen.getByLabelText('Zone of Gerik'), { target: { value: 'KEDAH' } });
    await waitFor(() => expect(sent('PATCH')).toHaveLength(1));
    expect(sent('PATCH')[0][0]).toBe('/delivery-places/p-gerik');
    expect(JSON.parse(String((sent('PATCH')[0][1] as RequestInit).body))).toEqual({ zone: 'KEDAH' });
  });

  it('names the towns rate cards price that no zone holds yet, and nothing when there are none', async () => {
    fetchMock.mockImplementation((path: string, init?: RequestInit) => (path === '/delivery-places'
      ? Promise.resolve({ ...PLACES, unplaced: [{ name: 'KUALA KETIL', cards: ['CARRIER B'] }, { name: 'KAPAR', cards: ['CARRIER C'] }] })
      : api(path, init)));
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><UnplacedTowns /></QueryClientProvider>,
    );
    expect(await screen.findByText(/2 towns on the rate cards have no zone yet: Kuala Ketil, Kapar\./)).toBeTruthy();
    unmount();
    fetchMock.mockImplementation(api);
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><UnplacedTowns /></QueryClientProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('a town abroad sits under No zone', async () => {
    fetchMock.mockImplementation(api);
    mount(null);
    const table = await screen.findByRole('table', { name: 'Places in no zone' });
    expect(within(table).getByText('Brunei')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add towns to no zone'), { target: { value: 'Singapore' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sent('POST')).toHaveLength(1));
    expect(JSON.parse(String((sent('POST')[0][1] as RequestInit).body))).toEqual({ zone: null, names: ['SINGAPORE'] });
  });
});
