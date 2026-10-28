// docs/bugs/0936-a-save-that-reported-success-left-the-order-s-lock-behind-so.md
// Owner 2026-09-15: 「我 save 了就 save 了啊，然后如果我要一瞬间再 edit 第二次也是可以的啊」.
// A Save used to report done while the order's re-read was still on the wire.
// Pressing Edit in that window opened the editor on the
// PRE-save copy still in the cache: its pinned version was already superseded,
// so the next Save was refused as "opened with an older screen" with nobody else
// involved. The Save's own callback now waits for that re-read.
// authed-fetch is mocked at the module seam (sales-order-queries.paged-enabled.test.tsx).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({
  authedFetch: vi.fn(),
  API_URL: 'http://test.local/api/scm',
  humanApiError: (e: unknown) => String(e),
}));
vi.mock('./mutation-error', () => ({ writeFailed: () => {}, writeFailedAs: () => () => {} }));

import { authedFetch } from './authed-fetch';
import { useMfgSalesOrderDetail, useUpdateMfgSalesOrderHeader } from './sales-order-queries';

const mockedFetch = vi.mocked(authedFetch);
const DETAIL = ['mfg-sales-order-detail', 'SO-1'];

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(DETAIL, { salesOrder: { doc_no: 'SO-1', version: 14 }, items: [] });
  const reads: Array<(body: unknown) => void> = [];
  /* PATCHes answer at once; each detail GET waits until the test releases it. */
  const fakeFetch = (_path: string, init?: RequestInit): Promise<unknown> => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(body.reserveLineWrites
        ? { ok: true, docNo: 'SO-1', version: 15, reserved: true }
        : { ok: true, docNo: 'SO-1', version: 15, released: true });
    }
    return new Promise((resolve) => { reads.push(resolve); });
  };
  mockedFetch.mockImplementation(fakeFetch as typeof authedFetch);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => ({ detail: useMfgSalesOrderDetail('SO-1'), save: useUpdateMfgSalesOrderHeader() }),
    { wrapper },
  );
  const cachedVersion = () =>
    (qc.getQueryData(DETAIL) as { salesOrder?: { version?: number } } | undefined)?.salesOrder?.version;
  return { result, reads, cachedVersion };
}

const patched = () => mockedFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');

beforeEach(() => { mockedFetch.mockReset(); });

describe('a finished Save hands back the order it produced', () => {
  test('the Save callback runs only once the re-read carries the saved version', async () => {
    const { result, reads, cachedVersion } = setup();
    let seenBySave: number | undefined | 'not yet';
    seenBySave = 'not yet';

    act(() => {
      result.current.save.mutate(
        { docNo: 'SO-1', completeLineWrites: true, lineWriteLeaseToken: 'lease-token-0123456789', version: 15 },
        { onSuccess: () => { seenBySave = cachedVersion(); } },
      );
    });
    await waitFor(() => expect(reads.length).toBe(1));
    expect(patched()).toBe(true);
    expect(seenBySave).toBe('not yet');

    await act(async () => { reads[0]!({ salesOrder: { doc_no: 'SO-1', version: 15 }, items: [] }); });

    await waitFor(() => expect(seenBySave).toBe(15));
  });

  test('taking the lease does not wait for, or trigger, a re-read', async () => {
    const { result, reads } = setup();

    let answered = false;
    await act(async () => {
      await result.current.save.mutateAsync({
        docNo: 'SO-1', reserveLineWrites: true, lineWriteLeaseToken: 'lease-token-0123456789', version: 14,
      });
      answered = true;
    });

    expect(answered).toBe(true);
    expect(reads.length).toBe(0);
  });
});
