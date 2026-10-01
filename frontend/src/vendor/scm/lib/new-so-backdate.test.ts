import { beforeEach, describe, expect, it, vi } from 'vitest';

const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
let failNext = false;
vi.mock('./authed-fetch', () => ({
  authedFetch: async (url: string, init: { body: string }) => {
    if (failNext) { failNext = false; throw new Error('Server refused'); }
    posted.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return {};
  },
}));

const { isBackdateRequestRow, askNewSoBackdateReason, sendNewSoBackdateRequests } = await import('./new-so-backdate');
const { todayMyt } = await import('./dates');
const { shiftIsoDay } = await import('./payment-slip-date');
const { CONVERT_LABEL } = await import('./so-money-queries');

/* Owner 2026-10-01 — a too-old payment on the NEW Sales Order goes to an admin
   as a request instead of blocking the save. */
describe('new SO backdate requests', () => {
  const old = shiftIsoDay(todayMyt(), -20);
  beforeEach(() => { posted.length = 0; failNext = false; });

  it('only a too-old, hand-keyed row is a request', () => {
    expect(isBackdateRequestRow({ paidAt: old, methodLabel: 'Cash', receiptBacked: false }, false)).toBe(true);
    expect(isBackdateRequestRow({ paidAt: todayMyt(), methodLabel: 'Cash', receiptBacked: false }, false)).toBe(false);
    expect(isBackdateRequestRow({ paidAt: shiftIsoDay(todayMyt(), 3), methodLabel: 'Cash', receiptBacked: false }, false)).toBe(false);
    expect(isBackdateRequestRow({ paidAt: old, methodLabel: 'Cash', receiptBacked: true }, false)).toBe(false);
    expect(isBackdateRequestRow({ paidAt: old, methodLabel: CONVERT_LABEL, receiptBacked: false }, false)).toBe(false);
    expect(isBackdateRequestRow({ paidAt: old, methodLabel: 'Cash', receiptBacked: false }, true)).toBe(false);
  });

  it('asks the reason only when a row needs it; a dismissed ask stops the save', async () => {
    const prompt = vi.fn(async () => 'late slip');
    expect(await askNewSoBackdateReason(prompt, 0)).toBe('');
    expect(prompt).not.toHaveBeenCalled();
    expect(await askNewSoBackdateReason(prompt, 2)).toBe('late slip');
    expect(await askNewSoBackdateReason(vi.fn(async () => null), 1)).toBeNull();
  });

  it('posts each row to the request route with the reason, and reports failures', async () => {
    const notify = vi.fn();
    await sendNewSoBackdateRequests('SO-1', [{ amountSen: 100 }, { amountSen: 200 }], 'late slip', notify);
    expect(posted.map((p) => p.url)).toEqual(['/mfg-sales-orders/SO-1/payment-backdate-requests', '/mfg-sales-orders/SO-1/payment-backdate-requests']);
    expect(posted[0]!.body).toEqual({ amountSen: 100, reason: 'late slip' });
    expect(notify.mock.calls[0]![0]).toMatchObject({ title: '2 payments sent for admin approval' });
    failNext = true;
    await sendNewSoBackdateRequests('SO-1', [{ amountSen: 100 }], 'x', notify);
    expect(notify.mock.calls[1]![0]).toMatchObject({ tone: 'error' });
  });
});
