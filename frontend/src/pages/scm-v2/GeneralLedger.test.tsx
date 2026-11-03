// The General Ledger the AutoCount way (owner 2026-09-14; docs/bugs/0924), in
// the owner's redesign (batch 6 §2).
//
// Pinned: the page reads its filters off the URL (the statements open it on
// an account and a period); one block per account — code, name, line count
// and its figures on the head row — then Balance b/f, the lines with a running
// balance and its side (Dr / Cr), the account's Total, and the Grand total;
// the other side prints as an account (code over name) with "+N" when more
// stand beside it; a reversed line is marked; Show reversed and the picked
// accounts are written back to the URL and asked of the server; a block folds;
// a long block shows 200 lines until asked for all; an entry's number opens
// its card; a report's figure leaves a way back.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { LedgerLine, LedgerParams, LedgerReport } from '../../vendor/scm/lib/ledger-queries';

const { useAccounts, useLedger, useJournalEntryCard } = vi.hoisted(() => ({ useAccounts: vi.fn(), useLedger: vi.fn(), useJournalEntryCard: vi.fn() }));

vi.mock('../../vendor/scm/lib/accounting-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAccounts,
}));
vi.mock('../../vendor/scm/lib/ledger-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLedger,
}));
vi.mock('./accounting-phase1-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), useJournalEntryCard,
}));

import { BLOCK_CUT, GeneralLedger, accountsLabel, ledgerParamsFromSearch } from './GeneralLedger';
import { balanceSide, ledgerSheet } from './books/ledger-sheet';

const wrap = (ui: ReactNode, at: string | { pathname: string; search: string; state: unknown }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter>
  </QueryClientProvider>
);

const REPORT: LedgerReport = {
  from: '2026-08-01', to: '2026-08-31', showReversed: false,
  scope: { codes: ['310-0010'], fromCode: null, toCode: null, all: false },
  blocks: [{
    code: '310-0010', name: 'CASH AT BANK - MAYBANK', type: 'ASSET', openingSen: 100_000,
    lines: [
      { lineId: 'l1', date: '2026-08-10', jeNo: '2990-JE-2608-0002', jeId: 'je-2', journal: 'BANK', counter: { code: '900-A001', name: 'ADVERTISEMENT', more: 0 }, doc: '2990-HPV-2608-017', doc2: null, description: 'Facebook ads August — LOO WEN WEI', who: 'LOO WEN WEI', debitSen: 0, creditSen: 30_000, balanceSen: 70_000, reversal: '' },
      { lineId: 'l2', date: '2026-08-12', jeNo: '2990-JE-2608-0003', jeId: 'je-3', journal: 'SALES', counter: { code: '300-0000', name: 'ACCOUNT RECEIVEABLE', more: 1 }, doc: '2990-SI-2608-001', doc2: '2990-SO-2608-067', description: 'Sales invoice 2990-SI-2608-001 — NG KAH YEE', who: 'NG KAH YEE', debitSen: 200_000, creditSen: 0, balanceSen: 270_000, reversal: '' },
    ],
    debitSen: 200_000, creditSen: 30_000, closingSen: 270_000,
  }],
  totals: { debitSen: 200_000, creditSen: 30_000 },
};
const WITH_PAIR: LedgerReport = {
  ...REPORT, showReversed: true,
  blocks: [{
    ...REPORT.blocks[0]!,
    lines: [...REPORT.blocks[0]!.lines, { lineId: 'l3', date: '2026-08-20', jeNo: '2990-JE-2608-0004', jeId: 'je-4', journal: 'BANK', counter: { code: '300-0000', name: 'ACCOUNT RECEIVEABLE', more: 0 }, doc: '2990-SO-2608-004', doc2: null, description: 'Payment transfer on 2990-SO-2608-004 — keyed twice', who: 'Keyed Twice', debitSen: 161_000, creditSen: 0, balanceSen: 270_000, reversal: 'reversed' }],
  }],
};

