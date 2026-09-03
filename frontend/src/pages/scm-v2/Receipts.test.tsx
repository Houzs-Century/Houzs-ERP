/* Receipts — the page contract (owner 2026-09-03): one month-windowed list of
   GENERAL + DEBTOR + CUSTOMER money-in; general receipts raise here (录入即
   过账, payer typed free) and void by reversal. The server half is
   backend/tests/receipts.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createAsync = vi.fn(async (_b: unknown) => ({ ok: true, receipt: { receiptNumber: 'HC-OR-2609-001', totalSen: 88800 } }));
const voidAsync = vi.fn(async (_id: unknown) => ({ ok: true }));

vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0010', account_name: 'MAYBANK', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
    { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useReceipts: () => ({ data: { month: '2026-09', receipts: [
    { kind: 'GENERAL', id: 'g1', number: 'HC-OR-2609-001', date: '2026-09-03', payer: 'ALLIANZ INSURANCE', moneyAccount: '310-0010', totalSen: 88800, status: 'POSTED' },
    { kind: 'DEBTOR', id: 'dr1', number: 'HC-ODR-2609-001', date: '2026-09-02', payer: 'AHMAD BIN ALI', moneyAccount: '310-0010', totalSen: 20000, status: 'POSTED', debtorId: 'd1' },
    { kind: 'CUSTOMER', id: 'p1', number: 'HC-SO-2609-004', date: '2026-09-01', payer: 'Customer deposit', moneyAccount: 'EDC', totalSen: 350000, status: 'RECEIVED' },
  ] }, isLoading: false }),
  useCreateReceipt: () => ({ mutateAsync: createAsync, isPending: false }),
  useVoidReceipt: () => ({ mutateAsync: voidAsync, isPending: false }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));

import { Receipts } from './Receipts';

const draw = () => render(<MemoryRouter><Receipts /></MemoryRouter>);

describe('the unified money-in list', () => {
  test('three kinds share the table, the month total sums the live rows, links go to the source pages', () => {
    draw();
    expect(screen.getByText('Receipt')).toBeTruthy();
    expect(screen.getByText('Other Debtor')).toBeTruthy();
    expect(screen.getByText('Customer')).toBeTruthy();
    /* 888.00 + 200.00 + 3,500.00 */
    expect(screen.getByText('MYR 4,588.00')).toBeTruthy();
    expect(screen.getByText('HC-SO-2609-004').closest('a')!.getAttribute('href')).toBe('/scm/sales-orders/HC-SO-2609-004');
    expect(screen.getByText('HC-ODR-2609-001').closest('a')!.getAttribute('href')).toBe('/scm/other-debtors');
  });

  test('a general receipt raises with typed payer, picked bank and free-pick lines', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New receipt'));
    fireEvent.change(screen.getByLabelText(/Received from/), { target: { value: 'ALLIANZ INSURANCE' } });
    const combos = screen.getAllByRole('combobox');
    fireEvent.focus(combos[0]!); // Received into — money only
    fireEvent.mouseDown(screen.getByText('310-0010 · MAYBANK'));
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: '车险赔偿' } });
    fireEvent.focus(screen.getAllByRole('combobox')[1]!);
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    fireEvent.change(screen.getByLabelText('line 1 amount'), { target: { value: '888' } });
    fireEvent.click(screen.getByText('Post receipt'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledWith({
      payerName: 'ALLIANZ INSURANCE',
      bankAccountCode: '310-0010',
      lines: [{ description: '车险赔偿', creditAccountCode: '700-0000', amountSen: 88800 }],
    }));
  });

  test('void confirms with the reversal sentence, then sends the id — offered on GENERAL rows only', async () => {
    voidAsync.mockClear(); confirmFn.mockClear();
    draw();
    expect(screen.getAllByLabelText(/^Void /)).toHaveLength(1); // only the GENERAL row
    fireEvent.click(screen.getByLabelText('Void HC-OR-2609-001'));
    await waitFor(() => expect(voidAsync).toHaveBeenCalledWith('g1'));
    expect(JSON.stringify(confirmFn.mock.calls[0]![0])).toMatch(/reversed/);
  });
});
