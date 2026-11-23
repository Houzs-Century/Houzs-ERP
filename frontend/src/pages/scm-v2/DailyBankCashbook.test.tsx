// The Daily Bank's Cash book tab (owner 2026-11-23: 先做一个daily bank的一开始直接，
// 但不需要列实际差额。然后我每天会手动输入收到的金额; 付款就根据pv). Pinned: a receipt
// goes only to an account whose cash book has started by the day, in sen, with a
// note; change and delete go through the same hooks (delete asks first); a
// starting balance may be below zero; someone without the Finance write key, or a
// day still to come, gets no form. The routes and the board's arithmetic are
// pinned in backend/tests/dailyBankCashbook.test.ts and src/acc/daily-bank.test.ts.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CashbookDay } from './daily-bank-cashbook-queries';

const add = vi.fn();
const edit = vi.fn();
const del = vi.fn();
const save = vi.fn();
const remove = vi.fn();
const confirm = vi.fn(async () => true);
let day: CashbookDay;

vi.mock('./daily-bank-cashbook-queries', () => ({
  useDailyBankCashbook: () => ({ data: day, isLoading: false, isError: false, error: null }),
  useAddCashbookReceipt: () => ({ mutate: add, isPending: false }),
  useEditCashbookReceipt: () => ({ mutate: edit, isPending: false }),
  useDeleteCashbookReceipt: () => ({ mutate: del, isPending: false }),
  useSaveCashbookStart: () => ({ mutate: save, isPending: false }),
  useRemoveCashbookStart: () => ({ mutate: remove, isPending: false }),
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/ConfirmDialog')>()),
  useConfirm: () => confirm,
}));
vi.mock('./EntityHistoryPanel', () => ({
  EntityHistoryPanel: (p: { entityType: string; entityId: string; recordLabel: string }) => (
    <div role="dialog" aria-label="History">{`${p.entityType}|${p.entityId}|${p.recordLabel}`}</div>
  ),
}));

import { DailyBankCashbook, openOn, rmToSen, typedLine } from './DailyBankCashbook';

const DAY = '2026-11-25';
const receipt = (over: Partial<CashbookDay['receipts'][number]>): CashbookDay['receipts'][number] => ({
  id: 'r1', accountCode: '310-0010', accountName: 'CASH AT BANK - MAYBANK', date: DAY, amountSen: 300_000, note: 'Hookka deposit',
  createdBy: 'Chew', createdAt: '2026-11-25T02:15:00Z', updatedBy: null, updatedAt: '2026-11-25T02:15:00Z',
  deletedBy: null, deletedAt: null, counted: true, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  day = {
    date: DAY, today: DAY, canWrite: true,
    accounts: [
      { accountCode: '310-0010', accountName: 'CASH AT BANK - MAYBANK', start: { date: '2026-11-24', balanceSen: 77_408_649, note: 'statement 23/11', setBy: 'Chew', setAt: '2026-11-24T01:00:00Z' } },
      { accountCode: '310-0020', accountName: 'CASH AT BANK - HLBB', start: { date: '2026-11-30', balanceSen: 5_000_000, note: null, setBy: 'Chew', setAt: '2026-11-24T01:00:00Z' } },
      { accountCode: '310-0030', accountName: 'CASH AT BANK - ALLIANCE', start: null },
    ],
    receipts: [receipt({}), receipt({ id: 'r2', amountSen: 12_000, note: 'Cash sales showroom', updatedBy: 'Mei' })],
    deleted: [receipt({ id: 'r3', amountSen: 9_000, note: 'typo', deletedBy: 'Chew', deletedAt: '2026-11-25T03:00:00Z', counted: false })],
  };
});

const renderTab = (date = DAY, today = DAY) => render(<DailyBankCashbook date={date} today={today} />);

describe('rmToSen', () => {
  test('plain amounts with at most two decimals, commas and RM allowed; a minus only where asked', () => {
    expect(rmToSen('1,234.50', { negative: false })).toBe(123_450);
    expect(rmToSen('RM 10', { negative: false })).toBe(1_000);
    expect(rmToSen('0.1', { negative: false })).toBe(10);
    expect(rmToSen('-5', { negative: false })).toBeNull();
    expect(rmToSen('-2,500.00', { negative: true })).toBe(-250_000);
    expect(rmToSen('1.234', { negative: false })).toBeNull();
    expect(rmToSen('abc', { negative: false })).toBeNull();
    expect(rmToSen('', { negative: false })).toBeNull();
  });

  test('a receipt goes only to an account whose cash book has started by the day', () => {
    expect(openOn(day.accounts, DAY).map((a) => a.accountCode)).toEqual(['310-0010']);
    expect(openOn(day.accounts, '2026-11-30').map((a) => a.accountCode)).toEqual(['310-0010', '310-0020']);
  });

  test('who typed a receipt, at what time (Malaysia), and who changed it', () => {
    expect(typedLine(receipt({}))).toBe('Chew · 10:15');
    expect(typedLine(receipt({ updatedBy: 'Mei' }))).toBe('Chew · 10:15 · changed by Mei');
  });
});

