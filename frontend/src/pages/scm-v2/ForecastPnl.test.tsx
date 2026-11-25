/* The Forecast P&L page (owner 2026-09-21). Pinned: the rows are the P&L's
   tree over the forecast's accounts (categories with subtotals, the unplaced
   under Unassigned); a sales line takes an amount and its % box is read-only;
   keying a % shows the implied amount in grey and keying an amount clears
   the %; the totals follow the shared arithmetic; Add month inherits the
   percentages and starts the amounts blank; Save sends the whole grid and a
   refused save shows the server's sentence naming the cell; empty lines hide
   and show; a purchase line splits by supplier and is then their sum. The
   server half is backend/tests/forecastPnl.test.ts. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ForecastResponse } from '../../vendor/scm/lib/forecast-queries';

const DATA: ForecastResponse = {
  months: {
    '2026-09': { '500-0003': { amtSen: 10_000_000 }, '601-0003': { bp: 6000 }, '900-S001': { amtSen: 2_000_000 } },
  },
  accounts: [
    { code: '500-0003', name: 'SALES OF SOFA', section: 'SALES', type: 'INCOME' },
    { code: '520-0000', name: 'DISCOUNT ALLOWED', section: 'SALES ADJUSTMENTS', type: 'INCOME' },
    { code: '601-0003', name: 'PURCHASE OF SOFA', section: 'COST OF GOODS SOLD', type: 'EXPENSE' },
    { code: '900-S001', name: 'SALARY', section: 'EXPENSES', type: 'EXPENSE' },
    { code: '900-A001', name: 'ADVERT', section: 'EXPENSES', type: 'EXPENSE' },
    { code: '950-0000', name: 'TAXATION', section: 'TAXATION', type: 'EXPENSE' },
  ],
  layout: {
    stored: true,
    blocks: {
      expenses: [
        { kind: 'category', id: 'pl:general', label: 'Administrative expense', children: [
          { kind: 'category', id: 'pl:general:salary', label: 'Salary & related', children: [{ kind: 'account', code: '900-S001' }] },
          { kind: 'category', id: 'pl:general:office', label: 'Office & admin', children: [{ kind: 'account', code: '900-A001' }] },
        ] },
      ],
    },
  },
};
const mutate = vi.fn();
const state = { data: DATA as ForecastResponse | undefined };
vi.mock('../../lib/activeCompany', async (importOriginal) => ({ ...(await importOriginal() as object), getActiveCompanyId: () => 2 }));
vi.mock('../../vendor/scm/lib/forecast-queries', () => ({
  useForecast: () => ({ data: state.data, isLoading: false, isError: false, error: null }),
  useSaveForecast: () => ({ mutate, isPending: false }),
}));
/* The page sits in the Finance report shell, whose report list reads the
   sidebar's gates (reports/ReportRail). */
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: null, can: () => true, pageAccess: () => 'full' }) }));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
const { ForecastPnl } = await import('./ForecastPnl');

const amount = (m: string, code: string) => screen.getByLabelText(`${m} ${code} amount`) as HTMLInputElement;
const percent = (m: string, code: string) => screen.getByLabelText(`${m} ${code} percent`) as HTMLInputElement;
const key = (el: HTMLInputElement, value: string) => { fireEvent.focus(el); fireEvent.change(el, { target: { value } }); fireEvent.blur(el); };
const rowText = (id: string): string => String((document.querySelector(`[data-row="${id}"]`) as HTMLElement).textContent);

beforeEach(() => { mutate.mockReset(); state.data = DATA; });

