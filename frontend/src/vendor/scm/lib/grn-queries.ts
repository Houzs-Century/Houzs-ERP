
import { useMemo } from 'react';
import { useListMrpEnrichmentChunks } from './list-mrp-enrichment-chunks';
import type { ListMrpStatus } from '../../../lib/listMrpStatus';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { grnListParams } from './grn-list-export';
import { applyListMrpEnrichment, type EnrichableMrpRow, type ListMrpEnrichment } from '../../../lib/listMrpEnrichment';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { writeFailed, writeFailedAs, reportInBandFailure, type InBandFailure } from './mutation-error';

export const useGrnFromPos = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purchaseOrderIds: string[]; deliveryNoteRef?: string; notes?: string }) =>
      authedFetch<{ id: string; grnNumber: string; poCount: number; lineCount: number }>(
        `/grns/from-pos`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['grns', 'outstanding-po-items'], refetchType: 'all' });
    },
    onError: writeFailedAs('GRN not created'),
  });
};

export const usePurchaseReturnFromGrns = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { grnIds: string[]; reason?: string; notes?: string }) =>
      authedFetch<{ id: string; returnNumber: string; grnCount: number; lineCount: number }>(
        `/purchase-returns/from-grns`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
    onError: writeFailedAs('Purchase return not created'),
  });
};

