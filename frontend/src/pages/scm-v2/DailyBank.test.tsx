// The Daily Bank page's render contract, by bank (owner 2026-09-29, his "BANK
// BALANCE AVAILABLE" sample): the three totals stay on top; under a dark bar
// with the day, one table per money account with its Bank Balance in the
// header — Balance B/F, Received today, Paid today, Pending payment,
// Available (after pending), In transit per acquirer, Available + in transit —
// and a last section for what names no bank; Get image / PNG / PDF.
// The hook is mocked at the module seam — the board arithmetic is pinned in
// backend/src/acc/daily-bank.test.ts, the route's names and numbers in
// backend/tests/dailyBankByBank.test.ts, the table model in daily-bank-report.test.ts.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { DailyBankBoard } from './accounting-phase1-queries';

const BOARD: DailyBankBoard = {
  date: '2026-09-29',
  blocks: [
    {
      accountCode: '310-0020', accountName: 'CASH AT BANK - HLBB',
      openingSen: 6_172_699, inSen: 285_000, outSen: 44_264, closingSen: 6_413_435,
      receipts: [{ jeNo: 'JE-2', sourceType: 'SOPAY', sourceDocNo: 'pay-1', docNo: '2990-MOR-2609-009', party: 'Hookka', note: 'Settle invoice HV-INV-0039', amountSen: 285_000 }],
      payouts: [{ jeNo: 'JE-4', sourceType: 'PV', sourceDocNo: 'PV-0432', docNo: 'PV-0432', party: 'Tan Yong Hong', note: 'Claude - Sep', amountSen: 44_264 }],
      pending: [{ id: 'pv-1', pvNumber: '2990-HPV-2609-023', payee: 'UNICOM MARKETING SDN BHD', description: 'BILL IV2026-09-007', voucherDate: '2026-09-18', accountCode: '310-0020', amountSen: 1_083_600 }],
      pendingSen: 1_083_600, availableSen: 5_329_835,
      transit: [{ acquirerCode: 'PBB', accountCode: '326-0010', accountName: 'CARD MACHINE CLEARING — PBB', balanceSen: 3_750_352, bankAccountCode: '310-0020' }],
      transitSen: 3_750_352, availableWithTransitSen: 9_080_187,
    },
    {
      accountCode: '310-0030', accountName: 'CASH AT BANK - ALLIANCE',
      openingSen: 2_433_855, inSen: 0, outSen: 0, closingSen: 2_433_855, receipts: [], payouts: [],
      pending: [], pendingSen: 0, availableSen: 2_433_855, transit: [], transitSen: 0, availableWithTransitSen: 2_433_855,
    },
  ],
  transit: [
    { acquirerCode: 'PBB', accountCode: '326-0010', accountName: 'CARD MACHINE CLEARING — PBB', balanceSen: 3_750_352, bankAccountCode: '310-0020' },
    { acquirerCode: '未标银行', accountCode: '326-0000', accountName: 'CARD MACHINE CLEARING (EDC)', balanceSen: 336_500, bankAccountCode: null },
  ],
  totalClosingSen: 8_847_290,
  totalTransitSen: 4_086_852,
  pendingApprovalSen: 1_083_600,
  availableSen: 7_763_690,
  unassignedTransit: [{ acquirerCode: '未标银行', accountCode: '326-0000', accountName: 'CARD MACHINE CLEARING (EDC)', balanceSen: 336_500, bankAccountCode: null }],
  unassignedPending: [],
  note: 'test note',
};

