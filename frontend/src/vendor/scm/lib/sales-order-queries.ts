import { appendSoListFilterParams } from './so-list-filter-state';
import type { SoListFilter } from '../../shared/so-list-filter-model';
import { reportInBandFailure, writeFailed, writeFailedAs, type InBandFailure } from './mutation-error';
import { resolveCompartmentArtUrl, loadCompartmentArt } from './sofa-compartment-art';

import { useMemo } from 'react';
import { useListMrpEnrichmentChunks } from './list-mrp-enrichment-chunks';
import type { ListMrpStatus } from '../../../lib/listMrpStatus';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, authedFetch, humanApiError } from './authed-fetch';
import { applySoListMrpEnrichment, type EnrichableSoRow, type SoListMrpEnrichment } from '../../../lib/soListEnrichment';
import { readAuthToken } from '../../../lib/authToken';
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromError,
  requestIdFromResponse,
} from '../../../lib/requestCorrelation';
import { companyHeader } from '../../../lib/activeCompany';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { askVpBrand, type VpBrandAsk } from './vp-brand-prompt';
import { invalidateCancelRequestViews } from './document-cancel-queries';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { prepareImageForUpload } from '../../../lib/imagePipeline';
import { resolveLoadedSoVersion, runSoVersionedMutation } from './so-versioned-mutation';



export const useMfgSalesOrders = (status?: string) =>
  useQuery({
    queryKey: ['mfg-sales-orders', status ?? 'all'],
    queryFn: () => authedFetch<{ salesOrders: any[] }>(`/mfg-sales-orders${status ? `?status=${status}` : ''}`),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

/** The Sales Order list's filter as query parameters, no paging: the list request
 *  and the list's export (so-list-export.ts) send exactly these. */
export function soListSearchParams(f: { from?: string; to?: string; status?: string; q?: string; sort?: string; filters?: readonly SoListFilter[]; debtorNames?: string[]; currencies?: string[]; brandings?: string[]; cols?: Record<string, string[]> }): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.from) usp.set('from', f.from);
  if (f.to) usp.set('to', f.to);
  if (f.status && f.status !== 'all') usp.set('status', f.status.toUpperCase());
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  appendSoListFilterParams(usp, f.filters ?? []);
  // Server-filterable column funnels (owner 2026-09-16): Customer Name /
  // Currency, JSON arrays (a customer name may contain a comma).
  if (f.debtorNames && f.debtorNames.length) usp.set('debtorNames', JSON.stringify(f.debtorNames));
  if (f.currencies && f.currencies.length) usp.set('currencies', JSON.stringify(f.currencies));
  // Branding funnel (owner 2026-10-17) — backend lib/so-list-branding-funnel.ts.
  if (f.brandings && f.brandings.length) usp.set('brandings', JSON.stringify(f.brandings));
  // Every other server-run column funnel (owner 2026-10-17) — backend
  // lib/so-list-column-funnels.ts. One JSON object keyed by grid column.
  if (f.cols && Object.keys(f.cols).length) usp.set('cols', JSON.stringify(f.cols));
  return usp;
}

