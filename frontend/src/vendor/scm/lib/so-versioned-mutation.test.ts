import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));

import { authedFetch } from './authed-fetch';
import { runSoVersionedMutation } from './so-versioned-mutation';

const mockedFetch = vi.mocked(authedFetch);

const queryClient = () => {
  const qc = new QueryClient();
  qc.setQueryData(['mfg-sales-order-detail', 'SO-1'], {
    salesOrder: { doc_no: 'SO-1', version: 7 },
    items: [],
  });
  return qc;
};

describe('standalone SO versioned mutation coordinator', () => {
  /* BRACES, not a concise arrow. `mockReset()` returns the mock, and vitest
     calls a function returned from beforeEach as that test's TEARDOWN — so
     `beforeEach(() => mockedFetch.mockReset())` makes vitest invoke authedFetch
     once after every test in this file. It is harmless here only because every
     test arms `...Once` implementations, which its own calls consume, so the
     teardown call finds an empty mock and returns undefined. Arm a plain
     `mockRejectedValue` and the teardown's rejection fails the test with an
     error thrown from nowhere the test can see. Proven 2026-08-15 while writing
     autoCountSync.test.tsx; see BUG-HISTORY. */
  beforeEach(() => { mockedFetch.mockReset(); });

  test('reserves from the loaded version, sends the action under that lease, then releases', async () => {
    mockedFetch
      .mockResolvedValueOnce({ version: 8, leaseToken: 'lease-from-server' })
      .mockResolvedValueOnce({ ok: true });
    const action = vi.fn(async ({ leaseToken }: { leaseToken: string }) => ({ leaseToken }));

    const result = await runSoVersionedMutation(queryClient(), 'SO-1', 'photo-upload', action);

    expect(result).toEqual({ leaseToken: 'lease-from-server' });
    expect(action).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(mockedFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      version: 7,
      reserveLineWrites: true,
    });
    expect(JSON.parse(String(mockedFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      version: 8,
      completeLineWrites: true,
      lineWriteLeaseToken: 'lease-from-server',
    });
  });

  test('a reservation conflict sends zero action writes and leaves caller input untouched', async () => {
    const conflict = Object.assign(new Error('conflict'), { status: 409 });
    mockedFetch.mockRejectedValueOnce(conflict);
    const draft = { reason: 'customer approved this exact override' };
    const action = vi.fn();

    await expect(runSoVersionedMutation(queryClient(), 'SO-1', 'price-override', action))
      .rejects.toBe(conflict);

    expect(action).not.toHaveBeenCalled();
    expect(draft).toEqual({ reason: 'customer approved this exact override' });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  /* Owner 2026-08-31: 「但我 edit 了之后，我 upload 的一些照片好像都会出现这样子的
     问题」 — the second photo of a batch answered "Someone else updated this
     order while you were editing" with nobody else involved.

     The reservation ITSELF advances the version (the header CAS bumps it), and
     the detail cache is only INVALIDATED afterwards — invalidation marks the
     entry, it does not erase it, so the next upload read the same number back
     and reserved against a version the server had already left behind. The
     order's own edits had done the same thing one step earlier. */
  test('a second line mutation reserves from the version the first one advanced to', async () => {
    const qc = queryClient();
    mockedFetch
      .mockResolvedValueOnce({ version: 8, leaseToken: 'lease-1' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ version: 9, leaseToken: 'lease-2' })
      .mockResolvedValueOnce({ ok: true });

    await runSoVersionedMutation(qc, 'SO-1', 'photo-upload', async () => ({}));
    await runSoVersionedMutation(qc, 'SO-1', 'photo-upload', async () => ({}));

    expect(mockedFetch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(mockedFetch.mock.calls[0]?.[1]?.body))).toMatchObject({ version: 7 });
    expect(JSON.parse(String(mockedFetch.mock.calls[2]?.[1]?.body))).toMatchObject({ version: 8 });
  });

  test('an action failure is rethrown after a best-effort matching release', async () => {
    mockedFetch
      .mockResolvedValueOnce({ version: 8, leaseToken: 'lease-from-server' })
      .mockResolvedValueOnce({ ok: true });
    const failed = new Error('upload failed');

    await expect(runSoVersionedMutation(queryClient(), 'SO-1', 'photo-upload', async () => {
      throw failed;
    })).rejects.toBe(failed);

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