describe('the Forecast P&L page', () => {
  test('lays the accounts on the tree, reads the saved cells and the implied figures, and hides the empty lines', () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    expect(screen.getByText('Trading income')).toBeTruthy();
    expect(screen.getByText('Administrative expense')).toBeTruthy();
    expect(screen.getByText('Salary & related')).toBeTruthy();
    expect(screen.getByText('500-0003 · SALES OF SOFA')).toBeTruthy();
    /* Saved: sales 100,000 as an amount; cost 60% with its implied 60,000; salary 20,000 with its implied 20%. */
    expect(amount('2026-09', '500-0003').value).toBe('100,000.00');
    expect(percent('2026-09', '601-0003').value).toBe('60');
    expect(amount('2026-09', '601-0003').placeholder).toBe('60,000.00');
    expect(amount('2026-09', '900-S001').value).toBe('20,000.00');
    expect(percent('2026-09', '900-S001').placeholder).toBe('20');
    /* The statement's arithmetic. */
    expect(rowText('gross-profit')).toContain('40,000.00');
    expect(rowText('net-profit')).toContain('20,000.00');
    expect(rowText('pl:general:salary')).toContain('20,000.00');
    /* A sales line has no % box; ADVERT and the discount, never keyed, are hidden until asked. */
    expect(screen.queryByLabelText('2026-09 500-0003 percent')).toBeNull();
    expect(screen.queryByText('900-A001 · ADVERT')).toBeNull();
    fireEvent.click(screen.getByText('Show empty lines'));
    expect(screen.getByText('900-A001 · ADVERT')).toBeTruthy();
    expect(screen.getByText('520-0000 · DISCOUNT ALLOWED')).toBeTruthy();
  });

  test('keying an amount moves every implied figure; keying the other box clears the first; the page says it is not saved', () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    key(amount('2026-09', '500-0003'), '200000');
    expect(amount('2026-09', '601-0003').placeholder).toBe('120,000.00');
    expect(rowText('gross-profit')).toContain('80,000.00');
    expect(percent('2026-09', '900-S001').placeholder).toBe('10');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    /* An amount on the cost line replaces its %. */
    key(amount('2026-09', '601-0003'), '50,000');
    expect(percent('2026-09', '601-0003').value).toBe('');
    expect(percent('2026-09', '601-0003').placeholder).toBe('25');
    expect(rowText('gross-profit')).toContain('150,000.00');
    /* A % on the salary line replaces its amount. */
    key(percent('2026-09', '900-S001'), '12.5');
    expect(amount('2026-09', '900-S001').value).toBe('');
    expect(amount('2026-09', '900-S001').placeholder).toBe('25,000.00');
    expect(rowText('net-profit')).toContain('125,000.00');
  });

  test('Add month inherits the percentages and none of the amounts; Save sends the whole grid', () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Month to add'), { target: { value: '2026-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add month' }));
    expect(screen.getByText('Oct 2026')).toBeTruthy();
    expect(screen.getByText('October 2026 added · type its sales; every other line kept its %')).toBeTruthy();
    expect(percent('2026-10', '601-0003').value).toBe('60');
    expect(amount('2026-10', '500-0003').value).toBe('');
    expect(amount('2026-10', '601-0003').placeholder).toBe('0.00');
    fireEvent.click(screen.getByText('Save'));
    expect(mutate).toHaveBeenCalledTimes(1);
    const sent = (mutate.mock.calls[0]![0] as { months: Record<string, Record<string, unknown>>; suppliers: unknown }).months;
    expect((mutate.mock.calls[0]![0] as { suppliers: unknown }).suppliers).toEqual({});
    expect(Object.keys(sent).sort()).toEqual(['2026-09', '2026-10']);
    expect(sent['2026-10']).toEqual({ '601-0003': { bp: 6000 } });
    expect(sent['2026-09']).toEqual(DATA.months['2026-09']);
    const opts = mutate.mock.calls[0]![1] as { onSuccess: () => void };
    act(() => { opts.onSuccess(); });
    expect(screen.getByText('Forecast saved · 2 months')).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  test('a refused save shows the server\'s sentence naming the cell; a removed month leaves on Save', () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    key(amount('2026-09', '900-S001'), '21000');
    fireEvent.click(screen.getByText('Save'));
    const opts = mutate.mock.calls[0]![1] as { onError: (e: unknown) => void; onSuccess: () => void };
    act(() => { opts.onError(new Error('2026-09 900-S001 amount: amount must be a whole number of sen')); });
    expect(within(screen.getByRole('alert')).getByText('2026-09 900-S001 amount: amount must be a whole number of sen')).toBeTruthy();
    expect(document.activeElement).toBe(amount('2026-09', '900-S001'));
    /* Removing the only month empties the grid the PUT will send. */
    fireEvent.click(screen.getByLabelText('Remove Sep 2026'));
    expect(screen.getByText('No month yet — pick one above and press Add month.')).toBeTruthy();
    fireEvent.click(screen.getByText('Save'));
    expect(mutate.mock.calls[1]![0]).toEqual({ months: {}, suppliers: {} });
  });

  test('the bar: the months covered as the grey line, the six after the last or Other…, Nothing to save, and Excel of the grid as shown', async () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    expect(screen.getByText('Sep 2026 – Sep 2026 · 1 month · targets per account on the P&L’s layout')).toBeTruthy();
    const pick = screen.getByLabelText('Month to add') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['October 2026', 'November 2026', 'December 2026', 'January 2027', 'February 2027', 'March 2027', 'Other…']);
    fireEvent.click(screen.getByText('Save'));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing to save')).toBeTruthy();
    /* Other… takes any month — an earlier one inherits the month before it. */
    fireEvent.change(pick, { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Other month to add'), { target: { value: '2026-08' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add month' }));
    expect(screen.getByText('Aug 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0]! as [{ title: string; tables: Array<{ columns: Array<{ label: string }>; rows: Array<{ label: string }> }> }, string];
    expect(file).toBe('forecast-pnl-2026-08-to-2026-09.xlsx');
    expect(sheet.title).toBe('Forecast P&L');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Aug 2026', 'Sep 2026']);
    expect(sheet.tables[0]!.rows.map((r) => r.label)).toContain('500-0003 · SALES OF SOFA');
    expect(sheet.tables[0]!.rows.map((r) => r.label)).toContain('NET PROFIT');
  });

  /* A purchase line's % is of its OWN group's sales (owner 2026-09-29: purchase
     of bedding 应该是根据回他的 sales 的 amount 算，而不是 total sales, sofa 同理):
     the account comes with `basis`, the box says so, and the implied figures
     move with that group's sales alone. */
  test("a purchase line's % is of its own group's sales, the box says which, and only that group's sales move it", () => {
    state.data = {
      ...DATA,
      months: { '2026-09': { '500-0003': { amtSen: 10_000_000 }, '500-0001': { amtSen: 4_000_000 }, '601-0003': { bp: 6000 }, '601-0001': { amtSen: 1_000_000 }, '900-S001': { bp: 1000 } } },
      accounts: [
        { code: '500-0003', name: 'SALES OF SOFA', section: 'SALES', type: 'INCOME' },
        { code: '500-0001', name: 'SALES OF BEDDING', section: 'SALES', type: 'INCOME' },
        { code: '601-0003', name: 'PURCHASE OF SOFA', section: 'COST OF GOODS SOLD', type: 'EXPENSE', basis: ['500-0003'] },
        { code: '601-0001', name: 'PURCHASES OF BEDDING', section: 'COST OF GOODS SOLD', type: 'EXPENSE', basis: ['500-0001'] },
        { code: '900-S001', name: 'SALARY', section: 'EXPENSES', type: 'EXPENSE' },
      ],
    };
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    /* Sofa 60% of the 100,000 sofa sales = 60,000 (not of the 140,000 whole); bedding 10,000 of 40,000 = 25%; salary 10% of everything = 14,000. */
    expect(amount('2026-09', '601-0003').placeholder).toBe('60,000.00');
    expect(percent('2026-09', '601-0001').placeholder).toBe('25');
    expect(amount('2026-09', '900-S001').placeholder).toBe('14,000.00');
    expect(percent('2026-09', '601-0003').title).toBe("% of this line's own sales: 500-0003");
    expect(percent('2026-09', '900-S001').title).toBe("% of the month's sales");
    expect(rowText('gross-profit')).toContain('70,000.00');
    /* More bedding sales: the bedding share falls, the sofa figure stands, salary follows the whole. */
    key(amount('2026-09', '500-0001'), '100000');
    expect(percent('2026-09', '601-0001').placeholder).toBe('10');
    expect(amount('2026-09', '601-0003').placeholder).toBe('60,000.00');
    expect(amount('2026-09', '900-S001').placeholder).toBe('20,000.00');
    expect(rowText('gross-profit')).toContain('130,000.00');
  });
});

