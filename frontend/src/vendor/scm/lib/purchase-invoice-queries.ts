// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — the Purchase Invoice
// (PI) query/mutation surface the vendored PI pages call.
//
// Copied VERBATIM from the source flow-queries.ts PI section except for the
// boundary:
//   • import { authedFetch } from './authed-fetch' (the repointed vendored fetch
import { writeFailed } from './mutation-error';
//     → /api/scm).
//   • the dropped `import { supabase }` / `verified-save` machinery — none of the
//     PI hooks below reference it (they all go through authedFetch).
//   • serviceNotify (cancel onError toast) is the vendored dialog-service bridge.
//
// The picker hooks (useOutstandingGrnItems / useCreatePisFromGrnItems) already
// live in suppliers-queries.ts — NOT duplicated here; the from-GRN page imports
// useOutstandingGrnItems from there.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── Purchase Invoice ────────────────────────────────────────────────── */
export const usePurchaseInvoices = (status?: string) =>
  useQuery({
    queryKey: ['purchase-invoices', status ?? 'all'],
    queryFn: () => authedFetch<{ purchaseInvoices: any[] }>(`/purchase-invoices${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

// Opt-in server-side pagination + search + sort + status-counts (mirrors
// useMfgSalesOrdersPaged). Sending `page` switches /purchase-invoices into its
// paginated contract ({ purchaseInvoices, total, page, pageSize, statusCounts });
// the legacy usePurchaseInvoices above (no page) still returns the historical
// unpaginated list. `status` is the resolved purchase_invoices.status DB value
// (UPPERCASE); each PI filter-pill bucket (draft/posted/partial/paid/cancelled)
// maps 1:1 to a single DB status, so no bucket needs dropping.
export function usePurchaseInvoicesPaged(params: { page: number; pageSize: number; status?: string; q?: string; sort?: string }) {
  const { page, pageSize, status, q, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status) usp.set('status', status);
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery({
    queryKey: ['purchase-invoices-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    queryFn: ({ signal }) => authedFetch<{ purchaseInvoices: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; draft: number; posted: number; partial: number; paid: number; cancelled: number } }>(`/purchase-invoices?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}
export const usePurchaseInvoiceDetail = (id: string | null) => useQuery({
  queryKey: ['purchase-invoice-detail', id],
  // customerDos = OUR delivery order(s) this purchase covers, resolved
  // server-side through the so_item_id chain (back-to-back POs only).
  queryFn: () => authedFetch<{ purchaseInvoice: any; items: any[]; customerDos?: Array<{ id: string; do_number: string }> }>(`/purchase-invoices/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});
export const usePostPurchaseInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-invoices/${id}/post`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', id] });
    },
  });
};
export const useRecordPiPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amountSen, notes }: { id: string; amountSen: number; notes?: string }) =>
      authedFetch(`/purchase-invoices/${id}/payment`, {
        method: 'PATCH', body: JSON.stringify({ amountSen, notes }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail', vars.id] });
    },
    onError: writeFailed,
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

/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a PI field. Pass one per PI intent (see
   lib/idempotency.ts): the middleware replays the first response — the SAME
   invoiceNumber — instead of booking the supplier's bill twice. Omitting it is
   exactly today's behaviour (the middleware no-ops).

   A duplicate PI is a payable the company does not owe; usePostPurchaseInvoice
   above then posts it to the accounts. */
export const useCreatePurchaseInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; invoiceNumber: string }>(`/purchase-invoices`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchase-invoices'] }),
  });
};

/* ── PI PO-clone CRUD (mirror the GRN/PR header + line item hooks) ──────────
   PATCH /purchase-invoices/:id (header), POST/PATCH/DELETE
   /purchase-invoices/:id/items[/:itemId]. Each invalidates the PI detail
   (['purchase-invoice-detail', id]) + list (['purchase-invoices']) — the same
   query keys usePurchaseInvoiceDetail + usePurchaseInvoices read. */
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

/* T12 — free-add a NEW line to an existing PI (PI is free-entry, grnId:null is
   first-class). POST /purchase-invoices/:id/items already accepts the full line
   payload (itemCode/materialName/itemGroup/variants + qty/price) and
   server-recomputes description2. Mirrors useAddGrnItem; invalidates the same
   keys usePurchaseInvoiceDetail + usePurchaseInvoices read. */
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
