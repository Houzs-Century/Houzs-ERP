// Books › Stock close (GL redesign item 4, the owner's redesign batch 6 §3).
// Pinned: the stock now with its five closing stocks (g5) on the share bar's
// legend; every closed month split by bucket, a bucket booked nowhere hidden,
// how it was booked and until when the nightly run re-checks it; the run log's
// every outcome — the quiet "no change" rows included, which is the whole point
// of the log — with its Every run / Changes / Failed filter; Run now sends the
// chosen month (any month, through "Other month…") and says what it did.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type RunOpts = { onSuccess?: (r: { outcome: { action: string; valueSen?: number } }) => void };
const runMutate = vi.fn((_body: { month: string }, opts?: RunOpts) => {
  opts?.onSuccess?.({ outcome: { action: 'unchanged', valueSen: 7_301_432 } });
});
const runState = { isPending: false, isError: false, error: null as { message: string } | null };

const run = (over: Record<string, unknown>) => ({
  month: '2026-10', trigger: 'cron', stock_value_sen: 7_301_432, je_no: null, rev_je_no: null, note: null, ...over,
});

vi.mock('./accounting-phase1-queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useStockClose: () => ({
    isLoading: false, isError: false,
    data: {
      liveValueSen: 8_000_000,
      liveBuckets: { customer: 5_000_000, display: 2_000_000, service: 600_000, showroom: 400_000, others: 0 },
      defaultMonth: '2026-10',
      sweepMonths: ['2026-10', '2026-09'],
      runs: [
        run({ ran_at: '2026-11-02T16:05:00Z', action: 'unchanged', je_no: '2990-JE-2610-0388', rev_je_no: '2990-JE-2611-0002' }),
        run({ ran_at: '2026-11-01T09:12:00Z', trigger: 'manual', action: 'reposted', je_no: '2990-JE-2610-0388', rev_je_no: '2990-JE-2611-0002' }),
        run({ ran_at: '2026-10-31T16:05:00Z', action: 'posted', stock_value_sen: 7_297_952, je_no: '2990-JE-2610-0387', rev_je_no: '2990-JE-2611-0001' }),
        run({ month: '2026-09', ran_at: '2026-10-31T16:06:00Z', action: 'failed', stock_value_sen: 0, note: 'locked period' }),
      ],
      months: [
        { month: '2026-10', buckets: { customer: 4_900_000, display: 1_801_432, service: 600_000, showroom: 0, others: 0 }, totalSen: 7_301_432, action: 'reposted', bookedOn: '2026-11-01', jeNo: '2990-JE-2610-0388', revJeNo: '2990-JE-2611-0002' },
        { month: '2026-08', buckets: { customer: 6_000_000, display: 1_000_000, service: 0, showroom: 300_000, others: 0 }, totalSen: 7_300_000, action: 'posted', bookedOn: '2026-09-01', jeNo: '2990-JE-2608-0031', revJeNo: '2990-JE-2609-0002' },
      ],
    },
  }),
  useRunStockClose: () => ({ mutate: runMutate, ...runState }),
}));

import { StockCloseTab } from './StockClose';

const renderPage = () => render(<MemoryRouter initialEntries={['/scm/accounting?tab=close']}><StockCloseTab /></MemoryRouter>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T04:00:00Z'));
  runMutate.mockClear();
  Object.assign(runState, { isPending: false, isError: false, error: null });
});
afterEach(() => vi.useRealTimers());

const card = (name: string) => screen.getByRole('region', { name });
/** The card's table: DataTable title-cases its heads ("Closing Stock"). */
const grid = (name: string) => within(card(name)).getByRole('table');

