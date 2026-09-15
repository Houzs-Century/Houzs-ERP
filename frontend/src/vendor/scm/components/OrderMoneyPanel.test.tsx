// The money panel on a cancelled Sales Order (owner 2026-09-15; docs/bugs/0931):
// paid · refunded · moved · remaining, and the two exits side by side.
//
// Pinned: nothing for a live order; the figures and the two buttons for a
// cancelled one with money left; Refund raises the voucher draft with the
// amount and the note; Convert lists this order (ticked) and the customer's
// other cancelled orders (unticked), each for what is left, and opens the New
// SO page with the customer copied and one converted row per tick; a
// spent order shows why the buttons are gone.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { ConvertSource, OrderMoney } from '../lib/so-money-queries';

const { useOrderMoney, mutateAsync, navigateSpy, notifySpy } = vi.hoisted(() => ({
  useOrderMoney: vi.fn(), mutateAsync: vi.fn(), navigateSpy: vi.fn(), notifySpy: vi.fn(),
}));
vi.mock('../lib/so-money-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useOrderMoney,
  useRequestRefund: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useNavigate: () => navigateSpy }));
vi.mock('./NotifyDialog', () => ({ useNotify: () => notifySpy }));

import { OrderMoneyPanel, moneySummary } from './OrderMoneyPanel';

const OLD = '2990-SO-2607-010';
const money = (over: Partial<OrderMoney> = {}): OrderMoney => ({
  docNo: OLD, status: 'CANCELLED', cancelled: true,
  customer: { name: 'Ah Meng', phone: '0123', customerId: 'cust-1', debtorCode: null },
  payments: [], bookedSen: 70_000, refunds: [], refundedSen: 0, conversions: [], convertedSen: 0, remainingSen: 70_000,
  open: true, reason: null, ...over,
});
const OTHERS: ConvertSource[] = [{ docNo: '2990-SO-2607-024', customer: 'Ah Meng', cancelledOn: '2026-08-01', remainingSen: 30_000, bookedSen: 30_000 }];

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);

beforeEach(() => {
  mutateAsync.mockReset(); navigateSpy.mockReset(); notifySpy.mockReset();
  useOrderMoney.mockReturnValue({ data: { money: money(), others: OTHERS }, isError: false });
});
afterEach(cleanup);

describe('moneySummary', () => {
  it('names only the figures that are there', () => {
    expect(moneySummary(money())).toBe('Paid RM 700.00 · Remaining RM 700.00');
    expect(moneySummary(money({ refundedSen: 40_000, convertedSen: 30_000, remainingSen: 0 }))).toBe('Paid RM 700.00 · Refunded RM 400.00 · Moved RM 300.00 · Remaining RM 0.00');
  });
});

describe('OrderMoneyPanel', () => {
  it('renders nothing for a live order, and nothing when the read failed', () => {
    useOrderMoney.mockReturnValue({ data: { money: money({ cancelled: false, status: 'CONFIRMED', open: false }), others: [] }, isError: false });
    const { container } = render(wrap(<OrderMoneyPanel docNo={OLD} />));
    expect(container.firstChild).toBeNull();
    useOrderMoney.mockReturnValue({ data: undefined, isError: true });
    const failed = render(wrap(<OrderMoneyPanel docNo={OLD} />));
    expect(failed.container.firstChild).toBeNull();
  });

  it('a cancelled order with money: the figures, then Refund and Convert side by side', () => {
    render(wrap(<OrderMoneyPanel docNo={OLD} />));
    expect(screen.getByText('Money on this cancelled order')).toBeTruthy();
    expect(screen.getByText('Paid RM 700.00 · Remaining RM 700.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refund' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeTruthy();
  });

  it('Refund: the amount (part or all) and the note go to the voucher draft', async () => {
    mutateAsync.mockResolvedValue({ id: 'pv1', pvNumber: '2990Draft-2609-003' });
    render(wrap(<OrderMoneyPanel docNo={OLD} />));
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    const amount = screen.getByLabelText('Refund amount') as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '400.00' } });
    fireEvent.blur(amount);
    fireEvent.change(screen.getByLabelText('Refund note'), { target: { value: 'customer wants it back' } });
    fireEvent.click(screen.getByRole('button', { name: 'Raise refund draft' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ amountSen: 40_000, note: 'customer wants it back' }));
    await waitFor(() => expect(notifySpy).toHaveBeenCalled());
    expect(String(notifySpy.mock.calls[0]![0].title)).toContain('2990Draft-2609-003');
  });

  it('Convert: this order ticked and the customer\'s other cancelled order beside it; the New SO page opens with one row per tick', () => {
    render(wrap(<OrderMoneyPanel docNo={OLD} />));
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect((screen.getByLabelText(`Take from ${OLD}`) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Take from 2990-SO-2607-024') as HTMLInputElement).checked).toBe(false);
    /* Part of this order, all of the other. */
    const mine = screen.getByLabelText(`Amount from ${OLD}`) as HTMLInputElement;
    fireEvent.change(mine, { target: { value: '400.00' } });
    fireEvent.blur(mine);
    fireEvent.click(screen.getByLabelText('Take from 2990-SO-2607-024'));
    expect(screen.getByTestId('convert-param').textContent).toBe(`${OLD}:40000,2990-SO-2607-024:30000`);
    fireEvent.click(screen.getByRole('button', { name: /Open a new order with RM 700\.00/ }));
    expect(navigateSpy).toHaveBeenCalledWith(`/scm/sales-orders/new?copyFrom=${encodeURIComponent(OLD)}&convert=${encodeURIComponent(`${OLD}:40000,2990-SO-2607-024:30000`)}`);
  });

  it('more than what is left on an order is refused before the page opens', () => {
    render(wrap(<OrderMoneyPanel docNo={OLD} />));
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    const mine = screen.getByLabelText(`Amount from ${OLD}`) as HTMLInputElement;
    fireEvent.change(mine, { target: { value: '700.01' } });
    fireEvent.blur(mine);
    expect(screen.getByText(/between RM 0\.01 and RM 700\.00/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Open a new order/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a spent order lists where the money went and says why the buttons are gone', () => {
    useOrderMoney.mockReturnValue({
      data: {
        money: money({
          refunds: [{ id: 'pv1', pvNumber: '2990Draft-2609-003', status: 'DRAFT', voucherDate: '2026-09-15', totalSen: 40_000 }],
          refundedSen: 40_000,
          conversions: [{ paymentId: 'x', toDocNo: '2990-SO-2609-050', amountSen: 30_000, paidOn: '2026-07-01', convertedOn: '2026-09-15' }],
          convertedSen: 30_000, remainingSen: 0, open: false, reason: `${OLD}'s money is spoken for — refunded or moved in full.`,
        }),
        others: [],
      },
      isError: false,
    });
    render(wrap(<OrderMoneyPanel docNo={OLD} />));
    expect(screen.getByText(/2990Draft-2609-003/).textContent).toContain('(draft)');
    expect(screen.getByText(/→ 2990-SO-2609-050/).textContent).toContain('RM 300.00');
    expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
    expect(screen.getByText(/spoken for/)).toBeTruthy();
  });
});
