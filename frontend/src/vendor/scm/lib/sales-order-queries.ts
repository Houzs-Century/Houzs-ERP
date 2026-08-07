// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — ONLY the Sales-Order
// read / detail / status / mutation hooks the vendored SO list + detail pages
// use. The full source module (~2000 lines) carries the entire SO/DO/SI/DR
// query surface; the DO/SI/DR hooks are intentionally NOT vendored here.
//
// HOUZS VENDOR NOTES:
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The one multipart photo POST that needed the
//     raw token + URL in the source is repointed through authedFetch's base URL
//     + the localStorage 'auth:token' the vendored layer uses.
//   - The source's verified-save (verifiedSave/readbackGet/friendlySaveMessage)
//     wrapper on the header + override mutations is DROPPED — the vendored layer
//     has no verified-save module. Those mutations fall back to the plain PATCH
//     the source already does when `__verify` is absent. Callers that passed
//     `__verify` still work: the extra key is simply stripped before the body
//     is sent (it never was a column).
//   - serviceNotify (the non-React 409/error toast bridge) maps to the vendored
//     dialog-service serviceNotify.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { prepareImageForUpload } from '../../../lib/imagePipeline';
import { resolveLoadedSoVersion, runSoVersionedMutation } from './so-versioned-mutation';

// The vendored authedFetch already handles FormData correctly (it omits the
// JSON content-type for non-string bodies so the multipart boundary survives),
// so the photo upload routes through it like every other call — no bespoke
// fetch with a hand-rolled base URL + token is needed in the Houzs layer.

/* ── SO list / detail reads ──────────────────────────────────────────────── */

