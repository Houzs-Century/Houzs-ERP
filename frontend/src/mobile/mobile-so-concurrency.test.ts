import { describe, expect, test, vi } from 'vitest';
import { confirmSoWithFreshVersion, uploadSoItemPhotoWithLease } from './mobile-so-concurrency';

describe('mobile SO concurrency callers', () => {
  test('bulk confirm reloads the row version and sends status + version CAS', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ salesOrder: { version: 7, status: 'DRAFT' } })
      .mockResolvedValueOnce({ salesOrder: { version: 8 } });
    await confirmSoWithFreshVersion('SO / 1', fetcher as never);
    expect(fetcher).toHaveBeenNthCalledWith(1, '/mfg-sales-orders/SO%20%2F%201');
    expect(fetcher).toHaveBeenNthCalledWith(2, '/mfg-sales-orders/SO%20%2F%201/status', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'CONFIRMED', expectedStatus: 'DRAFT', version: 7 }),
    });
  });

  test('missing version aborts before the status mutation', async () => {
    const fetcher = vi.fn().mockResolvedValue({ salesOrder: { status: 'DRAFT' } });
    await expect(confirmSoWithFreshVersion('SO-1', fetcher as never)).rejects.toThrow(/concurrency version/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('raw mobile photo upload carries the reserved lease token', async () => {
    const fetcher = vi.fn().mockResolvedValue({});
    const file = new File(['photo'], 'order.jpg', { type: 'image/jpeg' });
    await uploadSoItemPhotoWithLease('SO / 1', 'line / 2', file, 'lease-7', fetcher as never);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(fetcher.mock.calls[0]?.[0]).toBe('/mfg-sales-orders/SO%20%2F%201/items/line%20%2F%202/photos');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'X-SO-Edit-Lease': 'lease-7' });
    expect(init.body).toBeInstanceOf(FormData);
  });
});
