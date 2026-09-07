/* Other Debtors — the page contract (owner 2026-09-03): registry rows with
   outstanding, bills whose lines pick their own accounts, and receipts that
   tick-pays-in-full / type-for-partial and walk the PV's four layers.
   2026-09-06 (other debtor bill 那边也要有): the bill is a pop-out form —
   Insert adds a line and lands on it, amounts read 1,800.00 — every bill can
   be edited (the route re-posts) or copied, and the receipt's amounts wear
   the same dress. The server half is backend/tests/otherDebtors.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createDebtorAsync = vi.fn(async (_b: unknown) => ({ ok: true, debtor: { id: 'd9' } }));
const createBillAsync = vi.fn(async (_b: unknown) => ({ ok: true, bill: { billNumber: 'HC-ODB-2609-001', totalSen: 50000 } }));
const updateBillAsync = vi.fn(async (_b: unknown) => ({ ok: true, bill: { id: 'b1', billNumber: 'HC-ODB-2609-001', totalSen: 65000 }, reposted: true, jeNo: 'HC-JE-2609-031' }));
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
  useUpdateDebtorBill: () => ({ mutateAsync: updateBillAsync, isPending: false }),
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
const dialog = () => screen.getByRole('dialog');
/* MoneyInput commits on blur and re-dresses at rest (1,800.00). */
const setAmount = (scope: HTMLElement, label: string, rm: string) => {
  const box = within(scope).getByLabelText(label);
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: rm } });
  fireEvent.blur(box);
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const baseDetail = () => ({
  debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: '012-345', notes: null, is_active: true, outstanding_sen: 50000 },
  bills: [
    {
      id: 'b1', bill_number: 'HC-ODB-2609-001', bill_date: '2026-09-03', total_sen: 50000, received_sen: 20000, status: 'POSTED', notes: '转租九月',
      lines: [{ id: 'l1', line_no: 1, description: '转租', credit_account_code: '700-0000', amount_sen: 50000 }],
    },
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

describe('the Debtor Bill — a pop-out form whose lines pick their own account', () => {
  test('New bill opens a dialog; a filled line posts with the picked account, integer sen and the date', async () => {
    detail = baseDetail();
    createBillAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('New bill'));
    const d = dialog();
    expect(within(d).getByText(/New bill — AHMAD BIN ALI/)).toBeTruthy();
    fireEvent.change(within(d).getByPlaceholderText('Description'), { target: { value: '转租九月' } });
    fireEvent.focus(within(d).getByRole('combobox'));
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    setAmount(d, 'line 1 amount', '450');
    await waitFor(() => expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('450.00'));
    fireEvent.click(within(d).getByText('Post bill'));
    await waitFor(() => expect(createBillAsync).toHaveBeenCalledTimes(1));
    const sent = createBillAsync.mock.calls[0]![0] as { debtorId: string; billDate: string; lines: unknown[] };
    expect(sent.debtorId).toBe('d1');
    expect(sent.billDate).toMatch(ISO_DATE);
    expect(sent.lines).toEqual([{ description: '转租九月', creditAccountCode: '700-0000', amountSen: 45000 }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test("the lines are a table in the owner's order; Insert adds a line and lands on its account; Enter on an amount moves down; a line can be removed", () => {
    detail = baseDetail();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    fireEvent.click(screen.getByText('New bill'));
    const d = dialog();
    const amountHead = within(d).getByText('Amount (RM)');
    expect([...amountHead.parentElement!.children].map((c) => c.textContent)).toEqual(['Account (credit)', 'Description', 'Amount (RM)', '']);

    fireEvent.keyDown(within(d).getByLabelText('line 1 amount'), { key: 'Insert' });
    expect(within(d).getByLabelText('line 2 amount')).toBeTruthy();
    const landed = document.activeElement as HTMLElement | null;
    expect(landed?.getAttribute('role')).toBe('combobox');
    expect(landed?.closest('tr')?.getAttribute('data-line')).toBe('2');

    fireEvent.keyDown(within(d).getByLabelText('line 2 amount'), { key: 'Enter' });
    expect(within(d).getByLabelText('line 3 amount')).toBeTruthy();
    expect((document.activeElement as HTMLElement | null)?.closest('tr')?.getAttribute('data-line')).toBe('3');

    fireEvent.click(within(d).getByLabelText('remove line 3'));
    expect(within(d).queryByLabelText('line 3 amount')).toBeNull();
  });

  test('Edit opens the bill with its lines, says it will re-post, caps the total at the money received, and sends everything on Save & re-post', async () => {
    detail = baseDetail();
    updateBillAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    fireEvent.click(screen.getByLabelText('Edit HC-ODB-2609-001'));
    const d = dialog();
    expect(within(d).getByText(/Edit HC-ODB-2609-001/)).toBeTruthy();
    expect(within(d).getByText(/saving re-posts it/)).toBeTruthy();
    expect(within(d).getByText(/is already received against it/)).toBeTruthy();
    expect((within(d).getByRole('combobox') as HTMLInputElement).value).toBe('700-0000 · Other Income');
    expect((within(d).getByLabelText('line 1 description') as HTMLInputElement).value).toBe('转租');
    expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('500.00');
    expect((within(d).getByLabelText('Bill description') as HTMLInputElement).value).toBe('转租九月');

    /* Below the RM 200 received → refused on the spot. */
    setAmount(d, 'line 1 amount', '100');
    await waitFor(() => expect(within(d).getByText(/^The total cannot fall below the RM 200\.00 already received\.$/)).toBeTruthy());
    expect((within(d).getByText('Save & re-post') as HTMLButtonElement).disabled).toBe(true);

    setAmount(d, 'line 1 amount', '650');
    await waitFor(() => expect(within(d).queryByText(/^The total cannot fall below the/)).toBeNull());
    expect((within(d).getByText('Save & re-post') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(d).getByText('Save & re-post'));
    await waitFor(() => expect(updateBillAsync).toHaveBeenCalledWith({
      billId: 'b1',
      body: { billDate: '2026-09-03', notes: '转租九月', lines: [{ description: '转租', creditAccountCode: '700-0000', amountSen: 65000 }] },
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('Copy starts a NEW bill from the old one — lines and description ride over, the date is today, and it posts afresh', async () => {
    detail = baseDetail();
    createBillAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    fireEvent.click(screen.getByLabelText('Copy HC-ODB-2609-001'));
    const d = dialog();
    expect(within(d).getByText(/copied from HC-ODB-2609-001/)).toBeTruthy();
    expect(within(d).queryByText(/saving re-posts it/)).toBeNull();
    expect((within(d).getByRole('combobox') as HTMLInputElement).value).toBe('700-0000 · Other Income');
    expect((within(d).getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('500.00');
    expect((within(d).getByLabelText('Bill date') as HTMLInputElement).value).not.toBe('03/09/2026');
    fireEvent.click(within(d).getByText('Post bill'));
    await waitFor(() => expect(createBillAsync).toHaveBeenCalledTimes(1));
    const sent = createBillAsync.mock.calls[0]![0] as { debtorId: string; billDate: string; notes?: string; lines: unknown[] };
    expect(sent.debtorId).toBe('d1');
    expect(sent.billDate).not.toBe('2026-09-03');
    expect(sent.notes).toBe('转租九月');
    expect(sent.lines).toEqual([{ description: '转租', creditAccountCode: '700-0000', amountSen: 50000 }]);
  });
});

describe('the Receipt — tick pays in full, type for partial, four layers gate', () => {
  test('tick fills the outstanding; typing narrows it; the payload carries the allocation', async () => {
    detail = baseDetail();
    createReceiptAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    fireEvent.click(screen.getByText('New receipt'));
    /* Tick = the full RM 300 outstanding (500 − 200 received), dressed 300.00. */
    fireEvent.click(screen.getByLabelText('Collect HC-ODB-2609-001 in full'));
    expect(screen.getByText(/Receiving MYR 300\.00/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('amount for HC-ODB-2609-001') as HTMLInputElement).value).toBe('300.00'));
    /* Type = partial. */
    setAmount(document.body, 'amount for HC-ODB-2609-001', '100');
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

  test('a bill with money received offers Edit and Copy but no Cancel', () => {
    detail = baseDetail();
    draw();
    fireEvent.click(screen.getByText('AHMAD BIN ALI'));
    expect(screen.getByLabelText('Edit HC-ODB-2609-001')).toBeTruthy();
    expect(screen.getByLabelText('Copy HC-ODB-2609-001')).toBeTruthy();
    expect(screen.queryByLabelText('Cancel HC-ODB-2609-001')).toBeNull();
  });
});
