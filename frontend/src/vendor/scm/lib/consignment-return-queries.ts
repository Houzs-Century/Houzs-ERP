
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serviceNotify } from './dialog-service';
import { authedFetch } from './authed-fetch';
import { fetchAllPages } from '../../../lib/csv';
import { writeFailed } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export const useConsignmentNoteDetailForReturn = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-note-detail', id],
  queryFn: () => authedFetch<{ deliveryOrder: any; items: any[] }>(`/consignment-notes/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

export const useConsignmentReturns = (status?: string) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-return', 'list', status ?? 'all'],
  queryFn: () => authedFetch<{ deliveryReturns: any[] }>(
    `/consignment-returns${status ? `?status=${status}` : ''}`,
  ),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export type ConsignmentReturnAggregates = { revenueSen: number; costSen?: number; marginSen?: number };
type ConsignmentReturnsListFilter = { status?: string; q?: string; sort?: string };
function consignmentReturnsListParams(page: number, pageSize: number, f: ConsignmentReturnsListFilter): URLSearchParams {
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (f.status) usp.set('status', f.status);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  return usp;
}

export function fetchConsignmentReturnsExportRows<T>(f: ConsignmentReturnsListFilter): Promise<T[]> {
  return fetchAllPages<T>(async (page, perPage) => {
    const usp = consignmentReturnsListParams(page - 1, perPage, f);
    const body = await authedFetch<{ deliveryReturns?: T[]; total: number }>(`/consignment-returns?${usp.toString()}`);
    return { data: body.deliveryReturns ?? [], total: body.total };
  });
}

export const useConsignmentReturnsPaged = (params: {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
  sort?: string;
}) => {
  const { page, pageSize, status, q, sort } = params;
  const usp = consignmentReturnsListParams(page, pageSize, { status, q, sort });
  return useQuery<{ deliveryReturns: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentReturnAggregates }>({
    queryKey: ['consignment-return', 'list-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: ({ signal }) => authedFetch<{ deliveryReturns: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentReturnAggregates }>(`/consignment-returns?${usp.toString()}`, { signal }),
    placeholderData: (prev: unknown) => prev as { deliveryReturns: unknown[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentReturnAggregates } | undefined,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
};

export type ReturnableNoteLine = {
  noteItemId: string;
  consignmentDoId: string;
  noteNumber: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  delivered: number;
  returned: number;
  remaining: number;
  unitPriceSen: number;
  discountSen: number;
  unitCostSen: number;
  variants: unknown;
};

export const useReturnableNoteLines = () => useQuery({
  queryKey: ['consignment-return', 'returnable-note-lines'],
  queryFn: () => authedFetch<{ lines: ReturnableNoteLine[] }>(
    `/consignment-returns/returnable-note-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export const useConsignmentReturnDetail = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-return-detail', id],
  queryFn: () => authedFetch<{ deliveryReturn: any; items: any[] }>(`/consignment-returns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

export const useCreateConsignmentReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; returnNumber: string }>(`/consignment-returns`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consignment-return'] }),
  });
};

export const useUpdateConsignmentReturnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-returns/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
    },
  });
};

export const useUpdateConsignmentReturnStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedFetch<{ deliveryReturn: unknown }>(`/consignment-returns/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

export const useUpdateConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-returns/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
    },
  });
};

export const useDeleteConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/consignment-returns/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
    },
    onError: writeFailed,
  });
};
