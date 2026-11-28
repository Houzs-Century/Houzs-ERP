import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ForecastInputs } from '../../../vendor/scm/lib/cash-flow-forecast-queries';

const SHOWN = ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10'];
const DATA: ForecastInputs = {
  currentMonth: '2026-11', shown: SHOWN,
  months: { '2026-10': { '202-1000': -300_000 }, '2026-12': { '460-0001': 50_000_000 }, '2027-02': { '460-0009': -10_000 } },
  accounts: [
    { code: '202-1000', name: 'EQUIPMENT (OFFICE)', group: { id: 'cf:funding:capex', label: 'CAPITAL EXPENDITURE (CAPEX)' } },
    { code: '460-0001', name: 'LOAN - SAMPLE BANK', group: { id: 'cf:funding:loan+cf:funding:loan-out', label: 'LOAN & HP DRAWDOWN / LOAN & HP REPAYMENT' } },
  ],
  notOffered: [{ code: '460-0009', name: 'TRADE FINANCE - SAMPLE BANK' }],
};
const state = { data: DATA as ForecastInputs | undefined };
const mutateAsync = vi.fn(async (_m: unknown) => ({ ok: true }));
vi.mock('../../../vendor/scm/lib/cash-flow-forecast-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useForecastInputs: () => ({ data: state.data, isError: false }),
  useSaveForecastInputs: () => ({ mutateAsync, isPending: false }),
}));
const { CapexFinancingDialog, inputRows, netOf, withInput, withoutAccount } = await import('./CapexFinancingDialog');

const cell = (ym: string, code: string) => screen.getByLabelText(`${ym} ${code} amount`) as HTMLInputElement;
const key = (el: HTMLInputElement, value: string) => { fireEvent.focus(el); fireEvent.change(el, { target: { value } }); fireEvent.blur(el); };
const rowText = (id: string): string => String((document.querySelector(`[data-row="${id}"]`) as HTMLElement).textContent);

beforeEach(() => { mutateAsync.mockClear(); state.data = DATA; });

describe('the Capex & financing table', () => {
  test('the accounts in the layout’s groups, twelve months from this one, the stored amounts and the net', () => {
    render(<CapexFinancingDialog onClose={() => {}} canWrite />);
    const table = screen.getByRole('table', { name: 'Capex and financing by month' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Account', 'Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027', 'Mar 2027', 'Apr 2027', 'May 2027', 'Jun 2027', 'Jul 2027', 'Aug 2027', 'Sep 2027', 'Oct 2027']);
    expect(screen.getByText('CAPITAL EXPENDITURE (CAPEX)')).toBeTruthy();
    expect(screen.getByText('LOAN & HP DRAWDOWN / LOAN & HP REPAYMENT')).toBeTruthy();
    expect(cell('2026-12', '460-0001').value).toBe('500,000.00');
    expect(rowText('net')).toContain('500,000.00');
    expect(screen.getByText('No longer on the Cash Flow layout — clear before saving')).toBeTruthy();
    expect(cell('2027-02', '460-0009').readOnly).toBe(true);
    expect(cell('2027-02', '460-0009').value).toBe('-100.00');
  });

  test('a minus is money out; Clear empties the dropped account; Save sends the whole table, October kept', async () => {
    const onClose = vi.fn();
    render(<CapexFinancingDialog onClose={onClose} canWrite />);
    key(cell('2027-01', '460-0001'), '-15,000');
    key(cell('2027-02', '202-1000'), '-20000.50');
    expect(rowText('net')).toContain('(15,000.00)');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(mutateAsync).toHaveBeenCalledWith({
      '2026-10': { '202-1000': -300_000 },
      '2026-12': { '460-0001': 50_000_000 },
      '2027-01': { '460-0001': -1_500_000 },
      '2027-02': { '202-1000': -2_000_050 },
    });
    expect(onClose).toHaveBeenCalled();
  });

  test("a refused save shows the server's sentence; without the write key the table only reads", async () => {
    mutateAsync.mockRejectedValueOnce(Object.assign(new Error('400'), { body: JSON.stringify({ error: 'bad_cell', message: '2027-02 460-0009: not a capex or financing account on the Cash Flow layout — clear it first' }) }));
    const { unmount } = render(<CapexFinancingDialog onClose={() => {}} canWrite />);
    key(cell('2026-11', '202-1000'), '-1000');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(screen.getByRole('alert').textContent).toBe('2027-02 460-0009: not a capex or financing account on the Cash Flow layout — clear it first');
    unmount();
    render(<CapexFinancingDialog onClose={() => {}} canWrite={false} />);
    expect(cell('2026-12', '460-0001').readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('no account on the layout’s funding block: says where to place them', () => {
    state.data = { ...DATA, accounts: [], notOffered: [], months: {} };
    render(<CapexFinancingDialog onClose={() => {}} canWrite />);
    expect(screen.getByText(/No capex or financing account on the Cash Flow layout/)).toBeTruthy();
  });
});

describe('the table’s arithmetic', () => {
  test('a cell set and cleared, an account cleared everywhere, a month’s net, the rows', () => {
    const m = withInput({}, '2026-12', 'A', 100);
    expect(withInput(m, '2026-12', 'A', null)).toEqual({});
    expect(withInput(m, '2026-12', 'B', -40)).toEqual({ '2026-12': { A: 100, B: -40 } });
    expect(withoutAccount({ '2026-11': { A: 1, B: 2 }, '2026-12': { A: 3 } }, 'A')).toEqual({ '2026-11': { B: 2 } });
    expect(netOf({ '2026-12': { A: 100, B: -40 } }, '2026-12')).toBe(60);
    expect(netOf({}, '2026-12')).toBe(0);
    expect(inputRows(DATA).map((r) => (r.kind === 'group' ? `# ${r.label}` : `${r.code}${r.offered ? '' : ' (clear)'}`))).toEqual([
      '# CAPITAL EXPENDITURE (CAPEX)', '202-1000', '# LOAN & HP DRAWDOWN / LOAN & HP REPAYMENT', '460-0001',
      '# No longer on the Cash Flow layout — clear before saving', '460-0009 (clear)',
    ]);
  });
});
