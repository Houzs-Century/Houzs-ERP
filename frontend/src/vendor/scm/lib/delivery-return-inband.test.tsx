import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('./dialog-service', () => ({ serviceNotify: vi.fn(() => Promise.resolve(true)) }));

import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';
import {
  useCreateDeliveryReturn,
  useConvertDoToDeliveryReturn,
  useUpdateDeliveryReturnStatus,
  useAddDeliveryReturnItem,
  useUpdateDeliveryReturnItem,
  useDeleteDeliveryReturnItem,
} from './delivery-return-queries';

const mockedFetch = vi.mocked(authedFetch);
const notified = vi.mocked(serviceNotify);

function harness() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { spy, wrapper };
}

beforeEach(() => { mockedFetch.mockReset(); notified.mockClear(); });

type Hook = () => { mutate: (v: unknown) => void; isSuccess: boolean };
const CASES: ReadonlyArray<readonly [string, Hook, Record<string, unknown>, unknown]> = [
  ['create', useCreateDeliveryReturn as unknown as Hook, { id: 'dr-1', returnNumber: 'DR-1' }, {}],
  ['convert from DO', useConvertDoToDeliveryReturn as unknown as Hook, { id: 'dr-1', returnNumber: 'DR-1', lineCount: 1 }, { picks: [] }],
  ['status', useUpdateDeliveryReturnStatus as unknown as Hook, { deliveryReturn: {} }, { id: 'dr-1', status: 'RECEIVED' }],
  ['line add', useAddDeliveryReturnItem as unknown as Hook, { item: {} }, { id: 'dr-1', itemCode: 'X' }],
  ['line edit', useUpdateDeliveryReturnItem as unknown as Hook, { ok: true }, { id: 'dr-1', itemId: 'i-1', qty: 2 }],
  ['line delete', useDeleteDeliveryReturnItem as unknown as Hook, { ok: true }, { id: 'dr-1', itemId: 'i-1' }],
];

describe('delivery return writes report a refused stock write', () => {
  test.each(CASES)('%s with movementErrors is reported', async (_n, hook, answer, vars) => {
    mockedFetch.mockResolvedValueOnce({ ...answer, movementErrors: ['IN SKU-1: refused'] });
    const { wrapper } = harness();
    const { result } = renderHook(hook, { wrapper });
    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(notified).toHaveBeenCalled());
    expect(JSON.stringify(notified.mock.calls)).toContain('IN SKU-1: refused');
  });

  test.each(CASES)('%s that moved its stock says nothing', async (_n, hook, answer, vars) => {
    mockedFetch.mockResolvedValueOnce(answer);
    const { wrapper } = harness();
    const { result } = renderHook(hook, { wrapper });
    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(notified).not.toHaveBeenCalled();
  });
});

describe('delivery return line changes refresh stock', () => {
  test.each(CASES.slice(3))('%s refreshes inventory', async (_n, hook, answer, vars) => {
    mockedFetch.mockResolvedValueOnce(answer);
    const { spy, wrapper } = harness();
    const { result } = renderHook(hook, { wrapper });
    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy.mock.calls.some((a) => (a[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === 'inventory')).toBe(true);
  });
});
