// The other-debtor bill create posts a document with its journal, so a double
// press must reach the server under one Idempotency-Key (lib/idempotency.ts).
// authed-fetch is mocked at the module seam (accounting-queries-gl.test.tsx).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('./mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from './authed-fetch';
import { useCreateDebtorBill } from './accounting-queries';
import { useIdempotencyKeyFor } from '../../../lib/idempotency';

const mockedFetch = vi.mocked(authedFetch);
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => { mockedFetch.mockReset(); });

describe('useCreateDebtorBill — the Idempotency-Key', () => {
  test('the key goes out as the header, not in the body', async () => {
    mockedFetch.mockResolvedValue({ ok: true, bill: { id: 'b1', billNumber: 'HC-ODB-2611-001', totalSen: 100 } });
    const { result } = renderHook(() => useCreateDebtorBill(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ debtorId: 'deb-1', idempotencyKey: 'form-key-1', lines: [{ amountSen: 100 }] });
    });
    const [path, init] = mockedFetch.mock.calls[0];
    expect(path).toBe('/other-debtors/deb-1/bills');
    expect(new Headers((init as RequestInit).headers).get('Idempotency-Key')).toBe('form-key-1');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).not.toHaveProperty('idempotencyKey');
    expect(body).not.toHaveProperty('debtorId');
  });

  test('one form keeps its key; the next form opened gets a new one', () => {
    const { result, rerender } = renderHook(({ intent }) => useIdempotencyKeyFor(intent), { initialProps: { intent: 'new:new:INV' } });
    const first = result.current;
    rerender({ intent: 'new:new:INV' });
    expect(result.current).toBe(first);
    rerender({ intent: 'copy:b1:INV' });
    expect(result.current).not.toBe(first);
  });
});
