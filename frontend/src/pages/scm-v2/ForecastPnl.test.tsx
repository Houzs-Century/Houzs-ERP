/* The Forecast P&L page (owner 2026-09-21). Pinned: the rows are the P&L's
   tree over the forecast's accounts (categories with subtotals, the unplaced
   under Unassigned); a sales line takes an amount and its % box is read-only;
   keying a % shows the implied amount in grey and keying an amount clears
   the %; the totals follow the shared arithmetic; Add month inherits the
   percentages and starts the amounts blank; Save sends the whole grid and a
   refused save shows the server's sentence naming the cell; empty lines hide
   and show. The server half is backend/tests/forecastPnl.test.ts. */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(screen.getByText('SALES OF SOFA')).toBeTruthy();
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
    expect(screen.queryByText('ADVERT')).toBeNull();
    fireEvent.click(screen.getByText('Show empty lines'));
    expect(screen.getByText('ADVERT')).toBeTruthy();
    expect(screen.getByText('DISCOUNT ALLOWED')).toBeTruthy();
  });

  test('keying an amount moves every implied figure; keying the other box clears the first; the page says it is not saved', () => {
    render(<MemoryRouter><ForecastPnl /></MemoryRouter>);
    expect(screen.queryByText('Not saved')).toBeNull();
    key(amount('2026-09', '500-0003'), '200000');
    expect(amount('2026-09', '601-0003').placeholder).toBe('120,000.00');
    expect(rowText('gross-profit')).toContain('80,000.00');
    expect(percent('2026-09', '900-S001').placeholder).toBe('10');
    expect(screen.getByText('Not saved')).toBeTruthy();
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
    fireEvent.click(screen.getByText('Add month'));
    expect(screen.getByText('10/2026')).toBeTruthy();
    expect(percent('2026-10', '601-0003').value).toBe('60');
    expect(amount('2026-10', '500-0003').value).toBe('');
    expect(amount('2026-10', '601-0003').placeholder).toBe('0.00');
    fireEvent.click(screen.getByText('Save'));
    expect(mutate).toHaveBeenCalledTimes(1);
    const sent = mutate.mock.calls[0]![0] as Record<string, Record<string, unknown>>;
    expect(Object.keys(sent).sort()).toEqual(['2026-09', '2026-10']);
    expect(sent['2026-10']).toEqual({ '601-0003': { bp: 6000 } });
    expect(sent['2026-09']).toEqual(DATA.months['2026-09']);
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
    fireEvent.click(screen.getByLabelText('Remove 09/2026'));
    expect(screen.getByText(/No month yet/)).toBeTruthy();
    fireEvent.click(screen.getByText('Save'));
    expect(mutate.mock.calls[1]![0]).toEqual({});
  });
});
