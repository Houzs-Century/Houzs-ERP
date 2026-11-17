// Bank Recon's Card payments tab (owner 2026-11-17: 「我在bank recon时可以选刷卡的
// transaction」): the card payments no report carries, found by what a person holds —
// the order, the approval code, the amount — and ticked for the movement. A ticked
// payment stays in view whatever is typed, so the bar never counts one out of sight.

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { BankCardPayment } from './bank-queries';

vi.mock('./bank-queries', () => ({
  useMatchBankGroup: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useMatchWithCards: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  cardPaymentKey: (p: { source: string; id: string }) => `${p.source}:${p.id}`,
}));

import { ReconcilePickProvider } from './bank-reconcile-pick';
import { BankCardPaymentsTab } from './BankCardPaymentsTab';

const card = (id: string, docNo: string, amountSen: number, approvalCode: string | null, acquirerCode: string | null): BankCardPayment => ({
  source: 'SOPAY', id, docNo, paidOn: '2026-11-05', amountSen, approvalCode, customerName: null, acquirerCode, merchantProvider: acquirerCode, ageDays: 12,
});
const SWIPES = [
  card('p028', '2990-SO-2611-028', 399000, null, 'PBB'),
  card('p017', '2990-SO-2611-017', 399000, 'R21077', null),
  card('p081', '2990-SO-2611-081', 350000, '007909', null),
];

const renderTab = () => render(
  <MemoryRouter>
    <ReconcilePickProvider lines={[]} entries={[]} cards={SWIPES} cardSetup={{ feeAccount: { code: '900-T009', name: 'TERMINAL INTEREST CHARGES' }, feeProblem: null, maxChargePct: 10 }}>
      <BankCardPaymentsTab cards={SWIPES} />
    </ReconcilePickProvider>
  </MemoryRouter>,
);

const rows = () => screen.getAllByRole('checkbox').map((b) => b.getAttribute('aria-label'));
const find = (text: string) => fireEvent.change(screen.getByLabelText('Find a card payment'), { target: { value: text } });

describe('the Card payments tab', () => {
  test('lists every payment, untagged ones under 未标', () => {
    renderTab();
    expect(rows()).toEqual(['Card payment 2990-SO-2611-028 for the picked movement', 'Card payment 2990-SO-2611-017 for the picked movement', 'Card payment 2990-SO-2611-081 for the picked movement']);
    expect(screen.getAllByText('未标')).toHaveLength(2);
  });

  test('finds by approval code or amount, and keeps a ticked payment in view', () => {
    renderTab();
    find('R21077');
    expect(rows()).toEqual(['Card payment 2990-SO-2611-017 for the picked movement']);
    fireEvent.click(screen.getByLabelText('Card payment 2990-SO-2611-017 for the picked movement'));
    find('3500.00');
    expect(rows()).toEqual(['Card payment 2990-SO-2611-017 for the picked movement', 'Card payment 2990-SO-2611-081 for the picked movement']);
    /* Ticked with no movement yet: the bar asks for the one movement. */
    expect(screen.getByRole('region', { name: 'Match the ticked movements and entries' }).textContent).toContain('Tick the one movement that paid these card payments in.');
    find('nothing like this');
    expect(rows()).toEqual(['Card payment 2990-SO-2611-017 for the picked movement']);
  });
});
