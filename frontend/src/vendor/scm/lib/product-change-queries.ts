// ----------------------------------------------------------------------------
// product-change-queries — Finance's product change reports (owner 2026-11-23:
// 「我主要是看销售价和成本的变动，因为我要确定这些改动销售价是足够cover成本的变动」).
// One row per product change on a sales order, with selling and cost before and
// after (product lines only) and whether the selling change covered the cost
// change. Server: backend/src/scm/routes/accounting-product-changes.ts over
// acc/product-changes.ts; the change itself is recorded by
// scm/lib/so-product-change-record.ts.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type ProductChangeType = 'sku' | 'height' | 'option' | 'pieces' | 'qty' | 'new_line' | 'removed_line';
/** SELLING: the selling amount changed. COST_ONLY: it did not, the cost did. */
export type ProductChangeBucket = 'SELLING' | 'COST_ONLY';

export type ChangedLineSide = { code: string; qty: number; sellingSen: number; costSen: number };
export type ChangedLine = {
  id: string;
  types: ProductChangeType[];
  before: ChangedLineSide | null;
  after: ChangedLineSide | null;
};

export type ProductChangeRow = {
  id: string;
  docNo: string;
  soDate: string | null;
  customer: string | null;
  salesperson: string;
  imported: boolean;
  changeDay: string;
  changedAt: string | null;
  route: 'DIRECT' | 'AMENDMENT';
  amendmentNos: string[];
  changedBy: string[];
  approvedBy: string[];
  types: ProductChangeType[];
  bucket: ProductChangeBucket;
  sellingBeforeSen: number;
  sellingAfterSen: number;
  costBeforeSen: number;
  costAfterSen: number;
  sellingDeltaSen: number;
  costDeltaSen: number;
  marginDeltaSen: number;
  covered: boolean;
  shortfallSen: number;
  lines: ChangedLine[];
  rebuilt: boolean;
  costEstimated: boolean;
};

export type ProductChangesData = {
  month: string;
  from: string;
  to: string;
  rows: ProductChangeRow[];
};

/** Whole months, `YYYY-MM` each: from = to is one month. */
export type ChangeMonths = { from: string; to: string };

export const useProductChanges = (months: ChangeMonths) => useQuery({
  queryKey: ['product-changes', months.from, months.to],
  queryFn: () => authedFetch<ProductChangesData>(
    `/accounting/product-changes?from=${encodeURIComponent(months.from)}&to=${encodeURIComponent(months.to)}`,
  ),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});
