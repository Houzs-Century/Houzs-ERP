
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { companyHeaderFor } from '../../../lib/activeCompany';
import { idempotentInit, newIdempotencyKey } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { reportInBandFailure, type InBandFailure } from './mutation-error';
import { invalidateSoLists } from './sales-order-queries';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export { useMfgSalesOrderDetail, useSalesOrderPayments } from './sales-order-queries';

export type DeliverableSoLine = {
  soItemId: string;
  docNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  unitPriceSen: number;
  unitCostSen: number;
  discountSen: number;
  variants: unknown;
  delivered: number;
  returned: number;
  remaining: number;
  soRef?: string | null;
  soCustomerSoNo?: string | null;
  notReady: { status: 'PARTIAL' | 'PENDING'; reason: string } | null;
};

export const useDeliverableSoLines = () => useQuery({
  queryKey: ['mfg-delivery-orders', 'deliverable-so-lines'],
  queryFn: () => authedFetch<{ lines: DeliverableSoLine[] }>(
    `/delivery-orders-mfg/deliverable-so-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export type SoConvertHeader = {
  doc_no: string;
  debtor_code: string | null;
  debtor_name: string | null;
  agent: string | null;
  salesperson_id: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  customer_state: string | null;
  postcode: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  building_type: string | null;
  venue: string | null;
  venue_id: string | null;
  ref: string | null;
  po_doc_no: string | null;
  customer_so_no: string | null;
  sales_location: string | null;
  customer_delivery_date: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
};

export const useSoConvertHeader = (docNo: string | null) => useQuery({
  queryKey: ['mfg-delivery-orders', 'so-convert-header', docNo],
  enabled: !!docNo,
  queryFn: () => authedFetch<{ header: SoConvertHeader }>(
    `/delivery-orders-mfg/so-convert-header/${encodeURIComponent(docNo!)}`,
  ).then((r) => r.header),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useDeliverableSoLinesForDoc = (docNo: string | null) => useQuery({
  queryKey: ['mfg-delivery-orders', 'deliverable-so-lines', docNo],
  enabled: !!docNo,
  queryFn: () => authedFetch<{ lines: DeliverableSoLine[] }>(
    `/delivery-orders-mfg/deliverable-so-lines?docNos=${encodeURIComponent(docNo!)}`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export type SoConversionSource = {
  soDocNo: string | null;
  companyId: number | null;
  debtorCode: string | null;
  customerName: string | null;
  customerSoRef: string | null;
  phone: string | null;
  email: string | null;
  customerType: string | null;
  salesperson: string | null;
  salespersonId: string | null;
  agent: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  customerState: string | null;
  postcode: string | null;
  customerCountry: string | null;
  salesLocation: string | null;
  buildingType: string | null;
  branding: string | null;
  venue: string | null;
  venueId: string | null;
  customerDeliveryDate: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelationship: string | null;
  currency: string;
};

export const useSoConversionSource = (docNo: string | null) => useQuery({
  queryKey: ['mfg-delivery-orders', 'so-source', docNo],
  enabled: !!docNo,
  queryFn: () => authedFetch<{ source: SoConversionSource; missing: string[] }>(
    `/delivery-orders-mfg/so-source/${encodeURIComponent(docNo!)}`,
  ),
  staleTime: 30_000,
  retry: 1,
});


const releaseSoSideQueries = (qc: ReturnType<typeof useQueryClient>) => {
  invalidateSoLists(qc);
  qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail'] });
  qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', 'deliverable-so-lines'], refetchType: 'all' });
  void qc.invalidateQueries({ queryKey: ['inventory'] });
};

export const useMfgDeliveryOrders = (status?: string) => useQuery({
  queryKey: ['mfg-delivery-orders', status ?? 'all'],
  queryFn: () => authedFetch<{ deliveryOrders: any[] }>(`/delivery-orders-mfg${status ? `?status=${status}` : ''}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/** The Delivery Order list's filter as query parameters, no paging: the list
 *  request and the list's export (do-list-export.ts) send exactly these. */
export type DoDateBy = 'delivery' | 'do';

export function doListSearchParams(f: { status?: string; q?: string; sort?: string; debtorNames?: string[]; currencies?: string[]; from?: string; to?: string; dateBy?: DoDateBy }): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  // Server-filterable column funnels (owner 2026-09-16): Customer Name /
  // Currency, JSON arrays (a customer name may contain a comma).
  if (f.debtorNames && f.debtorNames.length) usp.set('debtorNames', JSON.stringify(f.debtorNames));
  if (f.currencies && f.currencies.length) usp.set('currencies', JSON.stringify(f.currencies));
  // Date window (HC-0151): inclusive ISO days on the chosen date column.
  if (f.from) usp.set('from', f.from);
  if (f.to) usp.set('to', f.to);
  if ((f.from || f.to) && f.dateBy) usp.set('dateBy', f.dateBy);
  return usp;
}

export function useMfgDeliveryOrdersPaged(params: { enabled: boolean; page: number; pageSize: number; status?: string; q?: string; sort?: string; debtorNames?: string[]; currencies?: string[]; from?: string; to?: string; dateBy?: DoDateBy; companyCode?: string | null }) {
  const { enabled, page, pageSize, status, q, sort, debtorNames, currencies, from, to, dateBy, companyCode } = params;
  const usp = doListSearchParams({ status, q, sort, debtorNames, currencies, from, to, dateBy });
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  return useQuery({
    enabled,
    queryKey: ['mfg-delivery-orders-paged', page, pageSize, status ?? '', q ?? '', sort ?? '', JSON.stringify(debtorNames ?? []), JSON.stringify(currencies ?? []), from ?? '', to ?? '', dateBy ?? '', companyCode ?? ''],
    queryFn: ({ signal }) => authedFetch<{ deliveryOrders: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; open: number; in_transit: number; delivered: number; cancelled: number } }>(`/delivery-orders-mfg?${usp.toString()}`, { signal, headers: companyHeaderFor(companyCode) }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export const useMfgDeliveryOrderDetail = (id: string | null, companyCode?: string | null) => useQuery({
  queryKey: ['mfg-delivery-order-detail', id, companyCode ?? ''],
  queryFn: () => authedFetch<{ deliveryOrder: any; items: any[] }>(`/delivery-orders-mfg/${id}`, { headers: companyHeaderFor(companyCode) }),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

export const useCreateMfgDeliveryOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; doNumber: string }>(
        `/delivery-orders-mfg`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

/* Convert to DO Draft (owner 2026-11-18): the goods are not in yet, so the DO
   is opened as a DRAFT for every line the order still has to deliver (the SO's
   live remaining, the same numbers the Transfer picker shows), the lorry
   delivers on it, and the office presses Confirm once the GR is in. A draft
   moves no stock and is not asked about stock or readiness; Confirm asks. */
export function soDraftPicks(lines: Array<Pick<DeliverableSoLine, 'soItemId' | 'remaining'>>): Array<{ soItemId: string; qty: number }> {
  return lines.filter((l) => Number(l.remaining) > 0).map((l) => ({ soItemId: l.soItemId, qty: Number(l.remaining) }));
}

export const useConvertSoToDoDraft = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (docNo: string) => {
      const { lines } = await authedFetch<{ lines?: DeliverableSoLine[] }>(
        `/delivery-orders-mfg/deliverable-so-lines?docNos=${encodeURIComponent(docNo)}`,
      );
      const picks = soDraftPicks(lines ?? []);
      if (picks.length === 0) throw new Error(`Nothing is left to deliver on ${docNo}.`);
      return authedFetch<{ id: string; doNumber: string }>('/delivery-orders-mfg/from-sos',
        idempotentInit(newIdempotencyKey(), { method: 'POST', body: JSON.stringify({ asDraft: true, picks }) }));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

export type DoDeliveryEvidence = {
  signatureData?: string;
  podKey?: string;
  podKeys?: string[];
  podLat?: number;
  podLng?: number;
  podAccuracyM?: number;
  podLocatedAt?: string;
};

export const useUpdateMfgDeliveryOrderStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, evidence, companyCode }: { id: string; status: string; evidence?: DoDeliveryEvidence; companyCode?: string | null }) =>
      authedFetch<{ deliveryOrder?: { id: string; status: string } } & InBandFailure>(`/delivery-orders-mfg/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status, ...(evidence ?? {}) }), headers: companyHeaderFor(companyCode),
      }),
    onSuccess: (data, vars) => {
      reportInBandFailure(doStatusInBandTitle(vars.status), data);
      refreshAfterDoStatus(qc, vars.id);
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/** The title over a status change whose stock write was refused. */
export function doStatusInBandTitle(status: string): string {
  if (status === 'CANCELLED') return 'DO cancelled, but stock was NOT returned';
  const word = status === 'LOADED' ? 'confirmed' : status === 'DELIVERED' ? 'delivered' : status === 'IN_TRANSIT' ? 'on the way' : 'shipped';
  return `DO ${word}, but stock was NOT deducted`;
}

function refreshAfterDoStatus(qc: ReturnType<typeof useQueryClient>, id: string) {
  void qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
  void qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', id] });
  void qc.invalidateQueries({ queryKey: ['inventory'] });
  releaseSoSideQueries(qc);
}

/* CANCEL a delivery order — the same status route, with the REASON the server
   now refuses a cancel without (400 `reason_required`, owner 2026-09-14:
   「DO cancel need pop out window for reason」; the guard is
   backend/src/scm/routes/document-cancel-routes.ts). Its own hook so `reason`
   is REQUIRED by the type rather than an optional field on the status hook a
   caller could forget. No onError: the one caller
   (pages/scm-v2/use-do-cancel-action.ts) reports the refusal itself, and a
   second notice here would say it twice. */
export const useCancelMfgDeliveryOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      authedFetch<{ deliveryOrder: { id: string; status: string }; movementErrors?: string[] }>(`/delivery-orders-mfg/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED', reason }),
      }),
    onSuccess: (_, vars) => refreshAfterDoStatus(qc, vars.id),
  });
};

export const useRevertMfgDeliveryOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, toStatus, reason }: { id: string; toStatus: 'DISPATCHED' | 'LOADED' | 'DRAFT'; reason: string }) =>
      authedFetch(`/delivery-orders-mfg/${id}/revert`, {
        method: 'POST', body: JSON.stringify({ toStatus, reason }),
      }),
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      void qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      releaseSoSideQueries(qc);
    },
    onError: (err) => {
      void serviceNotify({ title: 'Revert failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

export const useUpdateMfgDeliveryOrderHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/delivery-orders-mfg/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
    },
  });
};

export const useAddMfgDeliveryOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/delivery-orders-mfg/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

export const useUpdateMfgDeliveryOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/delivery-orders-mfg/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

export const useDeleteMfgDeliveryOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/delivery-orders-mfg/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};
