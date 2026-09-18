// The SO list's bar for ticked orders holding money: the money still on them,
// Refund and Convert over several orders of any customers (cancelled or live —
// a live order gives what is above its floor), and nothing at all while a
// ticked order has no money (a tick made to print is not a money question).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { ConvertSource } from '../../vendor/scm/lib/so-money-queries';

const { useOrdersWithMoney, navigateSpy, refundMutate, notifySpy } = vi.hoisted(() => ({
  useOrdersWithMoney: vi.fn(), navigateSpy: vi.fn(), refundMutate: vi.fn(), notifySpy: vi.fn(),
}));
vi.mock('../../vendor/scm/lib/so-money-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useOrdersWithMoney,
  useRequestRefunds: () => ({ mutateAsync: refundMutate, isPending: false }),
}));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useNavigate: () => navigateSpy }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => notifySpy }));

import { CancelledMoneyActions, sourcesOf } from './CancelledMoneyActions';

const WITH_MONEY: ConvertSource[] = [
  { docNo: '2990-SO-2607-024', customer: 'Yap Kah Heng', status: 'CANCELLED', cancelledOn: '2026-08-01', remainingSen: 336_500, bookedSen: 336_500, movableSen: 336_500, keepSen: 0 },
  { docNo: '2990-SO-2608-028', customer: 'Larding Chen', status: 'CANCELLED', cancelledOn: '2026-08-20', remainingSen: 143_300, bookedSen: 143_300, movableSen: 143_300, keepSen: 0 },
  /* A live order: RM 1,500 total, RM 1,000 on it, keeps 50% — RM 250 may move. */
  { docNo: '2990-SO-2609-060', customer: 'Lim Ah Lian', status: 'CONFIRMED', cancelledOn: null, remainingSen: 100_000, bookedSen: 100_000, movableSen: 25_000, keepSen: 75_000 },
];
const T = (docNo: string, status = 'CANCELLED', customer: string | null = null) => ({ docNo, status, customer });

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>
);

beforeEach(() => {
  useOrdersWithMoney.mockReturnValue({ data: { orders: WITH_MONEY, totalRemainingSen: 579_800 }, isLoading: false, isError: false });
  navigateSpy.mockReset(); refundMutate.mockReset(); notifySpy.mockReset();
});
afterEach(cleanup);

describe('sourcesOf', () => {
  it('keeps the ticked order in tick order and names the ones with nothing left', () => {
    expect(sourcesOf([T('2990-SO-2608-028'), T('2990-SO-2608-024'), T('2990-SO-2607-024')], WITH_MONEY)).toEqual({
      rows: [WITH_MONEY[1], WITH_MONEY[0]], without: ['2990-SO-2608-024'],
    });
  });
});

describe('CancelledMoneyActions', () => {
  it('shows nothing while a ticked order has no money on it, and nothing before the read is back', () => {
    render(wrap(<CancelledMoneyActions ticked={[T('2990-SO-2607-024'), T('2990-SO-2609-001', 'CONFIRMED')]} onDone={() => {}} />));
    expect(screen.queryByTestId('cancelled-money-bar')).toBeNull();
    expect(useOrdersWithMoney).toHaveBeenLastCalledWith(null, true);
    cleanup();
    useOrdersWithMoney.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(wrap(<CancelledMoneyActions ticked={[T('2990-SO-2607-024')]} onDone={() => {}} />));
    expect(screen.queryByTestId('cancelled-money-bar')).toBeNull();
  });

  it('two cancelled orders of two customers: the money on them, Convert opens the new order from the first ticked with both', () => {
    render(wrap(<CancelledMoneyActions ticked={[T('2990-SO-2608-028'), T('2990-SO-2607-024')]} onDone={() => {}} />));
    expect(screen.getByText('Cancelled orders')).toBeTruthy();
    expect(screen.getByText('RM 4,798.00 still on these 2 orders')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect((screen.getByLabelText('Take from 2990-SO-2608-028') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Take from 2990-SO-2607-024') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Larding Chen')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open a new order with RM 4,798\.00/ }));
    expect(navigateSpy).toHaveBeenCalledWith(`/scm/sales-orders/new?copyFrom=${encodeURIComponent('2990-SO-2608-028')}&convert=${encodeURIComponent('2990-SO-2608-028:143300,2990-SO-2607-024:336500')}`);
  });

  it('a live order beside a cancelled one: what still sits there and what may move; the picker takes only what is above the floor', () => {
    render(wrap(<CancelledMoneyActions ticked={[T('2990-SO-2609-060', 'CONFIRMED'), T('2990-SO-2608-028')]} onDone={() => {}} />));
    expect(screen.getByText('Money on these orders')).toBeTruthy();
    expect(screen.getByText('RM 2,433.00 still on these 2 orders · RM 1,683.00 can move')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(screen.getByText('RM 250.00 can move (keeps RM 750.00)')).toBeTruthy();
    expect((screen.getByLabelText('Amount from 2990-SO-2609-060') as HTMLInputElement).value).toBe('250.00');
    fireEvent.click(screen.getByRole('button', { name: /Open a new order with RM 1,683\.00/ }));
    expect(navigateSpy).toHaveBeenCalledWith(`/scm/sales-orders/new?copyFrom=${encodeURIComponent('2990-SO-2609-060')}&convert=${encodeURIComponent('2990-SO-2609-060:25000,2990-SO-2608-028:143300')}`);
  });

  it('Refund raises one draft per ticked order with one note, then clears the ticks', async () => {
    refundMutate.mockResolvedValue([{ docNo: '2990-SO-2608-028', pvNumber: '2990Draft-2609-010' }, { docNo: '2990-SO-2607-024', pvNumber: '2990Draft-2609-011' }]);
    const onDone = vi.fn();
    render(wrap(<CancelledMoneyActions ticked={[T('2990-SO-2608-028'), T('2990-SO-2607-024')]} onDone={onDone} />));
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    const first = screen.getByLabelText('Refund from 2990-SO-2608-028') as HTMLInputElement;
    fireEvent.change(first, { target: { value: '433.00' } });
    fireEvent.blur(first);
    fireEvent.change(screen.getByLabelText('Refund note'), { target: { value: 'Customer changed her mind' } });
    fireEvent.click(screen.getByRole('button', { name: 'Raise 2 refund drafts' }));
    await waitFor(() => expect(refundMutate).toHaveBeenCalledWith([
      { docNo: '2990-SO-2608-028', amountSen: 43_300, note: 'Customer changed her mind' },
      { docNo: '2990-SO-2607-024', amountSen: 336_500, note: 'Customer changed her mind' },
    ]));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({ title: '2 refund drafts raised for Finance' }));
  });

  it('a live order at its floor can still be refunded (no floor there) but has nothing to convert', () => {
    useOrdersWithMoney.mockReturnValue({ data: { orders: [{ ...WITH_MONEY[2]!, movableSen: 0, keepSen: 100_000 }], totalRemainingSen: 100_000 }, isLoading: false, isError: false });
    render(wrap(<CancelledMoneyActions ticked={[T('2990-SO-2609-060', 'CONFIRMED')]} onDone={() => {}} />));
    expect(screen.getByText('RM 1,000.00 still on this order · RM 0.00 can move')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Refund' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Convert' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
