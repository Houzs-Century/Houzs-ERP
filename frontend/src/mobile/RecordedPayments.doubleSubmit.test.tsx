// The phone's Add payment sheet records once per press (HC-SO-2609-164,
// HC-SO-008674: one transfer booked twice, seconds apart). Record Payment is held
// from the tap until the request settles; a refused save frees it, and the retry
// carries the same Idempotency-Key.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConvertSource } from '../vendor/scm/lib/so-money-queries';

const { addMutate, useMobileConvertSources } = vi.hoisted(() => ({ addMutate: vi.fn(), useMobileConvertSources: vi.fn() }));
vi.mock('../vendor/scm/lib/sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAddSalesOrderPayment: () => ({ mutateAsync: addMutate }),
  useEditSalesOrderPayment: () => ({ mutateAsync: vi.fn() }),
  useAttachSalesOrderPaymentSlip: () => ({ mutateAsync: vi.fn() }),
  useDeleteSalesOrderPayment: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../vendor/scm/lib/so-dropdown-options-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), useSoDropdownOptions: () => ({ data: undefined }),
}));
vi.mock('./MobileOrderMoney', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useMobileConvertSources }));
vi.mock('../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));
vi.mock('../vendor/scm/lib/payment-backdate-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useRaiseBackdateRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => false, user: null }) }));

import { AddPaymentSheet } from './RecordedPayments';
import { CONVERT_LABEL } from '../vendor/scm/lib/so-money-queries';

const SOURCES: ConvertSource[] = [{ docNo: 'HC-SO-2607-024', customer: 'Yap Kah Heng', status: 'CANCELLED', cancelledOn: '2026-08-01', remainingSen: 150_000, bookedSen: 150_000, movableSen: 150_000, keepSen: 0 }];

beforeEach(() => {
  addMutate.mockReset();
  useMobileConvertSources.mockImplementation((p: { docNo?: string | null }) => (p.docNo ? SOURCES : []));
});
afterEach(cleanup);

/* A converted row needs no slip upload, so the sheet is ready to record in two picks. */
const openReadySheet = () => {
  render(<AddPaymentSheet docNo="HC-SO-2609-164" staff={[]} onClose={() => {}} onSaved={() => {}} />);
  fireEvent.change(screen.getByText('Method').parentElement!.querySelector('select')!, { target: { value: CONVERT_LABEL } });
  fireEvent.change(screen.getByLabelText('Cancelled order'), { target: { value: 'HC-SO-2607-024' } });
  return () => screen.getByRole('button', { name: /Record/ }) as HTMLButtonElement;
};

describe('AddPaymentSheet records once per press', () => {
  it('a double tap sends one payment and the button stays disabled while it is pending', async () => {
    addMutate.mockReturnValue(new Promise(() => {}));
    const record = openReadySheet();

    await act(async () => {
      fireEvent.click(record());
      fireEvent.click(record());
    });

    expect(addMutate).toHaveBeenCalledTimes(1);
    expect(record().disabled).toBe(true);
    expect(record().textContent).toBe('Recording…');
  });

  it('a refused save frees the button and the retry carries the same key', async () => {
    let refuse: (e: Error) => void = () => {};
    addMutate.mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
    const record = openReadySheet();

    await act(async () => { fireEvent.click(record()); });
    await act(async () => { refuse(new Error('Pick the order the money comes from.')); });
    expect(record().disabled).toBe(false);

    addMutate.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { fireEvent.click(record()); });
    expect(addMutate).toHaveBeenCalledTimes(2);
    const key = (n: number) => (addMutate.mock.calls[n]![0] as { idempotencyKey: string }).idempotencyKey;
    expect(key(1)).toBe(key(0));
  });
});
