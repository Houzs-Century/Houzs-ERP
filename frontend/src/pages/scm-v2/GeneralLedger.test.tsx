// The General Ledger the AutoCount way (owner 2026-09-14; docs/bugs/0924).
//
// Pinned: the page reads its filters off the URL (the statements open it on
// an account and a period); one block per account with the code over the
// name, BALANCE B/F, the lines with a running balance, TOTAL, then the GRAND
// TOTAL; the other side prints as an account (code over name) with "+N" when
// more stand beside it; a reversed line is marked; the tick and an added
// account are written back to the URL and asked of the server.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { LedgerParams, LedgerReport } from '../../vendor/scm/lib/ledger-queries';

const { useAccounts, useLedger } = vi.hoisted(() => ({ useAccounts: vi.fn(), useLedger: vi.fn() }));

vi.mock('../../vendor/scm/lib/accounting-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAccounts,
}));
vi.mock('../../vendor/scm/lib/ledger-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLedger,
}));

import { GeneralLedger, ledgerParamsFromSearch } from './GeneralLedger';

const wrap = (ui: ReactNode, at: string) => (
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
      { lineId: 'l1', date: '2026-08-10', jeNo: '2990-JE-2608-0002', journal: 'BANK', counter: { code: '900-A001', name: 'ADVERTISEMENT', more: 0 }, doc: '2990-HPV-2608-017', doc2: null, description: 'Facebook ads August — LOO WEN WEI', who: 'LOO WEN WEI', debitSen: 0, creditSen: 30_000, balanceSen: 70_000, reversal: '' },
      { lineId: 'l2', date: '2026-08-12', jeNo: '2990-JE-2608-0003', journal: 'SALES', counter: { code: '300-0000', name: 'ACCOUNT RECEIVEABLE', more: 1 }, doc: '2990-SI-2608-001', doc2: '2990-SO-2608-067', description: 'Sales invoice 2990-SI-2608-001 — NG KAH YEE', who: 'NG KAH YEE', debitSen: 200_000, creditSen: 0, balanceSen: 270_000, reversal: '' },
    ],
    debitSen: 200_000, creditSen: 30_000, closingSen: 270_000,
  }],
  totals: { debitSen: 200_000, creditSen: 30_000 },
};
const WITH_PAIR: LedgerReport = {
  ...REPORT, showReversed: true,
  blocks: [{
    ...REPORT.blocks[0]!,
    lines: [...REPORT.blocks[0]!.lines, { lineId: 'l3', date: '2026-08-20', jeNo: '2990-JE-2608-0004', journal: 'BANK', counter: { code: '300-0000', name: 'ACCOUNT RECEIVEABLE', more: 0 }, doc: '2990-SO-2608-004', doc2: null, description: 'Payment transfer on 2990-SO-2608-004 — keyed twice', who: 'Keyed Twice', debitSen: 161_000, creditSen: 0, balanceSen: 270_000, reversal: 'reversed' }],
  }],
};

beforeEach(() => {
  useAccounts.mockReturnValue({ data: { accounts: [
    { account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', is_active: true },
    { account_code: '900-A001', account_name: 'ADVERTISEMENT', account_type: 'EXPENSE', is_active: true },
  ] }, isLoading: false });
  useLedger.mockImplementation((p: LedgerParams) => ({ data: p.showReversed ? WITH_PAIR : REPORT, isLoading: false, isError: false, isSuccess: true }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ledgerParamsFromSearch — the URL is the filter', () => {
  it('reads the account, the period and the tick; a missing period is this month to today', () => {
    const p = ledgerParamsFromSearch(new URLSearchParams('tab=gl&accounts=310-0010,900-A001&from=2026-08-01&to=2026-08-31&showReversed=1'));
    expect(p).toMatchObject({ from: '2026-08-01', to: '2026-08-31', accounts: ['310-0010', '900-A001'], showReversed: true });
    const d = ledgerParamsFromSearch(new URLSearchParams('tab=gl'));
    expect(d.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(d.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.accounts).toEqual([]);
    expect(d.showReversed).toBe(false);
  });
});

describe('General Ledger — the page', () => {
  it('opens on the URL\'s account and period and prints the block the AutoCount way', () => {
    render(wrap(<GeneralLedger />, '/scm/accounting?tab=gl&accounts=310-0010&from=2026-08-01&to=2026-08-31'));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-08-01', to: '2026-08-31', accounts: ['310-0010'], showReversed: false }));
    const block = document.querySelector('tbody[data-account="310-0010"]')!;
    expect(block).toBeTruthy();
    const rows = within(block as HTMLElement).getAllByRole('row');
    /* Heading (code over name), BALANCE B/F, two lines, TOTAL. */
    expect(rows).toHaveLength(5);
    expect(rows[0]!.textContent).toContain('310-0010');
    expect(rows[0]!.textContent).toContain('CASH AT BANK - MAYBANK');
    expect(rows[1]!.textContent).toContain('BALANCE B/F');
    expect(rows[1]!.textContent).toContain('1,000.00');
    expect(rows[2]!.textContent).toContain('2990-JE-2608-0002');
    expect(rows[2]!.textContent).toContain('Bank');
    expect(rows[2]!.textContent).toContain('900-A001');
    expect(rows[2]!.textContent).toContain('ADVERTISEMENT');
    expect(rows[2]!.textContent).toContain('2990-HPV-2608-017');
    expect(rows[2]!.textContent).toContain('300.00');
    expect(rows[2]!.textContent).toContain('700.00');
    /* The invoice's other side: the debtor and one more. */
    expect(rows[3]!.textContent).toContain('300-0000');
    expect(rows[3]!.textContent).toContain('+1');
    expect(rows[3]!.textContent).toContain('2990-SO-2608-067');
    expect(rows[3]!.textContent).toContain('2,700.00');
    expect(rows[4]!.textContent).toContain('TOTAL');
    expect(rows[4]!.textContent).toContain('2,000.00');
    expect(screen.getByText('GRAND TOTAL').closest('tr')!.textContent).toContain('2,000.00');
    expect(screen.getByText(/Reversed entries and their contras are left out/)).toBeTruthy();
    expect(document.querySelector('tr[data-reversal]')).toBeNull();
  });

  it('ticked, the pair is asked for, written to the URL, and the reversed line is marked', () => {
    render(wrap(<GeneralLedger />, '/scm/accounting?tab=gl&accounts=310-0010&from=2026-08-01&to=2026-08-31'));
    fireEvent.click(screen.getByLabelText('Show reversed entries'));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: ['310-0010'], showReversed: true }));
    const marked = document.querySelector('tr[data-reversal="reversed"]')!;
    expect(marked).toBeTruthy();
    expect(marked.textContent).toContain('2990-JE-2608-0004');
    expect(marked.textContent).toContain('reversed');
    expect(screen.getByText(/listed and marked; they move no balance/)).toBeTruthy();
  });

  it('an account removed from the chips leaves the URL and the request', () => {
    render(wrap(<GeneralLedger />, '/scm/accounting?tab=gl&accounts=310-0010,900-A001&from=2026-08-01&to=2026-08-31'));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: ['310-0010', '900-A001'] }));
    fireEvent.click(screen.getByLabelText('Remove 900-A001'));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: ['310-0010'] }));
    fireEvent.click(screen.getByRole('button', { name: 'All accounts' }));
    expect(useLedger).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: [] }));
    expect(screen.getByText(/Every account with a balance or a movement/)).toBeTruthy();
  });
});
