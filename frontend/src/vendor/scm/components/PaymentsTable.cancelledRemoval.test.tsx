// Finance's remove door on a CANCELLED order's payments (owner 2026-09-29,
// "1 a, 2 a, 做"). The case: one PBB swipe keyed on the real order AND on its
// cancelled duplicate 2990-SO-2608-028 — the copy books money that never came
// in, and the card on a cancelled order offered no way to take it off.
//
// Pinned: the card stays shut (no Add Payment, no pencil) but Finance — the
// correction right — gets a trash on each row; pressing it always asks why,
// says the entry is reversed on the payment's own day (not today), and sends
// the reason; a dismissed ask sends nothing; a refusal is said out loud;
// nobody else sees the button, and a locked LIVE order's card grows nothing.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { SoPayment } from '../lib/sales-order-queries';

const { deleteMutate, notifySpy, confirmSpy, promptSpy, perms } = vi.hoisted(() => ({
  deleteMutate: vi.fn(),
  notifySpy: vi.fn(),
  confirmSpy: vi.fn(),
  promptSpy: vi.fn(),
  perms: { current: [] as string[] },
}));

const DUP = '2990-SO-2608-028';
const ROW: SoPayment = {
  id: 'dup', so_doc_no: DUP, paid_at: '2026-07-22', method: 'merchant', merchant_provider: 'PBB', installment_months: null,
  online_type: null, approval_code: '855755', amount_sen: 143_300, account_sheet: 'PBB', slip_key: null, collected_by: null,
  collected_by_name: 'Scarlett Chong Kar Yin', note: null, created_at: '2026-08-22T03:01:05Z', created_by: null, version: 1,
};

vi.mock('../lib/sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSalesOrderPayments: () => ({ data: [ROW], isLoading: false }),
  useAddSalesOrderPayment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useEditSalesOrderPayment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useAttachSalesOrderPaymentSlip: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSalesOrderPayment: () => ({ mutate: deleteMutate, isPending: false }),
}));
vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ can: (k: string) => perms.current.includes(k), user: { permissions: perms.current } }),
}));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ staff: null }) }));
vi.mock('../lib/admin-queries', () => ({ useStaff: () => ({ data: [] }), usePickableStaff: () => ({ data: [] }) }));
vi.mock('../lib/so-dropdown-options-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSoDropdownOptions: () => ({ data: undefined }),
}));
vi.mock('../lib/so-money-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useConvertSources: () => ({ data: { sources: [] } }),
}));
vi.mock('./OrderMoneyPanel', () => ({ OrderMoneyPanel: () => null }));
vi.mock('./RefundsLine', () => ({ RefundsLine: () => null }));
vi.mock('./NotifyDialog', () => ({ useNotify: () => notifySpy }));
vi.mock('./ConfirmDialog', () => ({ useConfirm: () => confirmSpy, usePrompt: () => promptSpy }));
vi.mock('../../../lib/unsavedWork', () => ({ useUnsavedWork: () => undefined }));

import { PaymentsTable } from './PaymentsTable';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);
const REMOVE = 'Remove payment (Finance — cancelled order)';
const REASON = 'Same PBB swipe 855755 as 2990-SO-2607-019, keyed twice';

beforeEach(() => {
  deleteMutate.mockReset(); notifySpy.mockReset(); confirmSpy.mockReset(); promptSpy.mockReset();
  perms.current = [];
});
afterEach(cleanup);

describe('a cancelled order\'s payments: Finance may remove one, nobody may do anything else', () => {
  it('Finance: no Add Payment, no pencil — a trash that asks why, names the day it reverses on, and sends the reason', async () => {
    perms.current = ['scm.so_payment.amend'];
    promptSpy.mockResolvedValue(REASON);
    confirmSpy.mockResolvedValue(true);
    render(wrap(<PaymentsTable docNo={DUP} grandTotalSen={286_500} locked cancelledRemoval />));

    expect(screen.queryByText('Add Payment')).toBeNull();
    expect(screen.queryByTitle('Edit payment (same-day only)')).toBeNull();
    fireEvent.click(screen.getByTitle(REMOVE));

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledTimes(1));
    expect(promptSpy.mock.calls[0]![0]).toMatchObject({ title: 'Why is this payment being removed?' });
    const ask = confirmSpy.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string };
    expect(ask.title).toContain('from the cancelled order');
    expect(ask.body).toContain('reversed on 2026/07/22, not today');
    expect(ask.body).toContain('draft receipt is removed');
    expect(ask.confirmLabel).toBe('Remove');
    expect(deleteMutate.mock.calls[0]![0]).toEqual({ docNo: DUP, id: 'dup', version: 1, reason: REASON });

    /* The server's refusal reaches the screen instead of vanishing. */
    const { onError } = deleteMutate.mock.calls[0]![1] as { onError: (e: unknown) => void };
    onError(new Error('RM 300.00 of 2990-SO-2608-028\'s money is refunded or moved to another order. Undo that first, then remove this payment.'));
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Payment not removed', tone: 'error', body: expect.stringContaining('Undo that first') }));
  });

  it('a dismissed reason sends nothing', async () => {
    perms.current = ['scm.so_payment.amend'];
    promptSpy.mockResolvedValue(null);
    render(wrap(<PaymentsTable docNo={DUP} grandTotalSen={286_500} locked cancelledRemoval />));
    fireEvent.click(screen.getByTitle(REMOVE));
    await waitFor(() => expect(promptSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it('without the correction right there is no button at all', () => {
    perms.current = ['scm.sales.orders'];
    render(wrap(<PaymentsTable docNo={DUP} grandTotalSen={286_500} locked cancelledRemoval />));
    expect(screen.queryByTitle(REMOVE)).toBeNull();
    expect(screen.queryByTitle('Remove payment (same-day only)')).toBeNull();
  });

  it('a locked card that is not a cancelled order grows nothing, even for Finance', () => {
    perms.current = ['scm.so_payment.amend'];
    render(wrap(<PaymentsTable docNo="2990-SO-2609-001" grandTotalSen={286_500} locked />));
    expect(screen.queryByTitle(REMOVE)).toBeNull();
    expect(screen.queryByTitle('Remove payment (same-day only)')).toBeNull();
  });
});
