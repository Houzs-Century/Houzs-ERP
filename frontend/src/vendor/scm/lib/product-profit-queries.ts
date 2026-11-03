// ----------------------------------------------------------------------------
// product-profit-queries — the monthly product profit ranking (owner
// 2026-10-05: 每个月什么产品最好卖，兼顾售价和成本，不只看销量). One row per
// model the months sold, with its own cost and its share of the gifts; the page
// sorts, filters by category and switches the gifts in or out.
// Server: backend/src/scm/routes/accounting-product-profit.ts over
// acc/product-profit.ts.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type ProductCategory = 'mattress' | 'sofa' | 'bedframe' | 'other';

export type ProductProfitItem = { code: string; size: string | null; units: number; salesSen: number; costSen: number };
export type ProductProfitRow = {
  key: string;
  model: string;
  brand: string | null;
  category: ProductCategory;
  /** Sets for a sofa (the orders that bought it), pieces for everything else. */
  units: number;
  orders: number;
  salesSen: number;
  /** Its own cost, a set's unpriced modules included. */
  costSen: number;
  /** Its share of the gifts on the orders that bought it. */
  giftSen: number;
  /** Its share of the free bedframes among those gifts: pieces (one decimal) and cost. */
  freeBedframes: number;
  freeBedframeSen: number;
  /** Priced lines with no cost on them — the margin reads high. */
  noCostLines: number;
  items: ProductProfitItem[];
};
export type ProductProfitData = {
  /** The first month read (`YYYY-MM`). */
  month: string;
  /** The first and last days of the whole months read. */
  from: string;
  to: string;
  orders: number;
  rows: ProductProfitRow[];
  unallocatedGift: { orders: number; sen: number };
  freeBedframes: { pieces: number; sen: number; orders: number };
  noCost: { lines: number; salesSen: number };
};

/** The whole months the report reads, `YYYY-MM` each (the redesign's c8; owner
    2026-11-03 「要」): from = to is the monthly report it always was; several
    months add up, each order in the month of its SO date. */
export type ProfitMonths = { from: string; to: string };

export const useProductProfit = (months: ProfitMonths) => useQuery({
  queryKey: ['product-profit', months.from, months.to],
  queryFn: () => authedFetch<ProductProfitData>(
    `/accounting/product-profit?from=${encodeURIComponent(months.from)}&to=${encodeURIComponent(months.to)}`,
  ),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});
