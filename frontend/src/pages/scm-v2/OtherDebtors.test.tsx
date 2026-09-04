/* Other Debtors — the page contract (owner 2026-09-03): registry rows with
   outstanding, bills whose lines pick their own accounts, and receipts that
   tick-pays-in-full / type-for-partial and walk the PV's four layers. The
   server half is backend/tests/otherDebtors.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createDebtorAsync = vi.fn(async (_b: unknown) => ({ ok: true, debtor: { id: 'd9' } }));
const createBillAsync = vi.fn(async (_b: unknown) => ({ ok: true, bill: { billNumber: 'HC-ODB-2609-001', totalSen: 50000 } }));
const createReceiptAsync = vi.fn(async (_b: unknown) => ({ ok: true, receipt: { receiptNumber: 'HC-ODR-2609-001' } }));
const receiptActionAsync = vi.fn(async (_b: unknown) => ({ ok: true }));
const cancelBillAsync = vi.fn(async (_b: unknown) => ({ ok: true }));

let detail: Record<string, unknown> | undefined;

vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0010', account_name: 'MAYBANK', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
    { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
    { account_code: '305-0000', account_name: 'OTHER DEBTOR', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false, special_type: 'SDC' },
  ] }, isLoading: false }),
  useOtherDebtors: () => ({ data: { debtors: [
    { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 50000 },
  ] }, isLoading: false }),
  useDebtorDetail: (id: string | null) => ({ data: id ? detail : undefined, isLoading: false }),
  useCreateDebtor: () => ({ mutateAsync: createDebtorAsync, isPending: false }),
  useUpdateDebtor: () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false }),
  useCreateDebtorBill: () => ({ mutateAsync: createBillAsync, isPending: false }),
  useCancelDebtorBill: () => ({ mutateAsync: cancelBillAsync, isPending: false }),
  useCreateDebtorReceipt: () => ({ mutateAsync: createReceiptAsync, isPending: false }),
  useDebtorReceiptAction: () => ({ mutateAsync: receiptActionAsync, isPending: false }),
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));

import { OtherDebtors } from './OtherDebtors';

const draw = () => render(<MemoryRouter><OtherDebtors /></MemoryRouter>);

const baseDetail = () => ({
  debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 50000 },
  bills: [
    { id: 'b1', bill_number: 'HC-ODB-2609-001', bill_date: '2026-09-03', total_sen: 50000, received_sen: 20000, status: 'POSTED', notes: null },
  ],
  receipts: [] as Array<Record<string, unknown>>,
});

describe('the registry', () => {
  test('rows show the outstanding; picking one opens the detail', () => {
    detail = baseDetail();
    draw();
    expect(screen.getByText('MYR 500.00')).toBeTruthy();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    expect(screen.getByText('Bills')).toBeTruthy();
    expect(screen.getByText('HC-ODB-2609-001')).toBeTruthy();
  });
});

describe('the Debtor Bill — lines pick their own account', () => {
  test('a filled line posts with the picked account and integer sen', async () => {
    detail = baseDetail();
    createBillAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    fireEvent.click(screen.getByText('New bill'));
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: '转租九月' } });
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    fireEvent.change(screen.getByLabelText('line 1 amount'), { target: { value: '450' } });
    fireEvent.click(screen.getByText('Post bill'));
    await waitFor(() => expect(createBillAsync).toHaveBeenCalledWith({
      debtorId: 'd1',
      lines: [{ description: '转租九月', creditAccountCode: '700-0000', amountSen: 45000 }],
    }));
  });
});

describe('the Receipt — tick pays in full, type for partial, four layers gate', () => {
  test('tick fills the outstanding; typing narrows it; the payload carries the allocation', async () => {
    detail = baseDetail();
    createReceiptAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    fireEvent.click(screen.getByText('New receipt'));
    /* Tick = the full RM 300 outstanding (500 − 200 received). */
    fireEvent.click(screen.getByLabelText('Collect HC-ODB-2609-001 in full'));
    expect(screen.getByText(/Receiving MYR 300\.00/)).toBeTruthy();
    /* Type = partial. */
    fireEvent.change(screen.getByLabelText('amount for HC-ODB-2609-001'), { target: { value: '100' } });
    expect(screen.getByText(/Receiving MYR 100\.00/)).toBeTruthy();
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.mouseDown(screen.getByText('310-0010 · MAYBANK'));
    fireEvent.click(screen.getByText('Raise receipt'));
    await waitFor(() => expect(createReceiptAsync).toHaveBeenCalledWith({
      debtorId: 'd1',
      bankAccountCode: '310-0010',
      allocations: [{ billId: 'b1', amountSen: 10000 }],
    }));
  });

  test('the buttons follow the layers: Prepare → Check/Withdraw/Reject → Approve', async () => {
    receiptActionAsync.mockClear();
    const receipts = [
      { id: 'r1', receipt_number: 'HC-ODR-2609-001', receipt_date: '2026-09-03', bank_account_code: '310-0010', total_sen: 10000, status: 'DRAFT', submitted_at: null, submitted_by: null, checked_at: null, checked_by: null, approved_at: null, approved_by: null, posted_at: null, notes: null },
      { id: 'r2', receipt_number: 'HC-ODR-2609-002', receipt_date: '2026-09-03', bank_account_code: '310-0010', total_sen: 10000, status: 'DRAFT', submitted_at: 'x', submitted_by: 'u', checked_at: null, checked_by: null, approved_at: null, approved_by: null, posted_at: null, notes: null },
      { id: 'r3', receipt_number: 'HC-ODR-2609-003', receipt_date: '2026-09-03', bank_account_code: '310-0010', total_sen: 10000, status: 'DRAFT', submitted_at: 'x', submitted_by: 'u', checked_at: 'y', checked_by: 'v', approved_at: null, approved_by: null, posted_at: null, notes: null },
      { id: 'r4', receipt_number: 'HC-ODR-2609-004', receipt_date: '2026-09-03', bank_account_code: '310-0010', total_sen: 10000, status: 'POSTED', submitted_at: 'x', submitted_by: 'u', checked_at: 'y', checked_by: 'v', approved_at: 'z', approved_by: 'w', posted_at: 'z', notes: null },
    ];
    detail = { ...baseDetail(), receipts };
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    expect(screen.getByText('Prepare')).toBeTruthy();          // r1
    expect(screen.getByText('Check')).toBeTruthy();            // r2
    expect(screen.getByText('Withdraw')).toBeTruthy();         // r2
    expect(screen.getByText('Approve & post')).toBeTruthy();   // r3
    expect(screen.getByText('Approved')).toBeTruthy();         // r4 — the POSTED pill vocabulary

    fireEvent.click(screen.getByText('Approve & post'));
    await waitFor(() => expect(receiptActionAsync).toHaveBeenCalledWith({ receiptId: 'r3', action: 'approve' }));
    expect(JSON.stringify(confirmFn.mock.calls.at(-1)![0])).toMatch(/books into 310-0010/);
  });
});

describe('cancelling a bill', () => {
  test('confirms, then sends the bill id — offered only while nothing was received', async () => {
    cancelBillAsync.mockClear();
    detail = baseDetail();
    (detail.bills as Array<Record<string, unknown>>)[0]!.received_sen = 0;
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    fireEvent.click(screen.getByLabelText('Cancel HC-ODB-2609-001'));
    await waitFor(() => expect(cancelBillAsync).toHaveBeenCalledWith('b1'));
  });
});
