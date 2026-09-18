/* The card that tells the office whether a deposit is already banked.
 *
 * Four states, and two of them look identical if the code is careless: "this
 * order collected nothing" and "we could not read this order". Getting those
 * two confused sends someone to chase money that is already in the drawer,
 * which is the expensive direction — so the refusal case is asserted first and
 * asserted hardest.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CollectedOnOrderCard } from './CollectedOnOrderCard';
import type { CollectedPayment } from '../lib/collected-on-order';

afterEach(cleanup);

const pay = (over: Partial<CollectedPayment>): CollectedPayment => ({
  id: 'p1', paid_at: '2026-09-01', method: 'transfer',
  amount_sen: 100_00, account_sheet: 'MBB-1234', note: null, ...over,
});

const card = (props: Partial<Parameters<typeof CollectedOnOrderCard>[0]>) =>
  render(
    <CollectedOnOrderCard
      soDocNo="HC-SO-013497"
      payments={[]}
      error={null}
      isLoading={false}
      currency="MYR"
      {...props}
    />,
  );

describe('CollectedOnOrderCard', () => {
  it('a refused read says so, and never says the order collected nothing', () => {
    card({ error: new Error('permission denied') });
    expect(screen.getByText(/could not read the payments on HC-SO-013497/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing collected/i)).toBeNull();
  });

  it('an order with no receipts says exactly that, naming the order', () => {
    card({ payments: [] });
    expect(screen.getByText(/Nothing collected on HC-SO-013497 yet/i)).toBeTruthy();
  });

  it('lists the receipts and the total, and says which document took the money', () => {
    card({
      payments: [
        pay({ id: 'a', amount_sen: 150_00, paid_at: '2026-09-01' }),
        pay({ id: 'b', amount_sen: 250_00, paid_at: '2026-09-05', account_sheet: 'CIMB-9' }),
      ],
    });
    expect(screen.getByText(/Taken on HC-SO-013497, not on this document/i)).toBeTruthy();
    expect(screen.getByText('MYR 400.00')).toBeTruthy();
    expect(screen.getByText(/across 2 receipts/i)).toBeTruthy();
    expect(screen.getByText('CIMB-9')).toBeTruthy();
  });

  it('says "receipt", not "receipts", for a single one', () => {
    card({ payments: [pay({ amount_sen: 99_00 })] });
    expect(screen.getByText(/across 1 receipt\b/i)).toBeTruthy();
  });

  it('renders nothing at all for a document with no order behind it', () => {
    const { container } = card({ soDocNo: null });
    expect(container.textContent).toBe('');
  });

  it('formats in the document currency, not a hard-coded MYR', () => {
    card({ payments: [pay({ amount_sen: 100_00 })], currency: 'USD' });
    /* Two nodes carry it — the summary line and the row — which is itself the
       assertion: both read the same currency, so a hard-coded MYR anywhere in
       the card would leave one of them disagreeing with the other. */
    expect(screen.getAllByText('USD 100.00')).toHaveLength(2);
    expect(screen.queryByText(/MYR/)).toBeNull();
  });
});
