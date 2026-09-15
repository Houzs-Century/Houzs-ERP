// The General Ledger tab and a reversal pair (docs/bugs/0923).
//
// Owner 2026-09-15: 照理就是对冲掉，所以都不应该显示，je 可以留记录就好 — a
// reversed entry and the contra that undid it are one correction. The ledger
// asks the server for the pair only when the reader ticks "Show reversed
// entries", and then marks each row with the side it is on. The journal list
// keeps its REVERSED mark regardless (that screen is not under test here).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const { useAccounts, useGlEntries } = vi.hoisted(() => ({ useAccounts: vi.fn(), useGlEntries: vi.fn() }));

vi.mock('../../vendor/scm/lib/accounting-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAccounts,
  useGlEntries,
}));

import { GlTab } from './Accounting';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);

const row = (line_id: string, je_no: string, over: Record<string, unknown> = {}) => ({
  line_id, je_no, entry_date: '2026-08-31', source_type: 'SOPAY', source_doc_no: null, line_no: 1,
  account_code: '310-0010', account_name: 'CASH AT BANK', account_type: 'ASSET',
  debit_sen: 100_000, credit_sen: 0, party_type: null, party_code: null, party_name: null, notes: null,
  posted: true, posted_at: null, reversed: false, reversed_by_je: null, ...over,
});

/* What the server hands back: without the flag, the books alone; with it, the
   pair as well, each row carrying its side. */
const BOOKS = [row('l1', '2990-JE-2608-0001')];
const WITH_PAIR = [
  ...BOOKS,
  row('l2', '2990-JE-2608-0002', { reversed: true, reversed_by_je: 'je-contra' }),
  row('l3', '2990-JE-2609-0007', { entry_date: '2026-09-15', source_type: 'SOPAY_REVERSAL', debit_sen: 0, credit_sen: 100_000, reversed_by_je: 'je-original' }),
];

beforeEach(() => {
  useAccounts.mockReturnValue({ data: { accounts: [{ account_code: '310-0010', account_name: 'CASH AT BANK', account_type: 'ASSET', is_active: true }] }, isLoading: false });
  useGlEntries.mockImplementation((filters?: { showReversed?: boolean }) => ({
    data: { glEntries: filters?.showReversed ? WITH_PAIR : BOOKS },
    isLoading: false, isError: false, isSuccess: true,
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('General Ledger tab — a reversal pair is asked for only when the reader says so', () => {
  it('opens on the books alone: the pair is not requested, and the reader is told why it is missing', () => {
    render(wrap(<GlTab />));
    expect(useGlEntries).toHaveBeenLastCalledWith({ accountCode: undefined, showReversed: false });
    expect(screen.getByText('2990-JE-2608-0001')).toBeTruthy();
    expect(screen.queryByText('2990-JE-2608-0002')).toBeNull();
    expect(screen.queryByText('2990-JE-2609-0007')).toBeNull();
    expect(screen.getByText(/Reversed entries and their contras are left out/)).toBeTruthy();
    expect(screen.queryByText('Reversal')).toBeNull();
  });

  it('ticked, the pair is requested and each row is marked with its side', () => {
    render(wrap(<GlTab />));
    fireEvent.click(screen.getByLabelText('Show reversed entries'));
    expect(useGlEntries).toHaveBeenLastCalledWith({ accountCode: undefined, showReversed: true });
    expect(screen.getByText('2990-JE-2608-0002')).toBeTruthy();
    expect(screen.getByText('2990-JE-2609-0007')).toBeTruthy();
    expect(screen.getByText('Reversal')).toBeTruthy();
    expect(screen.getByText('reversed')).toBeTruthy();
    expect(screen.getByText('contra')).toBeTruthy();
    expect(screen.getByText(/no statement counts them/)).toBeTruthy();
  });

  it('the account filter and the tick travel together', () => {
    render(wrap(<GlTab />));
    fireEvent.change(screen.getByDisplayValue('All accounts'), { target: { value: '310-0010' } });
    fireEvent.click(screen.getByLabelText('Show reversed entries'));
    expect(useGlEntries).toHaveBeenLastCalledWith({ accountCode: '310-0010', showReversed: true });
  });
});
