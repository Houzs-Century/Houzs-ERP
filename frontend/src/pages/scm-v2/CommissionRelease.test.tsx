// Books › Commission release (owner 2026-11-25). Made-up figures. Pinned:
// the head under Books saying whether the release is on; what the prepayment
// holds bill by bill — how each is split over its orders, released and left,
// with a total; a bill's orders under it on a click; every month's release
// against what is booked and what the month is waiting for; off, Turn on asks
// first — naming every month it will book — and only then switches it on;
// on, Run now runs and says what changed.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const confirmMock = vi.fn(async (_opts: { title: string; body?: unknown }) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmMock }));

type Outcome = { month: string; action: string; releasedSen: number };
const runMutate = vi.fn((_v: undefined, opts?: { onSuccess?: (r: { outcomes: Outcome[] }) => void }) => {
  opts?.onSuccess?.({ outcomes: [{ month: '2026-10', action: 'reposted', releasedSen: 1 }, { month: '2026-09', action: 'unchanged', releasedSen: 1 }] });
});
const switchMutate = vi.fn((_on: boolean, opts?: { onSuccess?: (r: { ok: boolean; on: boolean; outcomes: Outcome[] }) => void }) => {
  opts?.onSuccess?.({ ok: true, on: true, outcomes: [{ month: '2026-09', action: 'posted', releasedSen: 1 }, { month: '2026-10', action: 'posted', releasedSen: 1 }] });
});
const ordersQuery = vi.fn((_layer: string | null) => ({ isLoading: false, isError: false, data: undefined as unknown }));

let on = false;
const status = () => ({
  on,
  booksStart: '2026-09',
  currentMonth: '2026-11',
  lastMonth: '2026-10',
  accounts: { prepaid: { code: '360-0050', name: 'PREPAYMENT COMMISSION' }, expense: { code: '900-C003', name: 'COMMISSION ( EVENT )' } },
  prepaid: [
    { month: null, amountSen: 500_000, docNo: 'OPEN-1', jeNo: 'JE-1', entryDate: '2026-08-31', sourceType: 'OPENING', notes: 'B/F', monthGuessed: false },
    { month: '2026-10', amountSen: 300_000, docNo: 'API-10', jeNo: 'JE-2', entryDate: '2026-10-31', sourceType: 'API', notes: "PAYROLL OCT'26", monthGuessed: false },
  ],
  layers: [
    { key: 'bill:2026-10', month: '2026-10', amountSen: 300_000, docs: ['API-10'], basis: 'close', orders: 12, fromMonth: '2026-10', byMonth: [{ month: '2026-10', sen: 40_000 }, { month: '2026-11', sen: 60_000 }], releasedSen: 100_000, leftSen: 200_000, note: null },
    { key: 'opening', month: null, amountSen: 500_000, docs: ['OPEN-1'], basis: 'goods', orders: 40, fromMonth: '2026-09', byMonth: [{ month: '2026-09', sen: 70_000 }, { month: '2026-10', sen: 30_000 }], releasedSen: 100_000, leftSen: 400_000, note: 'No per-order breakdown.' },
  ],
  months: [
    { month: '2026-09', totalSen: 70_000, parts: [{ key: 'opening', sen: 70_000 }] },
    { month: '2026-10', totalSen: 70_000, parts: [{ key: 'bill:2026-10', sen: 40_000 }, { key: 'opening', sen: 30_000 }] },
    { month: '2026-11', totalSen: 60_000, parts: [{ key: 'bill:2026-10', sen: 60_000 }] },
  ],
  posted: on ? [{ month: '2026-09', jeNo: 'JE-2609-0900', releasedSen: 70_000, reposted: false, bookedOn: '2026-11-25' }, { month: '2026-10', jeNo: 'JE-2610-0900', releasedSen: 65_000, reposted: false, bookedOn: '2026-11-25' }] : [],
  runs: on ? [{ month: '2026-10-01', ran_at: '2026-11-24T16:05:00Z', trigger: 'cron', released_sen: 65_000, action: 'posted', je_no: 'JE-2610-0900', note: null }] : [],
});

vi.mock('./commission-release-queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCommissionRelease: () => ({ isLoading: false, isError: false, data: status() }),
  useCommissionReleaseOrders: (layer: string | null) => ordersQuery(layer),
  useRunCommissionRelease: () => ({ mutate: runMutate, isPending: false, isError: false, error: null }),
  useCommissionReleaseSwitch: () => ({ mutate: switchMutate, isPending: false, isError: false, error: null }),
}));

import { CommissionReleaseTab, monthState } from './CommissionRelease';

