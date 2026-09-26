// ----------------------------------------------------------------------------
// delivery-row-mark — the Delivery Planning board's manual colour marks (owner
// 2026-09-26: 色板标记). The palette (tint + swatch) lives here so the look can
// change without a migration; the TOKENS must match the backend's
// scm/lib/row-mark-colours.ts, which is the write route's allow-list.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';

export type RowMarkColour = 'red' | 'amber' | 'green' | 'blue' | 'grey';

/** One palette entry: the stored `token`, the operator-facing `label`, the soft
 *  row `tint`, and the solid `swatch` shown in the picker. */
export const ROW_MARK_PALETTE: { token: RowMarkColour; label: string; tint: string; swatch: string }[] = [
  { token: 'red',   label: 'Red',   tint: '#fdeaea', swatch: '#d64545' },
  { token: 'amber', label: 'Amber', tint: '#fdf4dd', swatch: '#d99e2b' },
  { token: 'green', label: 'Green', tint: '#e7f4ea', swatch: '#2e7d4f' },
  { token: 'blue',  label: 'Blue',  tint: '#e6eefb', swatch: '#3b6fd0' },
  { token: 'grey',  label: 'Grey',  tint: '#eceef1', swatch: '#8a9099' },
];

const TINT = new Map(ROW_MARK_PALETTE.map((p) => [p.token, p.tint]));

/** The row background for a mark token, or undefined for no / unknown mark (so a
 *  stale token from a future palette never paints a row an unreadable colour). */
export function rowMarkTint(colour: string | null | undefined): string | undefined {
  return colour ? TINT.get(colour as RowMarkColour) : undefined;
}

type MarksResponse = { marks: { rowKey: string; colour: string }[] };

/** Every painted row, as a Map<rowKey, colour token>. Its own query key, so the
 *  board's frequent `['delivery-planning']` invalidations don't refetch it. */
export function useDeliveryRowMarks() {
  return useQuery({
    queryKey: ['delivery-row-marks'],
    queryFn: () =>
      authedFetch<MarksResponse>('/delivery-planning-row-marks').then(
        (r) => new Map(r.marks.map((m) => [m.rowKey, m.colour])),
      ),
    staleTime: 30_000,
  });
}

export function useSetRowMark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { rowKey: string; colour: RowMarkColour }) =>
      authedFetch<{ ok: true }>('/delivery-planning-row-marks', { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-row-marks'] }),
    onError: writeFailed,
  });
}

export function useClearRowMark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rowKey: string) =>
      authedFetch<{ ok: true }>(`/delivery-planning-row-marks/${encodeURIComponent(rowKey)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-row-marks'] }),
    onError: writeFailed,
  });
}

/* Paint / clear MANY rows at once from the bulk bar (owner 2026-09-26: 勾选几行
   → 点上方色块). Fans out to the single-row endpoints — a handful of selected
   rows, not a mass import — and reports any failure through the shared onError. */
export function useBulkSetRowMark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rowKeys, colour }: { rowKeys: string[]; colour: RowMarkColour }) =>
      Promise.all(rowKeys.map((rowKey) =>
        authedFetch<{ ok: true }>('/delivery-planning-row-marks', { method: 'PUT', body: JSON.stringify({ rowKey, colour }) }),
      )),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-row-marks'] }),
    onError: writeFailed,
  });
}

export function useBulkClearRowMark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rowKeys: string[]) =>
      Promise.all(rowKeys.map((rowKey) =>
        authedFetch<{ ok: true }>(`/delivery-planning-row-marks/${encodeURIComponent(rowKey)}`, { method: 'DELETE' }),
      )),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-row-marks'] }),
    onError: writeFailed,
  });
}