/* Step 1 of the Hookka forecast port (2026-11-24): a purchase line split by
   supplier. Made-up suppliers and figures. */
describe('a purchase line split by supplier', () => {
  const SUP_DATA: ForecastResponse = {
    ...DATA,
    accounts: DATA.accounts.map((a) => (a.code === '601-0003' ? { ...a, purchase: true } : a)),
    suppliers: { '2026-09': { '601-0003': { 'sup-a': { amtSen: 3_000_000 }, 'sup-b': { bp: 1500 } } } },
    supplierList: [
      { id: 'sup-a', code: '400-A001', name: 'Alpha Trading', active: true, recent: ['601-0003'] },
      { id: 'sup-b', code: '400-B001', name: 'Beta Supplies', active: true, recent: [] },
      { id: 'sup-c', code: '400-C001', name: 'Cedar Works', active: true, recent: ['601-0003'] },
      { id: 'sup-d', code: '400-D001', name: 'Delta Retired', active: false, recent: ['601-0003'] },
      { id: 'sup-e', code: '400-E001', name: 'Echo Imports', active: true, recent: [] },
    ],
  };
  beforeEach(() => { state.data = SUP_DATA; });
  const sup = (m: string, code: string, name: string, side: 'amount' | 'percent') => screen.getByLabelText(`${m} ${code} ${name} ${side}`) as HTMLInputElement;

  test('closed, the line shows the suppliers that carry a figure and their sum, read-only; the totals take the sum', () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    /* Alpha 30,000 + Beta 15% of 100,000 = 15,000 → 45,000 (45%), not the line's own 60%. */
    expect(amount('2026-09', '601-0003').value).toBe('45,000.00');
    expect(amount('2026-09', '601-0003').readOnly).toBe(true);
    expect(percent('2026-09', '601-0003').value).toBe('45');
    expect(sup('2026-09', '601-0003', 'Alpha Trading', 'amount').value).toBe('30,000.00');
    expect(sup('2026-09', '601-0003', 'Alpha Trading', 'percent').placeholder).toBe('30');
    expect(sup('2026-09', '601-0003', 'Beta Supplies', 'percent').value).toBe('15');
    expect(sup('2026-09', '601-0003', 'Beta Supplies', 'amount').placeholder).toBe('15,000.00');
    expect(rowText('gross-profit')).toContain('55,000.00');
    /* Closed: no supplier without a figure, no Other, no picker. */
    expect(screen.queryByText('Cedar Works')).toBeNull();
    expect(screen.queryByText('Other (new suppliers)')).toBeNull();
    expect(screen.queryByLabelText('Add a supplier under 601-0003')).toBeNull();
  });

  test("open, it lists the active suppliers that billed it lately, the keyed ones and Other, and offers the company's other active suppliers", () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    fireEvent.click(screen.getByLabelText('Show the suppliers of 601-0003'));
    const names = [...document.querySelectorAll('[data-row^="sup:601-0003:"]')].map((r) => r.getAttribute('data-row'));
    expect(names).toEqual(['sup:601-0003:sup-a', 'sup:601-0003:sup-b', 'sup:601-0003:sup-c', 'sup:601-0003:other', 'sup:601-0003:add']);
    const pick = screen.getByLabelText('Add a supplier under 601-0003') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Add supplier…', 'Echo Imports']);
    fireEvent.change(pick, { target: { value: 'sup-e' } });
    expect(sup('2026-09', '601-0003', 'Echo Imports', 'amount')).toBeTruthy();
    /* Other takes a figure like any supplier; the line follows. */
    key(sup('2026-09', '601-0003', 'Other (new suppliers)', 'amount'), '5000');
    expect(amount('2026-09', '601-0003').value).toBe('50,000.00');
    expect(rowText('gross-profit')).toContain('50,000.00');
  });

  test('clearing every supplier hands the line back its own figure; Save sends the lines and the supplier figures', () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    key(sup('2026-09', '601-0003', 'Alpha Trading', 'amount'), '');
    expect(amount('2026-09', '601-0003').value).toBe('15,000.00');
    key(sup('2026-09', '601-0003', 'Beta Supplies', 'percent'), '');
    /* No supplier left: the line's own 60% is back, and typeable. */
    expect(amount('2026-09', '601-0003').readOnly).toBe(false);
    expect(percent('2026-09', '601-0003').value).toBe('60');
    expect(amount('2026-09', '601-0003').placeholder).toBe('60,000.00');
    fireEvent.click(screen.getByText('Save'));
    expect(mutate.mock.calls[0]![0]).toEqual({ months: DATA.months, suppliers: {} });
  });

  test('Add month carries each supplier\'s % and none of the amounts; Excel shows the suppliers under their line', async () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Month to add'), { target: { value: '2026-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add month' }));
    expect(sup('2026-10', '601-0003', 'Beta Supplies', 'percent').value).toBe('15');
    expect(sup('2026-10', '601-0003', 'Alpha Trading', 'amount').value).toBe('');
    fireEvent.click(screen.getByText('Save'));
    expect((mutate.mock.calls[0]![0] as { suppliers: unknown }).suppliers).toEqual({
      '2026-09': SUP_DATA.suppliers!['2026-09'],
      '2026-10': { '601-0003': { 'sup-b': { bp: 1500 } } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalled());
    const [sheet] = xlsx.mock.calls[xlsx.mock.calls.length - 1]! as [{ tables: Array<{ rows: Array<{ label: string; depth: number; cells: number[] }> }> }];
    const rows = sheet.tables[0]!.rows;
    const at = rows.findIndex((r) => r.label === '601-0003 · PURCHASE OF SOFA');
    expect(rows.slice(at, at + 3).map((r) => [r.label, r.cells])).toEqual([
      ['601-0003 · PURCHASE OF SOFA', [4_500_000, 0]],
      ['Alpha Trading', [3_000_000, 0]],
      ['Beta Supplies', [1_500_000, 0]],
    ]);
    expect(rows[at + 1]!.depth).toBe(rows[at]!.depth + 1);
  });

  test("a refused supplier cell is named by the server and the page goes to it", () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    key(sup('2026-09', '601-0003', 'Alpha Trading', 'amount'), '31000');
    fireEvent.click(screen.getByText('Save'));
    const opts = mutate.mock.calls[0]![1] as { onError: (e: unknown) => void };
    act(() => { opts.onError(new Error('2026-09 601-0003 sup-a amount: amount must be a whole number of sen')); });
    expect(document.activeElement).toBe(sup('2026-09', '601-0003', 'Alpha Trading', 'amount'));
  });

  test('a server older than the split (no suppliers, no supplier list) reads as before', () => {
    state.data = { ...DATA, accounts: SUP_DATA.accounts };
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    expect(percent('2026-09', '601-0003').value).toBe('60');
    fireEvent.click(screen.getByLabelText('Show the suppliers of 601-0003'));
    expect([...document.querySelectorAll('[data-row^="sup:601-0003:"]')].map((r) => r.getAttribute('data-row'))).toEqual(['sup:601-0003:other', 'sup:601-0003:add']);
  });
});
