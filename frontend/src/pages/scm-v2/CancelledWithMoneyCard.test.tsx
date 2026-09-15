// Finance's list of cancelled orders still holding money (docs/bugs/0931):
// the count and the total when there are some, "none" when there are none,
// and a read that failed says so instead of reading as none.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { useCancelledWithMoney } = vi.hoisted(() => ({ useCancelledWithMoney: vi.fn() }));
vi.mock('../../vendor/scm/lib/so-money-queries', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useCancelledWithMoney }));

import { CancelledWithMoneyCard } from './CancelledWithMoneyCard';

afterEach(cleanup);

describe('CancelledWithMoneyCard', () => {
  it('lists each order with what it paid and what is left, and totals it', () => {
    useCancelledWithMoney.mockReturnValue({ data: { orders: [
      { docNo: '2990-SO-2607-024', customer: 'Yap Kah Heng', cancelledOn: '2026-08-01', remainingSen: 336_500, bookedSen: 336_500 },
      { docNo: '2990-SO-2608-028', customer: 'Larding Chen', cancelledOn: '2026-08-20', remainingSen: 143_300, bookedSen: 143_300 },
    ], totalRemainingSen: 479_800 }, isLoading: false, isError: false });
    render(<CancelledWithMoneyCard />);
    expect(screen.getByText('2 · RM 4,798.00')).toBeTruthy();
    expect(screen.getByText('2990-SO-2607-024').closest('tr')!.textContent).toContain('Yap Kah Heng');
    expect(screen.getByText('2990-SO-2608-028').closest('tr')!.textContent).toContain('RM 1,433.00');
  });

  it('says none when there are none, and says the read failed instead of none', () => {
    useCancelledWithMoney.mockReturnValue({ data: { orders: [], totalRemainingSen: 0 }, isLoading: false, isError: false });
    render(<CancelledWithMoneyCard />);
    expect(screen.getByText('none')).toBeTruthy();
    cleanup();
    useCancelledWithMoney.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<CancelledWithMoneyCard />);
    expect(screen.getByText(/not checked — the read failed/)).toBeTruthy();
  });
});
