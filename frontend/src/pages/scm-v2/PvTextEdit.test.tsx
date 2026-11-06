/* A voucher's words alone (owner 2026-11-06: 有时我要改 description): the notes and
   each line's description, on one small form that sends nothing else. The server half
   is backend/tests/pvEditText.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PvTextEdit } from './PvTextEdit';

const h = vi.hoisted(() => ({ mutateAsync: vi.fn(async (_b: unknown): Promise<unknown> => ({ paymentVoucher: {} })) }));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({
  useUpdatePvText: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));

const onClose = vi.fn();
const show = () => render(
  <PvTextEdit pvId="pv-1" notes="BILL 134 · DATED 2026-11-03"
    lines={[{ id: 'l-1', description: 'Rental deposit' }, { id: 'l-2', description: null }]} onClose={onClose} />,
);

beforeEach(() => {
  onClose.mockClear();
  h.mutateAsync.mockReset();
  h.mutateAsync.mockResolvedValue({ paymentVoucher: {} });
});

describe('Edit text', () => {
  test('starts from the voucher\'s own words', () => {
    show();
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('BILL 134 · DATED 2026-11-03');
    expect((screen.getByLabelText('Line 1 description') as HTMLInputElement).value).toBe('Rental deposit');
    expect((screen.getByLabelText('Line 2 description') as HTMLInputElement).value).toBe('');
  });

  test('Save sends the words and nothing else, then closes', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Rental for Sunway Kluang' } });
    fireEvent.change(screen.getByLabelText('Line 2 description'), { target: { value: 'Balance of the rental' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(h.mutateAsync.mock.calls).toEqual([[{
      id: 'pv-1',
      notes: 'Rental for Sunway Kluang',
      lines: [{ id: 'l-1', description: 'Rental deposit' }, { id: 'l-2', description: 'Balance of the rental' }],
    }]]);
  });

  test('a refusal is said on the form, which stays open with the words typed', async () => {
    h.mutateAsync.mockRejectedValue(new Error('This voucher is approved — its journal carries these words, so they stay as they are.'));
    show();
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'New words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
    await screen.findByText('This voucher is approved — its journal carries these words, so they stay as they are.');
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).value).toBe('New words');
  });

  test('Cancel closes and sends nothing', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });
});