export const useMfgSalesOrders = (status?: string) =>
  useQuery({
    queryKey: ['mfg-sales-orders', status ?? 'all'],
    queryFn: () => authedFetch<{ salesOrders: any[] }>(`/mfg-sales-orders${status ? `?status=${status}` : ''}`),
    // Switching the status tab keeps the current list visible while the next
    // status loads, instead of flashing an empty table (keepPreviousData).
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

// Opt-in server-side pagination + search + sort + status-counts. Sending
// `page` switches the backend into its paginated contract (returns
// { salesOrders, total, page, pageSize, statusCounts }); the legacy
// useMfgSalesOrders above (no page) still returns all 500 for the dead V1 page.
// Status tab values in the UI are lowercase (draft/confirmed/cancelled) but the
// mfg_sales_orders.status column stores UPPERCASE — uppercase here to match.
export function useMfgSalesOrdersPaged(params: { page: number; pageSize: number; status?: string; q?: string; sort?: string }) {
  const { page, pageSize, status, q, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status && status !== 'all') usp.set('status', status.toUpperCase());
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery({
    queryKey: ['mfg-sales-orders-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    // statusCounts carries ONE bucket per backend SO_STATUSES entry (lowercase:
    // draft/confirmed/in_production/ready_to_ship/shipped/delivered/invoiced/
    // closed/on_hold/cancelled) plus `all` and `other` (legacy/unknown
    // spellings), summing to `all`. Keys beyond the original four are optional
    // so a mid-deploy old backend (four-bucket shape) still typechecks — the
    // pages read every bucket with `?? 0`.
    queryFn: ({ signal }) => authedFetch<{ salesOrders: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; draft: number; confirmed: number; cancelled: number } & Partial<Record<'in_production' | 'ready_to_ship' | 'shipped' | 'delivered' | 'invoiced' | 'closed' | 'on_hold' | 'other', number>>; aggregates?: { revenueCenti: number; outstandingCenti: number; paidCenti: number } }>(`/mfg-sales-orders?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

// Dashboard summary mode (`?summary=1`) — the backend returns only the 6 cols
// the lifecycle-bucket KPIs need (doc_no, status, proceeded_at, local_total_centi,
// created_at, so_date), non-DRAFT, company + sales-scope scoped, so the dashboard
// isn't paying for 500 fully-hydrated rows. Bucketing stays in the FE (single
// source of truth). Ported from 2990's useMfgSalesOrdersSummary.
export type SoSummaryRow = {
  doc_no: string;
  status: string;
  proceeded_at: string | null;
  local_total_centi: number;
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

// Customer directory — server-side GROUP BY over Sales Orders (by phone/name),
// company + sales-scope scoped. Backend: GET /mfg-sales-orders/customers. Money
// is centi (divide by 100 in the UI). Ported from 2990's Customers page (which
// aggregated client-side); Houzs aggregates server-side so it scales past 500.
export type ScmCustomerOrder = {
  doc_no: string;
  status: string;
  so_date: string | null;
  created_at: string | null;
  local_total_centi: number;
  line_count: number;
};
export type ScmCustomer = {
  key: string;
  name: string;
  phone: string | null;
  order_count: number;
  lifetime_value_centi: number;
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

export type SoPayment = {
  id: string;
  so_doc_no: string;
  paid_at: string;
  method: 'merchant' | 'transfer' | 'cash' | 'installment';
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_centi: number;
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

/* ── SO mutations ────────────────────────────────────────────────────────── */

/* Refresh the SO list caches. TWO keys, because they are siblings rather than
   nested: ['mfg-sales-orders'] prefix-matches every per-SO sub-query as well
   (['mfg-sales-orders', docNo], the payments ledger), so a caller never needs to
   re-list those — but ['mfg-sales-orders-paged', …] is NOT under that prefix,
   and it is the key the live V2 list (useMfgSalesOrdersPaged) actually reads.
   Bump only the first and the on-screen list stays stale until staleTime/refocus.
   Every mutation that changes a LIST row — status, header, lines, line price,
   stock status, payments (the paged read carries paid/outstanding aggregates) —
   must call this. */
export const invalidateSoLists = (qc: ReturnType<typeof useQueryClient>) => {
  qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] });
  qc.invalidateQueries({ queryKey: ['mfg-sales-orders-paged'] });
};

/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as an SO field. Pass one per ORDER intent
   (see lib/idempotency.ts): the middleware then replays the first response —
   the SAME docNo — instead of minting a second order number for the same sale.
   Omitting it is exactly today's behaviour (the middleware no-ops), so a caller
   with genuine many-orders-per-run semantics (SoFromProducts' batch generator)
   still compiles and is unaffected.

   The SO is the source document the whole chain hangs off — a duplicate here
   propagates into DO / SI / stock and is what the #657/#658 scar records. */
export const useCreateMfgSalesOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ docNo: string }>(`/mfg-sales-orders`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => {
      invalidateSoLists(qc);
    },
  });
};

export const useUpdateMfgSalesOrderStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, status }: { docNo: string; status: string }) => {
      const version = await resolveLoadedSoVersion(qc, docNo);
      const cached = qc.getQueryData<{ salesOrder?: { status?: string } }>(['mfg-sales-order-detail', docNo]);
      return authedFetch<{ salesOrder: unknown; version: number }>(`/mfg-sales-orders/${docNo}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, version, expectedStatus: cached?.salesOrder?.status }),
      });
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
      /* The rollback alone is INVISIBLE: onMutate has already painted the new
         status onto the detail and every cached list, so a rejected transition
         reads to the operator as "it worked, then flickered back" — the
         status silently reverts and nothing says why. That is the shape HOOKKA
         shipped and had to fix repeatedly (its DO/invoice notify and production
         PIC "saved then reverted" incidents): a UI that reports an action as
         done which the backend refused. Notify OUTSIDE the ctx guard, because a
         throw inside onMutate leaves ctx undefined and that path was the most
         silent of all. Sibling useUpdateSoItemStockStatus already does this. */
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
    },
  });
};

export const useUpdateMfgSalesOrderHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    // HOUZS VENDOR: verified-save dropped — strip the client-only `__verify`
    // map and fall through to the plain PATCH the source already used when no
    // verification was requested.
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
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log', vars.docNo] });
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
    // HOUZS VENDOR: verified-save dropped — plain POST to the override route.
    mutationFn: async ({ docNo, itemId, overridePriceSen, reason }: {
      docNo: string; itemId: string; overridePriceSen: number; reason?: string;
    }) => {
      await runSoVersionedMutation(qc, docNo, 'price-override', ({ leaseToken }) =>
        authedFetch<{ items: Array<{ id: string; unit_price_centi: number }> }>(
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
      // An override re-prices the line → the SO total, and the list's revenue
      // aggregate, move with it.
      invalidateSoLists(qc);
    },
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
  /** WO-7 — signed URL for the `.thumb` sibling; absent from pre-thumb
   *  backends. Grids try it first and fall back to photoUrl on 404. */
  thumbUrl?: string;
  expiresAt?: string;
};

export const useUploadSoItemPhoto = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, itemId, file }: {
      docNo: string; itemId: string; file: File;
    }): Promise<UploadSoItemPhotoResult> => {
      /* WO-7 — downscale/re-encode the photo and generate its thumbnail in
         ONE decode pass (lib/imagePipeline). Falls back to the original file
         (thumb: null) when the browser can't compress. */
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
  });
};

/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a payment field. Pass one per payment
   INTENT (see lib/idempotency.ts): the server then de-dupes a double-fire
   instead of booking the money twice. Omitting it is exactly today's behaviour
   (the middleware no-ops), so an un-migrated caller still compiles and works. */
export const useAddSalesOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, idempotencyKey, ...body }: { docNo: string; idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ payment: SoPayment }>(`/mfg-sales-orders/${docNo}/payments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    // The ['mfg-sales-orders'] root prefix-covers this SO's payments ledger and
    // header sub-queries; the paged list carries the paid / outstanding
    // aggregates a payment moves.
    onSuccess: () => {
      invalidateSoLists(qc);
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
    // The ['mfg-sales-orders'] root prefix-covers this SO's payments ledger and
    // header sub-queries; the paged list carries the paid / outstanding
    // aggregates a payment moves.
    onSuccess: () => {
      invalidateSoLists(qc);
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
    mutationFn: ({ docNo, id, uploadSessionId }: { docNo: string; id: string; uploadSessionId: string }) =>
      authedFetch<{ payment: SoPayment }>(`/mfg-sales-orders/${docNo}/payments/${id}/slip`, {
        method: 'POST', body: JSON.stringify({ uploadSessionId }),
      }),
    onSuccess: (_data, vars) => {
      /* The per-row slip image is cached under its OWN key by the thumbnail
         query, which the ['mfg-sales-orders'] prefix does not cover — without
         this the ledger refetches but the cell keeps showing the old (or no)
         image until that key's staleTime elapses. */
      qc.invalidateQueries({ queryKey: ['payment-slip', vars.id] });
      invalidateSoLists(qc);
    },
  });
};

export const useDeleteSalesOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, id, version }: { docNo: string; id: string; version: number }) =>
      authedFetch<{ ok: boolean }>(
        `/mfg-sales-orders/${docNo}/payments/${id}?version=${encodeURIComponent(String(version))}`,
        { method: 'DELETE' },
      ),
    // The ['mfg-sales-orders'] root prefix-covers this SO's payments ledger and
    // header sub-queries; the paged list carries the paid / outstanding
    // aggregates a payment moves.
    onSuccess: () => {
      invalidateSoLists(qc);
    },
  });
};

/* ── Photo signed-URL helper (plain async fn, not a hook) ─────────────────── */

export type SignedPhotoUrlResponse = {
  signedUrl: string;
  /** WO-7 — signed `.thumb` sibling URL (absent from pre-thumb backends). */
  thumbUrl?: string;
  expiresAt: string;
};

export async function fetchSoItemPhotoSignedUrl(
  docNo: string,
  itemId: string,
  photoKey: string,
): Promise<SignedPhotoUrlResponse> {
  return authedFetch<SignedPhotoUrlResponse>(
    `/mfg-sales-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}/signed`,
  );
}
