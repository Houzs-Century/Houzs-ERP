import { writeFailed, writeFailedAs } from './mutation-error';

import { useMemo } from 'react';
import { useListMrpEnrichmentChunks } from './list-mrp-enrichment-chunks';
import type { ListMrpStatus } from '../../../lib/listMrpStatus';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { piListParams } from './pi-list-export';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { piLedgerGap, type PiLedgerOutcome } from './pi-ledger-outcome';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { applyPiListMrpEnrichment, type EnrichablePiRow, type PiListMrpEnrichment } from '../../../lib/piListEnrichment';

export const usePurchaseInvoices = (status?: string) =>
  useQuery({
    queryKey: ['purchase-invoices', status ?? 'all'],
    queryFn: () => authedFetch<{ purchaseInvoices: any[] }>(`/purchase-invoices${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

export function usePurchaseInvoicesPaged(params: { from?: string; to?: string; page: number; pageSize: number; status?: string; q?: string; sort?: string; creditorNames?: string[]; creditorCodes?: string[]; currencies?: string[] }) {
  const { page, pageSize, status, q, sort, creditorNames, creditorCodes, currencies, from, to } = params;
  const usp = piListParams({ status, q, sort, creditorNames, creditorCodes, currencies, from, to });
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  return useQuery({
    queryKey: ['purchase-invoices-paged', page, pageSize, status ?? '', q ?? '', sort ?? '', JSON.stringify(creditorNames ?? []), JSON.stringify(creditorCodes ?? []), JSON.stringify(currencies ?? [])],
    queryFn: ({ signal }) => authedFetch<{ purchaseInvoices: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; draft: number; posted: number; partial: number; paid: number; cancelled: number } & Partial<Record<'on_hold', number>> }>(`/purchase-invoices?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

const ENRICH_CHUNK = 100;

export function usePiListMrpEnrichmentMap(
  piIds: string[],
  enabled: boolean,
): { byId: Map<string, PiListMrpEnrichment>; isFetching: boolean; mrp: ListMrpStatus } {
  const { byId, isFetching, mrp } = useListMrpEnrichmentChunks<PiListMrpEnrichment>({
    ids: piIds,
    enabled,
    queryKeyPrefix: 'purchase-invoices-list-mrp-enrichment',
    urlPrefix: '/purchase-invoices/list-mrp-enrichment?piIds=',
    chunkSize: ENRICH_CHUNK,
  });
  return { byId, isFetching, mrp };
}

export function useEnrichedPiListRows<T extends EnrichablePiRow>(
  rows: T[],
  enabled: boolean,
): { rows: T[]; mrp: ListMrpStatus } {
  const ids = useMemo(
    () => rows.map((r) => r.id).filter((x): x is string => !!x),
    [rows],
  );
  const { byId, mrp } = usePiListMrpEnrichmentMap(ids, enabled);
  const healed = useMemo(
    () => rows.map((r) => applyPiListMrpEnrichment(r, r.id ? byId.get(r.id) : undefined)),
    [rows, byId],
  );
  return { rows: healed, mrp };
}
export const usePurchaseInvoiceDetail = (id: string | null) => useQuery({
  queryKey: ['purchase-invoice-detail', id],
  queryFn: () => authedFetch<{ purchaseInvoice: any; items: any[]; customerDos?: Array<{ id: string; do_number: string }> }>(`/purchase-invoices/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});
export const usePostPurchaseInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ledger?: PiLedgerOutcome }>(`/purchase-invoices/${id}/post`, { method: 'PATCH' }),
    onSuccess: async (res, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', id] });
      const gap = piLedgerGap(res.ledger);
      if (gap) await serviceNotify({ title: 'Invoice posted without its AP journal', body: gap.charAt(0).toUpperCase() + gap.slice(1), tone: 'error' });
    },
    onError: writeFailedAs('Purchase invoice not posted'),
  });
};
export const useCancelPurchaseInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-invoices/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', id] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel invoice failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

export const useCreatePurchaseInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; invoiceNumber: string }>(`/purchase-invoices`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchase-invoices'] }),
  });
};

export const useUpdatePurchaseInvoiceHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; supplierInvoiceRef?: string; invoiceDate?: string;
      dueDate?: string; currency?: string; notes?: string;
    }) => authedFetch<{ purchaseInvoice: any }>(`/purchase-invoices/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};

export const useUpdatePurchaseInvoiceItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...body }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true }>(`/purchase-invoices/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};

export const useDeletePurchaseInvoiceItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/purchase-invoices/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
    onError: writeFailed,
  });
};

export const useAddPurchaseInvoiceItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/purchase-invoices/${id}/items`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};
