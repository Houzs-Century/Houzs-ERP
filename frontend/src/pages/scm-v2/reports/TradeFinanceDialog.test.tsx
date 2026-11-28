import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { TradeFinance } from '../../../vendor/scm/lib/cash-flow-forecast-queries';

const DATA: TradeFinance = {
  currentMonth: '2026-11', shown: ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03'],
  suppliers: [{ id: 'A', code: '400-A001', name: 'Alpha Trading', term: 'NET 60' }, { id: 'B', code: '400-B001', name: 'Beta Supplies', term: null }],
  facilities: [{
    code: '460-0009', name: 'TRADE FINANCE - SAMPLE BANK', lender: 'SAMPLE BANK', tenorSet: null, rateSet: null, tenorDays: 60, rateBp: 100, defaultRateBp: 100,
    interest: { code: '900-L004', name: 'LOAN INTEREST' }, owedNowSen: 90_000,
    open: [{ date: '2026-08-20', sen: 40_000 }, { date: '2026-11-05', sen: 50_000 }],
    suppliers: ['A'], off: {},
    dues: { A: { '2026-12': { billSen: 900_000, forecastSen: 0 }, '2027-01': { billSen: 0, forecastSen: 300_000 } }, B: { '2026-12': { billSen: 0, forecastSen: 100_000 } } },
    schedule: [],
  }],
};
const state = { data: DATA as TradeFinance | undefined };
const mutateAsync = vi.fn(async (_p: unknown) => ({ ok: true }));
vi.mock('../../../vendor/scm/lib/cash-flow-forecast-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useTradeFinance: () => ({ data: state.data, isError: false }),
  useSaveTradeFinance: () => ({ mutateAsync, isPending: false }),
}));
const { TradeFinanceDialog, readRate, readTenor, tfSchedule, toggleTick } = await import('./TradeFinanceDialog');

const rowText = (label: string): string[] => [...(document.querySelector(`[data-row="${label}"]`) as HTMLElement).querySelectorAll('td')].slice(1).map((td) => td.textContent);

beforeEach(() => { mutateAsync.mockClear(); state.data = DATA; });

describe('the plan’s arithmetic', () => {
  test('a tick toggled; a rate and a tenor read; the months worked out', () => {
    expect(toggleTick({}, '2027-01', 'A')).toEqual({ '2027-01': ['A'] });
    expect(toggleTick({ '2027-01': ['A'] }, '2027-01', 'A')).toEqual({});
    expect([readRate(''), readRate('0.67'), readRate('1%'), readRate('101'), readRate('x')]).toEqual([null, 67, 100, undefined, undefined]);
    expect([readTenor(''), readTenor('90'), readTenor('0'), readTenor('1.5')]).toEqual([null, 90, undefined, undefined]);
    const f = DATA.facilities[0]!;
    expect(tfSchedule({ currentYm: '2026-11', months: DATA.shown, tenorDays: 60, rateBp: 100, open: f.open, dues: f.dues, suppliers: ['A'], off: { '2027-01': ['A'] } })).toEqual([
      { ym: '2026-11', drawSen: 0, repaySen: 40_000, interestSen: 400, owedSen: 50_000 },
      { ym: '2026-12', drawSen: 900_000, repaySen: 0, interestSen: 0, owedSen: 950_000 },
      { ym: '2027-01', drawSen: 0, repaySen: 50_000, interestSen: 500, owedSen: 900_000 },
      { ym: '2027-02', drawSen: 0, repaySen: 900_000, interestSen: 9_000, owedSen: 0 },
      { ym: '2027-03', drawSen: 0, repaySen: 0, interestSen: 0, owedSen: 0 },
    ]);
  });
});

describe('the Trade finance table', () => {
  test('the facility, the chosen supplier’s dues ticked, and the months they make', () => {
    render(<TradeFinanceDialog onClose={() => {}} canWrite />);
    expect(screen.getByText('460-0009 · TRADE FINANCE - SAMPLE BANK')).toBeTruthy();
    expect(screen.getByText('Owed today RM 900.00')).toBeTruthy();
    expect((screen.getByLabelText('460-0009 tenor in days') as HTMLInputElement).placeholder).toBe('60');
    expect((screen.getByLabelText('460-0009 interest per draw') as HTMLInputElement).placeholder).toBe('1.00');
    expect((screen.getByLabelText('Alpha Trading 2026-12 drawn') as HTMLInputElement).checked).toBe(true);
    expect(rowText('Drawdown')).toEqual(['', '9,000.00', '3,000.00', '', '']);
    expect(rowText('Repayment')).toEqual(['400.00', '', '500.00', '9,000.00', '3,000.00']);
    expect(rowText('Owed at month end')).toEqual(['500.00', '9,500.00', '12,000.00', '3,000.00', '']);
  });

  test('untick a month, add a supplier, change the tenor and rate; Save sends the whole plan', async () => {
    const onClose = vi.fn();
    render(<TradeFinanceDialog onClose={onClose} canWrite />);
    fireEvent.click(screen.getByLabelText('Alpha Trading 2027-01 drawn'));
    expect(rowText('Drawdown')).toEqual(['', '9,000.00', '', '', '']);
    fireEvent.change(screen.getByLabelText('460-0009 add a supplier'), { target: { value: 'B' } });
    expect(rowText('Drawdown')).toEqual(['', '10,000.00', '', '', '']);
    fireEvent.change(screen.getByLabelText('460-0009 tenor in days'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('460-0009 interest per draw'), { target: { value: '0.5' } });
    expect(rowText('Repayment')).toEqual(['400.00', '', '', '500.00', '10,000.00']);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(mutateAsync).toHaveBeenCalledWith({ '460-0009': { tenorDays: 90, rateBp: 50, suppliers: ['A', 'B'], off: { '2027-01': ['A'] } } });
    expect(onClose).toHaveBeenCalled();
  });

  test('a tenor out of range is said; removing a supplier clears its months', () => {
    render(<TradeFinanceDialog onClose={() => {}} canWrite />);
    fireEvent.change(screen.getByLabelText('460-0009 tenor in days'), { target: { value: '0' } });
    expect(screen.getByRole('alert').textContent).toContain('The tenor is whole days, 1 to 400');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('No supplier yet: add the ones this facility pays.')).toBeTruthy();
    expect(rowText('Drawdown')).toEqual(['', '', '', '', '']);
  });

  test("a refused save shows the server's sentence; without the write key the table only reads; no facility is said", async () => {
    mutateAsync.mockRejectedValueOnce(Object.assign(new Error('400'), { body: JSON.stringify({ error: 'bad_plan', message: '460-0009: supplier B is not one of this company\'s.' }) }));
    const { unmount } = render(<TradeFinanceDialog onClose={() => {}} canWrite />);
    fireEvent.click(screen.getByLabelText('Alpha Trading 2026-12 drawn'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(screen.getByRole('alert').textContent).toBe("460-0009: supplier B is not one of this company's.");
    unmount();
    const ro = render(<TradeFinanceDialog onClose={() => {}} canWrite={false} />);
    expect((screen.getByLabelText('Alpha Trading 2026-12 drawn') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByLabelText('460-0009 add a supplier')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    ro.unmount();
    state.data = { ...DATA, facilities: [] };
    render(<TradeFinanceDialog onClose={() => {}} canWrite />);
    expect(within(screen.getByRole('dialog')).getByText(/No trade-finance account/)).toBeTruthy();
  });
});
