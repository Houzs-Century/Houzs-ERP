
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { fetchAllPages } from '../../../lib/csv';
import { writeFailed, writeFailedAs } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export const useConsignmentNotes = (status?: string) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-note', 'list', status ?? 'all'],
  queryFn: () => authedFetch<{ deliveryOrders: any[] }>(
    `/consignment-notes${status ? `?status=${status}` : ''}`,
  ),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export type ConsignmentNoteAggregates = { revenueSen: number; costSen?: number; marginSen?: number };
type ConsignmentNotesListFilter = { status?: string; q?: string; sort?: string };
function consignmentNotesListParams(page: number, pageSize: number, f: ConsignmentNotesListFilter): URLSearchParams {
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (f.status) usp.set('status', f.status);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  return usp;
}

export function fetchConsignmentNotesExportRows<T>(f: ConsignmentNotesListFilter): Promise<T[]> {
  return fetchAllPages<T>(async (page, perPage) => {
    const usp = consignmentNotesListParams(page - 1, perPage, f);
    const body = await authedFetch<{ deliveryOrders?: T[]; total: number }>(`/consignment-notes?${usp.toString()}`);
    return { data: body.deliveryOrders ?? [], total: body.total };
  });
}

export const useConsignmentNotesPaged = (params: {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
  sort?: string;
}) => {
  const { page, pageSize, status, q, sort } = params;
  const usp = consignmentNotesListParams(page, pageSize, { status, q, sort });
  return useQuery<{ deliveryOrders: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentNoteAggregates }>({
    queryKey: ['consignment-note', 'list-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: ({ signal }) => authedFetch<{ deliveryOrders: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentNoteAggregates }>(`/consignment-notes?${usp.toString()}`, { signal }),
    placeholderData: (prev: unknown) => prev as { deliveryOrders: unknown[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentNoteAggregates } | undefined,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
};

export const useConsignmentNoteDetail = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-note-detail', id],
  queryFn: () => authedFetch<{ deliveryOrder: any; items: any[] }>(`/consignment-notes/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

export type DeliverableOrderLine = {
  orderItemId: string;
  orderDocNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  ordered: number;
  delivered: number;
  outstanding: number;
  unitPriceSen: number;
  discountSen: number;
  unitCostSen: number;
  variants: unknown;
};

export const useDeliverableOrderLines = () => useQuery({
  queryKey: ['consignment-note', 'deliverable-order-lines'],
  queryFn: () => authedFetch<{ lines: DeliverableOrderLine[] }>(
    `/consignment-notes/deliverable-order-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export const useCreateConsignmentNote = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; doNumber: string }>(
        `/consignment-notes`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consignment-note'] }),
  });
};

export const useUpdateConsignmentNoteStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedFetch(`/consignment-notes/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

export const useUpdateConsignmentNoteHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-notes/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
    },
  });
};

export const useAddConsignmentNoteItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/consignment-notes/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
    },
  });
};

export const useUpdateConsignmentNoteItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-notes/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
    },
  });
};

export const useDeleteConsignmentNoteItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/consignment-notes/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
    },
    onError: writeFailed,
  });
};

export type ConsignmentNotePayment = {
  id: string;
  delivery_order_id: string;
  paid_at: string;
  method: 'merchant' | 'transfer' | 'cash';
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_sen: number;
  account_sheet: string | null;
  collected_by: string | null;
  collected_by_name: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
};

export const useConsignmentNotePayments = (id: string | null) => useQuery({
  queryKey: ['consignment-note', id, 'payments'],
  queryFn: () => authedFetch<{ payments: ConsignmentNotePayment[] }>(`/consignment-notes/${id}/payments`).then((r) => r.payments),
  enabled: Boolean(id),
  staleTime: 2 * 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useAddConsignmentNotePayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey, ...body }: { id: string; idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ payment: ConsignmentNotePayment }>(`/consignment-notes/${id}/payments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
    },
  });
};

export const useDeleteConsignmentNotePayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paymentId }: { id: string; paymentId: string }) =>
      authedFetch<{ ok: boolean }>(`/consignment-notes/${id}/payments/${paymentId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
    },
    onError: writeFailedAs('Payment not deleted'),
  });
};
