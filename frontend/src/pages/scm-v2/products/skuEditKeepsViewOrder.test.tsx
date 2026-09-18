/* SKU Master: pressing Edit Prices keeps the rows exactly where the operator
 * was looking at them (owner 2026-09-15: "我看到的 front end UI 明明顺着排，结果点
 * edit 了，顺序直接不一样"). The grid sorts and funnels client-side; the edit
 * table used to render the server array instead, so a sorted row jumped. */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MfgProductRow } from '../../../vendor/scm/lib/mfg-products-queries';

const row = (id: string, code: string, name: string): MfgProductRow => ({
  id, code, name, category: 'ACCESSORY', base_price_sen: 1000, price1_sen: null,
  status: 'ACTIVE', unit_m3_milli: 0,
});

// Server order is by code; sorting by Description reverses it.
const SERVER_ROWS = [row('a', 'A-001', 'ZEBRA PILLOW'), row('b', 'B-002', 'MANGO CUSHION'), row('c', 'C-003', 'APPLE BOLSTER')];

const idle = { mutate: () => {}, mutateAsync: async () => ({}), isPending: false };
vi.mock('../../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: SERVER_ROWS, isLoading: false, isFetching: false, error: null }),
  useMaintenanceConfig: () => ({ data: undefined, isLoading: false }),
  useUpdateMfgProductPrices: () => idle,
  useDeleteMfgProduct: () => idle,
  useUpdateMfgProductStatus: () => idle,
}));
vi.mock('../../../vendor/scm/lib/product-models-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../vendor/scm/lib/product-models-queries')>()),
  useBrandingPool: () => ({ pool: [] }),
}));

import { Products } from '../Products';
import { NotifyProvider } from '../../../vendor/scm/components/NotifyDialog';
import { ConfirmProvider } from '../../../vendor/scm/components/ConfirmDialog';

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>
      <NotifyProvider><ConfirmProvider><MemoryRouter><Products /></MemoryRouter></ConfirmProvider></NotifyProvider>
    </QueryClientProvider>,
  );

const codesInOrder = () =>
  screen.getAllByRole('row')
    .map((r) => within(r).queryAllByText(/^[ABC]-00\d$/)[0]?.textContent)
    .filter((c): c is string => Boolean(c));

beforeEach(() => localStorage.clear());

describe('SKU Master Edit Prices keeps the order and set on screen', () => {
  test('a Description sort survives pressing Edit Prices', () => {
    renderPage();
    expect(codesInOrder()).toEqual(['A-001', 'B-002', 'C-003']);

    fireEvent.click(screen.getByRole('columnheader', { name: /Description/ }));
    expect(codesInOrder()).toEqual(['C-003', 'B-002', 'A-001']);

    fireEvent.click(screen.getByRole('button', { name: /Edit Prices/ }));
    expect(screen.getByRole('button', { name: /Save/ })).toBeTruthy();
    expect(codesInOrder()).toEqual(['C-003', 'B-002', 'A-001']);
  });

  test('a column funnel keeps the same rows in edit mode and after Cancel', () => {
    renderPage();
    fireEvent.click(screen.getByTitle('Filter & sort Description'));
    fireEvent.click(screen.getByRole('checkbox', { name: /MANGO CUSHION/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(codesInOrder()).toEqual(['B-002']);

    fireEvent.click(screen.getByRole('button', { name: /Edit Prices/ }));
    expect(codesInOrder()).toEqual(['B-002']);

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(codesInOrder()).toEqual(['B-002']);
  });

  /* 0917 still holds: a funnel is a list of VALUES, so a description renamed
     under it would vanish once saved. A successful Save opens the grid unfiltered. */
  test('a successful Save opens the grid with no funnel, so a renamed row cannot vanish', async () => {
    renderPage();
    fireEvent.click(screen.getByTitle('Filter & sort Description'));
    fireEvent.click(screen.getByRole('checkbox', { name: /MANGO CUSHION/ }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /Edit Prices/ }));

    fireEvent.click(screen.getAllByText('MANGO CUSHION').find((el) => !el.closest('[hidden]'))!);
    const input = screen.getByDisplayValue('MANGO CUSHION');
    fireEvent.change(input, { target: { value: 'MANGO CUSHION XL' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }));

    expect(await screen.findByRole('button', { name: /Edit Prices/ })).toBeTruthy();
    expect(codesInOrder()).toEqual(['A-001', 'B-002', 'C-003']);
  });

  test('leaving edit mode keeps the sort the operator set', () => {
    renderPage();
    fireEvent.click(screen.getByRole('columnheader', { name: /Description/ }));
    fireEvent.click(screen.getByRole('button', { name: /Edit Prices/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(codesInOrder()).toEqual(['C-003', 'B-002', 'A-001']);
  });
});