beforeEach(() => {
  useAccounts.mockReturnValue({ data: { accounts: [
    { account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', is_active: true },
    { account_code: '900-A001', account_name: 'ADVERTISEMENT', account_type: 'EXPENSE', is_active: true },
  ] }, isLoading: false });
  useLedger.mockImplementation((p: LedgerParams) => ({ data: p.showReversed ? WITH_PAIR : REPORT, isLoading: false, isError: false, isSuccess: true }));
  useJournalEntryCard.mockReturnValue({ data: undefined, isLoading: true, isError: false });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const rowsOf = (el: Element) => Array.from(el.querySelectorAll<HTMLElement>('[data-cw-row]'));

describe('ledgerParamsFromSearch — the URL is the filter', () => {
  it('reads the account, the period and the switch; a missing period is this month to today', () => {
    const p = ledgerParamsFromSearch(new URLSearchParams('tab=gl&accounts=310-0010,900-A001&from=2026-08-01&to=2026-08-31&showReversed=1'));
    expect(p).toMatchObject({ from: '2026-08-01', to: '2026-08-31', accounts: ['310-0010', '900-A001'], showReversed: true });
    const d = ledgerParamsFromSearch(new URLSearchParams('tab=gl'));
    expect(d.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(d.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.accounts).toEqual([]);
    expect(d.showReversed).toBe(false);
  });

  it('the Accounts button names what it shows', () => {
    expect(accountsLabel({ accounts: [] })).toBe('All');
    expect(accountsLabel({ accounts: ['310-0010'] })).toBe('310-0010');
    expect(accountsLabel({ accounts: ['310-0010', '900-A001'] })).toBe('2 accounts');
    expect(accountsLabel({ accounts: [], fromAccount: '300-0000', toAccount: '' })).toBe('300-0000 – …');
  });
});

describe('a balance reads as an amount and its side', () => {
  it('debit for assets and expenses, credit for the rest; the contrary side when it turns', () => {
    expect(balanceSide('ASSET', 70_000)).toEqual({ sen: 70_000, side: 'Dr' });
    expect(balanceSide('ASSET', -5_000)).toEqual({ sen: 5_000, side: 'Cr' });
    expect(balanceSide('INCOME', 150_000)).toEqual({ sen: 150_000, side: 'Cr' });
    expect(balanceSide('LIABILITY', -1)).toEqual({ sen: 1, side: 'Dr' });
    expect(balanceSide('EXPENSE', 0)).toEqual({ sen: 0, side: '' });
  });
});

describe('General Ledger — the page', () => {
  it('opens on the URL\'s account and period and prints the block the AutoCount way', () => {
    render(wrap(<GeneralLedger />, '/scm/accounting?tab=gl&accounts=310-0010&from=2026-08-01&to=2026-08-31'));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-08-01', to: '2026-08-31', accounts: ['310-0010'], showReversed: false }), true);
    const block = document.querySelector('[data-account="310-0010"]')!;
    expect(block).toBeTruthy();
    const rows = rowsOf(block);
    /* Head (code, name, count, figures), Balance b/f, two lines, Total. */
    expect(rows).toHaveLength(5);
    expect(rows[0]!.textContent).toContain('310-0010');
    expect(rows[0]!.textContent).toContain('CASH AT BANK - MAYBANK');
    expect(rows[0]!.textContent).toContain('2 lines');
    expect(rows[0]!.textContent).toContain('2,700.00 Dr');
    expect(rows[1]!.textContent).toContain('Balance b/f');
    expect(rows[1]!.textContent).toContain('2026/08/01');
    expect(rows[1]!.textContent).toContain('1,000.00 Dr');
    expect(rows[2]!.textContent).toContain('2990-JE-2608-0002');
    expect(rows[2]!.textContent).toContain('Bank');
    expect(rows[2]!.textContent).toContain('900-A001');
    expect(rows[2]!.textContent).toContain('ADVERTISEMENT');
    expect(rows[2]!.textContent).toContain('2990-HPV-2608-017');
    expect(rows[2]!.textContent).toContain('300.00');
    expect(rows[2]!.textContent).toContain('700.00 Dr');
    /* The invoice's other side: the debtor and one more. */
    expect(rows[3]!.textContent).toContain('300-0000');
    expect(rows[3]!.textContent).toContain('+1');
    expect(rows[3]!.textContent).toContain('2990-SO-2608-067');
    expect(rows[3]!.textContent).toContain('2,700.00 Dr');
    expect(rows[4]!.textContent).toContain('Total · 310-0010 CASH AT BANK - MAYBANK');
    expect(rows[4]!.textContent).toContain('2,000.00');
    expect(screen.getByText('Grand total · 1 account').closest('[data-cw-row]')!.textContent).toContain('2,000.00');
    expect(screen.getByText(/Reversed entries and their contras are left out/)).toBeTruthy();
    expect(document.querySelector('[data-cw-row][data-reversal]')).toBeNull();
    expect(screen.getByText('Finance · Books')).toBeTruthy();
    for (const label of ['Excel', 'PDF', 'Print']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
  });

  it('Show reversed: the pair is asked for, written to the URL, and the reversed line is marked', () => {
    render(wrap(<GeneralLedger />, '/scm/accounting?tab=gl&accounts=310-0010&from=2026-08-01&to=2026-08-31'));
    fireEvent.click(screen.getByRole('switch', { name: 'Show reversed' }));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: ['310-0010'], showReversed: true }), true);
    const marked = document.querySelector('[data-cw-row][data-reversal="reversed"]')!;
    expect(marked).toBeTruthy();
    expect(marked.textContent).toContain('2990-JE-2608-0004');
    expect(marked.textContent).toContain('reversed');
    expect(screen.getByText(/listed and marked; they move no balance/)).toBeTruthy();
  });

  it('an account removed from the chips leaves the URL and the request; the picker ticks and clears', () => {
    render(wrap(<GeneralLedger />, '/scm/accounting?tab=gl&accounts=310-0010,900-A001&from=2026-08-01&to=2026-08-31'));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: ['310-0010', '900-A001'] }), true);
    fireEvent.click(screen.getByLabelText('Remove 900-A001'));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: ['310-0010'] }), true);
    fireEvent.click(screen.getByRole('button', { name: /Accounts/ }));
    const pop = screen.getByRole('dialog', { name: 'Pick accounts' });
    expect(within(pop).getByText('Untick the accounts to use a range.')).toBeTruthy();
    fireEvent.click(within(pop).getByRole('menuitemcheckbox', { name: /900-A001/ }));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: ['310-0010', '900-A001'] }), true);
    fireEvent.change(within(pop).getByLabelText('Find an account'), { target: { value: 'zzz' } });
    expect(within(pop).getByText('No account matches.')).toBeTruthy();
    fireEvent.click(within(pop).getByRole('button', { name: 'All accounts' }));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: [] }), true);
    expect(screen.getByText(/Every account with a balance or a movement/)).toBeTruthy();
  });

  it('a block folds; Collapse all and Expand all fold every block', () => {
    render(wrap(<GeneralLedger />, '/scm/accounting?tab=gl&accounts=310-0010&from=2026-08-01&to=2026-08-31'));
    const block = () => document.querySelector('[data-account="310-0010"]')!;
    fireEvent.click(rowsOf(block())[0]!);
    expect(rowsOf(block())).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(rowsOf(block())).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(rowsOf(block())).toHaveLength(1);
  });

  it('a long block shows 200 lines until asked for all', () => {
    const many: LedgerLine[] = Array.from({ length: BLOCK_CUT + 5 }, (_, i) => ({ ...REPORT.blocks[0]!.lines[0]!, lineId: `m${i}`, jeNo: `2990-JE-2608-${String(i).padStart(4, '0')}` }));
    useLedger.mockReturnValue({ data: { ...REPORT, blocks: [{ ...REPORT.blocks[0]!, lines: many }] }, isLoading: false, isError: false });
    render(wrap(<GeneralLedger />, '/scm/accounting?tab=gl&accounts=310-0010&from=2026-08-01&to=2026-08-31'));
    expect(rowsOf(document.querySelector('[data-account="310-0010"]')!)).toHaveLength(BLOCK_CUT + 3);
    fireEvent.click(screen.getByRole('button', { name: `Show all ${BLOCK_CUT + 5} lines` }));
    expect(rowsOf(document.querySelector('[data-account="310-0010"]')!)).toHaveLength(BLOCK_CUT + 8);
  });

  it('an entry’s number opens its card; a report’s figure leaves a way back; bad dates say so', () => {
    render(wrap(<GeneralLedger />, { pathname: '/scm/accounting', search: '?tab=gl&accounts=310-0010&from=2026-08-01&to=2026-08-31', state: { back: { to: '/scm/accounting?tab=pnl', label: 'P&L' } } }));
    expect(screen.getByRole('button', { name: 'P&L' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2990-JE-2608-0002' }));
    expect(useJournalEntryCard).toHaveBeenLastCalledWith('je-2');
    cleanup();
    render(wrap(<GeneralLedger />, '/scm/accounting?tab=gl&from=2026-09-30&to=2026-09-01'));
    expect(screen.getByText(/From is later than To/)).toBeTruthy();
    expect(useLedger).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it('the Excel sheet: each account bold, its b/f, its lines with the balance and its side, totals and the grand total', () => {
    const sheet = ledgerSheet(REPORT, '310-0010');
    expect(sheet.title).toBe('General ledger');
    const rows = sheet.tables[0]!.rows;
    expect(rows[0]).toMatchObject({ kind: 'category', label: '310-0010 CASH AT BANK - MAYBANK' });
    expect(rows[1]).toMatchObject({ label: 'Balance b/f', cells: ['2026/08/01', '', '', '', '', '', '', '', 100_000, 'Dr'] });
    expect(rows[2]).toMatchObject({ kind: 'row', depth: 1, label: '2990-JE-2608-0002' });
    expect(rows[2]!.cells.slice(6)).toEqual(['', 30_000, 70_000, 'Dr']);
    expect(rows[4]).toMatchObject({ kind: 'total', label: 'Total · 310-0010 CASH AT BANK - MAYBANK' });
    expect(rows[5]).toMatchObject({ kind: 'net', label: 'Grand total · 1 account' });
  });
});
