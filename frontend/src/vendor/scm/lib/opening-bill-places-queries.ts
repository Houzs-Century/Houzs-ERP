// ----------------------------------------------------------------------------
// Opening bills in the Cash Flow (owner 2026-11-25, 「要，做 A」): where each
// supplier's payments of its opening bills (the AutoCount bills brought over at
// go-live) read, a bill's own choice where one supplier's bills are for
// different things, and what each bill bought by AutoCount's lines.
// Backend: scm/routes/accounting-opening-bill-places.ts.
// ----------------------------------------------------------------------------
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type PlaceAccount = { code: string; name: string };
/** A choice or the automatic rule's answer: an account, or a Cash Flow category. */
export type PlaceOut = ({ kind: 'account' } & PlaceAccount) | { kind: 'category'; id: string; label: string };
export type CashFlowCategory = { id: string; label: string; path: string };
export type OpeningSupplierRow = {
  id: string; code: string; name: string;
  bills: number; openBills: number; owingSen: number; paidSen: number;
  billsSet: number;
  /** How many of its bills read by what they bought (AutoCount's lines). */
  billsByGoods: number;
  set: PlaceOut | null;
  /** What its own bills in the ERP give; null = the creditor control. */
  auto: PlaceOut | null;
};
export type OpeningBillsPayload = { suppliers: OpeningSupplierRow[]; accounts: PlaceAccount[]; categories: CashFlowCategory[] };
/** What a bill bought as the Cash Flow splits it: a share per purchase account, the rest as the supplier's line. Weights only. */
export type BillGoods = { parts: Array<PlaceAccount & { sen: number }>; restSen: number };
export type OpeningBillRow = {
  id: string; number: string; date: string; text: string; totalSen: number; paidSen: number; status: string; set: PlaceOut | null;
  goods: BillGoods | null;
};
/** One choice to keep: a supplier's or a bill's, an account or a category, or neither to clear it. */
export type PlaceChange = { supplierId: string | null; billId: string | null; account: string | null; category: string | null };

const BASE = '/accounting/reports/receipts-payments/opening-bills';
const KEY = 'report-rp-opening-bills';

export const useOpeningBills = (enabled: boolean) => useQuery({
  queryKey: [KEY],
  queryFn: () => authedFetch<OpeningBillsPayload>(BASE),
  enabled,
  staleTime: 0,
  retry: retryUnlessClientError,
});

export const useOpeningBillRows = (supplierId: string | null) => useQuery({
  queryKey: [KEY, supplierId],
  queryFn: () => authedFetch<{ bills: OpeningBillRow[] }>(`${BASE}/${encodeURIComponent(String(supplierId))}`),
  enabled: supplierId !== null,
  staleTime: 0,
  retry: retryUnlessClientError,
});

/** Keep one choice; the list, the bills and the Cash Flow are read again. */
export const useSaveOpeningBillPlace = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (change: PlaceChange) => authedFetch<{ ok: boolean }>(`${BASE}/place`, { method: 'PUT', body: JSON.stringify(change) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [KEY] });
      void qc.invalidateQueries({ queryKey: ['report-rp'] });
    },
    onError: writeFailedAs('That Cash Flow line was not saved'),
  });
};
