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

const { useOrderMoney, mutateAsync, navigateSpy, notifySpy, readConvertSource } = vi.hoisted(() => ({
  useOrderMoney: vi.fn(), mutateAsync: vi.fn(), navigateSpy: vi.fn(), notifySpy: vi.fn(), readConvertSource: vi.fn(),
}));
vi.mock('../lib/so-money-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useOrderMoney,
  readConvertSource,
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
  totalSen: 100_000, keepFraction: 0, keepSen: 0, movableSen: over.remainingSen ?? 70_000,
  open: true, reason: null, ...over,
});
const OTHERS: ConvertSource[] = [{ docNo: '2990-SO-2607-024', customer: 'Ah Meng', status: 'CANCELLED', cancelledOn: '2026-08-01', remainingSen: 30_000, bookedSen: 30_000, movableSen: 30_000, keepSen: 0 }];

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);

beforeEach(() => {
  mutateAsync.mockReset(); navigateSpy.mockReset(); notifySpy.mockReset(); readConvertSource.mockReset();
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
  it('renders nothing for an order that collected nothing, and nothing when the read failed', () => {
    useOrderMoney.mockReturnValue({ data: { money: money({ cancelled: false, status: 'CONFIRMED', open: false, bookedSen: 0, remainingSen: 0, movableSen: 0 }), others: [] }, isError: false });
    const { container } = render(wrap(<OrderMoneyPanel docNo={OLD} />));
    expect(container.firstChild).toBeNull();
    useOrderMoney.mockReturnValue({ data: undefined, isError: true });
    const failed = render(wrap(<OrderMoneyPanel docNo={OLD} />));
    expect(failed.container.firstChild).toBeNull();
  });

  /* A LIVE order (owner 2026-09-16): the panel shows what it keeps and what
     may move; Convert offers only that much, Refund the whole remaining. */
  it('a live order with money: the floor it keeps, Convert capped at what may move, Refund without a floor', () => {
    useOrderMoney.mockReturnValue({ data: { money: money({ cancelled: false, status: 'CONFIRMED', totalSen: 150_000, bookedSen: 100_000, remainingSen: 100_000, keepFraction: 0.5, keepSen: 75_000, movableSen: 25_000 }), others: [] }, isError: false });
    render(wrap(<OrderMoneyPanel docNo={OLD} />));
    expect(screen.getByText('Money on this order')).toBeTruthy();
    expect(screen.getByText('Keeps RM 750.00 (50% of RM 1,500.00) · RM 250.00 can move')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    const mine = screen.getByLabelText(`Amount from ${OLD}`) as HTMLInputElement;
    expect(mine.value).toBe('250.00');
    expect(screen.getByText('RM 250.00 can move (keeps RM 750.00)')).toBeTruthy();
    fireEvent.change(mine, { target: { value: '250.01' } });
    fireEvent.blur(mine);
    expect(screen.getByText(/between RM 0.01 and RM 250.00/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Open a new order/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    expect((screen.getByLabelText('Refund amount') as HTMLInputElement).value).toBe('1,000.00');
  });

  it('a live order at its floor: Refund stays, Convert is off and says why', () => {
    useOrderMoney.mockReturnValue({ data: { money: money({ cancelled: false, status: 'CONFIRMED', totalSen: 150_000, bookedSen: 75_000, remainingSen: 75_000, keepFraction: 0.5, keepSen: 75_000, movableSen: 0 }), others: [] }, isError: false });
    render(wrap(<OrderMoneyPanel docNo={OLD} />));
    expect(screen.getByText('Keeps RM 750.00 (50% of RM 1,500.00) · nothing can move')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Convert' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Nothing above the floor to move.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Refund' }) as HTMLButtonElement).disabled).toBe(false);
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

  it('on the phone (docs/bugs/0933) the same ticks are handed to the screen router instead of a URL', () => {
    const onOpen = vi.fn();
    render(wrap(<OrderMoneyPanel docNo={OLD} onOpenNewOrder={onOpen} />));
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    fireEvent.click(screen.getByLabelText('Take from 2990-SO-2607-024'));
    fireEvent.click(screen.getByRole('button', { name: /Open a new order with RM 1,000\.00/ }));
    expect(onOpen).toHaveBeenCalledWith(OLD, [{ docNo: OLD, amountSen: 70_000 }, { docNo: '2990-SO-2607-024', amountSen: 30_000 }]);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("another cancelled order by number — any customer's — joins the list ticked for what is left; a refused one says why", async () => {
    readConvertSource.mockResolvedValue({ ok: true, source: { docNo: '2990-SO-2608-028', customer: 'Larding Chen', status: 'CANCELLED', cancelledOn: null, remainingSen: 143_300, bookedSen: 143_300, movableSen: 143_300, keepSen: 0 } });
    render(wrap(<OrderMoneyPanel docNo={OLD} />));
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    fireEvent.change(screen.getByLabelText('Another cancelled order'), { target: { value: ' 2990-SO-2608-028 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByLabelText('Take from 2990-SO-2608-028')).toBeTruthy());
    expect(readConvertSource).toHaveBeenCalledWith(' 2990-SO-2608-028 ');
    expect((screen.getByLabelText('Take from 2990-SO-2608-028') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Larding Chen')).toBeTruthy();
    expect(screen.getByTestId('convert-param').textContent).toBe(OLD + ':70000,2990-SO-2608-028:143300');
    /* Enter adds too; a refused order says why, and stays out. */
    readConvertSource.mockResolvedValue({ ok: false, reason: '2990-SO-2609-001 is not cancelled.' });
    fireEvent.change(screen.getByLabelText('Another cancelled order'), { target: { value: '2990-SO-2609-001' } });
    fireEvent.keyDown(screen.getByLabelText('Another cancelled order'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('2990-SO-2609-001 is not cancelled.')).toBeTruthy());
    expect(screen.queryByLabelText('Take from 2990-SO-2609-001')).toBeNull();
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
