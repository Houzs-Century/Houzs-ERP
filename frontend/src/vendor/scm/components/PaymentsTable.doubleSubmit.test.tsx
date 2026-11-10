// One press of a payment row's Save = one POST (HC-SO-2609-164, HC-SO-008674:
// the same transfer booked twice, seconds apart). The row's Save is held from
// the press until the request settles; a refused save frees it again, and the
// retry carries the SAME Idempotency-Key, so the server can tell it is one intent.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const { addMutate, notifySpy } = vi.hoisted(() => ({ addMutate: vi.fn(), notifySpy: vi.fn() }));

vi.mock('../lib/sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSalesOrderPayments: () => ({ data: [], isLoading: false }),
  useAddSalesOrderPayment: () => ({ mutate: addMutate, mutateAsync: vi.fn(), isPending: false }),
  useEditSalesOrderPayment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useAttachSalesOrderPaymentSlip: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSalesOrderPayment: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => false, user: { permissions: [] } }) }));
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
vi.mock('./BackdateRequestsPanel', () => ({ BackdateRequestsPanel: () => null }));
vi.mock('./NotifyDialog', () => ({ useNotify: () => notifySpy }));
vi.mock('./ConfirmDialog', () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock('../../../lib/unsavedWork', () => ({ useUnsavedWork: () => undefined }));

import { PaymentsTable, newPaymentDraft } from './PaymentsTable';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);
const DRAFT = { ...newPaymentDraft(), amountSen: 150_000, slipUploadSessionId: 'sess-1' };
const saveButton = () => screen.getByTitle('Save payment') as HTMLButtonElement;
type Callbacks = { onSuccess: () => void; onError: (e: unknown) => void };

beforeEach(() => { addMutate.mockReset(); notifySpy.mockReset(); });
afterEach(cleanup);

describe('a payment row saves once per press', () => {
  it('a double press posts once, and Save stays disabled while it is pending', async () => {
    render(wrap(<PaymentsTable docNo="HC-SO-2609-164" grandTotalSen={500_000} initialDrafts={[DRAFT]} />));

    await act(async () => {
      fireEvent.click(saveButton());
      fireEvent.click(saveButton());
    });

    expect(addMutate).toHaveBeenCalledTimes(1);
    expect(addMutate.mock.calls[0]![0]).toMatchObject({ amountSen: 150_000, uploadSessionId: 'sess-1', idempotencyKey: DRAFT.idempotencyKey });
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toContain('Saving');
    fireEvent.click(saveButton());
    expect(addMutate).toHaveBeenCalledTimes(1);
  });

  it('a refused save frees the row, and the corrected save goes out under the same key', async () => {
    render(wrap(<PaymentsTable docNo="HC-SO-2609-164" grandTotalSen={500_000} initialDrafts={[DRAFT]} />));

    await act(async () => { fireEvent.click(saveButton()); });
    expect(addMutate).toHaveBeenCalledTimes(1);

    await act(async () => { (addMutate.mock.calls[0]![1] as Callbacks).onError(new Error('That payment slip has not finished uploading.')); });
    expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to save payment', tone: 'error' }));
    expect(saveButton().disabled).toBe(false);

    await act(async () => { fireEvent.click(saveButton()); });
    expect(addMutate).toHaveBeenCalledTimes(2);
    expect((addMutate.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey).toBe(DRAFT.idempotencyKey);
  });
});