export function useMfgSalesOrdersPaged(params: { from?: string; to?: string; page: number; pageSize: number; status?: string; q?: string; sort?: string; enabled?: boolean; filters?: readonly SoListFilter[]; debtorNames?: string[]; currencies?: string[]; brandings?: string[]; cols?: Record<string, string[]> }) {
  const { page, pageSize, status, q, sort, enabled, filters = [], debtorNames, currencies, brandings, cols, from, to } = params;
  const usp = soListSearchParams({ status, q, sort, filters, debtorNames, currencies, brandings, cols, from, to });
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  return useQuery({
    enabled: enabled ?? true,
    queryKey: ['mfg-sales-orders-paged', page, pageSize, status ?? '', q ?? '', sort ?? '', usp.getAll('f').join('|'), JSON.stringify(debtorNames ?? []), JSON.stringify(currencies ?? []), JSON.stringify(brandings ?? []), usp.get('cols') ?? ''],
    queryFn: ({ signal }) => authedFetch<{ salesOrders: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; draft: number; confirmed: number; cancelled: number } & Partial<Record<'in_production' | 'ready_to_ship' | 'shipped' | 'delivered' | 'invoiced' | 'closed' | 'on_hold' | 'other', number>>; aggregates?: { revenueSen: number; outstandingSen: number; paidSen: number } }>(`/mfg-sales-orders?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export function useSoFunnelValues() {
  return useQuery({
    queryKey: ['mfg-sales-orders-funnel-values'],
    queryFn: ({ signal }) => authedFetch<{ values: Record<string, string[]>; truncated: boolean }>('/mfg-sales-orders/funnel-values', { signal }),
    staleTime: 5 * 60_000,
    retry: retryUnlessClientError,
  });
}

const ENRICH_CHUNK = 100;

export function useSoListMrpEnrichmentMap(
  docNos: string[],
  enabled: boolean,
): { byDoc: Map<string, SoListMrpEnrichment>; isFetching: boolean; mrp: ListMrpStatus } {
  const { byId, isFetching, mrp } = useListMrpEnrichmentChunks<SoListMrpEnrichment>({
    ids: docNos,
    enabled,
    queryKeyPrefix: 'mfg-sales-orders-list-mrp-enrichment',
    urlPrefix: '/mfg-sales-orders/list-mrp-enrichment?docNos=',
    chunkSize: ENRICH_CHUNK,
  });
  return { byDoc: byId, isFetching, mrp };
}

export function useEnrichedSoListRows<T extends EnrichableSoRow>(
  rows: T[],
  enabled: boolean,
): { rows: T[]; mrp: ListMrpStatus } {
  const ids = useMemo(
    () => rows.map((r) => r.doc_no).filter((x): x is string => !!x),
    [rows],
  );
  const { byDoc, mrp } = useSoListMrpEnrichmentMap(ids, enabled);
  const healed = useMemo(
    () => rows.map((r) => applySoListMrpEnrichment(r, r.doc_no ? byDoc.get(r.doc_no) : undefined)),
    [rows, byDoc],
  );
  return { rows: healed, mrp };
}

export type SoSummaryRow = {
  doc_no: string;
  status: string;
  local_total_sen: number;
  created_at: string | null;
  so_date: string | null;
};
export const useMfgSalesOrdersSummary = () =>
  useQuery({
    queryKey: ['mfg-sales-orders', 'summary'],
    queryFn: () => authedFetch<{ salesOrders: SoSummaryRow[] }>(`/mfg-sales-orders?summary=1`),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

export type ScmCustomerOrder = {
  doc_no: string;
  status: string;
  so_date: string | null;
  created_at: string | null;
  local_total_sen: number;
  line_count: number;
};
export type ScmCustomer = {
  key: string;
  name: string;
  phone: string | null;
  order_count: number;
  lifetime_value_sen: number;
  last_order_at: string;
  orders: ScmCustomerOrder[];
};
export const useMfgCustomers = () =>
  useQuery({
    queryKey: ['mfg-sales-orders', 'customers'],
    queryFn: () => authedFetch<{ customers: ScmCustomer[] }>(`/mfg-sales-orders/customers`),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

export const useMfgSalesOrderDetail = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-order-detail', docNo],
  queryFn: () => authedFetch<{ salesOrder: any; items: any[] }>(`/mfg-sales-orders/${docNo}`),
  enabled: Boolean(docNo), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

export type NonSellingWarehouseNote = {
  code: string | null;
  name: string | null;
  type: string | null;
  notice: string;
};

export type SoLineCoverage = {
  id: string;
  stock_state: 'stock' | 'po' | 'shortage' | null;
  coverage_po: string | null;
  coverage_eta: string | null;
  ready_source_pos: Array<{ po: string | null; qty: number; kind: 'po' | 'adjustment' }>;
  stock_status_effective: string | null;
  non_selling_warehouse?: NonSellingWarehouseNote | null;
  awaiting_processing_date?: boolean;
};

export const useSoLineCoverage = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-order-coverage', docNo],
  queryFn: async () => {
    try {
      return await authedFetch<{ coverage: SoLineCoverage[] }>(`/mfg-sales-orders/${docNo}/coverage`);
    } catch (e) {
      if ((e as { status?: number } | null)?.status === 404) return { coverage: [] };
      throw e;
    }
  },
  enabled: Boolean(docNo),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export type DebtorSuggestion = {
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
};

export const useDebtorSearch = (q: string) => useQuery({
  queryKey: ['mfg-sales-orders', 'debtors', q],
  queryFn: ({ signal }) => authedFetch<{ debtors: DebtorSuggestion[] }>(
    `/mfg-sales-orders/debtors/search${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    { signal },
  ),
  enabled: q.trim().length >= 2,
  staleTime: 5 * 60_000,
  retry: retryUnlessClientError,
});

export type SoAuditFieldChange = {
  field: string;
  from?: unknown;
  to?: unknown;
  from_label?: string;
  to_label?: string;
};
export type SoAuditEntry = {
  id: string;
  so_doc_no: string;
  action: string;
  actor_id: string | null;
  actor_name_snapshot: string | null;
  field_changes: SoAuditFieldChange[];
  status_snapshot: string | null;
  source: string | null;
  note: string | null;
  created_at: string;
};

export const useSalesOrderAuditLog = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-order-audit-log', docNo],
  queryFn: () => authedFetch<{ entries: SoAuditEntry[] }>(`/mfg-sales-orders/${docNo}/audit-log`).then((r) => r.entries),
  enabled: Boolean(docNo),
  staleTime: 5 * 60_000,
  retry: retryUnlessClientError,
});