vi.mock('./accounting-phase1-queries', () => ({
  useDailyBank: () => ({ data: BOARD, isLoading: false, isError: false, error: null }),
  useDailyClose: () => ({ data: { rows: [] }, isLoading: false }),
  useSaveDailyClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirmDailyClose: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
const pdfMock = vi.fn(async (_b: unknown) => undefined);
vi.mock('./daily-bank-pdf', () => ({ generateDailyBankPdf: (b: unknown) => pdfMock(b) }));

import { DailyBank } from './DailyBank';
import { accountLines } from './DailyBankAccounts';

/** Where the page has put the address — the view lives in it. */
const Where = () => <span data-testid="where">{useLocation().search}</span>;
const renderAt = (search: string) => render(<MemoryRouter initialEntries={[`/scm/daily-bank${search}`]}><DailyBank /><Where /></MemoryRouter>);

describe('DailyBank Accounts, a block per account', () => {
  test('a bank: its opening, the day in and out, the subtotal and the closing, then what awaits approval and its card money', () => {
    renderAt('?view=accounts');
    const hlb = screen.getByLabelText('310-0020 CASH AT BANK - HLBB');
    expect(within(hlb).getByText('61,726.99')).toBeTruthy();
    const rows = [...hlb.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].slice(1).map((td) => td.textContent));
    expect(rows).toEqual([
      ['2990-MOR-2609-009', 'Customer payment · Hookka', 'JE-2', '2,850.00', ''],
      ['PV-0432', 'Tan Yong Hong · Claude - Sep', 'JE-4', '', '442.64'],
    ]);
    expect(hlb.querySelector('tfoot')?.textContent).toBe('Subtotal2,850.00442.64');
    expect(hlb.textContent).toContain('Closing balance 61,726.99 + 2,850.00 − 442.64');
    expect(hlb.textContent).toContain('64,134.35');
    expect(hlb.textContent).toContain('· Awaiting approval · UNICOM MARKETING SDN BHD · 2990-HPV-2609-023−10,836.00');
    expect(hlb.textContent).toContain('Available (after pending)53,298.35');
    expect(hlb.textContent).toContain('· In transit · PBB card money, not yet in this bank37,503.52');
    expect(hlb.textContent).toContain('Available + in transit90,801.87');
  });

  test('a quiet bank says so; all accounts close together; what names no bank waits at the end', () => {
    renderAt('?view=accounts');
    expect(within(screen.getByLabelText('310-0030 CASH AT BANK - ALLIANCE')).getByText('No movement this day.')).toBeTruthy();
    const all = screen.getByLabelText('Closing · all bank & cash');
    expect(all.textContent).toContain('Opening 86,065.54 + In 2,850.00 − Out 442.64 · 2 movements');
    expect(all.textContent).toContain('88,472.90');
    const loose = screen.getByLabelText('Not tied to a bank');
    expect(loose.textContent).toContain('In transit · 未标银行 card money · CARD MACHINE CLEARING (EDC)');
    expect(loose.textContent).toContain('3,365.00');
  });

  test('customer payments group by how they were paid; anything else stays one line per document', () => {
    const block = { ...BOARD.blocks[0]!, receipts: [
      { jeNo: 'JE-7', sourceType: 'SOPAY', sourceDocNo: 'p7', docNo: 'OR-7', party: 'Tan', note: '', amountSen: 10_000, method: 'cash' },
      { jeNo: 'JE-8', sourceType: 'SOPAY', sourceDocNo: 'p8', docNo: 'OR-8', party: 'Lim', note: '', amountSen: 5_000, method: 'cash' },
      { jeNo: 'JE-9', sourceType: 'SIPAY', sourceDocNo: 'p9', docNo: 'OR-9', party: 'Wong', note: '', amountSen: 7_000, method: 'online:DuitNow' },
      { jeNo: 'JE-10', sourceType: 'SETTLEBANK', sourceDocNo: 'SETTLEBANK-5-1', docNo: 'SETTLEBANK-5-1', party: null, note: 'MBB payout', amountSen: 90_000, method: null },
    ], payouts: [] };
    expect(accountLines(block).map((l) => [l.doc, l.description, l.inSen])).toEqual([
      ['2 receipts', 'Cash · 2 sales · Tan, Lim', 15_000],
      ['OR-9', 'Online · DuitNow · Wong', 7_000],
      ['SETTLEBANK-5-1', 'MBB payout', 90_000],
    ]);
  });

  test('a day still to come has not happened yet', () => {
    renderAt('?view=accounts&date=2999-01-01');
    expect(screen.getByText('This day hasn’t happened yet.')).toBeTruthy();
  });

  test('Get image, PNG and PDF: the PDF prints the board the page shows', async () => {
    renderAt('?view=board');
    expect(screen.getByRole('button', { name: /Get image/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /PNG/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    await waitFor(() => expect(pdfMock).toHaveBeenCalledWith(BOARD));
  });
});

describe("DailyBank Board (the redesign's Money today)", () => {
  test('no view in the address opens the Board and says so in the address', async () => {
    renderAt('');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?view=board'));
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('can move today is bank and cash less what awaits approval; card money on its way is said, not added', () => {
    renderAt('?view=board');
    const hero = screen.getByLabelText('Can move today');
    expect(within(hero).getByText('RM 77,636.90')).toBeTruthy();
    expect(within(hero).getByText('RM 88,472.90')).toBeTruthy();
    expect(within(hero).getByText('RM 10,836.00')).toBeTruthy();
    expect(hero.textContent).toContain('RM 40,868.52 is on its way from card machines. Not spendable until it lands.');
    const bridge = screen.getByLabelText('How the day got here');
    expect([...bridge.children].map((r) => r.textContent)).toEqual([
      'Yesterday86,065.54', '+ In today2,850.00', '− Out today442.64', 'Bank & cash now88,472.90', '− Awaiting approval10,836.00', 'Can move today77,636.90',
    ]);
  });

  test('each account shows its day; one opens the Accounts sheet at its block', async () => {
    renderAt('?view=board');
    const accounts = screen.getByLabelText('Accounts');
    expect(within(accounts).getByText('Hookka')).toBeTruthy();
    expect(within(accounts).getByText('+2,850.00')).toBeTruthy();
    expect(within(accounts).getByText('−442.64')).toBeTruthy();
    expect(within(accounts).getByText('No movement today')).toBeTruthy();
    fireEvent.click(within(accounts).getAllByTitle('See every movement of this account')[0]!);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?view=accounts'));
    expect((document.querySelector('[data-account="310-0020"]') as HTMLElement).className).toMatch(/focused/);
  });

  test('card money on its way, and the vouchers awaiting approval with the way to them', () => {
    renderAt('?view=board');
    const transit = screen.getByLabelText('On its way · card machines');
    expect(within(transit).getByText('PBB')).toBeTruthy();
    expect(within(transit).getByText('RM 37,503.52')).toBeTruthy();
    expect(within(transit).getByText('未标银行')).toBeTruthy();
    const awaiting = screen.getByLabelText('Awaiting your approval');
    expect(awaiting.textContent).toContain('UNICOM MARKETING SDN BHD · BILL IV2026-09-007 · 2990-HPV-2609-023');
    expect(within(awaiting).getByRole('link', { name: /Review vouchers/ }).getAttribute('href')).toBe('/scm/payment-vouchers?status=CHECKED');
  });
});
