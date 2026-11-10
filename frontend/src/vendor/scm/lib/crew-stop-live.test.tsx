/* The open run-sheet stop follows the other crew member's taps: it asks the
   light POD read again while the stop is open, lays the live status and times
   over the board row, and stops asking once the delivery is finished. */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('./authed-fetch', () => ({ authedFetch }));
const { useLiveDoStop, withLiveDo } = await import('./crew-stop-live');
const { CREW_STOP_POLL_MS } = await import('./crew-stop-photos');

const live = (status: string, arrival_at: string | null = null) => ({
  deliveryOrder: { id: 'do-1', do_number: 'DO-1', status, arrival_at, departure_at: '2026-11-10T05:00:00Z' },
});

afterEach(() => { vi.useRealTimers(); authedFetch.mockReset(); });

describe('withLiveDo', () => {
  const row = { delivery_orders: [{ id: 'do-0', status: 'CANCELLED' }, { id: 'do-1', status: 'DISPATCHED' }], arrival_at: null, departure_at: null };
  test('lays the live status and times over the latest DO of the row', () => {
    const out = withLiveDo(row, live('IN_TRANSIT', '2026-11-10T06:00:00Z').deliveryOrder);
    expect(out.delivery_orders.map((d) => d.status)).toEqual(['CANCELLED', 'IN_TRANSIT']);
    expect(out).toMatchObject({ arrival_at: '2026-11-10T06:00:00Z', departure_at: '2026-11-10T05:00:00Z' });
  });
  test('an answer for another DO, or none, leaves the row alone', () => {
    expect(withLiveDo(row, { ...live('DELIVERED').deliveryOrder, id: 'do-9' })).toBe(row);
    expect(withLiveDo(row, null)).toBe(row);
  });
});

describe('useLiveDoStop', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
  );

  test('asks again while the stop is open, so the helper\'s "Arrived" shows on the driver\'s phone, then stops once delivered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    authedFetch.mockResolvedValueOnce(live('IN_TRANSIT')).mockResolvedValueOnce(live('IN_TRANSIT', '2026-11-10T06:00:00Z')).mockResolvedValue(live('DELIVERED'));
    const { result } = renderHook(() => useLiveDoStop('DO-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.deliveryOrder.status).toBe('IN_TRANSIT'));
    expect(authedFetch).toHaveBeenCalledWith('/delivery-planning/do/DO-1/pod');
    await vi.advanceTimersByTimeAsync(CREW_STOP_POLL_MS);
    await waitFor(() => expect(result.current.data?.deliveryOrder.arrival_at).toBe('2026-11-10T06:00:00Z'));
    await vi.advanceTimersByTimeAsync(CREW_STOP_POLL_MS);
    await waitFor(() => expect(result.current.data?.deliveryOrder.status).toBe('DELIVERED'));
    const calls = authedFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CREW_STOP_POLL_MS * 3);
    expect(authedFetch.mock.calls.length).toBe(calls);
  });

  test('asks nothing when no DO stop is open', () => {
    renderHook(() => useLiveDoStop(null), { wrapper });
    expect(authedFetch).not.toHaveBeenCalled();
  });
});
