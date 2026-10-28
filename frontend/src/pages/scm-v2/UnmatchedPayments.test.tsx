/* Payments not matched yet — card and transfer on one list (owner 2026-09-30:
   我有没有一个表是显示全部还没 match 的). Pinned:
     • every row says where the payment is stuck and links the screen that
       unsticks it — Merchant Recon for a card, Bank Recon for a transfer;
     • All / Card / Transfer, each with its count, and the total shown;
     • an order's number opens the order;
     • the list asks for the last 180 days by default. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { UnmatchedPayment } from './unmatched-payments-queries';

const row = (over: Partial<UnmatchedPayment>): UnmatchedPayment => ({
  source: 'SOPAY', paymentId: 'p1', docNo: '2990-SO-2609-045', customerName: 'YEAP KAR CHUN', salespersonName: 'Nico',
  paidOn: '2026-09-02', kind: 'card', channel: 'PBB', amountSen: 324_000, reference: 'R18656', ageDays: 28,
  state: 'CARD_TO_CONFIRM', bankAccountCode: null, statementUpTo: null, ...over,
});
const ROWS: UnmatchedPayment[] = [
  row({}),
  row({ paymentId: 'p2', docNo: '2990-SO-2609-031', customerName: 'Chong Hui Wen', kind: 'transfer', channel: 'Bank Transfer', amountSen: 143_300, reference: '260920CE0DB5C26', ageDays: 10, state: 'TRANSFER_NOT_MATCHED', bankAccountCode: '310-0020', statementUpTo: '2026-09-28' }),
  row({ paymentId: 'p3', docNo: '2990-SO-2608-069', customerName: 'Poon How kei', kind: 'transfer', channel: 'TNG', amountSen: 150_000, reference: '602788', ageDays: 1, state: 'TRANSFER_NO_STATEMENT', bankAccountCode: '310-0020', statementUpTo: '2026-09-28' }),
  row({ paymentId: 'p4', docNo: '2990-SO-2609-050', channel: null, amountSen: 50_000, ageDays: 3, state: 'CARD_NOT_REPORTED' }),
];

const asked: Array<[string, string]> = [];
vi.mock('./unmatched-payments-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./unmatched-payments-queries')>()),
  useUnmatchedPayments: (from: string, to: string) => {
    asked.push([from, to]);
    return { data: { from, to, rows: ROWS }, isLoading: false, isError: false };
  },
}));

import { UnmatchedPayments } from './UnmatchedPayments';

const draw = () => render(<MemoryRouter><UnmatchedPayments /></MemoryRouter>);
const rowOf = (docNo: string): HTMLElement => screen.getByText(docNo).closest('tr') as HTMLElement;

describe('Payments not matched yet', () => {
  test('each row says where it is stuck and links the screen that unsticks it', () => {
    draw();
    const card = within(rowOf('2990-SO-2609-045'));
    expect(card.getByText('Card · PBB')).toBeTruthy();
    expect(card.getByText('On a merchant report — waiting for you to confirm')).toBeTruthy();
    expect(card.getByText('Merchant Recon').getAttribute('href')).toBe('/scm/merchant-recon');
    expect(card.getByText('2990-SO-2609-045').getAttribute('href')).toBe('/scm/sales-orders/2990-SO-2609-045');

    const transfer = within(rowOf('2990-SO-2609-031'));
    expect(transfer.getByText('Transfer · Bank Transfer')).toBeTruthy();
    expect(transfer.getByText('Not matched to the bank statement yet')).toBeTruthy();
    expect(transfer.getByText('Bank Recon').getAttribute('href')).toBe('/scm/bank-recon');

    const late = within(rowOf('2990-SO-2608-069'));
    expect(late.getByText(/^Bank statement for this day not uploaded yet \(uploaded to /)).toBeTruthy();

    /* Keyed in without a bank: 未标, as Merchant Recon names it. */
    const untagged = within(rowOf('2990-SO-2609-050'));
    expect(untagged.getByText('Card · 未标')).toBeTruthy();
    expect(untagged.getByText('Not on a merchant report yet')).toBeTruthy();
  });

  test('All, Card and Transfer carry their counts, and the total follows the choice', () => {
    draw();
    expect(screen.getByRole('button', { name: 'All (4)' })).toBeTruthy();
    expect(screen.getByText(/^4 payments not matched, .*6,673\.00 in total\. Card 2 \(.*3,740\.00\) · Transfer 2 \(.*2,933\.00\)\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Transfer (2)' }));
    expect(screen.queryByText('2990-SO-2609-045')).toBeNull();
    expect(screen.getByText('2990-SO-2609-031')).toBeTruthy();
    expect(screen.getByText(/^2 payments not matched, .*2,933\.00 in total\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Card (2)' }));
    expect(screen.queryByText('2990-SO-2609-031')).toBeNull();
    expect(screen.getByText('2990-SO-2609-045')).toBeTruthy();
  });

  test('asks for the last 180 days by default', () => {
    asked.length = 0;
    draw();
    const [from, to] = asked[0]!;
    expect((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000).toBe(180);
  });
});
