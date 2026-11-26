
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { siListParams } from './si-list-export';
import { writeFailed, writeFailedAs } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export { useMfgDeliveryOrderDetail } from './delivery-order-queries';

export const useSalesInvoices = (status?: string) =>
  useQuery({
    queryKey: ['sales-invoices', status ?? 'all'],
    queryFn: () => authedFetch<{ salesInvoices: any[] }>(`/sales-invoices${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

export function useSalesInvoicesPaged(params: { from?: string; to?: string; page: number; pageSize: number; status?: string; q?: string; sort?: string; debtorNames?: string[]; currencies?: string[] }) {
  const { page, pageSize, status, q, sort, debtorNames, currencies, from, to } = params;
  const usp = siListParams({ status, q, sort, debtorNames, currencies, from, to });
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  return useQuery({
    queryKey: ['sales-invoices-paged', page, pageSize, status ?? '', q ?? '', sort ?? '', JSON.stringify(debtorNames ?? []), JSON.stringify(currencies ?? [])],
    queryFn: ({ signal }) => authedFetch<{ salesInvoices: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; draft: number; sent: number; partial: number; paid: number; cancelled: number } }>(`/sales-invoices?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}
export const useSalesInvoiceDetail = (id: string | null) => useQuery({
  queryKey: ['sales-invoice-detail', id],
  queryFn: () => authedFetch<{ salesInvoice: any; items: any[] }>(`/sales-invoices/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});
export const useCreateSalesInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; invoiceNumber: string; revenue?: { posted: boolean; jeNo?: string; status: string } }>(
        `/sales-invoices`, idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      qc.invalidateQueries({ queryKey: ['account-balances'] });
      qc.invalidateQueries({ queryKey: ['ar-aging'] });
    },
  });
};

export const useUpdateSalesInvoiceStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedFetch(`/sales-invoices/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      qc.invalidateQueries({ queryKey: ['account-balances'] });
      qc.invalidateQueries({ queryKey: ['ar-aging'] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};
export const useRecordSiPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amountSen, notes }: { id: string; amountSen: number; notes?: string }) =>
      authedFetch(`/sales-invoices/${id}/payment`, {
        method: 'PATCH', body: JSON.stringify({ amountSen, notes }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
    },
    onError: writeFailed,
  });
};

export type DoRemainingLine = {
  doItemId: string;
  deliveryOrderId: string;
  doNumber: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  lineDeliveryDate: string | null;
  delivered: number;
  invoiced: number;
  returned: number;
  remaining: number;
  unitPriceSen: number;
  unitCostSen: number;
  discountSen: number;
  variants: unknown;
  soRef?: string | null;
  soCustomerSoNo?: string | null;
};

export const useInvoiceableDoLines = () => useQuery({
  queryKey: ['sales-invoices', 'invoiceable-do-lines'],
  queryFn: () => authedFetch<{ lines: DoRemainingLine[] }>(
    `/sales-invoices/invoiceable-do-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export const useConvertDosToSi = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ picks }: { picks: Array<{ doItemId: string; qty: number }> }) =>
      authedFetch<{ id: string; invoiceNumber: string; revenue: { posted: boolean; jeNo?: string; status: string } }>(
        `/sales-invoices/from-dos`,
        { method: 'POST', body: JSON.stringify({ picks }) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      qc.invalidateQueries({ queryKey: ['account-balances'] });
      qc.invalidateQueries({ queryKey: ['ar-aging'] });
      qc.invalidateQueries({ queryKey: ['sales-invoices', 'invoiceable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['delivery-returns', 'returnable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
    },
    onError: writeFailedAs('Invoice not created'),
  });
};

export const useAppendDoToSalesInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, doId }: { id: string; doId: string }) =>
      authedFetch<{ ok: boolean; added: number }>(`/sales-invoices/${id}/items/from-do/${doId}`, { method: 'POST' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      qc.invalidateQueries({ queryKey: ['journal-entries'] });
      qc.invalidateQueries({ queryKey: ['account-balances'] });
      qc.invalidateQueries({ queryKey: ['sales-invoices', 'invoiceable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['delivery-returns', 'returnable-do-lines'], refetchType: 'all' });
    },
    onError: writeFailedAs('DO lines not added to this invoice'),
  });
};

export const useUpdateSalesInvoiceHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/sales-invoices/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
    },
    onError: writeFailed,
  });
};

export const useAddSalesInvoiceItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/sales-invoices/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
    },
    onError: writeFailedAs('Line not added'),
  });
};

export const useUpdateSalesInvoiceItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/sales-invoices/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
    },
    onError: writeFailed,
  });
};

export const useDeleteSalesInvoiceItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/sales-invoices/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
    },
    onError: writeFailedAs('Line not deleted'),
  });
};

export type SiPayment = {
  id: string;
  sales_invoice_id: string;
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

export const useSalesInvoicePayments = (id: string | null) => useQuery({
  queryKey: ['sales-invoices', id, 'payments'],
  queryFn: () => authedFetch<{ payments: SiPayment[] }>(`/sales-invoices/${id}/payments`).then((r) => r.payments),
  enabled: Boolean(id),
  staleTime: 2 * 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useAddSalesInvoicePayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey, ...body }: { id: string; idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ payment: SiPayment }>(`/sales-invoices/${id}/payments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoices', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
    },
  });
};

export const useDeleteSalesInvoicePayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paymentId }: { id: string; paymentId: string }) =>
      authedFetch<{ ok: boolean }>(`/sales-invoices/${id}/payments/${paymentId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoices', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
    },
  });
};
