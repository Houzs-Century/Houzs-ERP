// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — ONLY the Sales
// Invoice (SI) read / detail / status / item / payment / line-picker hooks the
// vendored SI list / new / from-do / detail pages use.
//
// HOUZS VENDOR NOTES (boundary only — bodies are verbatim):
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The 409 short-stock prompt + sofa whole-set
//     hard-block live inside authedFetch (mirrors the source).
//   - serviceNotify (the non-React error toast bridge) maps to the vendored
//     dialog-service serviceNotify (used by the status-update onError).
//   - useMfgDeliveryOrderDetail + useDeliveryOrderPayments are NOT re-defined
//     here: the New-SI prefill imports them, but they already live in the
//     vendored delivery-order-queries slice — re-exported below so the page's
//     single import site keeps working.
//   - DoRemainingLine + the invoiceable-line picker are SI-side here; the DR
//     slice re-exports the type from here to stay a single source of truth.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed, writeFailedAs } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

// Re-export the DO-side prefill hooks the New-SI page pulls from this module in
// the source (they live in the vendored DO slice — single source of truth).
export { useMfgDeliveryOrderDetail, useDeliveryOrderPayments } from './delivery-order-queries';

/* ── Sales Invoice ───────────────────────────────────────────────────── */
export const useSalesInvoices = (status?: string) =>
  useQuery({
    queryKey: ['sales-invoices', status ?? 'all'],
    queryFn: () => authedFetch<{ salesInvoices: any[] }>(`/sales-invoices${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

// Opt-in server-side pagination + search + sort + status-counts (mirrors
// useMfgSalesOrdersPaged). Sending `page` switches /sales-invoices into its
// paginated contract ({ salesInvoices, total, page, pageSize, statusCounts });
// the legacy useSalesInvoices above (no page) still returns the historical
// unpaginated list. `status` is the RESOLVED sales_invoices.status DB value
// (UPPERCASE) — the caller maps its filter-pill bucket to a DB status first and
// passes undefined for the multi-status buckets the single-status filter can't
// express (sent/partial/paid), so those show all rows still counted.
export function useSalesInvoicesPaged(params: { page: number; pageSize: number; status?: string; q?: string; sort?: string }) {
  const { page, pageSize, status, q, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status) usp.set('status', status);
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery({
    queryKey: ['sales-invoices-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    queryFn: ({ signal }) => authedFetch<{ salesInvoices: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; sent: number; partial: number; paid: number; cancelled: number } }>(`/sales-invoices?${usp.toString()}`, { signal }),
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
/* Create a Sales Invoice (header + line items). The server posts revenue on
   create (idempotent), so invalidate the GL queries too. */
/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as an SI field. Pass one per SI intent
   (see lib/idempotency.ts): the middleware replays the first response — the SAME
   invoiceNumber — instead of invoicing the customer twice. Omitting it is
   exactly today's behaviour (the middleware no-ops).

   Mirrors useAddSalesInvoicePayment 220 lines below, idempotent since #657 while
   the invoice the payment settles was not. A duplicate SI is the worst of the
   set to unwind: this onSuccess shows why — it posts REVENUE and moves
   journal-entries / account-balances / ar-aging, so a double invoice doubles
   the books, not just a row. */
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
      /* Cancel reverses revenue (contra JE) — refresh accounting + the
         invoiceable-lines picker so the released qty re-appears as Pending. */
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
    mutationFn: ({ id, amountCenti, notes }: { id: string; amountCenti: number; notes?: string }) =>
      authedFetch(`/sales-invoices/${id}/payment`, {
        method: 'PATCH', body: JSON.stringify({ amountCenti, notes }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['sales-invoices'] });
      qc.invalidateQueries({ queryKey: ['sales-invoice-detail', vars.id] });
    },
    onError: writeFailed,
  });
};

/* Line-level DO → conversion descriptor (Commander 2026-05-30, Phase B). Each
   row is a DO line that can still be invoiced OR returned — remaining =
   delivered − invoiced − returned, derived live by the server (no stored
   counter). Invoicing + returning compete for the same Pending pool, so an
   invoiced unit can't be returned and vice-versa. Shared by the invoiceable +
   returnable pickers (same shape; `remaining` means remaining_to_invoice on the
   SI side and remaining_to_return on the DR side). */
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
  delivered: number;
  invoiced: number;
  returned: number;
  remaining: number;
  unitPriceCenti: number;
  unitCostCenti: number;
  discountCenti: number;
  variants: unknown;
};

/* Invoiceable DO LINES for the line-level DO→Sales Invoice picker. Each row is a
   DO line with remaining_to_invoice > 0. A line can be invoiced across several
   invoices until remaining hits 0. */
export const useInvoiceableDoLines = () => useQuery({
  queryKey: ['sales-invoices', 'invoiceable-do-lines'],
  queryFn: () => authedFetch<{ lines: DoRemainingLine[] }>(
    `/sales-invoices/invoiceable-do-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* Convert picked DO LINES (each with a partial qty) → ONE Sales Invoice. Server
   validates the picks share one customer + each qty is 1..remaining_to_invoice,
   creates one invoice line per pick (status SENT), recomputes totals, then
   records revenue (Dr 1100 AR / Cr 4000 Sales Revenue), idempotent on the
   invoice number. Returns the new invoice's { id, invoiceNumber }. */
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
      /* Picker must refetch so already-invoiced DO lines drop off the list
         (Wei Siang 2026-05-30). Both pickers compete for the same DO Pending
         pool, so refresh BOTH. */
      qc.invalidateQueries({ queryKey: ['sales-invoices', 'invoiceable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['delivery-returns', 'returnable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
    },
    onError: writeFailedAs('Invoice not created'),
  });
};

/* Append a DO's lines into an EXISTING invoice (Detail "Transfer from Delivery Order"). */
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
      /* Force picker refetch — both pickers share the same DO Pending pool. */
      qc.invalidateQueries({ queryKey: ['sales-invoices', 'invoiceable-do-lines'], refetchType: 'all' });
      qc.invalidateQueries({ queryKey: ['delivery-returns', 'returnable-do-lines'], refetchType: 'all' });
    },
    onError: writeFailedAs('DO lines not added to this invoice'),
  });
};

/* SI header PATCH — editable SO/DO-style fields. Mirrors
   useUpdateMfgDeliveryOrderHeader. */
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

/* SI line-item CRUD — mirrors the DO item hooks. Each mutation recomputes the
   SI totals server-side, so we invalidate both the detail + list. */
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

/* SI payments ledger — mirror of the DO payments hooks. */
export type SiPayment = {
  id: string;
  sales_invoice_id: string;
  paid_at: string;
  method: 'merchant' | 'transfer' | 'cash';
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_centi: number;
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

/* `idempotencyKey` — optional, destructured OUT of the body. See
   useAddSalesOrderPayment / lib/idempotency.ts for the one-key-per-intent rule. */
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
