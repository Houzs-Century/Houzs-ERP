
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed, writeFailedAs } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

type WithMovementErrors = { movementErrors?: string[] };

const reportMovementErrors = (title: string, res: WithMovementErrors | undefined | void): void => {
  const errs = res?.movementErrors;
  if (!errs?.length) return;
  writeFailedAs(title)(new Error(
    `${errs.join('\n')}\n\n` +
    'The document is saved. Stock was NOT adjusted for this change — tell IT so the ledger can be repaired.',
  ));
};

export const usePurchaseReturns = (status?: string) =>
  useQuery({
    queryKey: ['purchase-returns', status ?? 'all'],
    queryFn: () => authedFetch<{ purchaseReturns: any[] }>(
      `/purchase-returns${status ? `?status=${status}` : ''}`,
    ),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });

export const usePurchaseReturnDetail = (id: string | null) => useQuery({
  queryKey: ['purchase-return-detail', id],
  queryFn: () => authedFetch<{ purchaseReturn: any; items: any[] }>(`/purchase-returns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

export type ReturnableGrnLine = {
  grnItemId: string; grnNumber: string | null; materialKind: string | null;
  itemCode: string; materialName: string | null; itemGroup: string | null;
  variants: Record<string, unknown> | null; unitPriceSen: number;
  rejectionReason: string | null; remaining: number;
};
export const useReturnableGrnLines = (poId: string | null) => useQuery({
  queryKey: ['pr-returnable-grn-lines', poId],
  queryFn: () => authedFetch<{ lines: ReturnableGrnLine[]; supplierId: string | null }>(
    `/purchase-returns/returnable-grn-lines?poId=${encodeURIComponent(poId as string)}`,
  ),
  enabled: Boolean(poId), staleTime: 15_000, retry: retryUnlessClientError,
});

/* HC-0227: the same pool, raised from a Purchase Invoice — the receipt lines the
   invoice bills, capped at the invoice's own qty per line. */
export const useReturnablePiLines = (piId: string | null) => useQuery({
  queryKey: ['pr-returnable-pi-lines', piId],
  queryFn: () => authedFetch<{ lines: ReturnableGrnLine[]; invoiceNumber: string; supplierId: string | null; purchaseOrderId: string | null }>(
    `/purchase-returns/returnable-pi-lines?piId=${encodeURIComponent(piId as string)}`,
  ),
  enabled: Boolean(piId), staleTime: 15_000, retry: retryUnlessClientError,
});

export const useCreatePurchaseReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; returnNumber: string } & WithMovementErrors>(`/purchase-returns`,
        idempotentInit(idempotencyKey, {
          method: 'POST', body: JSON.stringify(body),
        })),
    onSuccess: (data) => {
      reportMovementErrors('Return created, but stock did not move', data);
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
};

export const usePostPurchaseReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-returns/${id}/post`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', id] });
    },
  });
};

export const useCompletePurchaseReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, creditNoteRef }: { id: string; creditNoteRef?: string }) =>
      authedFetch(`/purchase-returns/${id}/complete`, {
        method: 'PATCH', body: JSON.stringify({ creditNoteRef }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', vars.id] });
    },
    onError: writeFailed,
  });
};

export const useCancelPurchaseReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-returns/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', id] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel return failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

export const useUpdatePurchaseReturnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; returnDate?: string; reason?: string;
      creditNoteRef?: string; notes?: string; supplierReplaces?: boolean;
    }) => authedFetch<{ purchaseReturn: any }>(`/purchase-returns/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
    },
    onError: writeFailed,
  });
};

export const useUpdatePurchaseReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...body }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true } & WithMovementErrors>(`/purchase-returns/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (data, vars) => {
      reportMovementErrors('Line saved, but stock did not move', data);
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailed,
  });
};

export const useDeletePurchaseReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<{ ok: true } & WithMovementErrors>(`/purchase-returns/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (data, vars) => {
      reportMovementErrors('Line deleted, but stock did not come back', data);
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailedAs('Line not deleted'),
  });
};
