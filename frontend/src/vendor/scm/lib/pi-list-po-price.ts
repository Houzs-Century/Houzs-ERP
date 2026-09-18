/* pi-list-po-price — the Purchase Invoices LIST marker: was this invoice billed
   at its purchase orders' prices?

   Owner 2026-09-14: 「在外面的界面 UI 上，能直接看到这个 PI 的价钱，以及之前在 PO
   里的价钱是多少」, and the price on the PO is 「只是一个 reference」 — so this is a
   quiet marker, not a warning, and nothing is gated on it.

   Fetched a beat after the list renders, for the ids it just showed, from
   GET /purchase-invoices/list-po-price — which reads the lines through the SAME
   server function as the detail page, so the list and the detail cannot count
   differently. */

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type PiPoPriceSummary = {
  linesDiffering: number;
  totalDiffSen: number;
  /** Lines that HAD a PO price to compare (a PO line priced above 0). */
  comparableLines: number;
  lines: number;
};

export type PoPriceMarker = { label: string; tone: 'differs' | 'matches' | 'none'; diffSen: number };

export const poPriceMarker = (s: PiPoPriceSummary | undefined): PoPriceMarker | null => {
  if (!s) return null;
  if (s.linesDiffering > 0) {
    return { label: `${s.linesDiffering} ${s.linesDiffering === 1 ? 'line differs' : 'lines differ'}`, tone: 'differs', diffSen: s.totalDiffSen };
  }
  /* Nothing to compare is its own answer. "Matches PO" on an invoice whose
     orders never named a price would read as a check that passed. */
  if (s.comparableLines === 0) return { label: 'No PO price', tone: 'none', diffSen: 0 };
  return { label: 'Matches PO', tone: 'matches', diffSen: 0 };
};

const CHUNK = 100;

export function usePiListPoPriceMap(piIds: string[], enabled: boolean): Map<string, PiPoPriceSummary> {
  const chunks = useMemo(() => {
    const uniq = [...new Set(piIds.filter(Boolean))].sort();
    const out: string[][] = [];
    for (let i = 0; i < uniq.length; i += CHUNK) out.push(uniq.slice(i, i + CHUNK));
    return out;
  }, [piIds]);

  const results = useQueries({
    queries: chunks.map((chunk) => ({
      enabled: enabled && chunk.length > 0,
      queryKey: ['purchase-invoices-list-po-price', chunk.join(',')],
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        authedFetch<{ summary: Record<string, PiPoPriceSummary> }>(
          `/purchase-invoices/list-po-price?piIds=${encodeURIComponent(chunk.join(','))}`,
          { signal },
        ),
      staleTime: 30_000,
    })),
  });

  const sig = results.map((r) => r.dataUpdatedAt).join('|');
  return useMemo(() => {
    const map = new Map<string, PiPoPriceSummary>();
    for (const r of results) {
      const s = r.data?.summary;
      if (s) for (const [k, v] of Object.entries(s)) map.set(k, v);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `results` is read through `sig` (per-chunk dataUpdatedAt); depending on the array itself would rebuild every render.
  }, [sig]);
}
