/* PiBackfillCard — the owner-pressed door on the item-3 backfill: dry run
   first, the write loop drains `remaining`, and a pass that completes
   NOTHING stops the loop with the failures on screen (no spinning on a
   wall of unbound groups). Server half: tests/piPeriodicBackfill.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: (path: string, init?: RequestInit) => fetchMock(path, init),
}));

import { PiBackfillCard } from './PiBackfill';

const DRY = {
  dryRun: true,
  missing: [{ invoiceNumber: 'PI-001', totalSen: 100000, kind: 'missing' }],
  reshape: [{ invoiceNumber: 'PI-002', totalSen: 50000, kind: 'reshape' }],
  current: 3,
};

describe('the backfill card', () => {
  test('dry run shows the classified counts and arms the write button', async () => {
    fetchMock.mockReset().mockResolvedValueOnce(DRY);
    render(<PiBackfillCard />);
    const writeBtn = screen.getByText('执行写入') as HTMLButtonElement;
    expect(writeBtn.disabled).toBe(true);
    fireEvent.click(screen.getByText('Dry run'));
    await waitFor(() => expect(screen.getByText(/already current/)).toBeTruthy());
    expect(screen.getByText('PI-001')).toBeTruthy();
    expect(screen.getByText('PI-002')).toBeTruthy();
    expect((screen.getByText('执行写入 (2)') as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/accounting/backfill/pi-periodic?dryRun=1');
  });

  test('the write loop drains remaining, then re-classifies for the after-state', async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(DRY)
      .mockResolvedValueOnce({ dryRun: false, processed: [{ invoiceNumber: 'PI-001', kind: 'missing', outcome: 'posted' }], remaining: 1, summary: { attempted: 1, done: 1, failed: 0 } })
      .mockResolvedValueOnce({ dryRun: false, processed: [{ invoiceNumber: 'PI-002', kind: 'reshape', outcome: 'reshaped' }], remaining: 0, summary: { attempted: 1, done: 1, failed: 0 } })
      .mockResolvedValueOnce({ dryRun: true, missing: [], reshape: [], current: 5 });
    render(<PiBackfillCard />);
    fireEvent.click(screen.getByText('Dry run'));
    await waitFor(() => expect(screen.getByText('执行写入 (2)')).toBeTruthy());
    fireEvent.click(screen.getByText('执行写入 (2)'));
    await waitFor(() => expect(screen.getByText(/账已齐/)).toBeTruthy());
    expect(screen.getByText(/写入结果/)).toBeTruthy();
    /* dry + two write passes + the refresh. */
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/accounting/backfill/pi-periodic?limit=25');
  });

  test('a pass that completes nothing STOPS the loop and shows its failures', async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(DRY)
      .mockResolvedValueOnce({ dryRun: false, processed: [{ invoiceNumber: 'PI-001', kind: 'missing', outcome: 'failed', reason: 'group_unbound: SOFA' }], remaining: 1, summary: { attempted: 1, done: 0, failed: 1 } })
      .mockResolvedValueOnce({ dryRun: true, missing: [{ invoiceNumber: 'PI-001', totalSen: 100000, kind: 'missing' }], reshape: [], current: 4 });
    render(<PiBackfillCard />);
    fireEvent.click(screen.getByText('Dry run'));
    await waitFor(() => expect(screen.getByText('执行写入 (2)')).toBeTruthy());
    fireEvent.click(screen.getByText('执行写入 (2)'));
    await waitFor(() => expect(screen.getByText(/1 failed/)).toBeTruthy());
    expect(screen.getByText(/group_unbound: SOFA/)).toBeTruthy();
    /* dry + ONE write pass (stall guard) + the refresh — never a second write. */
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
