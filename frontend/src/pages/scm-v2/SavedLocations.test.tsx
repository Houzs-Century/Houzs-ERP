/* The Saved Locations maintenance page (owner 2026-11-02 方案2). Renders the REAL
   page + the REAL query hooks against a mocked authedFetch, so both the page and
   saved-locations-queries are exercised. Pinned: the list shows what the server
   returns; adding needs a name AND an address; a complete entry POSTs. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch }));

const { SavedLocations } = await import('./SavedLocations');
const { NotifyProvider } = await import('../../vendor/scm/components/NotifyDialog');
const { ConfirmProvider } = await import('../../vendor/scm/components/ConfirmDialog');

const wrap = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ConfirmProvider>
          <NotifyProvider>{ui}</NotifyProvider>
        </ConfirmProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

const SEEDED = {
  id: 'l1', name: 'Sunway Loading Bay', contactName: 'Mr Lee', contactPhone: '+60123334444',
  address1: 'Lot B1, Jalan PJS 11/15', address2: null, city: 'Petaling Jaya', postcode: '47500',
  state: 'Selangor', isActive: true, notes: null,
};

const isGet = (opts: unknown) => opts === undefined || (opts as { method?: string }).method === undefined;

beforeEach(() => authedFetch.mockReset());

describe('SavedLocations', () => {
  test('lists the saved locations the server returns', async () => {
    authedFetch.mockImplementation((path: string) =>
      path === '/saved-locations' ? Promise.resolve({ locations: [SEEDED] }) : Promise.resolve({}));
    wrap(<SavedLocations />);
    expect(await screen.findByText('Sunway Loading Bay')).toBeTruthy();
  });

  test('a complete entry POSTs; no name blocks it client-side', async () => {
    authedFetch.mockImplementation((path: string, opts?: unknown) =>
      path === '/saved-locations' && isGet(opts)
        ? Promise.resolve({ locations: [] })
        : Promise.resolve({ location: { ...SEEDED, id: 'l2', name: 'New Point' } }));
    wrap(<SavedLocations />);
    fireEvent.click(await screen.findByText('New location'));
    await screen.findByPlaceholderText('e.g. Sunway Pyramid loading bay');

    // No name: the client refuses before any POST.
    fireEvent.click(screen.getByText('Add location'));
    expect(authedFetch).not.toHaveBeenCalledWith('/saved-locations', expect.objectContaining({ method: 'POST' }));

    // Name + an address line: it POSTs.
    fireEvent.change(screen.getByPlaceholderText('e.g. Sunway Pyramid loading bay'), { target: { value: 'New Point' } });
    fireEvent.change(screen.getByPlaceholderText('Street / unit'), { target: { value: '88 Jalan Perindustrian' } });
    fireEvent.click(screen.getByText('Add location'));
    await waitFor(() =>
      expect(authedFetch).toHaveBeenCalledWith('/saved-locations', expect.objectContaining({ method: 'POST' })));
  });
});
