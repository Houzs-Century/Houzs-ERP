
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
  imported: boolean;
  part: CoverPart;
  amountSen: number;
};

export type Count = { orders: number; amountSen: number };

export type CoverTotal = Count & {
  pct: number | null;
};

/** The two cover rates, one decimal, of amounts or of order counts. */
export type CoverRates = {
  onBacklog: number | null;
  onMonth: number | null;
};

export type CoverMonth = {
  month: string;
  backlog: Count;
  backlogProcessed: Count;
  processed: Count;
  amount: CoverRates;
  orders: CoverRates;
};

export type SoBacklogCoverData = {
  month: string;
  from: string;
  to: string;
  total: Count;
  parts: Record<CoverPart, CoverTotal>;
  backlog: Count;
  cover: { amount: CoverRates; orders: CoverRates };
  average: { from: string; to: string; amount: CoverRates; orders: CoverRates };
  defaultFrom: string;
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
