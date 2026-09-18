/* The Self-check card for a payment that reached the ledger and then stopped
   agreeing with it. Pinned: a clean answer over ZERO entries must not borrow
   the words of a clean answer over four thousand — "nothing to compare" is a
   different statement from "all of them agree", and the card that says the
   second one over an empty ledger is telling the owner he is safe when nobody
   has checked anything. Also pinned: both sides of every disagreement are on
   screen, so the difference can be read without opening the entry. */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { PaymentDriftCard } from './Accounting';
import type { PaymentDrift, PaymentDriftRow } from './accounting-phase1-queries';

const row = (over: Partial<PaymentDriftRow> = {}): PaymentDriftRow => ({
  source: 'SOPAY', id: 'p1', docNo: 'HS-SO-2609-001', jeNo: 'JE-2609-0007',
  fields: ['amount'], paymentAmountSen: 199_000, entryAmountSen: 150_000,
  paidOn: '2026-09-01', entryDate: '2026-09-01',
  paymentMethod: 'cash', entryMethod: 'cash',
  ...over,
});

const draw = (d: PaymentDrift) => render(<PaymentDriftCard d={d} />);

describe('the payment-drift card', () => {
  test('an empty ledger says nothing to compare, not that everything agrees', () => {
    draw({ rows: [], scanned: 0, ok: true });
    expect(screen.getByText('nothing to compare')).toBeTruthy();
    expect(screen.getByText(/No payment has reached the ledger in this company yet/)).toBeTruthy();
    expect(screen.queryByText(/^all /)).toBeNull();
  });

  test('a clean answer counts what it read', () => {
    draw({ rows: [], scanned: 4_281, ok: true });
    expect(screen.getByText('all 4281')).toBeTruthy();
    expect(screen.getByText(/Comparing 4281 payments against the journal entry/)).toBeTruthy();
  });

  test('an amount disagreement shows both sides', () => {
    draw({ rows: [row()], scanned: 12, ok: false });
    expect(screen.getByText('1 do not')).toBeTruthy();
    expect(screen.getByText('HS-SO-2609-001')).toBeTruthy();
    expect(screen.getByText('JE-2609-0007')).toBeTruthy();
    expect(screen.getByText('amount')).toBeTruthy();
    expect(screen.getByText(/RM 1,990\.00/)).toBeTruthy();
    expect(screen.getByText(/RM 1,500\.00/)).toBeTruthy();
  });

  test('a method change is named in words the owner uses', () => {
    draw({ rows: [row({ fields: ['method'], paymentMethod: 'merchant', entryMethod: 'cash', paymentAmountSen: 150_000 })], scanned: 12, ok: false });
    expect(screen.getByText('how it was paid')).toBeTruthy();
    expect(screen.getByText(/2026-09-01 · merchant/)).toBeTruthy();
    expect(screen.getByText(/2026-09-01 · cash/)).toBeTruthy();
  });

  test('an entry whose method could not be read says so, rather than naming one', () => {
    draw({ rows: [row({ entryMethod: null })], scanned: 12, ok: false });
    expect(screen.getByText(/· not stated/)).toBeTruthy();
  });

  test('a payment whose date was erased reads as no date, not as blank', () => {
    draw({ rows: [row({ fields: ['date'], paidOn: '', paymentAmountSen: 150_000 })], scanned: 12, ok: false });
    expect(screen.getByText(/no date · cash/)).toBeTruthy();
  });

  test('it offers no fix, and says why', () => {
    draw({ rows: [row()], scanned: 12, ok: false });
    expect(screen.getByText(/Nothing here is corrected automatically/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('a check that could not run says so instead of reading green', () => {
    draw({ rows: [], scanned: 0, ok: false, error: 'journal scan: timeout' });
    expect(screen.getByText(/The check could not run: journal scan: timeout/)).toBeTruthy();
    expect(screen.queryByText('nothing to compare')).toBeNull();
  });
});