export type SoRelatedAuditEntry = Omit<SoAuditEntry, 'so_doc_no'> & {
  entity_type: 'PURCHASE_ORDER' | 'DELIVERY_ORDER' | 'SALES_INVOICE';
  entity_id: string;
  entity_doc_no: string | null;
};

export const useSalesOrderRelatedAuditLog = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-order-related-audit-log', docNo],
  queryFn: () => authedFetch<{ entries: SoRelatedAuditEntry[] }>(`/mfg-sales-orders/${docNo}/related-audit-log`).then((r) => r.entries),
  enabled: Boolean(docNo),
  staleTime: 60_000,
  retry: retryUnlessClientError,
});

export type SoPayment = {
  id: string;
  so_doc_no: string;
  paid_at: string;
  /* `converted` = money moved from another order (docs/bugs/0927/0931) — or,
     with a NEGATIVE amount, a MIRROR: money that left this order (owner
     2026-09-16), following the converted row it became or the refund voucher. */
  method: 'merchant' | 'transfer' | 'cash' | 'installment' | 'converted';
  converted_from_so_doc_no?: string | null;
  converted_to_so_doc_no?: string | null;
  mirror_of_payment_id?: string | null;
  refund_pv_id?: string | null;
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_sen: number;
  account_sheet: string | null;
  slip_key?: string | null;
  collected_by: string | null;
  collected_by_name: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
  version: number;
  updated_at?: string | null;
};

export const useSalesOrderPayments = (docNo: string | null) => useQuery({
  queryKey: ['mfg-sales-orders', docNo, 'payments'],
  queryFn: () => authedFetch<{ payments: SoPayment[] }>(`/mfg-sales-orders/${docNo}/payments`).then((r) => r.payments),
  enabled: Boolean(docNo),
  staleTime: 2 * 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});


export const invalidateSoLists = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
  qc.invalidateQueries({ queryKey: ['mfg-sales-orders-paged'] });
};

export const invalidateSoPaymentMoved = (qc: ReturnType<typeof useQueryClient>, docNo: string) => {
  invalidateSoLists(qc);
  void qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', docNo] });
  void qc.invalidateQueries({ queryKey: ['so-money', docNo] });
  void qc.invalidateQueries({ queryKey: ['sales-invoices'] });
  void qc.invalidateQueries({ queryKey: ['sales-invoices-paged'] });
  void qc.invalidateQueries({ queryKey: ['sales-invoice-detail'] });
};

export const useCreateMfgSalesOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ docNo: string; vpBrand?: VpBrandAsk } & InBandFailure>(`/mfg-sales-orders`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: (res) => {
      invalidateSoLists(qc);
      reportInBandFailure('Order saved, but a payment was not recorded', res);
      /* A live order whose products name no brand: ask which brand it is for,
         for the Venture Portal (owner 2026-09-27). Not awaited -- the save is
         done, and the question is optional. lib/vp-brand-prompt.ts. */
      void askVpBrand(res.docNo, res.vpBrand ?? null);
    },
  });
};

export const useUpdateMfgSalesOrderStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, status, expectedStatus }: { docNo: string; status: string; expectedStatus: string | null }) => {
      const version = await resolveLoadedSoVersion(qc, docNo);
      return authedFetch<{ salesOrder: unknown; version: number; vpBrand?: VpBrandAsk }>(`/mfg-sales-orders/${docNo}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, version, expectedStatus: expectedStatus ?? undefined }),
      });
    },
    /* A draft just confirmed is asked which brand it is for, as a create is
       (owner 2026-09-27); the server only asks on that transition. */
    onSuccess: (res, vars) => {
      void askVpBrand(vars.docNo, res.vpBrand ?? null);
    },
    onMutate: async ({ docNo, status }) => {
      const detailKey = ['mfg-sales-order-detail', docNo];
      await qc.cancelQueries({ queryKey: ['mfg-sales-orders'] });
      await qc.cancelQueries({ queryKey: detailKey });
      const prevDetail = qc.getQueryData(detailKey);
      const prevLists = qc.getQueriesData<{ salesOrders?: Array<Record<string, unknown>> }>({ queryKey: ['mfg-sales-orders'] });
      qc.setQueryData(detailKey, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const o = old as { salesOrder?: Record<string, unknown> };
        if (!o.salesOrder) return old;
        return { ...o, salesOrder: { ...o.salesOrder, status } };
      });
      for (const [key, data] of prevLists) {
        if (!data?.salesOrders) continue;
        qc.setQueryData(key, {
          ...data,
          salesOrders: data.salesOrders.map((r) => (r.doc_no === docNo ? { ...r, status } : r)),
        });
      }
      return { detailKey, prevDetail, prevLists };
    },
    onError: (err, _vars, ctx) => {
      if (ctx) {
        qc.setQueryData(ctx.detailKey, ctx.prevDetail);
        for (const [key, data] of ctx.prevLists) qc.setQueryData(key, data);
      }
      serviceNotify({
        title: 'Status update failed',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      });
    },
    onSettled: (_data, _err, vars) => {
      invalidateSoLists(qc);
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-status-changes', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
      if (vars.status.trim().toUpperCase() === 'CANCELLED') invalidateCancelRequestViews(qc, 'so', vars.docNo);
    },
  });
};

export const useOverrideSoLock = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, status, reason }: { docNo: string; status: string; reason: string }) => {
      const version = await resolveLoadedSoVersion(qc, docNo);
      const res = await authedFetch<{ overrideRecorded?: boolean }>(`/mfg-sales-orders/${docNo}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, version, expectedStatus: status, overrideReason: reason }),
      });
      if (res.overrideRecorded !== true) throw new Error('The server did not record the override reason. The SO stays locked.');
      return res;
    },
    onError: writeFailedAs('Override not saved — the SO stays locked'),
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: ['mfg-sales-order-status-changes', vars.docNo] });
      void qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useUpdateMfgSalesOrderHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, __verify: _v, __suppressInvalidate: _s, ...body }: { docNo: string; __verify?: Record<string, unknown>; __suppressInvalidate?: boolean } & Record<string, unknown>) => {
      void _v;
      void _s;
      return authedFetch<{ ok: boolean; version: number }>(`/mfg-sales-orders/${docNo}`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
    },
    onSuccess: (_, vars) => {
      if (vars.reserveLineWrites === true || vars.__suppressInvalidate === true) return;
      invalidateSoLists(qc);
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
      /* RETURNED, so the caller's own onSuccess waits for the order's re-read
         (docs/bugs/0936-a-save-that-reported-success-left-the-order-s-lock-behind-so.md). Fired and forgotten, a Save reported done with the
         pre-save copy still in the cache; Edit pressed in that window pinned its
         superseded version and the next Save was refused as an older screen. */
      return qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
    },
  });
};

export const useAddMfgSalesOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, idempotencyKey, leaseToken, ...item }: { docNo: string; idempotencyKey?: string; leaseToken: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/mfg-sales-orders/${docNo}/items`, {
        method: 'POST',
        headers: {
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          'X-SO-Edit-Lease': leaseToken,
        },
        body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      if (vars.leaseToken) return;
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      invalidateSoLists(qc);
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useUpdateMfgSalesOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, leaseToken, ...item }: { docNo: string; itemId: string; leaseToken: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/mfg-sales-orders/${docNo}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'X-SO-Edit-Lease': leaseToken },
        body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      if (vars.leaseToken) return;
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      invalidateSoLists(qc);
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useDeleteMfgSalesOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, leaseToken }: { docNo: string; itemId: string; leaseToken: string }) =>
      authedFetch<void>(`/mfg-sales-orders/${docNo}/items/${itemId}`, {
        method: 'DELETE',
        headers: { 'X-SO-Edit-Lease': leaseToken },
      }),
    onSuccess: (_, vars) => {
      if (vars.leaseToken) return;
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      invalidateSoLists(qc);
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

/* Discard a DRAFT SO (owner 2026-07-20) — hard-deletes the draft + its children
   via the backend DELETE /:docNo (DRAFT-only, company-scoped, same `edit`
   permission as an SO edit). The order ceases to exist, so beyond refreshing the
   list caches we DROP the detail query for that docNo rather than invalidating
   it (there is nothing left to refetch, and the caller navigates away). */
export const useDeleteMfgSalesOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo }: { docNo: string }) => {
      const version = await resolveLoadedSoVersion(qc, docNo);
      return authedFetch<{ ok: boolean; docNo: string }>(
        `/mfg-sales-orders/${docNo}?version=${encodeURIComponent(String(version))}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: (_, vars) => {
      invalidateSoLists(qc);
      qc.removeQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
    },
  });
};

