
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { writeFailed, writeFailedAs, reportInBandFailure, type InBandFailure } from './mutation-error';

export { useMfgDeliveryOrderDetail } from './delivery-order-queries';
export type { DoRemainingLine } from './sales-invoice-queries';

import type { DoRemainingLine } from './sales-invoice-queries';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

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
export const useCreateDeliveryReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; returnNumber: string } & InBandFailure>(`/delivery-returns`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: (data) => {
      reportInBandFailure('Delivery return saved, but the stock was not received back', data);
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
};

export const useReturnableDoLines = () => useQuery({
  queryKey: ['delivery-returns', 'returnable-do-lines'],
  queryFn: () => authedFetch<{ lines: DoRemainingLine[] }>(
    `/delivery-returns/returnable-do-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export const useConvertDoToDeliveryReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { picks: Array<{ doItemId: string; qty: number; condition?: string }> }) =>
      authedFetch<{ id: string; returnNumber: string; lineCount: number } & InBandFailure>(
        `/delivery-returns/from-do`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: (data) => {
      reportInBandFailure('Delivery return saved, but the stock was not received back', data);
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['delivery-returns', 'returnable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['sales-invoices', 'invoiceable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
    },
    onError: writeFailedAs('Delivery return not created'),
  });
};

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
      authedFetch<{ deliveryReturn: unknown } & InBandFailure>(`/delivery-returns/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (data, vars) => {
      reportInBandFailure('Status saved, but the stock was not adjusted', data);
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      qc.invalidateQueries({ queryKey: ['delivery-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

export const useAddDeliveryReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown } & InBandFailure>(`/delivery-returns/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (data, vars) => {
      reportInBandFailure('Line saved, but the stock was not adjusted', data);
      qc.invalidateQueries({ queryKey: ['delivery-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailedAs('Line not added'),
  });
};

export const useUpdateDeliveryReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean } & InBandFailure>(`/delivery-returns/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (data, vars) => {
      reportInBandFailure('Line saved, but the stock was not adjusted', data);
      qc.invalidateQueries({ queryKey: ['delivery-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailed,
  });
};

export const useDeleteDeliveryReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<InBandFailure | undefined>(`/delivery-returns/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (data, vars) => {
      reportInBandFailure('Line saved, but the stock was not adjusted', data);
      qc.invalidateQueries({ queryKey: ['delivery-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['delivery-returns'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailedAs('Line not deleted'),
  });
};
