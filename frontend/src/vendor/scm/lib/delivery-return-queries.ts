// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — ONLY the Delivery
// Return (DR) read / detail / status / item / line-picker hooks the vendored DR
// list / new / from-do / detail pages use.
//
// HOUZS VENDOR NOTES (boundary only — bodies are verbatim):
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST.
//   - serviceNotify (the non-React error toast bridge) maps to the vendored
//     dialog-service serviceNotify (used by the status-update onError).
//   - useMfgDeliveryOrderDetail (New-DR prefill) lives in the vendored DO slice
//     — re-exported below so the page's single import site keeps working.
//   - DoRemainingLine is owned by the SI slice (the invoiceable + returnable
//     pickers share the shape) — re-exported here, not re-declared.
//
// A Delivery Return = goods coming BACK from the customer → creating one
// INCREASES stock (handled server-side on create).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { writeFailed, writeFailedAs } from './mutation-error';

// Re-export the DO-side prefill hook the New-DR page pulls from this module in
// the source (it lives in the vendored DO slice — single source of truth).
export { useMfgDeliveryOrderDetail } from './delivery-order-queries';
// The line-picker descriptor is shared with the SI side — single source of truth.
export type { DoRemainingLine } from './sales-invoice-queries';

import type { DoRemainingLine } from './sales-invoice-queries';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── Delivery Returns ────────────────────────────────────────────────── */
export const useDeliveryReturns = (status?: string) =>
  useQuery({
    queryKey: ['delivery-returns', status ?? 'all'],
    queryFn: () => authedFetch<{ deliveryReturns: any[] }>(`/delivery-returns${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
export const useDeliveryReturnDetail = (id: string | null) => useQuery({
  queryKey: ['delivery-return-detail', id],
  queryFn: () => authedFetch<{ deliveryReturn: any; items: any[] }>(`/delivery-returns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});
/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a return field. Pass one per return
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME returnNumber — instead of taking the goods back twice. Omitting it is
   exactly today's behaviour (the middleware no-ops).

   NOT on fix/so-idempotency's list of remaining creates — that list was written
   by reading the files it happened to open, and this one sits in its own. The
   onSuccess note below is the reason it belongs: a return increases stock ON
   CREATE, so a duplicate is an on-hand lie, not a spare row. */
export const useCreateDeliveryReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; returnNumber: string }>(`/delivery-returns`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      /* A return increases stock on create — refresh inventory queries so the
         on-hand drilldown reflects the IN. */
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
};

/* Returnable DO LINES for the line-level DO→Delivery Return picker. Each row is
   a DO line with remaining_to_return > 0 — the SAME Pending pool as
   remaining_to_invoice, so invoiced units never appear here. A line can be
   returned across several returns until remaining hits 0. */
export const useReturnableDoLines = () => useQuery({
  queryKey: ['delivery-returns', 'returnable-do-lines'],
  queryFn: () => authedFetch<{ lines: DoRemainingLine[] }>(
    `/delivery-returns/returnable-do-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* Convert picked DO LINES (each with a partial qty) → ONE Delivery Return.
   Server validates the picks share one customer + each qty is
   1..remaining_to_return, creates one return line per pick (status RECEIVED),
   recomputes totals, then increases stock. Returns the new return's
   { id, returnNumber, lineCount }. */
export const useConvertDoToDeliveryReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { picks: Array<{ doItemId: string; qty: number; condition?: string }> }) =>
      authedFetch<{ id: string; returnNumber: string; lineCount: number }>(
        `/delivery-returns/from-do`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      /* Picker must refetch so returned DO lines drop off the list. Both
         pickers (return + invoice) compete for the same DO Pending pool so
         refresh both (Wei Siang 2026-05-30). */
      qc.invalidateQueries({ queryKey: ['delivery-returns', 'returnable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['sales-invoices', 'invoiceable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
    },
    onError: writeFailedAs('Delivery return not created'),
  });
};

/* DR header PATCH — editable SO/DO-style fields. Mirrors
   useUpdateMfgDeliveryOrderHeader. */
export const useUpdateDeliveryReturnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/delivery-returns/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      qc.invalidateQueries({ queryKey: ['delivery-return-detail', vars.id] });
    },
    onError: writeFailed,
  });
};

export const useUpdateDeliveryReturnStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedFetch<{ deliveryReturn: unknown }>(`/delivery-returns/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      qc.invalidateQueries({ queryKey: ['delivery-return-detail', vars.id] });
      /* Cancel reverses the inventory increase (negative ADJUSTMENT) — refresh
         inventory so on-hand reflects the removed stock. */
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/* DR line-item CRUD — mirrors the DO item hooks. Each mutation recomputes the
   DR totals server-side, so we invalidate both the detail + list. */
export const useAddDeliveryReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/delivery-returns/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['delivery-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
    },
    onError: writeFailedAs('Line not added'),
  });
};

export const useUpdateDeliveryReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/delivery-returns/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['delivery-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
    },
    onError: writeFailed,
  });
};

export const useDeleteDeliveryReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/delivery-returns/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['delivery-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
    },
    onError: writeFailedAs('Line not deleted'),
  });
};
