
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serviceNotify } from './dialog-service';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const usePurchaseConsignmentReturns = (status?: string) => useQuery({
  queryKey: ['pc-return', 'list', status ?? 'all'],
  queryFn: () => authedFetch<{ purchaseReturns: any[] }>(`/purchase-consignment-returns${status ? `?status=${status}` : ''}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const usePurchaseConsignmentReturnDetail = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['pc-return-detail', id],
  queryFn: () => authedFetch<{ purchaseReturn: any; items: any[] }>(`/purchase-consignment-returns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

export type ReturnablePcReceiveLine = {
  receiveItemId: string;
  pcReceiveId: string;
  receiveNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  materialKind: string;
  itemCode: string;
  materialName: string;
  itemGroup: string | null;
  description: string | null;
  uom: string | null;
  accepted: number;
  returned: number;
  remaining: number;
  unitPriceSen: number;
  variants: unknown;
};

export const useReturnablePcReceiveLines = () => useQuery({
  queryKey: ['pc-return', 'returnable-receive-lines'],
  queryFn: () => authedFetch<{ lines: ReturnablePcReceiveLine[] }>(
    `/purchase-consignment-returns/returnable-receive-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export const useCreatePurchaseConsignmentReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; returnNumber: string }>(`/purchase-consignment-returns`,
        idempotentInit(idempotencyKey, {
          method: 'POST', body: JSON.stringify(body),
        })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pc-return'] }),
  });
};

export const usePostPurchaseConsignmentReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-consignment-returns/${id}/post`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['pc-return'] });
      qc.invalidateQueries({ queryKey: ['pc-return-detail', id] });
    },
  });
};

export const useCancelPurchaseConsignmentReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-consignment-returns/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['pc-return'] });
      qc.invalidateQueries({ queryKey: ['pc-return-detail', id] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel return failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

export const useUpdatePurchaseConsignmentReturnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; returnDate?: string; reason?: string;
      creditNoteRef?: string; notes?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => authedFetch<{ purchaseReturn: any }>(`/purchase-consignment-returns/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['pc-return'] });
    },
  });
};

export const useUpdatePurchaseConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...body }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true }>(`/purchase-consignment-returns/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['pc-return'] });
    },
  });
};

export const useDeletePurchaseConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/purchase-consignment-returns/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['pc-return'] });
    },
    onError: writeFailed,
  });
};
