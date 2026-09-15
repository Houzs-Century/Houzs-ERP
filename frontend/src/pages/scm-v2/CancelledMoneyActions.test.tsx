// The SO list's bar for ticked cancelled orders: the money still on them,
// Refund and Convert over several orders of any customers, a ticked order
// with no money blocks both and is named, a mixed selection shows nothing.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { ConvertSource } from '../../vendor/scm/lib/so-money-queries';

const { useCancelledWithMoney, navigateSpy, refundMutate, notifySpy } = vi.hoisted(() => ({
  useCancelledWithMoney: vi.fn(), navigateSpy: vi.fn(), refundMutate: vi.fn(), notifySpy: vi.fn(),
}));
vi.mock('../../vendor/scm/lib/so-money-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCancelledWithMoney,
  useRequestRefunds: () => ({ mutateAsync: refundMutate, isPending: false }),
}));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useNavigate: () => navigateSpy }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => notifySpy }));

import { CancelledMoneyActions, sourcesOf } from './CancelledMoneyActions';

const WITH_MONEY: ConvertSource[] = [
  { docNo: '2990-SO-2607-024', customer: 'Yap Kah Heng', cancelledOn: '2026-08-01', remainingSen: 336_500, bookedSen: 336_500 },
  { docNo: '2990-SO-2608-028', customer: 'Larding Chen', cancelledOn: '2026-08-20', remainingSen: 143_300, bookedSen: 143_300 },
];
const T = (docNo: string, status = 'CANCELLED', customer: string | null = null) => ({ docNo, status, customer });

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>
);

beforeEach(() => {
  useCancelledWithMoney.mockReturnValue({ data: { orders: WITH_MONEY, totalRemainingSen: 479_800 }, isLoading: false, isError: false });
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
  it('shows nothing unless every ticked order is cancelled', () => {
    render(wrap(<CancelledMoneyActions ticked={[T('2990-SO-2607-024'), T('2990-SO-2609-001', 'CONFIRMED')]} onDone={() => {}} />));
    expect(screen.queryByTestId('cancelled-money-bar')).toBeNull();
    expect(useCancelledWithMoney).toHaveBeenLastCalledWith(null, false);
  });

  it('two cancelled orders of two customers: the money on them, Convert opens the new order from the first ticked with both', () => {
    render(wrap(<CancelledMoneyActions ticked={[T('2990-SO-2608-028'), T('2990-SO-2607-024')]} onDone={() => {}} />));
    expect(screen.getByText('RM 4,798.00 still on these 2 orders')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect((screen.getByLabelText('Take from 2990-SO-2608-028') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Take from 2990-SO-2607-024') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Larding Chen')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open a new order with RM 4,798\.00/ }));
    expect(navigateSpy).toHaveBeenCalledWith(`/scm/sales-orders/new?copyFrom=${encodeURIComponent('2990-SO-2608-028')}&convert=${encodeURIComponent('2990-SO-2608-028:143300,2990-SO-2607-024:336500')}`);
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

  it('a ticked cancelled order with nothing left blocks both buttons and is named', () => {
    render(wrap(<CancelledMoneyActions ticked={[T('2990-SO-2607-024'), T('2990-SO-2608-024')]} onDone={() => {}} />));
    expect(screen.getByText('2990-SO-2608-024 has no money on it')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Refund' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Convert' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
