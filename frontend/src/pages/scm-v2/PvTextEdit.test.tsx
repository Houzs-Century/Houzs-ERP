/* A voucher's words alone (owner 2026-11-06: 有时我要改 description): the notes and
   each line's description, on one small form that sends nothing else — and the bank
   it pays into (owner 2026-11-09: 可以，开放), sent only when it was changed. The
   server half is backend/tests/pvEditText.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PvTextEdit } from './PvTextEdit';
import { NO_PAY_TO, type PayTo } from './pv-pay-to';

const h = vi.hoisted(() => ({ mutateAsync: vi.fn(async (_b: unknown): Promise<unknown> => ({ paymentVoucher: {} })) }));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useUpdatePvText: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));

const onClose = vi.fn();
const CIMB: PayTo = { bank: 'CIMB', accountNo: '8000 1111', accountName: '' };
const show = (payTo: PayTo = CIMB) => render(
  <PvTextEdit pvId="pv-1" notes="BILL 134 · DATED 2026-11-03" payTo={payTo}
    lines={[{ id: 'l-1', description: 'Rental deposit' }, { id: 'l-2', description: null }]} onClose={onClose} />,
);
const typeInto = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const valueOf = (label: string) => (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;

beforeEach(() => {
  onClose.mockClear();
  h.mutateAsync.mockReset();
  h.mutateAsync.mockResolvedValue({ paymentVoucher: {} });
});

describe('Edit text & bank', () => {
  test('starts from the voucher\'s own words and the bank it pays into', () => {
    show();
    expect(valueOf('Description')).toBe('BILL 134 · DATED 2026-11-03');
    expect(valueOf('Line 1 description')).toBe('Rental deposit');
    expect(valueOf('Line 2 description')).toBe('');
    expect(valueOf('Bank')).toBe('CIMB');
    expect(valueOf('Account no.')).toBe('8000 1111');
    expect(valueOf('Account name')).toBe('');
  });

  test('Save sends the words and nothing else when the bank is left as it was, then closes', async () => {
    show();
    typeInto('Description', 'Rental for Sunway Kluang');
    typeInto('Line 2 description', 'Balance of the rental');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.mutateAsync.mock.calls).toEqual([[{
      id: 'pv-1',
      notes: 'Rental for Sunway Kluang',
      lines: [{ id: 'l-1', description: 'Rental deposit' }, { id: 'l-2', description: 'Balance of the rental' }],
    }]]);
  });

  test('a bank changed is sent whole: each field trimmed, a blank one as nothing', async () => {
    show();
    typeInto('Bank', ' MAYBANK ');
    typeInto('Account no.', '5123 4567 8901');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.mutateAsync.mock.calls[0]![0]).toEqual({
      id: 'pv-1',
      notes: 'BILL 134 · DATED 2026-11-03',
      lines: [{ id: 'l-1', description: 'Rental deposit' }, { id: 'l-2', description: '' }],
      payToBankName: 'MAYBANK', payToAccountNo: '5123 4567 8901', payToAccountName: null,
    });
  });

  test('a voucher with no bank: the fields start empty and what is typed is sent', async () => {
    show(NO_PAY_TO);
    expect(valueOf('Bank')).toBe('');
    typeInto('Bank', 'PUBLIC BANK');
    typeInto('Account no.', '3188 0000 99');
    typeInto('Account name', 'FOSHAN CHAIRS SDN BHD');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.mutateAsync.mock.calls[0]![0]).toMatchObject({
      payToBankName: 'PUBLIC BANK', payToAccountNo: '3188 0000 99', payToAccountName: 'FOSHAN CHAIRS SDN BHD',
    });
  });

  test('a refusal is said on the form, which stays open with what was typed', async () => {
    h.mutateAsync.mockRejectedValue(new Error('This voucher is approved — its journal carries these words, so they stay as they are.'));
    show();
    typeInto('Description', 'New words');
    typeInto('Bank', 'MAYBANK');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('This voucher is approved — its journal carries these words, so they stay as they are.');
    expect(onClose).not.toHaveBeenCalled();
    expect(valueOf('Description')).toBe('New words');
    expect(valueOf('Bank')).toBe('MAYBANK');
  });

  test('Cancel closes and sends nothing', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });
});
