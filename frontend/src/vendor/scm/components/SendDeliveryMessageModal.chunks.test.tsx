/* HC-0197: a 64-customer blast in one request ran past the 30 s deadline. The
   modal now sends SEND_CHUNK customers per request, a failed request fails only
   its own customers, and only the rows that went out are handed back. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import type { PlanningOrder } from '../lib/delivery-planning-queries';

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('../lib/authed-fetch', () => ({ authedFetch }));
vi.mock('../lib/dialog-service', () => ({ serviceNotify: vi.fn() }));
const { SendDeliveryMessageModal, SEND_CHUNK } = await import('./SendDeliveryMessageModal');
const { NotifyProvider } = await import('./NotifyDialog');

const row = (i: number): PlanningOrder => ({
  row_type: 'so', so_doc_no: `HC-SO-${String(i).padStart(6, '0')}`, phone: `+60 12-${String(1000000 + i)}`,
  debtor_name: `Customer ${i}`, branding: 'AKEMI', customer_delivery_date: '2026-11-10', amended_delivery_date: null,
  balance_sen: 0, balance_sen_live: 0, regions: ['KL'],
} as unknown as PlanningOrder);

describe('SendDeliveryMessageModal sends in chunks', () => {
  test('23 customers go in 3 requests; the timed-out one fails only its own customers', async () => {
    const rows = Array.from({ length: 23 }, (_, i) => row(i + 1));
    const bodies: string[][] = [];
    authedFetch.mockImplementation((path: string, init?: { body?: string }) => {
      if (path !== '/delivery-messages/send') return Promise.resolve({ orders: [], counts: {}, regions: [] });
      const docNos = (JSON.parse(init?.body ?? '{}') as { docNos: string[] }).docNos;
      bodies.push(docNos);
      if (bodies.length === 2) return Promise.reject(new Error('That took too long.'));
      return Promise.resolve({ sent: docNos.map((d) => ({ phone: d, docNos: [d], httpCode: 200 })), failed: [], skipped: [], statusNotMoved: [] });
    });
    const onSent = vi.fn();
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <NotifyProvider>
          <SendDeliveryMessageModal rows={rows} kind="delivery" onClose={vi.fn()} onSent={onSent} />
        </NotifyProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send 23 messages' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));

    expect(bodies.map((b) => b.length)).toEqual([SEND_CHUNK, SEND_CHUNK, 3]);
    const sent = (onSent.mock.calls[0]![0] as PlanningOrder[]).map((o) => o.so_doc_no);
    expect(sent).toEqual([...bodies[0]!, ...bodies[2]!]);
    expect(await screen.findByText(/Failed 10: .*\(That took too long\.\)/)).toBeTruthy();
  });
});
