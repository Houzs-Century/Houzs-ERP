/* Setup › Currencies in the redesign (Finance-1a-Setup, batch 6 §6.4). What is
   pinned: the master as the shared table (Code · Name · Symbol · Rate to MYR ·
   Status · Updated), MYR as the base at 1, Edit opened by a double-click or the
   row's ⋯ (no Edit button), New currency in the same modal, and the payloads
   the two calls send — unchanged from before the redesign. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

const createMutate = vi.fn();
const updateMutate = vi.fn();
vi.mock('../../vendor/scm/lib/currencies-queries', () => ({
  useCurrencies: () => ({
    isLoading: false, isError: false, error: null,
    data: [
      { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', rate_to_myr: '1.000000', is_active: true, sort_order: 0, updated_at: '2026-08-01T02:00:00Z' },
      { code: 'USD', name: 'US Dollar', symbol: '$', rate_to_myr: '4.452000', is_active: true, sort_order: 2, updated_at: '2026-10-28T03:00:00Z' },
      { code: 'EUR', name: 'Euro', symbol: '€', rate_to_myr: '4.812000', is_active: false, sort_order: 3, updated_at: '2026-06-02T03:00:00Z' },
    ],
  }),
  useCreateCurrency: () => ({ mutate: createMutate, isPending: false }),
  useUpdateCurrency: () => ({ mutate: updateMutate, isPending: false }),
}));

import { Currencies } from './Currencies';

const draw = () => render(<MemoryRouter><Currencies /></MemoryRouter>);
const rowOf = (code: string) => screen.getAllByText(code).map((el) => el.closest('tr')).find((tr) => tr != null) as HTMLElement;

describe('the currency master', () => {
  test('Finance · Setup, the design’s columns, MYR the base, status as tags', () => {
    draw();
    expect(screen.getByText('Finance · Setup')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Currencies' })).toBeTruthy();
    expect(screen.getByText('The currency master and each currency’s rate to MYR')).toBeTruthy();
    expect(within(rowOf('MYR')).getByText('1 · base')).toBeTruthy();
    expect(within(rowOf('USD')).getByText('4.452')).toBeTruthy();
    expect(within(rowOf('USD')).getByText('Active')).toBeTruthy();
    expect(within(rowOf('EUR')).getByText('Not offered')).toBeTruthy();
    /* Updated is the row's own date, in the house format. */
    expect(within(rowOf('USD')).getByText('2026/10/28')).toBeTruthy();
    /* No Edit button repeats the double-click. */
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  test('a double-click opens Edit; the rate and status save through the same update', () => {
    updateMutate.mockClear();
    draw();
    fireEvent.doubleClick(rowOf('USD'));
    const dialog = screen.getByRole('dialog', { name: 'Edit USD' });
    expect(within(dialog).getByText('GRN, purchase invoices and payment vouchers fill this rate from now.')).toBeTruthy();
    expect(within(dialog).getByText('1 USD = this many ringgit')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rate to MYR'), { target: { value: '4.5' } });
    fireEvent.click(within(dialog).getByText('Save'));
    expect(updateMutate.mock.calls[0]![0]).toEqual({ code: 'USD', name: 'US Dollar', symbol: '$', rateToMyr: 4.5, isActive: true });
  });

  test('MYR’s rate is not offered for editing — it stays 1', () => {
    updateMutate.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('More for MYR'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit MYR' });
    expect(within(dialog).getByText('MYR is the base currency; its rate stays 1.')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Rate to MYR')).toBeNull();
    fireEvent.click(within(dialog).getByText('Save'));
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({ code: 'MYR', rateToMyr: 1 });
  });

  test('a rate that is not above 0 is refused in the form', () => {
    updateMutate.mockClear();
    draw();
    fireEvent.doubleClick(rowOf('USD'));
    fireEvent.change(screen.getByLabelText('Rate to MYR'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Save'));
    expect(screen.getByRole('alert').textContent).toBe('The rate must be more than 0.');
    expect(updateMutate).not.toHaveBeenCalled();
  });

  test('New currency: the 2–8 character code rule, a taken code, then the create payload', () => {
    createMutate.mockClear();
    draw();
    fireEvent.click(screen.getByText('New currency'));
    const dialog = screen.getByRole('dialog', { name: 'New currency' });
    fireEvent.change(screen.getByLabelText('Currency code'), { target: { value: 'J' } });
    fireEvent.click(within(dialog).getByText('Add currency'));
    expect(within(dialog).getByRole('alert').textContent).toBe('The code is 2–8 letters or digits, e.g. JPY.');
    fireEvent.change(screen.getByLabelText('Currency code'), { target: { value: 'usd' } });
    fireEvent.click(within(dialog).getByText('Add currency'));
    expect(within(dialog).getByRole('alert').textContent).toBe('USD is already in the list.');
    fireEvent.change(screen.getByLabelText('Currency code'), { target: { value: 'jpy' } });
    fireEvent.change(screen.getByLabelText('Currency name'), { target: { value: 'Japanese Yen' } });
    fireEvent.change(screen.getByLabelText('Currency symbol'), { target: { value: '¥' } });
    fireEvent.change(screen.getByLabelText('Rate to MYR'), { target: { value: '0.0294' } });
    fireEvent.click(within(dialog).getByText('Add currency'));
    expect(createMutate.mock.calls[0]![0]).toEqual({ code: 'JPY', name: 'Japanese Yen', symbol: '¥', rateToMyr: 0.0294 });
  });
});
