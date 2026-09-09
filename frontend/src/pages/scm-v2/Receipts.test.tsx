/* Receipts — the page contract (owner 2026-09-03): one month-windowed list of
   GENERAL + DEBTOR + CUSTOMER money-in; general receipts raise here (录入即
   过账, payer typed free) and void by reversal. The server half is
   backend/tests/receipts.test.ts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createAsync = vi.fn(async (_b: unknown) => ({ ok: true, receipt: { receiptNumber: 'HC-OR-2609-001', totalSen: 88800 } }));
const voidAsync = vi.fn(async (_id: unknown) => ({ ok: true }));
const updateAsync = vi.fn(async (_b: unknown) => ({ ok: true, reposted: true, jeNo: 'JE-2608-009', receipt: { receiptNumber: 'HC-OR-2609-001', totalSen: 88800, receiptDate: '2026-08-28' } }));

/* ONE stable object, as react-query would hand back — a fresh literal per
   render would re-fire the seeding effect forever. */
const DETAIL_G1 = {
  receipt: { id: 'g1', receipt_number: 'HC-OR-2609-001', payer_name: 'ALLIANZ INSURANCE', receipt_date: '2026-09-03', bank_account_code: '310-0010', total_sen: 88800, status: 'POSTED', notes: null },
  lines: [{ id: 'l1', line_no: 1, description: '车险赔偿', credit_account_code: '700-0000', amount_sen: 88800 }],
};
/* Which month the page asked the list for — undefined = every month. */
const receiptsAsked: Array<string | undefined> = [];
const LIST = { month: null, receipts: [
  { kind: 'GENERAL', id: 'g1', number: 'HC-OR-2609-001', date: '2026-09-03', payer: 'ALLIANZ INSURANCE', moneyAccount: '310-0010', totalSen: 88800, status: 'POSTED' },
  { kind: 'DEBTOR', id: 'dr1', number: 'HC-ODR-2609-001', date: '2026-09-02', payer: 'AHMAD BIN ALI', moneyAccount: '310-0010', totalSen: 20000, status: 'POSTED', debtorId: 'd1' },
  { kind: 'CUSTOMER', id: 'p1', number: 'HC-SO-2609-004', date: '2026-09-01', payer: 'Customer deposit', moneyAccount: 'EDC', totalSen: 350000, status: 'RECEIVED' },
] };
vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  /* The real pure helpers stay (postableAccounts — docs/bugs/0693); only the hooks are stubbed. */
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useReceiptDetail: (id: string | null) => ({ data: id === 'g1' ? DETAIL_G1 : undefined, isLoading: false }),
  useUpdateReceipt: () => ({ mutateAsync: updateAsync, isPending: false }),
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0010', account_name: 'MAYBANK', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
    { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useReceipts: (month?: string) => { receiptsAsked.push(month); return { data: LIST, isLoading: false }; },
  useCreateReceipt: () => ({ mutateAsync: createAsync, isPending: false }),
  useVoidReceipt: () => ({ mutateAsync: voidAsync, isPending: false }),
  /* The Other Debtor door (owner 2026-09-08): the registry, one debtor's open
     bills, and the raise-and-post mutation. */
  useOtherDebtors: () => ({ data: { debtors: [
    { id: 'd1', name: 'AHMAD BIN ALI', phone: null, notes: null, is_active: true, outstanding_sen: 30000 },
    { id: 'd2', name: 'OLD DEBTOR', phone: null, notes: null, is_active: false, outstanding_sen: 0 },
  ] }, isLoading: false }),
  useDebtorDetail: (id: string | null) => ({ data: id === 'd1' ? DETAIL_D1 : undefined, isLoading: false }),
  useCreateDebtorReceipt: () => ({ mutateAsync: debtorReceiptAsync, isPending: false }),
}));
const debtorReceiptAsync = vi.fn(async (_b: unknown) => ({ ok: true, posted: true, jeNo: 'HC-JE-2609-0007', receipt: { id: 'dr9', receiptNumber: 'HC-ODR-2609-002', totalSen: 30000 } }));
const DETAIL_D1 = {
  debtor: { id: 'd1', name: 'AHMAD BIN ALI', phone: null, notes: null, is_active: true, outstanding_sen: 30000 },
  bills: [
    { id: 'b1', bill_number: 'HC-ODB-2609-001', bill_date: '2026-09-01', total_sen: 50000, received_sen: 20000, status: 'POSTED', notes: null },
    { id: 'b0', bill_number: 'HC-ODB-2608-009', bill_date: '2026-08-20', total_sen: 10000, received_sen: 10000, status: 'PAID', notes: null },
  ],
  receipts: [],
};
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

  /* 月份只是筛选 (owner 2026-09-08): the page opens on every month; picking one
     narrows the list, and "All months" widens it again. */
  test('opens on every month; the month field filters and can be cleared', () => {
    receiptsAsked.length = 0;
    draw();
    expect(receiptsAsked[0]).toBeUndefined();
    expect((screen.getByLabelText('Month') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('All months')).toBeNull();
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-09' } });
    expect(receiptsAsked.at(-1)).toBe('2026-09');
    fireEvent.click(screen.getByText('All months'));
    expect(receiptsAsked.at(-1)).toBeUndefined();
  });

  /* 不可能链接起来吗? … receipt 页我也希望这样 → 用这个方式 (owner 2026-09-08):
     an Other Debtor's money is received from THIS New receipt — pick the
     debtor, tick the bill, Post — and it books at once through the debtor
     module's own route with postNow. */
  test('an Other Debtor\'s money is received here: the debtor\'s open bills, tick in full, Post books it in one call', async () => {
    debtorReceiptAsync.mockClear();
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New receipt'));
    fireEvent.click(screen.getByRole('radio', { name: 'Other Debtor' }));
    expect(screen.getByText('New receipt — Other Debtor — 录入即过账')).toBeTruthy();
    expect(screen.getByText('Pick the debtor to list what they still owe.')).toBeTruthy();
    /* The registry: active debtors only, what each still owes beside the name. */
    const debtor = screen.getByLabelText('Debtor') as HTMLSelectElement;
    expect([...debtor.options].map((o) => o.textContent)).toEqual(['— pick the debtor —', 'AHMAD BIN ALI — owes MYR 300.00']);
    fireEvent.change(debtor, { target: { value: 'd1' } });
    /* Only the bill with money outstanding is offered; the paid one is not. */
    expect(screen.getByText('HC-ODB-2609-001')).toBeTruthy();
    expect(screen.queryByText('HC-ODB-2608-009')).toBeNull();
    fireEvent.click(screen.getByLabelText('Collect HC-ODB-2609-001 in full'));
    expect(screen.getByText('Total MYR 300.00')).toBeTruthy();
    fireEvent.focus(screen.getByLabelText(/Received into/));
    fireEvent.mouseDown(screen.getByText('310-0010 · MAYBANK'));
    fireEvent.click(screen.getByText('Post receipt'));
    await waitFor(() => expect(debtorReceiptAsync).toHaveBeenCalledTimes(1));
    expect(debtorReceiptAsync.mock.calls[0]![0]).toMatchObject({
      debtorId: 'd1', bankAccountCode: '310-0010', postNow: true,
      allocations: [{ billId: 'b1', amountSen: 30000 }],
    });
    expect(createAsync).not.toHaveBeenCalled();
    /* The pop-out closes on the post. */
    await waitFor(() => expect(screen.queryByText(/录入即过账/)).toBeNull());
  });

  test('a general receipt raises with its own date, typed payer, picked bank and free-pick lines', async () => {
    createAsync.mockClear();
    draw();
    fireEvent.click(screen.getByText('New receipt'));
    /* The date is the receipt's own (owner 2026-09-07: 没办法输入日期) —
       typed day-first, sent ISO; the number's month follows it server-side. */
    const date = screen.getByLabelText('Receipt date') as HTMLInputElement;
    fireEvent.focus(date);
    fireEvent.change(date, { target: { value: '02092026' } });
    fireEvent.blur(date);
    expect(date.value).toBe('02/09/2026');
    fireEvent.change(screen.getByLabelText(/Received from/), { target: { value: 'ALLIANZ INSURANCE' } });
    const combos = screen.getAllByRole('combobox');
    fireEvent.focus(combos[0]!); // Received into — money only
    fireEvent.mouseDown(screen.getByText('310-0010 · MAYBANK'));
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: '车险赔偿' } });
    fireEvent.focus(screen.getAllByRole('combobox')[1]!);
    fireEvent.mouseDown(screen.getByText('700-0000 · Other Income'));
    /* MoneyInput commits on blur and re-dresses at rest (1,800.00 style). */
    const amount = screen.getByLabelText('line 1 amount') as HTMLInputElement;
    fireEvent.focus(amount);
    fireEvent.change(amount, { target: { value: '888' } });
    fireEvent.blur(amount);
    expect(amount.value).toBe('888.00');
    fireEvent.click(screen.getByText('Post receipt'));
    await waitFor(() => expect(createAsync).toHaveBeenCalledWith({
      payerName: 'ALLIANZ INSURANCE',
      receiptDate: '2026-09-02',
      bankAccountCode: '310-0010',
      lines: [{ description: '车险赔偿', creditAccountCode: '700-0000', amountSen: 88800 }],
    }));
  });

  test('the form opens on today and every control wears the one field dress (格子整齐)', () => {
    draw();
    fireEvent.click(screen.getByText('New receipt'));
    const date = screen.getByLabelText('Receipt date') as HTMLInputElement;
    expect(date.value).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    /* Payer, both account pickers, the description and the amount all carry
       the PV form's fieldInput class — no more bordered boxes beside bare
       selects (owner 2026-09-07: 有些有格子有些没有). */
    const dressed = [
      screen.getByLabelText(/Received from/),
      ...screen.getAllByRole('combobox'),
      screen.getByPlaceholderText('Description'),
      screen.getByLabelText('line 1 amount'),
    ];
    expect(dressed).toHaveLength(5);
    for (const el of dressed) expect(el.className, el.outerHTML.slice(0, 80)).toMatch(/fieldInput/);
    expect(date.closest('span')!.className).toMatch(/fieldInput/);
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

describe('edit a posted receipt and re-post (owner 2026-09-07: 收钱的日期错了 → 做 b)', () => {
  test('the pencil sits on GENERAL POSTED rows only, seeds the form from the receipt, and Save & re-post PATCHes the whole receipt', async () => {
    updateAsync.mockClear();
    draw();
    expect(screen.getAllByLabelText(/^Edit /)).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Edit HC-OR-2609-001'));
    await waitFor(() => expect(screen.getByText('Edit HC-OR-2609-001 — 改了会重新过账')).toBeTruthy());
    expect((screen.getByLabelText(/Received from/) as HTMLInputElement).value).toBe('ALLIANZ INSURANCE');
    const date = screen.getByLabelText('Receipt date') as HTMLInputElement;
    expect(date.value).toBe('03/09/2026');
    expect((screen.getByLabelText('line 1 amount') as HTMLInputElement).value).toBe('888.00');
    fireEvent.focus(date);
    fireEvent.change(date, { target: { value: '28082026' } });
    fireEvent.blur(date);
    fireEvent.click(screen.getByText('Save & re-post'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({
      id: 'g1',
      payerName: 'ALLIANZ INSURANCE',
      receiptDate: '2026-08-28',
      bankAccountCode: '310-0010',
      lines: [{ description: '车险赔偿', creditAccountCode: '700-0000', amountSen: 88800 }],
    }));
    /* The form closes and the next New starts clean. */
    await waitFor(() => expect(screen.queryByText(/改了会重新过账/)).toBeNull());
  });
});
