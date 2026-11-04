// The Trial balance in the owner's Claude Design (batch 6, step 5): As at a day
// (read c1), the three tiles with today's words, the accounts by section on the
// statement table — code over name — each section totalled and the grand total
// last, a row's lines in a drawer, and the exports as shown.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AccountBalance } from '../../vendor/scm/lib/accounting-queries';

const BALANCES: AccountBalance[] = [
  { account_code: '310-0010', account_name: 'CASH AT BANK', account_type: 'ASSET', total_debit_sen: 900_000, total_credit_sen: 300_000, balance_sen: 600_000 },
  { account_code: '330-0000', account_name: 'STOCK', account_type: 'ASSET', total_debit_sen: 0, total_credit_sen: 0, balance_sen: 0 },
  { account_code: '400-0000', account_name: 'TRADE CREDITORS', account_type: 'LIABILITY', total_debit_sen: 100_000, total_credit_sen: 250_000, balance_sen: 150_000 },
  { account_code: '500-0000', account_name: 'SALES', account_type: 'INCOME', total_debit_sen: 0, total_credit_sen: 700_000, balance_sen: 700_000 },
  { account_code: '900-A001', account_name: 'ADVERT', account_type: 'EXPENSE', total_debit_sen: 250_000, total_credit_sen: 0, balance_sen: 250_000 },
] as AccountBalance[];

const state = vi.hoisted(() => ({ asOf: [] as Array<string | undefined>, fail: false, ledger: [] as unknown[] }));
vi.mock('../../vendor/scm/lib/accounting-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAccountBalances: (asOf?: string) => {
    state.asOf.push(asOf);
    return state.fail
      ? { data: undefined, isLoading: false, isError: true, isSuccess: false, error: new Error('account balances are unavailable') }
      : { data: { balances: BALANCES }, isLoading: false, isError: false, isSuccess: true, error: null };
  },
}));
vi.mock('../../vendor/scm/lib/ledger-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLedger: (p: unknown) => {
    state.ledger.push(p);
    return {
      isLoading: false, isError: false,
      data: { blocks: [{ code: '900-A001', name: 'ADVERT', type: 'EXPENSE', openingSen: 50_000, debitSen: 200_000, creditSen: 0, closingSen: 250_000, lines: [
        { lineId: 'l1', date: '2026-10-05', jeNo: 'HC-JE-2610-0001', journal: 'GENERAL', counter: { code: '310-0010', name: 'CASH AT BANK', more: 0 }, doc: 'PV-1', doc2: null, description: 'Fair ads', who: null, debitSen: 200_000, creditSen: 0, balanceSen: 250_000, reversal: '' },
      ] }] },
    };
  },
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));

import { TrialBalanceTab, trialBalanceLines } from './TrialBalance';

const Where = () => {
  const l = useLocation();
  return <output aria-label="address">{`${l.pathname}${l.search}`}</output>;
};
const at = (url: string) => render(
  <MemoryRouter initialEntries={[url]}><Routes><Route path="*" element={<><TrialBalanceTab /><Where /></>} /></Routes></MemoryRouter>,
);
const TB = '/scm/accounting?tab=tb&in=reports&from=2026-10-01&to=2026-10-31';

beforeEach(() => {
  state.asOf = [];
  state.fail = false;
  state.ledger = [];
  xlsx.mockClear();
  window.localStorage.removeItem('fin-reports-colw-v2');
});

