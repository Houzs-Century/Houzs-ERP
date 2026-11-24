// ----------------------------------------------------------------------------
// so-backlog-cover-queries — Finance › Reports › SO conversion & backlog (owner
// 2026-11-24): the month's orders by Processing Date, this month's and the
// backlog's, the backlog at the 1st, the two backlog cover rates and their
// average. Server: backend/src/scm/routes/accounting-so-backlog-cover.ts over
// acc/so-backlog-cover.ts.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/** this_month: raised in the month it was processed. backlog: raised before it. */
export type CoverPart = 'this_month' | 'backlog';

/** Where the date an order counts on comes from: its Processing Date, or its
 *  first shipped DO when it has none. */
export type DateFrom = 'processing_date' | 'first_do';

export type CoverRow = {
  docNo: string;
  soDate: string;
  processedOn: string;
  dateFrom: DateFrom;
  customer: string | null;
  /** The order came over from AutoCount at the cutover. */
  imported: boolean;
  part: CoverPart;
  amountSen: number;
};

export type Count = { orders: number; amountSen: number };

export type CoverTotal = Count & {
  /** Share of the month's processed total, one decimal; null when nothing was processed. */
  pct: number | null;
};

export type CoverMonth = {
  month: string;
  /** Orders raised before the month and not processed by its 1st. */
  backlog: Count;
  backlogProcessed: Count;
  processed: Count;
  onBacklog: number | null;
  onMonth: number | null;
};

export type SoBacklogCoverData = {
  month: string;
  from: string;
  to: string;
  total: Count;
  parts: Record<CoverPart, CoverTotal>;
  /** The backlog at the month's 1st. */
  backlog: Count;
  cover: { onBacklog: number | null; onMonth: number | null };
  average: { from: string; to: string; onBacklog: number | null; onMonth: number | null };
  /** Where the average starts when the reader picks nothing. */
  defaultFrom: string;
  /** The months the average covers, oldest first; the last is this month. */
  months: CoverMonth[];
  rows: CoverRow[];
};

export const soBacklogCoverPath = (month: string, avgFrom: string | null): string =>
  `/accounting/so-backlog-cover?month=${encodeURIComponent(month)}${avgFrom ? `&avgFrom=${encodeURIComponent(avgFrom)}` : ''}`;

export const useSoBacklogCover = (month: string, avgFrom: string | null) => useQuery({
  queryKey: ['so-backlog-cover', month, avgFrom],
  queryFn: () => authedFetch<SoBacklogCoverData>(soBacklogCoverPath(month, avgFrom)),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});
