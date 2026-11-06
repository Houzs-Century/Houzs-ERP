/* HC-0175: a Delivery Message Status pick shows at once, before the PATCH answers. */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { PlanningOrder, PlanningResponse } from './delivery-planning-queries';

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('./authed-fetch', () => ({ authedFetch }));
vi.mock('./dialog-service', () => ({ serviceNotify: vi.fn() }));
const { useUpdateDeliveryFields } = await import('./delivery-planning-queries');

const row = (doc: string, status: string | null): PlanningOrder =>
  ({ row_type: 'so', so_doc_no: doc, delivery_message_status: status, regions: ['KL'] } as unknown as PlanningOrder);
const KEY = ['delivery-planning', 'ALL', 'OPEN'];

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity }, mutations: { retry: false } } });
  qc.setQueryData<PlanningResponse>(KEY, { orders: [row('A', null), row('B', 'Done Send')], counts: {} as PlanningResponse['counts'], regions: [] });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useUpdateDeliveryFields(), { wrapper });
  const statuses = () => qc.getQueryData<PlanningResponse>(KEY)!.orders.map((o) => o.delivery_message_status);
  return { result, statuses };
}

describe('useUpdateDeliveryFields optimistic patch', () => {
  test('the picked status is on the board while the save is still in flight', async () => {
    authedFetch.mockImplementation(() => new Promise(() => {}));
    const { result, statuses } = setup();
    result.current.mutate({ type: 'so', id: 'A', deliveryMessageStatus: 'To Send Delivery Date' });
    await waitFor(() => expect(statuses()).toEqual(['To Send Delivery Date', 'Done Send']));
  });

  test('a Service Case pick lands on that job only, not its sibling job', async () => {
    authedFetch.mockImplementation(() => new Promise(() => {}));
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity }, mutations: { retry: false } } });
    const leg = (job_kind: string) => ({ row_type: 'assr', assr_id: 7, job_kind, so_doc_no: `A#${job_kind}`, delivery_message_status: 'Done Send', regions: ['KL'] } as unknown as PlanningOrder);
    qc.setQueryData<PlanningResponse>(KEY, { orders: [leg('inspection'), leg('delivery')], counts: {} as PlanningResponse['counts'], regions: [] });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useUpdateDeliveryFields(), { wrapper });
    result.current.mutate({ type: 'assr', id: '7', jobKind: 'delivery', deliveryMessageStatus: 'To Send Delivery Date' });
    await waitFor(() => expect(qc.getQueryData<PlanningResponse>(KEY)!.orders.map((o) => o.delivery_message_status)).toEqual(['Done Send', 'To Send Delivery Date']));
  });

  test('a rejected save puts the old status back', async () => {
    authedFetch.mockRejectedValue(new Error('403'));
    const { result, statuses } = setup();
    result.current.mutate({ type: 'so', id: 'B', deliveryMessageStatus: '' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(statuses()).toEqual([null, 'Done Send']);
  });
});
