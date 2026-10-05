/* The Product Profit tab (owner 2026-10-05). Pinned: a row per model ranked
   by gross profit with its own cost, its share of the gifts and the bedframes
   it gave away; the category chips tick any number at once; the gifts switch
   moves gross profit and drops the gifts column; ▸ opens a model's sizes; the
   three charts are drawn; Excel draws the rows as shown. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProductProfitData } from '../../vendor/scm/lib/product-profit-queries';

let data: ProductProfitData;
vi.mock('../../vendor/scm/lib/product-profit-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/product-profit-queries')>()),
  useProductProfit: () => ({ data, isLoading: false, isError: false, error: null }),
}));
const xlsx = vi.fn();
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: vi.fn() }));

import { ProductProfitTab } from './ProductProfit';

beforeEach(() => {
  xlsx.mockReset();
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

const table = () => within(screen.getByRole('table', { name: 'Product profit' }));
const modelsShown = () => table().getAllByRole('button', { name: /sizes$/ }).map((b) => b.textContent);

describe('Product Profit', () => {
  test('a row per model, ranked by gross profit, with its gifts and the bedframes it gave away', () => {
    render(<ProductProfitTab />);
    expect(modelsShown().map((t) => t.replace(/ ·.*$/, ''))).toEqual(['ULTIMATE', 'SOFFIO', 'JAGER']);
    const t = table();
    expect(t.getByText('2 pcs')).toBeTruthy();
    expect(t.getByText('1 set')).toBeTruthy();
    expect(t.getAllByText('8,100.00').length).toBeGreaterThan(0);
    expect(t.getByText('1 pc · 900.00')).toBeTruthy();
    expect(t.getByText(/Cost incomplete/)).toBeTruthy();
    expect(within(screen.getByLabelText('Totals')).getByText('Free bedframes')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Products ranked, highest first' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Share of gross profit' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'From sales to gross profit' })).toBeTruthy();
  });

  test('categories tick any number at once; All clears them', () => {
    render(<ProductProfitTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Mattress' }));
    expect(modelsShown().map((t) => t.replace(/ ·.*$/, ''))).toEqual(['ULTIMATE']);
    fireEvent.click(screen.getByRole('button', { name: 'Bedframe' }));
    expect(modelsShown().map((t) => t.replace(/ ·.*$/, ''))).toEqual(['ULTIMATE', 'JAGER']);
    fireEvent.click(screen.getByRole('button', { name: 'Sofa' }));
    expect(modelsShown().length).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'Mattress' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('the gifts switch moves gross profit and drops the gifts column', () => {
    render(<ProductProfitTab />);
    expect(table().getByText('Gifts')).toBeTruthy();
    expect(table().getAllByText('8,100.00').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(table().queryByText('Gifts')).toBeNull();
    expect(table().getAllByText('9,000.00').length).toBeGreaterThan(0);
  });

  test('the ranking chart follows Rank by', () => {
    render(<ProductProfitTab />);
    const charts = within(screen.getByLabelText('Charts'));
    expect(charts.getByText(/Gross profit ranking · top 3/)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Rank by' }), { target: { value: 'units' } });
    expect(charts.getByText(/Units sold ranking · top 3/)).toBeTruthy();
    expect(modelsShown().map((t) => t.replace(/ ·.*$/, ''))).toEqual(['ULTIMATE', 'SOFFIO', 'JAGER']);
  });

  test('▸ opens a model\'s sizes', () => {
    render(<ProductProfitTab />);
    fireEvent.click(table().getByRole('button', { name: "Show ULTIMATE's sizes" }));
    expect(table().getByText('ULT-K')).toBeTruthy();
    expect(table().getByText(/King/)).toBeTruthy();
  });

  test('Excel draws the rows as shown', () => {
    render(<ProductProfitTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Sofa' }));
    fireEvent.click(screen.getByRole('button', { name: /Excel/ }));
    const [sheet, file] = xlsx.mock.calls[0] as [{ tables: Array<{ rows: Array<{ label: string }> }> }, string];
    expect(sheet.tables[0].rows.map((r) => r.label)).toEqual(['1. SOFFIO · ZANOTTI', 'Total']);
    expect(file).toBe('product-profit-2026-09.xlsx');
  });
});