describe('Books › Stock close', () => {
  test('the head names the page under Books, the nightly rule and the last run', () => {
    renderPage();
    expect(screen.getByText('Finance · Books')).toBeTruthy();
    expect(screen.getByText('Every night at 00:05 it re-checks the last two months · last run 2026/11/03 00:05 · no change')).toBeTruthy();
  });

  test('stock now: the total, when this month is booked, and the five closing stocks with shares that add up to 100', () => {
    renderPage();
    const now = card('Stock now');
    expect(within(now).getByText('Stock now · 2026/11/03')).toBeTruthy();
    expect(screen.getByText('RM 80,000.00')).toBeTruthy();
    expect(screen.getByText('November is booked on 2026/12/01 at 00:05 and re-checked every night until 2027/01/31')).toBeTruthy();
    for (const [name, share, amount] of [
      ['Customer stock', '63%', 'RM 50,000.00'], ['Display stock', '25%', 'RM 20,000.00'], ['Service stock', '7%', 'RM 6,000.00'],
      ['Showroom stock', '5%', 'RM 4,000.00'], ['Other stock', '0%', 'RM 0.00'],
    ]) {
      const name$ = within(now).getByText(name);
      expect(name$.textContent).toContain(share);
      expect(name$.parentElement?.textContent).toContain(amount);
    }
  });

  test('closed months: split by bucket, a bucket booked nowhere hidden, how it was booked and the nightly re-check', () => {
    renderPage();
    const months = grid('Closed months');
    for (const head of ['Month', 'Customer', 'Display', 'Service', 'Showroom', 'Closing Stock', 'Booked', 'Entry', 'Nightly Re-check']) {
      expect(within(months).getAllByText(head).length).toBeGreaterThan(0);
    }
    expect(within(months).queryByText('Others')).toBeNull();
    expect(within(months).getByText('October 2026')).toBeTruthy();
    expect(within(months).getByText('73,014.32')).toBeTruthy();
    expect(within(months).getByText('Re-posted 2026/11/01')).toBeTruthy();
    expect(within(months).getByText('Posted 2026/09/01')).toBeTruthy();
    expect(within(months).getByText('Until 2026/12/31')).toBeTruthy();
    expect(within(months).getByText('Ended 2026/10/31')).toBeTruthy();
  });

  test('every run, the quiet no-change ones included, filtered to the changes or the failures', () => {
    renderPage();
    const runs = () => grid('Every run');
    expect(within(runs()).getByText('No change')).toBeTruthy();
    expect(within(runs()).getByText('Re-posted')).toBeTruthy();
    expect(within(runs()).getByText('Posted')).toBeTruthy();
    expect(within(runs()).getByText('Failed')).toBeTruthy();
    expect(within(runs()).getByText('By hand')).toBeTruthy();
    expect(within(runs()).getAllByText('Nightly').length).toBe(3);
    expect(within(runs()).getByText('2990-JE-2610-0387 · reversal 2990-JE-2611-0001')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Changes/ }));
    expect(within(runs()).queryByText('No change')).toBeNull();
    expect(within(runs()).queryByText('Failed')).toBeNull();
    expect(within(runs()).getByText('Re-posted')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }));
    expect(within(runs()).getByText('locked period')).toBeTruthy();
    expect(within(runs()).queryByText('Posted')).toBeNull();
  });

  test('Run now sends the chosen month and says what it did', () => {
    renderPage();
    const select = screen.getByLabelText('Close month') as HTMLSelectElement;
    expect(select.value).toBe('2026-10');
    expect([...select.options].map((o) => o.textContent)).toEqual(['October 2026', 'September 2026', 'August 2026', 'Other month…']);
    fireEvent.change(select, { target: { value: '2026-09' } });
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    expect(runMutate).toHaveBeenCalledWith({ month: '2026-09' }, expect.anything());
    expect(screen.getByText('September 2026 checked · no change · RM 73,014.32')).toBeTruthy();
  });

  test('Other month… runs any month', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Close month'), { target: { value: 'other' } });
    const runNow = screen.getByRole('button', { name: /Run now/ }) as HTMLButtonElement;
    expect(runNow.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Other month'), { target: { value: '2026-05' } });
    fireEvent.click(runNow);
    expect(runMutate).toHaveBeenCalledWith({ month: '2026-05' }, expect.anything());
  });

  test('a refused run shows the server’s sentence', () => {
    Object.assign(runState, { isError: true, error: { message: 'May 2026 is locked.' } });
    renderPage();
    expect(screen.getByText('May 2026 is locked.')).toBeTruthy();
  });
});