export const useOverrideMfgSoLinePrice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, itemId, overridePriceSen, reason }: {
      docNo: string; itemId: string; overridePriceSen: number; reason?: string;
    }) => {
      await runSoVersionedMutation(qc, docNo, 'price-override', ({ leaseToken }) =>
        authedFetch<{ items: Array<{ id: string; unit_price_sen: number }> }>(
          `/mfg-sales-orders/${docNo}/items/${itemId}/override`,
          {
            method: 'POST',
            headers: { 'X-SO-Edit-Lease': leaseToken },
            body: JSON.stringify({ overridePriceSen, reason }),
          },
        ),
      );
      return { ok: true as const, itemId, newPrice: overridePriceSen };
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-price-overrides', vars.docNo] });
      invalidateSoLists(qc);
    },
    onError: writeFailed,
  });
};

export const useMfgSoLinePriceAfterDo = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, unitPriceSen, discountSen, reason }: {
      docNo: string; itemId: string; unitPriceSen: number; discountSen: number; reason?: string;
    }) =>
      runSoVersionedMutation(qc, docNo, 'price-after-do', ({ leaseToken }) =>
        authedFetch<{ ok: boolean; doNumbers?: string[]; doCopyFailed?: string[]; siCopyFailed?: string[] }>(
          `/mfg-sales-orders/${docNo}/items/${itemId}/price-after-do`,
          {
            method: 'POST',
            headers: { 'X-SO-Edit-Lease': leaseToken },
            body: JSON.stringify({ unitPriceSen, discountSen, reason }),
          },
        ),
      ),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      invalidateSoLists(qc);
    },
    onError: writeFailed,
  });
};

export const useUpdateSoItemStockStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, status }: { docNo: string; itemId: string; status: 'PENDING' | 'READY' }) =>
      runSoVersionedMutation(qc, docNo, 'stock-status', ({ leaseToken }) =>
        authedFetch<{ ok: boolean; advancedTo?: string | null; unchanged?: boolean }>(
          `/mfg-sales-orders/${docNo}/items/${itemId}/stock-status`,
          {
            method: 'PATCH',
            headers: { 'X-SO-Edit-Lease': leaseToken },
            body: JSON.stringify({ status }),
          },
        ),
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      invalidateSoLists(qc);
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Stock status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

export type UploadSoItemPhotoResult = {
  photoKey: string;
  photoUrl: string;
  thumbUrl?: string;
  expiresAt?: string;
};

export const useUploadSoItemPhoto = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, itemId, file }: {
      docNo: string; itemId: string; file: File;
    }): Promise<UploadSoItemPhotoResult> => {
      const prepared = await prepareImageForUpload(file);
      const fd = new FormData();
      fd.append('file', prepared.file);
      if (prepared.thumb) fd.append('thumb', prepared.thumb);
      return runSoVersionedMutation(qc, docNo, 'photo-upload', ({ leaseToken }) =>
        authedFetch<UploadSoItemPhotoResult>(
          `/mfg-sales-orders/${docNo}/items/${itemId}/photos`,
          { method: 'POST', headers: { 'X-SO-Edit-Lease': leaseToken }, body: fd },
        ),
      );
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
  });
};

export const useDeleteSoItemPhoto = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, photoKey }: {
      docNo: string; itemId: string; photoKey: string;
    }) =>
      runSoVersionedMutation(qc, docNo, 'photo-delete', ({ leaseToken }) =>
        authedFetch<{ ok: boolean }>(
          `/mfg-sales-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}`,
          { method: 'DELETE', headers: { 'X-SO-Edit-Lease': leaseToken } },
        ),
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-sales-orders', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
    },
    onError: writeFailed,
  });
};

