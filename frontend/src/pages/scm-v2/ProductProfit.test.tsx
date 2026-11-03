/* The Product profit report (owner 2026-10-05; the redesign, batch 6 §5.11).
   Pinned: a row per model ranked by gross profit with its own cost, its share
   of the gifts and the bedframes it gave away; the category chips tick any
   number at once; the gifts switch moves gross profit and drops the gifts
   column; a model opens to its sizes; the three charts are drawn; the month is
   one whole month of the shared range (question g2 open); Excel draws the rows
   as shown, Charts PNG sits under the header's ⋯. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProductProfitData } from '../../vendor/scm/lib/product-profit-queries';

let data: ProductProfitData;
const asked = vi.fn();
vi.mock('../../vendor/scm/lib/product-profit-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/product-profit-queries')>()),
  useProductProfit: (month: string) => { asked(month); return { data, isLoading: false, isError: false, error: null }; },
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: vi.fn() }));
const png = vi.fn(async (..._a: unknown[]) => {});
vi.mock('./ProductProfitCharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ProductProfitCharts')>()),
  chartsPng: (...a: unknown[]) => png(...a),
}));

import { ProductProfitTab } from './ProductProfit';

const Where = () => {
  const l = useLocation();
  return <output aria-label="address">{l.search}</output>;
};
const draw = (search = '?tab=products&from=2026-09-01&to=2026-09-30') => render(
  <MemoryRouter initialEntries={[`/scm/accounting${search}`]}>
    <Routes><Route path="*" element={<><ProductProfitTab /><Where /></>} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  xlsx.mockClear();
  png.mockClear();
  asked.mockClear();
  window.sessionStorage.removeItem('fin-report-range');
  data = {
    month: '2026-09', from: '2026-09-01', to: '2026-09-30', orders: 3,
    rows: [
      {
        key: 'm:1', model: 'ULTIMATE', brand: 'AKEMI', category: 'mattress', units: 2, orders: 2,
        salesSen: 1_200_000, costSen: 300_000, giftSen: 90_000, freeBedframes: 1, freeBedframeSen: 90_000, noCostLines: 0,
        items: [{ code: 'ULT-Q', size: 'Queen', units: 1, salesSen: 600_000, costSen: 150_000 }, { code: 'ULT-K', size: 'King', units: 1, salesSen: 600_000, costSen: 150_000 }],
      },
      {
        key: 'm:3', model: 'SOFFIO', brand: 'ZANOTTI', category: 'sofa', units: 1, orders: 1,
        salesSen: 500_000, costSen: 200_000, giftSen: 0, freeBedframes: 0, freeBedframeSen: 0, noCostLines: 0, items: [],
      },
      {
        key: 'm:4', model: 'JAGER', brand: null, category: 'bedframe', units: 1, orders: 1,
        salesSen: 150_000, costSen: 0, giftSen: 0, freeBedframes: 0, freeBedframeSen: 0, noCostLines: 1, items: [],
      },
    ],
    unallocatedGift: { orders: 0, sen: 0 },
    freeBedframes: { pieces: 1, sen: 90_000, orders: 1 },
    noCost: { lines: 1, salesSen: 150_000 },
  };
});

const table = () => within(within(screen.getByRole('region', { name: 'Product profit' })).getAllByRole('table')[0]!);
const modelsShown = () => table().getAllByText(/^(ULTIMATE|SOFFIO|JAGER)$/).map((e) => e.textContent);

describe('Product profit', () => {
  test('a row per model, ranked by gross profit, with its gifts and the bedframes it gave away', () => {
    draw();
    expect(asked).toHaveBeenLastCalledWith('2026-09');
    expect(modelsShown()).toEqual(['ULTIMATE', 'SOFFIO', 'JAGER']);
    const t = table();
    expect(t.getByText('2 pcs')).toBeTruthy();
    expect(t.getByText('1 set')).toBeTruthy();
    expect(t.getAllByText('8,100.00').length).toBeGreaterThan(0);
    expect(t.getByText('1 pc · 900.00')).toBeTruthy();
    expect(t.getByText(/Cost incomplete/)).toBeTruthy();
    /* Headers read in Title Case app-wide (owner 2026-09-25); the % says what it is a % of. */
    expect(t.getByText('Margin · % of Sales')).toBeTruthy();
    const totals = within(screen.getByRole('group', { name: 'Totals' }));
    expect(totals.getByText('Free bedframes')).toBeTruthy();
    expect(totals.getByText('Sales')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Products ranked, highest first' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Share of gross profit' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'From sales to gross profit' })).toBeTruthy();
  });

  test('categories tick any number at once; All clears them', () => {
    draw();
    const cats = within(screen.getByRole('group', { name: 'Category' }));
    fireEvent.click(cats.getByRole('button', { name: 'Mattress' }));
    expect(modelsShown()).toEqual(['ULTIMATE']);
    fireEvent.click(cats.getByRole('button', { name: 'Bedframe' }));
    expect(modelsShown()).toEqual(['ULTIMATE', 'JAGER']);
    fireEvent.click(cats.getByRole('button', { name: 'Sofa' }));
    expect(modelsShown().length).toBe(3);
    fireEvent.click(cats.getByRole('button', { name: 'All' }));
    expect(cats.getByRole('button', { name: 'Mattress' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('the gifts switch moves gross profit and drops the gifts column', () => {
    draw();
    expect(table().getByText('Gifts')).toBeTruthy();
    expect(table().getAllByText('8,100.00').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('switch', { name: 'Include gifts' }));
    expect(table().queryByText('Gifts')).toBeNull();
    expect(table().getAllByText('9,000.00').length).toBeGreaterThan(0);
    expect(within(screen.getByRole('group', { name: 'Totals' })).getByText('Gifts (not counted)')).toBeTruthy();
  });

  test('the ranking chart follows Rank by', () => {
    draw();
    const charts = within(screen.getByRole('group', { name: 'Charts' }));
    expect(charts.getByText(/Gross profit ranking · top 3/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Rank by' })).getByRole('button', { name: 'Units sold' }));
    expect(charts.getByText(/Units sold ranking · top 3/)).toBeTruthy();
    expect(modelsShown()).toEqual(['ULTIMATE', 'SOFFIO', 'JAGER']);
  });

  test('a model opens to its sizes', () => {
    draw();
    const row = screen.getByText('ULTIMATE').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Expand row' }));
    const sizes = within(screen.getByRole('table', { name: "ULTIMATE's sizes" }));
    expect(sizes.getByText('ULT-K')).toBeTruthy();
    expect(sizes.getByText('King')).toBeTruthy();
  });

  test('one whole month: the month the range ends in, and a month picked sets the range to it', async () => {
    draw('?tab=products&from=2026-07-01&to=2026-08-20');
    expect(asked).toHaveBeenLastCalledWith('2026-08');
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await waitFor(() => expect(asked).toHaveBeenLastCalledWith('2026-06'));
    expect(screen.getByLabelText('address').textContent).toBe('?tab=products&from=2026-06-01&to=2026-06-30');
  });

  test('Excel draws the rows as shown; Charts PNG sits under the ⋯', async () => {
    draw();
    fireEvent.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Sofa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0] as [{ tables: Array<{ rows: Array<{ label: string }> }> }, string];
    expect(sheet.tables[0]!.rows.map((r) => r.label)).toEqual(['1. SOFFIO · ZANOTTI', 'Total']);
    expect(file).toBe('product-profit-2026-09.xlsx');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Charts PNG' }));
    await waitFor(() => expect(png).toHaveBeenCalledTimes(1));
    expect(png.mock.calls[0]![2]).toBe('product-profit-2026-09-charts.png');
  });
});
