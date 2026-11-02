/* HC-0197: after a Service Arrangement blast the ticked ASSR rows show Done Send. */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { PlanningOrder, PlanningResponse } from './delivery-planning-queries';

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('./authed-fetch', () => ({ authedFetch }));
vi.mock('./dialog-service', () => ({ serviceNotify: vi.fn() }));
const { useSendDeliveryMessages } = await import('./delivery-planning-queries');

const row = (type: 'so' | 'assr', doc: string, status: string | null): PlanningOrder =>
  ({ row_type: type, so_doc_no: doc, delivery_message_status: status, regions: ['KL'] } as unknown as PlanningOrder);
const KEY = ['delivery-planning', 'ALL', 'OPEN'];
const TO_SEND = 'To Send Delivery Date';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity }, mutations: { retry: false } } });
  qc.setQueryData<PlanningResponse>(KEY, {
    orders: [
      row('assr', 'ASSR/2610-048#inspection', TO_SEND),
      row('assr', 'ASSR/2610-054#delivery', TO_SEND),
      row('assr', 'ASSR/2610-099#delivery', TO_SEND),
      row('so', 'HC-SO-2610-005', TO_SEND),
    ],
    counts: {} as PlanningResponse['counts'],
    regions: [],
  });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useSendDeliveryMessages(), { wrapper });
  const statuses = () => qc.getQueryData<PlanningResponse>(KEY)!.orders.map((o) => o.delivery_message_status);
  return { result, statuses };
}

describe('Service Arrangement send moves the ASSR rows to Done Send', () => {
  test('only the legs that went out change, at once', async () => {
    authedFetch.mockResolvedValue({
      sent: [
        { phone: '60123', docNos: ['ASSR/2610-048#inspection'], httpCode: 200 },
        { phone: '60124', docNos: ['ASSR/2610-054#delivery'], httpCode: 200 },
      ],
      failed: [{ phone: '60125', docNos: ['ASSR/2610-099#delivery'], error: 'send failed' }],
      skipped: [],
    });
    const { result, statuses } = setup();
    result.current.mutate({ docNos: ['ASSR/2610-048#inspection', 'ASSR/2610-054#delivery', 'ASSR/2610-099#delivery'], kind: 'assr_arrangement' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(statuses()).toEqual(['Done Send', 'Done Send', TO_SEND, TO_SEND]);
  });
});