describe('DailyBankCashbook — money received', () => {
  test('type a receipt: the started account, the amount in sen, the note trimmed', () => {
    renderTab();
    const form = screen.getByRole('form', { name: 'Type a receipt' });
    const account = within(form).getByLabelText('Account received into') as HTMLSelectElement;
    expect([...account.options].map((o) => o.value)).toEqual(['310-0010']);
    const addButton = within(form).getByRole('button', { name: /Add receipt/ }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Amount received'), { target: { value: '3,000.00' } });
    expect(addButton.disabled).toBe(true);   // no note yet
    fireEvent.change(within(form).getByLabelText('Who paid or what for'), { target: { value: '  Hookka deposit SO-1234 ' } });
    fireEvent.click(addButton);
    expect(add).toHaveBeenCalledWith({ accountCode: '310-0010', date: DAY, amountSen: 300_000, note: 'Hookka deposit SO-1234' }, expect.anything());
  });

  test('the day lists what was typed, who typed it, and what was deleted', () => {
    renderTab();
    const card = screen.getByLabelText('Money received');
    expect(card.textContent).toContain('2 typed · RM 3,120.00 on the Board');
    expect(card.textContent).toContain('Chew · 10:15 · changed by Mei');
    expect(within(card).getByText('Deleted this day (1)')).toBeTruthy();
    expect(card.textContent).toContain('Deleted by Chew');
  });

  test('change a receipt: the new amount in sen, same id', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Change receipt Cash sales showroom' }));
    const amount = screen.getByLabelText('Amount') as HTMLInputElement;
    expect(amount.value).toBe('120.00');
    fireEvent.change(amount, { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(edit).toHaveBeenCalledWith({ id: 'r2', accountCode: '310-0010', date: DAY, amountSen: 15_000, note: 'Cash sales showroom' }, expect.anything());
  });

  test('delete asks first, then deletes', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Delete receipt Hookka deposit' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith({ id: 'r1' }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete RM 3,000.00 into 310-0010?', danger: true }));
  });

  test('a receipt before its account\'s start is flagged as not on the Board', () => {
    day.receipts = [receipt({ counted: false })];
    renderTab();
    expect(screen.getByText("Not on the Board: before this account's start")).toBeTruthy();
  });

  test('its history opens on the receipt', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'History of receipt Hookka deposit' }));
    expect(screen.getByRole('dialog', { name: 'History' }).textContent).toBe('DAILY_BANK_RECEIPT|r1|310-0010 · 2026/11/25 · RM 3,000.00');
  });

  test('no form without the Finance write key, nor for a day still to come', () => {
    day.canWrite = false;
    renderTab();
    expect(screen.queryByRole('form', { name: 'Type a receipt' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change receipt/ })).toBeNull();
    expect(screen.getByText(/changing it needs Finance’s posting permission/)).toBeTruthy();
    day.canWrite = true;
    renderTab('2026-11-26', DAY);
    expect(screen.queryByRole('form', { name: 'Type a receipt' })).toBeNull();
    expect(screen.getByText('This day hasn’t happened yet. Money is typed once it is received.')).toBeTruthy();
  });
});

describe('DailyBankCashbook — starting balances', () => {
  test('each account says what the Board shows for it', () => {
    renderTab();
    const card = screen.getByLabelText('Starting balances');
    expect(card.textContent).toContain('2 of 3 accounts use the cash book');
    const rows = [...card.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].slice(0, 4).map((td) => td.textContent));
    expect(rows).toEqual([
      ['310-0010 CASH AT BANK - MAYBANK', '2026/11/24', '774,086.49', 'Cash book statement 23/11 · set by Chew'],
      ['310-0020 CASH AT BANK - HLBB', '2026/11/30', '50,000.00', 'Cash book set by Chew'],
      ['310-0030 CASH AT BANK - ALLIANCE', 'Not set', '', 'Ledger no starting balance: the Board shows the ledger'],
    ]);
  });

  test('set a start: the page\'s day, the balance in sen (an overdrawn one below zero)', () => {
    renderTab();
    fireEvent.click(within(screen.getByLabelText('Starting balances')).getAllByRole('button', { name: /Set start/ })[0]!);
    fireEvent.change(screen.getByLabelText('310-0030 balance at the start of the day'), { target: { value: '-2,500.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save start' }));
    expect(save).toHaveBeenCalledWith({ accountCode: '310-0030', startDate: DAY, balanceSen: -250_000, note: null }, expect.anything());
  });

  test('change keeps what is there until it is typed over', () => {
    renderTab();
    fireEvent.click(within(screen.getByLabelText('Starting balances')).getAllByRole('button', { name: /Change/ })[0]!);
    expect((screen.getByLabelText('310-0010 balance at the start of the day') as HTMLInputElement).value).toBe('774086.49');
    expect((screen.getByLabelText('310-0010 note') as HTMLInputElement).value).toBe('statement 23/11');
    fireEvent.click(screen.getByRole('button', { name: 'Save start' }));
    expect(save).toHaveBeenCalledWith({ accountCode: '310-0010', startDate: '2026-11-24', balanceSen: 77_408_649, note: 'statement 23/11' }, expect.anything());
  });

  test('remove asks first, then puts the account back on the ledger', async () => {
    renderTab();
    fireEvent.click(within(screen.getByLabelText('Starting balances')).getAllByRole('button', { name: /Remove/ })[0]!);
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ accountCode: '310-0010' }, expect.anything()));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Remove 310-0010's starting balance?", danger: true }));
  });
});