export const useGrns = (status?: string) =>
  useQuery({
    queryKey: ['grns', status ?? 'all'],
    queryFn: () => authedFetch<{ grns: any[] }>(`/grns${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

export function useGrnsPaged(params: { from?: string; to?: string; page: number; pageSize: number; status?: string; q?: string; sort?: string; creditorNames?: string[]; creditorCodes?: string[]; currencies?: string[] }) {
  const { page, pageSize, status, q, sort, creditorNames, creditorCodes, currencies, from, to } = params;
  const usp = grnListParams({ status, q, sort, creditorNames, creditorCodes, currencies, from, to });
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  return useQuery({
    queryKey: ['grns-paged', page, pageSize, status ?? '', q ?? '', sort ?? '', JSON.stringify(creditorNames ?? []), JSON.stringify(creditorCodes ?? []), JSON.stringify(currencies ?? [])],
    queryFn: ({ signal }) => authedFetch<{ grns: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; draft: number; posted: number; cancelled: number } & Partial<Record<'on_hold', number>> }>(`/grns?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

const GRN_ENRICH_CHUNK = 100;

export function useGrnListMrpEnrichmentMap(
  grnIds: string[],
  enabled: boolean,
): { byId: Map<string, ListMrpEnrichment>; isFetching: boolean; mrp: ListMrpStatus } {
  const { byId, isFetching, mrp } = useListMrpEnrichmentChunks<ListMrpEnrichment>({
    ids: grnIds,
    enabled,
    queryKeyPrefix: 'grns-list-mrp-enrichment',
    urlPrefix: '/grns/list-mrp-enrichment?grnIds=',
    chunkSize: GRN_ENRICH_CHUNK,
  });
  return { byId, isFetching, mrp };
}

export function useEnrichedGrnListRows<T extends EnrichableMrpRow>(
  rows: T[],
  enabled: boolean,
): { rows: T[]; mrp: ListMrpStatus } {
  const ids = useMemo(
    () => rows.map((r) => r.id).filter((x): x is string => !!x),
    [rows],
  );
  const { byId, mrp } = useGrnListMrpEnrichmentMap(ids, enabled);
  const healed = useMemo(
    () => rows.map((r) => applyListMrpEnrichment(r, r.id ? byId.get(r.id) : undefined)),
    [rows, byId],
  );
  return { rows: healed, mrp };
}
export const useGrnDetail = (id: string | null) => useQuery({
  queryKey: ['grn-detail', id],
  queryFn: () => authedFetch<{ grn: any; items: any[] }>(`/grns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* Several notes at once — ONE supplier invoice may bill SEVERAL goods-received
   notes (owner 2026-08-06), so the PI review screen needs every picked note's
   lines, not just the primary's. Same query key + options as useGrnDetail, so a
   note already fetched singly is served from that cache. */
export const useGrnDetails = (ids: string[]) => useQueries({
  queries: ids.map((id) => ({
    queryKey: ['grn-detail', id],
    queryFn: () => authedFetch<{ grn: any; items: any[] }>(`/grns/${id}`),
    staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
  })),
});
const invalidateGrnPoSide = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
  void qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail'] });
  void qc.invalidateQueries({ queryKey: ['inventory'] });
};
export const useCreateGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; grnNumber: string } & InBandFailure>(`/grns`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => {
      invalidateGrnPoSide(qc);
      return qc.invalidateQueries({ queryKey: ['grns'] });
    },
  });
};
export const usePostGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ grn?: unknown } & InBandFailure>(`/grns/${id}/post`, { method: 'PATCH' }),
    onSuccess: (data, id) => {
      reportInBandFailure('GRN posted, but not everything was recorded', data);
      invalidateGrnPoSide(qc);
      qc.invalidateQueries({ queryKey: ['grn-detail', id] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailedAs('GRN not posted — the stock was NOT received'),
  });
};

/* ── GRN PO-clone CRUD (mirror the PO header + line item hooks) ─────────────
   PATCH /grns/:id (header), POST/PATCH/DELETE /grns/:id/items[/:itemId].
   Each invalidates the GRN detail (['grn-detail', id]) + list (['grns']) —
   the same query keys useGrnDetail + useGrns read — plus ['inventory']: on a
   POSTED GRN every one of these re-syncs stock server-side (header → warehouse
   relocation OUT+IN, item add → IN, item edit → delta OUT/IN, item delete →
   reversing OUT), so a mounted Stock Card / inventory list must refetch. Same
   stock-side rule usePostGrn / useCancelGrn follow (docs/modules/grn.md §1). */
export const useUpdateGrnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; receivedAt?: string; deliveryNoteRef?: string;
      warehouseId?: string; notes?: string; currency?: string;
    }) => authedFetch<{ grn: any }>(`/grns/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
};

export const useAddGrnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, ...body }: { grnId: string } & Record<string, unknown>) =>
      authedFetch<{ item: any } & InBandFailure>(`/grns/${grnId}/items`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (data, vars) => {
      reportInBandFailure('Line added, but not everything was recorded', data);
      invalidateGrnPoSide(qc);
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
};

export const useUpdateGrnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId, ...body }: { grnId: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true } & InBandFailure>(`/grns/${grnId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (data, vars) => {
      reportInBandFailure('Line saved, but not everything was recorded', data);
      invalidateGrnPoSide(qc);
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
};

export const useSetGrnLineRack = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId, rackId }: { grnId: string; itemId: string; rackId: string | null }) =>
      authedFetch<{ ok: true }>(`/grns/${grnId}/items/${itemId}/rack`, {
        method: 'PATCH', body: JSON.stringify({ rackId }),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      void qc.invalidateQueries({ queryKey: ['grn-racks', vars.grnId] });
      void qc.invalidateQueries({ queryKey: ['warehouse'] });
    },
  });
};

export type GrnItemRackRow = { grnItemId: string; rackId: string; qty: number };

export const useGrnItemRacks = (grnId: string | undefined) =>
  useQuery({
    queryKey: ['grn-racks', grnId],
    enabled: !!grnId,
    queryFn: () => authedFetch<{ racks: GrnItemRackRow[] }>(`/grns/${grnId}/racks`).then((r) => r.racks),
    retry: retryUnlessClientError,
  });

export const useSetGrnLineRacks = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId, racks }: { grnId: string; itemId: string; racks: { rackId: string; qty: number }[] }) =>
      authedFetch<{ ok: true }>(`/grns/${grnId}/items/${itemId}/racks`, {
        method: 'PUT', body: JSON.stringify({ racks }),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['grn-racks', vars.grnId] });
      void qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
    },
  });
};

export const useDeleteGrnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId }: { grnId: string; itemId: string }) =>
      authedFetch<void>(`/grns/${grnId}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailed,
  });
};

export const useCancelGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ grn: any; cancelErrors?: string[] }>(`/grns/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (data, id) => {
      reportInBandFailure('GRN cancelled, but the stock was not reversed', data);
      invalidateGrnPoSide(qc);
      qc.invalidateQueries({ queryKey: ['grn-detail', id] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel GRN failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

export const usePurchaseInvoiceFromGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grnId: string) =>
      authedFetch<{ id: string; invoiceNumber: string }>(`/purchase-invoices/from-grn`, {
        method: 'POST', body: JSON.stringify({ grnId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
    onError: writeFailedAs('Purchase invoice not created'),
  });
};

export const usePurchaseReturnFromGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, idempotencyKey }: { grnId: string; idempotencyKey?: string }) =>
      authedFetch<{ id: string; returnNumber: string }>(`/purchase-returns/from-grn`,
        idempotentInit(idempotencyKey, {
          method: 'POST', body: JSON.stringify({ grnId }),
        })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
    onError: writeFailedAs('Purchase return not created'),
  });
};