export const useAddSalesOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, idempotencyKey, ...body }: { docNo: string; idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ payment: SoPayment }>(`/mfg-sales-orders/${docNo}/payments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: (_data, vars) => {
      invalidateSoPaymentMoved(qc, vars.docNo);
    },
  });
};

/* Owner 2026-07-13 — SAME-DAY payment edit. PATCH /:docNo/payments/:id with the
   editable fields (amount / method + sub-fields / date / account sheet /
   approval code / collected-by). The backend 409s when the payment wasn't
   created on the current MYT calendar day. */
export const useEditSalesOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, id, version, ...body }: { docNo: string; id: string; version: number } & Record<string, unknown>) =>
      authedFetch<{ payment: SoPayment }>(`/mfg-sales-orders/${docNo}/payments/${id}`, {
        method: 'PATCH', body: JSON.stringify({ ...body, version }),
      }),
    onSuccess: (_data, vars) => {
      invalidateSoPaymentMoved(qc, vars.docNo);
    },
  });
};

/* Owner 2026-08-07 — attach the proof to an ALREADY-RECORDED payment. Kept
   separate from useEditSalesOrderPayment because the backend keeps them
   separate: PATCH is same-day-gated (it moves money), this route is not (it
   moves none). That distinction is the whole point — a balance collected
   yesterday can still get its slip today. */
export const useAttachSalesOrderPaymentSlip = () => {
  const qc = useQueryClient();
  return useMutation({
    /* `reason` — owed by a role holding the correction right (docs/bugs/0888);
       the server refuses such a caller's attach without one. */
    mutationFn: ({ docNo, id, uploadSessionId, reason }: { docNo: string; id: string; uploadSessionId: string; reason?: string }) =>
      authedFetch<{ payment: SoPayment }>(`/mfg-sales-orders/${docNo}/payments/${id}/slip`, {
        method: 'POST', body: JSON.stringify({ uploadSessionId, ...(reason ? { reason } : {}) }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['payment-slip', vars.id] });
      invalidateSoPaymentMoved(qc, vars.docNo);
    },
  });
};

export const useDeleteSalesOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, id, version, reason }: { docNo: string; id: string; version: number; reason?: string }) =>
      authedFetch<{ ok: boolean }>(
        `/mfg-sales-orders/${docNo}/payments/${id}?version=${encodeURIComponent(String(version))}`
          + (reason ? `&reason=${encodeURIComponent(reason)}` : ''),
        { method: 'DELETE' },
      ),
    onSuccess: (_data, vars) => {
      invalidateSoPaymentMoved(qc, vars.docNo);
    },
  });
};


export type SignedPhotoPayload = {
  mode?: 'signed';
  signedUrl: string;
  thumbUrl?: string;
  expiresAt: string;
};

export type ProxyPhotoPayload = {
  mode: 'proxy';
  proxyPath: string;
  thumbProxyPath: string;
  expiresAt: null;
  reason: string;
};

export type PhotoUrlPayload = SignedPhotoPayload | ProxyPhotoPayload;

/** True when the payload cannot supply an `<img src>` and the caller must
 *  stream the bytes through the authed proxy instead. Covers both the explicit
 *  `mode: 'proxy'` arm and a signed arm whose URL is not directly loadable. */
export const isProxyPhotoPayload = (p: PhotoUrlPayload): p is ProxyPhotoPayload =>
  p.mode === 'proxy';

export async function fetchSoItemPhotoSignedUrl(
  docNo: string,
  itemId: string,
  photoKey: string,
): Promise<PhotoUrlPayload> {
  return authedFetch<PhotoUrlPayload>(
    `/mfg-sales-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}/signed`,
  );
}

/** A signed URL is only usable as <img src> if it is an ABSOLUTE http(s) URL —
 *  the signature travels in the query string, so no header is needed.
 *
 *  Belt to `isProxyPhotoPayload`'s braces, and a cheap invariant check rather
 *  than a live failure path: the signed arm of `/photos/:photoKey/signed` can
 *  only emit an absolute R2 URL, and the one relative `photoUrl` the API ever
 *  produces (the POST upload route's own signing fallback) is filtered by
 *  `startsWith('http')` before it can reach the URL cache. The guard is kept
 *  because it costs one regex and it is what makes "anything in the cache is
 *  <img>-loadable" true by construction rather than by trusting the callers to
 *  agree — but do not read it as documentation of a 404 anyone has seen. */
export const isDirectlyLoadableUrl = (url: string | undefined | null): boolean =>
  !!url && /^https?:\/\//i.test(url);

/** Carries the HTTP status so the caller can tell a genuinely-missing photo
 *  (404) or a refused one (401/403) from a transient server fault. */
export class PhotoProxyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PhotoProxyError';
    this.status = status;
  }
}

const PHOTO_PROXY_TIMEOUT_MS = 30_000;

export async function fetchSoItemPhotoBlob(
  docNo: string,
  itemId: string,
  photoKey: string,
): Promise<Blob> {
  return fetchItemPhotoBlobAt(
    `/mfg-sales-orders/${encodeURIComponent(docNo)}/items/${encodeURIComponent(itemId)}`,
    photoKey,
  );
}

async function fetchItemPhotoBlobAt(itemBase: string, photoKey: string): Promise<Blob> {
  const token = readAuthToken();
  if (!token) throw new PhotoProxyError(401, 'Your session has expired — please sign in again.');

  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(PHOTO_PROXY_TIMEOUT_MS); } catch { signal = undefined; }

  let res: Response;
  try {
    res = await correlatedFetch(
      `${API_URL}${itemBase}/photos/${encodeURIComponent(photoKey)}`,
      { headers: { authorization: `Bearer ${token}`, ...companyHeader() }, signal },
    );
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw correlateError(
        new PhotoProxyError(408, 'The photo took too long to load — please try again.'),
        requestIdFromError(e),
      );
    }
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(
      new PhotoProxyError(res.status, humanApiError(res.status, text)),
      requestIdFromResponse(res),
    );
  }

  return consumeCorrelated(res, () => res.blob());
}


export async function fetchPoItemPhotoSignedUrl(
  poId: string,
  itemId: string,
  photoKey: string,
): Promise<PhotoUrlPayload> {
  return authedFetch<PhotoUrlPayload>(
    `/mfg-purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}`
      + `/photos/${encodeURIComponent(photoKey)}/signed`,
  );
}

export async function fetchPoItemPhotoBlob(
  poId: string,
  itemId: string,
  photoKey: string,
): Promise<Blob> {
  return fetchItemPhotoBlobAt(
    `/mfg-purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}`,
    photoKey,
  );
}

export async function fetchDoItemPhotoBlob(
  doId: string,
  itemId: string,
  photoKey: string,
): Promise<Blob> {
  return fetchItemPhotoBlobAt(
    `/delivery-orders-mfg/${encodeURIComponent(doId)}/items/${encodeURIComponent(itemId)}`,
    photoKey,
  );
}

/* PO WRITE twins (owner 2026-08-28: 如果我要 add on 照片在 PO 而已 — a purchaser
   attaches photos DIRECTLY on a PO line). Two ownership classes share the
   photo_urls column, told apart by key prefix: carried `so-items/...` keys are
   SO-owned (the server refuses deleting them here — manage on the SO);
   `po-items/...` keys are PO-authored, live only on the PO, and print only on
   the PO PDF. */
export const PO_OWNED_PHOTO_PREFIX = 'po-items/';
export const isPoOwnedPhotoKey = (key: string): boolean => key.startsWith(PO_OWNED_PHOTO_PREFIX);

export type UploadPoItemPhotoResult = { photoKey: string; photoUrls: string[] };

export async function uploadPoItemPhoto(
  poId: string,
  itemId: string,
  file: File,
): Promise<UploadPoItemPhotoResult> {
  const prepared = await prepareImageForUpload(file);
  const fd = new FormData();
  fd.append('file', prepared.file);
  if (prepared.thumb) fd.append('thumb', prepared.thumb);
  return authedFetch<UploadPoItemPhotoResult>(
    `/mfg-purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}/photos`,
    { method: 'POST', body: fd },
  );
}

export async function deletePoItemPhoto(
  poId: string,
  itemId: string,
  photoKey: string,
): Promise<{ photoUrls: string[] }> {
  return authedFetch<{ photoUrls: string[] }>(
    `/mfg-purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}`
      + `/photos/${encodeURIComponent(photoKey)}`,
    { method: 'DELETE' },
  );
}

export async function fetchSofaCompartmentPhotoBlob(code: string, photoKey: string): Promise<Blob> {
  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(PHOTO_PROXY_TIMEOUT_MS); } catch { signal = undefined; }
  const token = readAuthToken();
  const res = await correlatedFetch(
    `${API_URL}/maintenance-config/sofa-compartments/${encodeURIComponent(code)}`
      + `/photo/${encodeURIComponent(photoKey)}`,
    { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...companyHeader() }, signal },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new PhotoProxyError(res.status, humanApiError(res.status, text));
  }
  return consumeCorrelated(res, () => res.blob());
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

/* Fetch every sofa compartment's ART into a `{ code: dataURL }` map for the PO
   PDF's plan view.
 *
 * REWRITTEN 2026-08-28 to follow POS, at the owner's instruction. The previous
 * version fetched every imageKey through the uploaded-photo API, which is one of
 * the THREE shapes a key can take and not the common one: the seeded default is
 * `sofa-modules/<code>.svg`, bundled art served from /public. Every default
 * compartment 404'd, the catch below swallowed it, and the sheet drew its own
 * schematic — which is what the owner was looking at when he said the plan still
 * did not look like his sofas.
 *
 * The art also arrives PADDED inside a 1024² frame, so it is cropped to its
 * silhouette before it is handed to jsPDF — POS's technique, ported in
 * sofa-compartment-art.ts, without which the modules tile small and gappy.
 *
 * Per-compartment best-effort: anything that cannot be resolved, fetched or
 * measured is simply absent from the map and the engine draws that one cell's
 * schematic. */
/* THE PRINT PATH LOADS ITS OWN ART — one lookup, not five call sites, and it
 * does NOT depend on the stored config carrying an imageKey.
 *
 * WHY IT IS KEYED BY THE CODES THE SHEET NEEDS (owner, 2026-08-28, still looking
 * at a schematic after two fixes: 「还是一样的问题啊」). The earlier version walked
 * `sofaCompartmentMeta` and used only entries that HAD an `imageKey`. The stored
 * config has none: `seedCompartmentMeta` in Products.tsx supplies the default
 * `sofa-modules/<id>.svg` CLIENT-SIDE, so the Maintenance list shows a thumbnail
 * for every compartment while the database holds nothing. Two places, one
 * default, and only one of them had it — which is why the owner could see the
 * pictures on screen and never on paper, and why neither of us was wrong.
 *
 * So the default is derived from the CODE rather than looked up: a compartment's
 * code IS the name of its artwork. The stored config is consulted only for an
 * OVERRIDE — an uploaded photo, or an external URL somebody typed in. A missing
 * config is now a non-event rather than the difference between a picture and a
 * drawing.
 *
 * Fail-soft throughout: anything that cannot be resolved, fetched or measured is
 * simply absent, and that cell draws its schematic. A print must never fail for
 * want of a picture. */
const ART_DEADLINE_MS = 6000;

async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function loadSofaCompartmentArtForPrint(
  codes: readonly string[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  if (wanted.length === 0) return {};

  const meta = await withDeadline(
    (async () => {
      const resolved = await authedFetch<{ data?: { sofaCompartmentMeta?: Record<string, { imageKey?: string }> } }>(
        '/maintenance-config/resolved?scope=master',
      );
      return resolved.data?.sofaCompartmentMeta ?? {};
    })(),
    ART_DEADLINE_MS,
    {} as Record<string, { imageKey?: string }>,
  );

  const out: Record<string, string> = {};
  await withDeadline(Promise.all(wanted.map(async (code) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a Record index is typed as always present and is not; `meta` comes off the wire and carries an entry only for a compartment somebody overrode, which is the common case for NONE of them.
      const key = meta[code]?.imageKey || `sofa-modules/${code}`;
      const url = resolveCompartmentArtUrl(code, key, API_URL);
      if (!url) return;
      if (url.startsWith(`${API_URL}/`)) {
        const blob = await fetchSofaCompartmentPhotoBlob(code, key);
        const dataUrl = await blobToDataUrl(blob);
        if (dataUrl) out[code] = dataUrl;
        return;
      }
      const art = await loadCompartmentArt(url);
      if (art) out[code] = art.dataUrl;
    } catch {
    }
  })), ART_DEADLINE_MS, [] as unknown[]);
  return out;
}

export async function loadSofaCompartmentPhotos(
  meta: Record<string, { imageKey?: string }> | undefined | null,
): Promise<Record<string, string>> {
  if (!meta) return {};
  const entries = Object.entries(meta)
    .filter((e): e is [string, { imageKey: string }] => typeof e[1].imageKey === 'string' && e[1].imageKey.length > 0);
  const out: Record<string, string> = {};
  await Promise.all(entries.map(async ([code, m]) => {
    try {
      const url = resolveCompartmentArtUrl(code, m.imageKey, API_URL);
      if (!url) return;
      if (url.startsWith(`${API_URL}/`)) {
        const blob = await fetchSofaCompartmentPhotoBlob(code, m.imageKey);
        const dataUrl = await blobToDataUrl(blob);
        if (dataUrl) out[code] = dataUrl;
        return;
      }
      const art = await loadCompartmentArt(url);
      if (art) out[code] = art.dataUrl;
    } catch {
    }
  }));
  return out;
}

/** One salesperson who holds Sales Orders in the ACTIVE company. */
export type SoHandoverHolder = {
  staffId: string;
  name: string | null;
  staffCode: string | null;
  active: boolean | null;
  orders: number;
};

/**
 * WHO holds this company's Sales Orders, most first.
 *
 * The Salesperson Handover panel's "Orders currently with" picker. It reads
 * this and NOT the staff roster: `/staff` is scoped by a person's company LINK
 * (`scm/lib/staffCompanyScope.ts`), which buckets an AutoCount-imported rep with
 * no ERP login to the other company — so the roster hid 22 holders / 339
 * non-cancelled orders in HOUZS, every one of them the kind of resigned rep the
 * panel exists to hand over (production run 34336422828, 2026-09-09). Switching
 * company does not rescue it: their ORDERS are in HOUZS while their staff rows
 * answer to 2990.
 *
 * A list derived from the orders cannot omit somebody who holds one.
 */
export const useSoHandoverHolders = () => useQuery({
  queryKey: ['so-handover-holders'],
  queryFn: () => authedFetch<{ holders?: SoHandoverHolder[] }>('/so-handover/holders')
    .then((r) => r.holders ?? []),
  staleTime: 60_000,
});
