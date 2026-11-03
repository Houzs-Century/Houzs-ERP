/* PiBackfillCard — "Purchase invoices in the ledger", the owner-pressed door on
   the item-3 backfill, in the redesign (Finance-1a-Setup, batch 6 §6.2): dry
   run first, the write loop drains `remaining`, and a pass that completes
   NOTHING stops the loop with the failures on screen (no spinning on a wall
   of unbound groups). Server half: tests/piPeriodicBackfill.test.ts. */

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
const UNBOUND = 'SOFA is not bound to a purchase account for this company — bind it on Accounting → Item Groups, then post again.';

describe('the backfill card', () => {
  test('dry run shows the classified counts, the list, and arms Write', async () => {
    fetchMock.mockReset().mockResolvedValueOnce(DRY);
    render(<PiBackfillCard />);
    expect(screen.getByText('Purchase invoices in the ledger')).toBeTruthy();
    expect(screen.getByText('Dr each group’s purchase account, Cr Trade creditors. Dry run first; the write is yours.')).toBeTruthy();
    /* Nothing to write before the dry run has spoken. */
    expect(screen.queryByText(/^Write/)).toBeNull();
    fireEvent.click(screen.getByText('Dry run'));
    await waitFor(() => expect(screen.getByText(
      '1 missing (RM 1,000.00) · 1 to reshape (RM 500.00) · 3 already current. Nothing is written until you press Write.',
    )).toBeTruthy());
    expect(screen.getByText('PI-001')).toBeTruthy();
    expect(screen.getByText('PI-002')).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByText('Reshape')).toBeTruthy();
    expect((screen.getByText('Write 2') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Dry run again')).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/accounting/backfill/pi-periodic?dryRun=1');
  });

  test('the write loop drains remaining, marks each invoice written, then re-classifies for the after-state', async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(DRY)
      .mockResolvedValueOnce({ dryRun: false, processed: [{ invoiceNumber: 'PI-001', kind: 'missing', outcome: 'posted', jeNo: 'HC-JE-2610-0001' }], remaining: 1, summary: { attempted: 1, done: 1, failed: 0 } })
      .mockResolvedValueOnce({ dryRun: false, processed: [{ invoiceNumber: 'PI-002', kind: 'reshape', outcome: 'reshaped', jeNo: 'HC-JE-2610-0002' }], remaining: 0, summary: { attempted: 1, done: 1, failed: 0 } })
      .mockResolvedValueOnce({ dryRun: true, missing: [], reshape: [], current: 5 });
    render(<PiBackfillCard />);
    fireEvent.click(screen.getByText('Dry run'));
    await waitFor(() => expect(screen.getByText('Write 2')).toBeTruthy());
    fireEvent.click(screen.getByText('Write 2'));
    await waitFor(() => expect(screen.getByText('2 done · every purchase invoice is current now')).toBeTruthy());
    expect(screen.getAllByText('Written')).toHaveLength(2);
    expect(screen.getByText('HC-JE-2610-0002')).toBeTruthy();
    /* dry + two write passes + the refresh. */
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/accounting/backfill/pi-periodic?limit=25');
    /* Nothing left: no Write button on the after-state. */
    expect(screen.queryByText(/^Write \d/)).toBeNull();
  });

  test('a pass that completes nothing STOPS the loop and shows its failures', async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(DRY)
      .mockResolvedValueOnce({ dryRun: false, processed: [{ invoiceNumber: 'PI-001', kind: 'missing', outcome: 'failed', reason: UNBOUND }], remaining: 1, summary: { attempted: 1, done: 0, failed: 1 } })
      .mockResolvedValueOnce({ dryRun: true, missing: [{ invoiceNumber: 'PI-001', totalSen: 100000, kind: 'missing' }], reshape: [], current: 4 });
    render(<PiBackfillCard />);
    fireEvent.click(screen.getByText('Dry run'));
    await waitFor(() => expect(screen.getByText('Write 2')).toBeTruthy());
    fireEvent.click(screen.getByText('Write 2'));
    await waitFor(() => expect(screen.getByText(`0 done · 1 failed: ${UNBOUND}`)).toBeTruthy());
    /* The server's sentence also sits on the invoice's own row, which stays Missing. */
    expect(screen.getByText(UNBOUND).closest('tr')?.textContent).toContain('PI-001');
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.queryByText('Written')).toBeNull();
    /* dry + ONE write pass (stall guard) + the refresh — never a second write. */
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