describe('the Trial balance’s lines', () => {
  test('a block per section in statement order, its accounts and its total; the grand total’s balance is the difference', () => {
    const { lines, totals } = trialBalanceLines(BALANCES, false);
    expect(lines.map((l) => l.id)).toEqual([
      'blk:ASSET', 'acc:310-0010', 'tot:ASSET',
      'blk:LIABILITY', 'acc:400-0000', 'tot:LIABILITY',
      'blk:INCOME', 'acc:500-0000', 'tot:INCOME',
      'blk:EXPENSE', 'acc:900-A001', 'tot:EXPENSE',
      'net:total',
    ]);
    expect(totals).toEqual({ dr: 1_250_000, cr: 1_250_000, diff: 0 });
    expect(lines.at(-1)!.cells).toEqual({ dr: { amountSen: 1_250_000, pct: null }, cr: { amountSen: 1_250_000, pct: null }, bal: { amountSen: 0, pct: null } });
    /* An account with nothing posted shows only when asked. */
    expect(trialBalanceLines(BALANCES, true).lines.map((l) => l.id)).toContain('acc:330-0000');
  });
});

describe('the Trial balance page', () => {
  test('As at the range’s end, read as at that day; the tiles in today’s words; the accounts code over name', () => {
    at(TB);
    expect(state.asOf.at(-1)).toBe('2026-10-31');
    const tiles = screen.getByRole('group', { name: 'Trial balance figures' });
    expect(tiles.textContent).toContain('Σ Debit12,500.00');
    expect(tiles.textContent).toContain('Σ Credit12,500.00');
    expect(within(tiles).getByText('0.00 — books balance')).toBeTruthy();
    const advert = screen.getByText('ADVERT').closest('tr')!;
    expect(advert.textContent).toContain('900-A001');
    expect(advert.textContent).toContain('2,500.00');
    expect(screen.getByText('Total expenses').closest('tr')!.textContent).toContain('2,500.00');
    expect(screen.getByText('Total', { selector: 'span' }).closest('tr')!.className).toMatch(/rowFinal/);
    expect(screen.queryByText('STOCK')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Accounts with nothing posted' }));
    expect(screen.getByText('STOCK')).toBeTruthy();
  });

  test('a row’s lines open in a drawer, from the first of the as-at month to the day, with the ledger one click away', () => {
    at(TB);
    fireEvent.doubleClick(screen.getByText('ADVERT').closest('tr')!);
    const drawer = screen.getByRole('dialog', { name: 'Lines of 900-A001 ADVERT' });
    expect(state.ledger.at(-1)).toEqual({ from: '2026-10-01', to: '2026-10-31', accounts: ['900-A001'] });
    expect(drawer.textContent).toContain('2026/10/01 – 2026/10/31 · balance b/f 500.00');
    expect(within(drawer).getByText('Fair ads')).toBeTruthy();
    expect(within(drawer).getByRole('link', { name: /Open in General ledger/ }).getAttribute('href'))
      .toBe('/scm/accounting?tab=gl&accounts=900-A001&from=2026-10-01&to=2026-10-31&in=reports');
  });

  test('As at writes the day into the address; Excel carries the table as shown', async () => {
    at(TB);
    fireEvent.change(screen.getByLabelText('Trial balance as at'), { target: { value: '2026/09/30' } });
    fireEvent.blur(screen.getByLabelText('Trial balance as at'));
    expect(screen.getByLabelText('address').textContent).toContain('to=2026-09-30');
    expect(state.asOf.at(-1)).toBe('2026-09-30');
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, name] = xlsx.mock.calls[0]! as [{ title: string; tables: Array<{ columns: Array<{ label: string }>; rows: Array<{ label: string }> }> }, string];
    expect(name).toBe('trial-balance-2026-09-30.xlsx');
    expect(sheet.title).toBe('Trial Balance');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Debit', 'Credit', 'Balance']);
    expect(sheet.tables[0]!.rows.at(-1)!.label).toBe('Total');
  });

  test('a failed read says the report is not a statement about the books — and never “books balance”', () => {
    state.fail = true;
    at(TB);
    expect(screen.getByRole('alert').textContent).toContain('The account balances could not be loaded, so this report is not a statement about the books.');
    expect(screen.queryByText(/books balance/i)).toBeNull();
    expect(screen.getByText('— — not checked')).toBeTruthy();
  });
});
