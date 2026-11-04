/* The Product profit report (owner 2026-10-05; the redesign, batch 6 §5.11).
   Pinned: a row per model ranked by gross profit with its own cost, its share
   of the gifts and the bedframes it gave away; the category chips tick any
   number at once; the gifts switch moves gross profit and drops the gifts
   column; a model opens to its sizes; the three charts are drawn; the shared
   range is read in whole months — one month is the monthly report, several add
   up (c8; owner 2026-11-03 「要」, question g2), and a part month widens with
   the subtitle saying so; Excel draws the rows as shown, Charts PNG sits under
   the header's ⋯. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProductProfitData } from '../../vendor/scm/lib/product-profit-queries';
import { ShellContext, type ShellSlots } from './reports/reportParts';

let data: ProductProfitData;
const asked = vi.fn();
vi.mock('../../vendor/scm/lib/product-profit-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/product-profit-queries')>()),
  useProductProfit: (months: { from: string; to: string }) => { asked(months); return { data, isLoading: false, isError: false, error: null }; },
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
/* Inside a shell, to read the header's grey line the report sets. */
const subtitle = vi.fn();
const drawInShell = (search: string) => {
  const slots: ShellSlots = { actionsHost: null, setSubtitle: subtitle, inPlaceHost: null, setInPlace: () => {} };
  return render(
    <MemoryRouter initialEntries={[`/scm/accounting${search}`]}>
      <ShellContext.Provider value={slots}><ProductProfitTab /></ShellContext.Provider>
    </MemoryRouter>,
  );
};
const lastSubtitle = () => subtitle.mock.calls.map((c) => c[0]).filter((t) => t != null).at(-1);

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
    expect(asked).toHaveBeenLastCalledWith({ from: '2026-09', to: '2026-09' });
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

  test('one whole month of the shared range is the monthly report, and the subtitle names the month alone', () => {
    subtitle.mockClear();
    drawInShell('?tab=products&from=2026-09-01&to=2026-09-30');
    expect(asked).toHaveBeenLastCalledWith({ from: '2026-09', to: '2026-09' });
    expect(lastSubtitle()).toBe('September 2026 · by SO date · All · gifts included');
    /* The shell's shared dates, not a month box of its own. */
    expect(screen.queryByLabelText('Month')).toBeNull();
  });

  test('several months read together; a part month widens to the whole month and the subtitle says so', () => {
    subtitle.mockClear();
    data = { ...data, month: '2026-07', from: '2026-07-01', to: '2026-08-31' };
    drawInShell('?tab=products&from=2026-07-15&to=2026-08-20');
    expect(asked).toHaveBeenLastCalledWith({ from: '2026-07', to: '2026-08' });
    expect(lastSubtitle()).toBe('July 2026 – August 2026 · whole months · by SO date · All · gifts included');
    expect(screen.getByText(/^2 months added together, each order in the month of its SO date\./)).toBeTruthy();
  });

  test("a range carried in from another report stays the reader's range", () => {
    draw('?tab=products&from=2026-01-01&to=2026-10-31');
    expect(asked).toHaveBeenLastCalledWith({ from: '2026-01', to: '2026-10' });
    expect(screen.getByLabelText('address').textContent).toBe('?tab=products&from=2026-01-01&to=2026-10-31');
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

  test('several months: the file and the sheet name the months', async () => {
    data = { ...data, month: '2026-07', from: '2026-07-01', to: '2026-08-31' };
    draw('?tab=products&from=2026-07-01&to=2026-08-31');
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0] as [{ subtitle: string; meta: Array<{ label: string; value: string }> }, string];
    expect(file).toBe('product-profit-2026-07-2026-08.xlsx');
    expect(sheet.subtitle).toBe('July 2026 – August 2026 · by SO date · All · gifts included · RM');
    expect(sheet.meta[0]).toEqual({ label: 'Months', value: 'July 2026 – August 2026' });
  });
});