const renderPage = () => render(<MemoryRouter initialEntries={['/scm/accounting?tab=commrel']}><CommissionReleaseTab /></MemoryRouter>);
const card = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T04:00:00Z'));
  on = false;
  confirmMock.mockClear();
  runMutate.mockClear();
  switchMutate.mockClear();
  ordersQuery.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('Books › Commission release', () => {
  test('the head names the page under Books and says the release is off', () => {
    renderPage();
    expect(screen.getByText('Finance · Books')).toBeTruthy();
    expect(screen.getByText('Commission release')).toBeTruthy();
    expect(screen.getByText('Off · nothing is booked — below is what it would book')).toBeTruthy();
    expect(within(card('Prepayment now')).getByText('Commission bills on 360-0050 PREPAYMENT COMMISSION')).toBeTruthy();
    expect(within(card('Prepayment now')).getByText('RM 8,000.00')).toBeTruthy();
  });

  test('what the prepayment holds: each bill, how it is split, released and left, with a total', () => {
    renderPage();
    const bills = card('Bills');
    const row = (name: string) => within(bills).getByText(name).closest('tr')!;
    expect(within(row('October 2026 bill')).getByText('Event Commission close')).toBeTruthy();
    expect(within(row('October 2026 bill')).getByText('2,000.00')).toBeTruthy();
    expect(within(row('Opening balance')).getByText('Goods of the orders')).toBeTruthy();
    expect(within(row('Opening balance')).getByText('4,000.00')).toBeTruthy();
    expect(within(bills).getByText('6,000.00')).toBeTruthy();
  });

  test('a click on a bill shows its orders under it', () => {
    ordersQuery.mockImplementation((layer) => ({
      isLoading: false, isError: false,
      data: layer ? { layer, through: '2026-11', orders: [{ docNo: 'SO-1', soDate: '2026-10-02', status: 'CONFIRMED', totalSen: 400_000, shareSen: 50_000, sold: 0.5, releasedSen: 25_000, leftSen: 25_000 }] } : undefined,
    }));
    renderPage();
    fireEvent.click(within(card('Bills')).getByText('October 2026 bill'));
    const orders = card('Orders of the bill');
    expect(within(orders).getByText('October 2026 bill — its orders')).toBeTruthy();
    expect(within(orders).getByText('SO-1')).toBeTruthy();
    expect(within(orders).getByText('50%')).toBeTruthy();
    expect(ordersQuery).toHaveBeenLastCalledWith('bill:2026-10');
  });

  test('month by month: what each month releases, made of which bills, and what it waits for', () => {
    renderPage();
    const months = card('Month by month');
    const row = (name: string) => within(months).getByText(name).closest('tr')!;
    expect(within(row('October 2026')).getByText('October 2026 bill 400.00 · Opening balance 300.00')).toBeTruthy();
    expect(within(row('October 2026')).getByText('Not booked — release is off')).toBeTruthy();
    expect(within(row('November 2026')).getByText('Books on 2026/12/01')).toBeTruthy();
  });

  test('off: Turn on asks first, naming every month it will book, then switches it on', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Turn on/ }));
    await waitFor(() => expect(switchMutate).toHaveBeenCalledWith(true, expect.anything()));
    const opts = confirmMock.mock.calls[0]![0];
    expect(opts.title).toBe('Turn on the monthly commission release?');
    expect(String(opts.body)).toContain('September 2026: 700.00');
    expect(String(opts.body)).toContain('October 2026: 700.00');
    expect(String(opts.body)).not.toContain('November 2026');
    expect(String(opts.body)).toContain('Dr 900-C003 COMMISSION ( EVENT ) / Cr 360-0050 PREPAYMENT COMMISSION');
  });

  test('off: a Turn on refused at the question switches nothing', async () => {
    confirmMock.mockResolvedValueOnce(false);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Turn on/ }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(switchMutate).not.toHaveBeenCalled();
  });

  test('on: the booked months, a month that moved, and Run now', () => {
    on = true;
    renderPage();
    expect(screen.getByText(/^On · every night at 00:05 it books the month that has ended · last run/)).toBeTruthy();
    const months = card('Month by month');
    const row = (name: string) => within(months).getByText(name).closest('tr')!;
    expect(within(row('September 2026')).getByText('Booked')).toBeTruthy();
    expect(within(row('October 2026')).getByText('Changes tonight')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    expect(runMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Checked · 1 month(s) changed')).toBeTruthy();
  });

  test('the month states, one by one', () => {
    const at = { on: true, currentMonth: '2026-11' };
    const m = (over: Partial<Parameters<typeof monthState>[0]>) => ({ month: '2026-10', totalSen: 100, parts: [], bookedSen: 100, jeNo: 'JE', reposted: false, ...over });
    expect(monthState(m({}), at).label).toBe('Booked');
    expect(monthState(m({ reposted: true }), at).label).toBe('Booked (re-posted)');
    expect(monthState(m({ bookedSen: null }), at).label).toBe('Books tonight');
    expect(monthState(m({ bookedSen: null, totalSen: 0 }), at).label).toBe('Nothing to release');
    expect(monthState(m({ bookedSen: 90 }), { ...at, on: false }).label).toBe('Differs — release is off');
  });
});
