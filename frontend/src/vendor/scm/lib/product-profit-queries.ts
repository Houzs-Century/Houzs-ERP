// ----------------------------------------------------------------------------
// product-profit-queries — the monthly product profit ranking (owner
// 2026-10-05: 每个月什么产品最好卖，兼顾售价和成本，不只看销量). One row per
// model the month sold, with its own cost and its share of the gifts; the page
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
  month: string;
  from: string;
  to: string;
  orders: number;
  rows: ProductProfitRow[];
  unallocatedGift: { orders: number; sen: number };
  freeBedframes: { pieces: number; sen: number; orders: number };
  noCost: { lines: number; salesSen: number };
};

export const useProductProfit = (month: string) => useQuery({
  queryKey: ['product-profit', month],
  queryFn: () => authedFetch<ProductProfitData>(`/accounting/product-profit?month=${encodeURIComponent(month)}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});
