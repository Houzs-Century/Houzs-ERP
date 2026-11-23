// The cash book's Daily Bank (owner 2026-11-23: 原版的daily bank还是要保留哦，我这算是新的
// daily bank): its own page, the original's frame on the cash-book board — Board,
// Accounts, Receipts & starts. Pinned: it reads only the cash-book board, never the
// original's; a bank's card says since when it is on the cash book; a typed receipt
// is called by its note; the banks not on it yet are named, with the way to start
// them. The board's arithmetic is pinned in backend/src/acc/daily-bank.test.ts.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { DailyBankBoard } from './accounting-phase1-queries';

const CASH: DailyBankBoard = {
  date: '2026-11-25',
  blocks: [{
    accountCode: '310-0010', accountName: 'CASH AT BANK - MAYBANK', start: { date: '2026-11-24', balanceSen: 10_000_000 },
    openingSen: 10_000_000, inSen: 300_000, outSen: 120_050, closingSen: 10_179_950,
    receipts: [{ jeNo: '', sourceType: 'TYPED', sourceDocNo: 'r1', docNo: '', party: null, note: 'Hookka deposit', amountSen: 300_000, method: null, typedBy: 'Chew' }],
    payouts: [{ jeNo: '', sourceType: 'PV', sourceDocNo: 'pv-1', docNo: 'HPV-101', party: 'UNICOM', note: 'Truck rental · incl. bank charge RM 0.50', amountSen: 120_050, method: null }],
    pending: [{ id: 'pv-2', pvNumber: 'HPV-102', payee: 'UMOBILE', description: 'Phone bill', voucherDate: '2026-11-25', accountCode: '310-0010', amountSen: 80_000 }],
    pendingSen: 80_000, availableSen: 10_099_950, transit: [], transitSen: 0, availableWithTransitSen: 10_099_950,
  }],
  transit: [],
  totalClosingSen: 10_179_950, totalTransitSen: 0, pendingApprovalSen: 80_000, availableSen: 10_099_950,
  unassignedTransit: [], unassignedPending: [],
  book: 'cashbook',
  notStarted: [{ accountCode: '310-0020', accountName: 'CASH AT BANK - HLBB', startDate: null }],
  note: 'The cash book: test note.',
};

const original = vi.fn();
vi.mock('./accounting-phase1-queries', () => ({
  useDailyBank: (date: string) => { original(date); return { data: undefined, isLoading: false, isError: false, error: null }; },
  useDailyClose: () => ({ data: { rows: [] }, isLoading: false }),
  useSaveDailyClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirmDailyClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./daily-bank-cashbook-queries', () => ({
  useDailyBankCashbookBoard: () => ({ data: CASH, isLoading: false, isError: false, error: null }),
  useDailyBankCashbook: (date: string) => ({ data: { date, today: date, canWrite: true, accounts: [
    { accountCode: '310-0010', accountName: 'CASH AT BANK - MAYBANK', start: { date: '2026-11-24', balanceSen: 10_000_000, note: null, setBy: 'Chew', setAt: null } },
    { accountCode: '310-0020', accountName: 'CASH AT BANK - HLBB', start: null },
  ], receipts: [], deleted: [], methods: [{ key: 'online', label: 'Online' }] }, isLoading: false, isError: false, error: null }),
  useAddCashbookReceipt: () => ({ mutate: vi.fn(), isPending: false }),
  useEditCashbookReceipt: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCashbookReceipt: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveCashbookStart: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveCashbookStart: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveCashbookDay: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/ConfirmDialog')>()),
  useConfirm: () => async () => true,
}));
vi.mock('../../hooks/useBranding', () => ({ useBranding: () => ({ companyName: 'Houzs Century Sdn Bhd' }) }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Mei Ling' } }) }));
vi.mock('./finance/finance-todo-queries', () => ({ useTodoCalendar: (month: string) => ({ data: { month, events: [] } }) }));

import { DailyBankCashbookPage } from './DailyBank';

const Where = () => <span data-testid="where">{useLocation().search}</span>;
const renderAt = (search: string) => render(
  <MemoryRouter initialEntries={[`/scm/daily-bank-cashbook${search}`]}><DailyBankCashbookPage /><Where /></MemoryRouter>,
);

describe('Daily Bank (cash book) — its own page beside the original', () => {
  test('reads only the cash-book board; its views are Board, Accounts and Receipts & starts', () => {
    renderAt('?view=board');
    expect(screen.getByRole('heading', { name: 'Daily Bank (cash book)' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'View' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Board', 'Accounts', 'Receipts & starts']);
    expect(original).not.toHaveBeenCalled();
    const hero = screen.getByLabelText('Can move today');
    expect(within(hero).getByText('RM 100,999.50')).toBeTruthy();
  });

  test('a bank says since when it is on the cash book; a typed receipt is called by its note, a voucher by its payee', () => {
    renderAt('?view=board');
    const accounts = screen.getByLabelText('Accounts');
    expect(within(accounts).getByText('Cash book since 2026/11/24')).toBeTruthy();
    expect(within(accounts).getByText('Hookka deposit')).toBeTruthy();
    expect(within(accounts).getByText('+3,000.00')).toBeTruthy();
    expect(within(accounts).getByText('UNICOM')).toBeTruthy();
    expect(within(accounts).getByText('−1,200.50')).toBeTruthy();
    expect(screen.getByText(/^Your cash book; the original Daily Bank is unchanged\./)).toBeTruthy();
  });

  test('the banks not on it yet are named, and lead to Receipts & starts', async () => {
    renderAt('?view=board');
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('Not on the cash book yet, so not in these totals: CASH AT BANK - HLBB.');
    fireEvent.click(within(note).getByRole('button', { name: 'Open Receipts & starts' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?view=entries'));
    expect(screen.getByLabelText('Starting balances')).toBeTruthy();
  });

  test('the Accounts sheet lists a typed receipt by its note and who typed it', () => {
    renderAt('?view=accounts');
    const may = screen.getByLabelText('310-0010 CASH AT BANK - MAYBANK');
    expect(may.textContent).toContain('Cash book since 2026/11/24');
    const rows = [...may.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].slice(1).map((td) => td.textContent));
    expect(rows).toEqual([
      ['', 'Hookka deposit · typed by Chew', '', '3,000.00', ''],
      ['HPV-101', 'UNICOM · Truck rental · incl. bank charge RM 0.50', '', '', '1,200.50'],
    ]);
  });

  test('under each bank: no card money, and a line between the rows (owner 2026-11-23: 这个可以不要出现吗？然后我要有线条)', () => {
    renderAt('?view=accounts');
    const may = screen.getByLabelText('310-0010 CASH AT BANK - MAYBANK');
    expect(may.textContent).not.toMatch(/In transit/);
    const strip = may.querySelector('[class*="afterStrip"]')!;
    expect(strip.className).toMatch(/afterRuled/);
    expect([...strip.children].map((r) => r.textContent)).toEqual([
      '· Awaiting approval · UMOBILE · HPV-102−800.00',
      'Available (after pending)100,999.50',
    ]);
  });

  test('an address with the original\'s Daily close view opens the Board here', async () => {
    renderAt('?view=close');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?view=board'));
  });
});
