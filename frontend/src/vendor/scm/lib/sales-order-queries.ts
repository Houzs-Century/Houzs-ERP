// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — ONLY the Sales-Order
import { writeFailed } from './mutation-error';
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

import { useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, authedFetch, humanApiError } from './authed-fetch';
import { applySoListMrpEnrichment, type EnrichableSoRow, type SoListMrpEnrichment } from '../../../lib/soListEnrichment';
// The photo PROXY fallback streams raw bytes, which authedFetch would try to
// JSON-parse — so it uses the shared correlated transport + token accessor
// directly, exactly as slip.ts does for the same reason.
import { readAuthToken } from '../../../lib/authToken';
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromError,
  requestIdFromResponse,
} from '../../../lib/requestCorrelation';
import { companyHeader } from '../../../lib/activeCompany';
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
export function useMfgSalesOrdersPaged(params: { page: number; pageSize: number; status?: string; q?: string; sort?: string; enabled?: boolean }) {
  const { page, pageSize, status, q, sort, enabled } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status && status !== 'all') usp.set('status', status.toUpperCase());
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery({
    // `enabled` (default true) lets the list page defer the FIRST fetch by one
    // render until the DataTable's one-shot mount sort-report lands, so the
    // initial query already carries any localStorage-restored `sort` instead of
    // firing sort-less, getting aborted, and immediately re-firing with sort.
    enabled: enabled ?? true,
    queryKey: ['mfg-sales-orders-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    // statusCounts carries ONE bucket per backend SO_STATUSES entry (lowercase:
    // draft/confirmed/in_production/ready_to_ship/shipped/delivered/invoiced/
    // closed/on_hold/cancelled) plus `all` and `other` (legacy/unknown
    // spellings), summing to `all`. Keys beyond the original four are optional
    // so a mid-deploy old backend (four-bucket shape) still typechecks — the
    // pages read every bucket with `?? 0`.
    queryFn: ({ signal }) => authedFetch<{ salesOrders: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; draft: number; confirmed: number; cancelled: number } & Partial<Record<'in_production' | 'ready_to_ship' | 'shipped' | 'delivered' | 'invoiced' | 'closed' | 'on_hold' | 'other', number>>; aggregates?: { revenueSen: number; outstandingSen: number; paidSen: number } }>(`/mfg-sales-orders?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

/* Deferred SO-list enrichment — the MRP-derived fields the list no longer
   computes on its critical path (READY source-PO chips + the readiness/planning
   verdicts). Fired AFTER the list renders, for the docs it just showed, and
   merged in by applySoListMrpEnrichment. Desktop (one page) and mobile (many
   infinite-scroll pages) share this: the docs are chunked at 100 so the request
   stays bounded no matter how far mobile scrolls, and each chunk is cached
   independently (a page already fetched is not re-requested when the next
   loads). The backend runs ONE company-wide computeMrp per request regardless
   of the chunk size, so chunking costs only extra bounded row reads, never
   extra allocation work. */
const ENRICH_CHUNK = 100;

export function useSoListMrpEnrichmentMap(
  docNos: string[],
  enabled: boolean,
): { byDoc: Map<string, SoListMrpEnrichment>; isFetching: boolean } {
  // Sort so the chunk cache keys are stable across renders (row order can shift
  // under a re-sort without changing which docs are on screen).
  const chunks = useMemo(() => {
    const uniq = [...new Set(docNos.filter(Boolean))].sort();
    const out: string[][] = [];
    for (let i = 0; i < uniq.length; i += ENRICH_CHUNK) out.push(uniq.slice(i, i + ENRICH_CHUNK));
    return out;
  }, [docNos]);

  const results = useQueries({
    queries: chunks.map((chunk) => ({
      enabled: enabled && chunk.length > 0,
      queryKey: ['mfg-sales-orders-list-mrp-enrichment', chunk.join(',')],
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        authedFetch<{ enrichment: Record<string, SoListMrpEnrichment> }>(
          `/mfg-sales-orders/list-mrp-enrichment?docNos=${encodeURIComponent(chunk.join(','))}`,
          { signal },
        ),
      staleTime: 30_000,
      retry: retryUnlessClientError,
      retryDelay: 800,
    })),
  });

  // Signature over the per-chunk update timestamps: rebuild the merged map only
  // when a chunk's data actually changes, not on every parent render.
  const sig = results.map((r) => r.dataUpdatedAt).join('|');
  const isFetching = results.some((r) => r.isFetching);
  const byDoc = useMemo(() => {
    const map = new Map<string, SoListMrpEnrichment>();
    for (const r of results) {
      const e = r.data?.enrichment;
      if (e) for (const [k, v] of Object.entries(e)) map.set(k, v);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `results` is read through its `sig` (per-chunk dataUpdatedAt); depending on the array itself would rebuild every render.
  }, [sig]);

  return { byDoc, isFetching };
}

/* The overlay both SO-list surfaces apply: take the rows the list endpoint
   returned (SHIPPED chips + stored-status placeholders), fetch the deferred MRP
   enrichment for their docs, and return the healed rows. One hook so desktop and
   mobile cannot drift. */
export function useEnrichedSoListRows<T extends EnrichableSoRow>(
  rows: T[],
  enabled: boolean,
): T[] {
  const docNos = useMemo(
    () => rows.map((r) => r.doc_no).filter((x): x is string => !!x),
    [rows],
  );
  const { byDoc } = useSoListMrpEnrichmentMap(docNos, enabled);
  return useMemo(
    () => rows.map((r) => applySoListMrpEnrichment(r, r.doc_no ? byDoc.get(r.doc_no) : undefined)),
    [rows, byDoc],
  );
}

// Dashboard summary mode (`?summary=1`) — the backend returns only the 6 cols
// the lifecycle-bucket KPIs need (doc_no, status, local_total_sen,
// created_at, so_date), non-DRAFT, company + sales-scope scoped, so the dashboard
// isn't paying for 500 fully-hydrated rows. Bucketing stays in the FE (single
// source of truth). Ported from 2990's useMfgSalesOrdersSummary.
export type SoSummaryRow = {
  doc_no: string;
  status: string;
  local_total_sen: number;
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
  local_total_sen: number;
  line_count: number;
};
export type ScmCustomer = {
  key: string;
  name: string;
  phone: string | null;
  order_count: number;
  lifetime_value_sen: number;
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
  amount_sen: number;
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

/* `expectedStatus` is the server's compare-and-set on the status column: the
   backend refuses with 409 `so_version_conflict` when it does not equal the
   row's CURRENT status. So it must carry the status the operator was LOOKING
   at, and the caller is the only thing that holds it.

   It is REQUIRED, not optional, because it decides whether the CAS runs at all
   (see CLAUDE.md, "a parameter that DECIDES something is required"). Pass an
   explicit `null` where a surface genuinely does not know the current status —
   the backend then skips the status half and the version CAS alone guards the
   write.

   IT MUST NOT BE READ BACK OUT OF THE QUERY CACHE. `onMutate` below paints the
   TARGET status onto the detail + list caches, and react-query runs `onMutate`
   BEFORE `mutationFn` — so a mutationFn that read the cache read its own
   optimistic write and sent `expectedStatus === status`. Every transition off
   a warm detail cache therefore failed the CAS and returned 409, which the
   operator saw as "Status update failed — Someone else updated this order
   while you were editing" on the very first click, with nobody else involved.
   Cancel SO on the detail page was 100% reproducible; the list buttons happened
   to work only because a cold detail cache made `onMutate`'s paint a no-op.
   Pinned by sales-order-status-expected.test.tsx. */
export const useUpdateMfgSalesOrderStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, status, expectedStatus }: { docNo: string; status: string; expectedStatus: string | null }) => {
      const version = await resolveLoadedSoVersion(qc, docNo);
      return authedFetch<{ salesOrder: unknown; version: number }>(`/mfg-sales-orders/${docNo}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, version, expectedStatus: expectedStatus ?? undefined }),
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
        authedFetch<{ items: Array<{ id: string; unit_price_sen: number }> }>(
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
    onError: writeFailed,
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
    onError: writeFailed,
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

/* ── Photo URL helper (plain async fn, not a hook) ─────────────────────────
   THE WIRE SHAPE IS A UNION, AND THE PROXY ARM IS THE PRODUCTION ARM.

   `GET /photos/:photoKey/signed` mints a presigned R2 URL, which needs the R2
   S3-API credentials (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT).
   Those are wrangler SECRETS and have never been provisioned in production, so
   signing throws for EVERY photo and the route answers its `mode: 'proxy'` arm
   — always, for every tile, today. The `mode: 'signed'` arm is the one nothing
   currently takes. Mirror of backend/src/scm/lib/photoProxyFallback.ts; keep
   the two in step.

   The proxy arm deliberately carries NO `signedUrl`. Its `proxyPath` is behind
   the bearer-auth gate, and a browser sends no Authorization header on an
   <img src> — piping it into one trades a visible 500 for an invisible 401.
   Fetch it with the authed client and hand <img> a blob: object URL instead
   (fetchSoItemPhotoBlob below does exactly that).

   TYPED AS A UNION ON PURPOSE. This used to be declared
   `{ signedUrl: string; thumbUrl?: string; expiresAt: string }` — flatly untrue
   of the payload production actually returns — so `res.signedUrl` type-checked
   everywhere while being `undefined` at runtime on every request, and a new
   photo surface could be written straight onto the outage with no compile
   error. Narrow on `mode` and the compiler now refuses that. */

export type SignedPhotoPayload = {
  /** Absent on responses minted before the union landed; treat as 'signed'. */
  mode?: 'signed';
  signedUrl: string;
  /** WO-7 — signed `.thumb` sibling URL (absent from pre-thumb backends). */
  thumbUrl?: string;
  expiresAt: string;
};

export type ProxyPhotoPayload = {
  mode: 'proxy';
  /** API-client-relative path; fetch with the authed client, read as a Blob. */
  proxyPath: string;
  /** Same, for the `.thumb` sibling. 404s when no thumb was ever generated. */
  thumbProxyPath: string;
  expiresAt: null;
  /** Why signing failed, e.g. "R2_ACCESS_KEY_ID not configured". */
  reason: string;
};

export type PhotoUrlPayload = SignedPhotoPayload | ProxyPhotoPayload;

/** True when the payload cannot supply an `<img src>` and the caller must
 *  stream the bytes through the authed proxy instead. Covers both the explicit
 *  `mode: 'proxy'` arm and a signed arm whose URL is not directly loadable. */
export const isProxyPhotoPayload = (p: PhotoUrlPayload): p is ProxyPhotoPayload =>
  p.mode === 'proxy';

export async function fetchSoItemPhotoSignedUrl(
  docNo: string,
  itemId: string,
  photoKey: string,
): Promise<PhotoUrlPayload> {
  return authedFetch<PhotoUrlPayload>(
    `/mfg-sales-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}/signed`,
  );
}

/** A signed URL is only usable as <img src> if it is an ABSOLUTE http(s) URL —
 *  the signature travels in the query string, so no header is needed.
 *
 *  Belt to `isProxyPhotoPayload`'s braces, and a cheap invariant check rather
 *  than a live failure path: the signed arm of `/photos/:photoKey/signed` can
 *  only emit an absolute R2 URL, and the one relative `photoUrl` the API ever
 *  produces (the POST upload route's own signing fallback) is filtered by
 *  `startsWith('http')` before it can reach the URL cache. The guard is kept
 *  because it costs one regex and it is what makes "anything in the cache is
 *  <img>-loadable" true by construction rather than by trusting the callers to
 *  agree — but do not read it as documentation of a 404 anyone has seen. */
export const isDirectlyLoadableUrl = (url: string | undefined | null): boolean =>
  !!url && /^https?:\/\//i.test(url);

/** Carries the HTTP status so the caller can tell a genuinely-missing photo
 *  (404) or a refused one (401/403) from a transient server fault. */
export class PhotoProxyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PhotoProxyError';
    this.status = status;
  }
}

/* A photo tile is a background nicety, not a blocking flow, so its deadline is
   tighter than slip.ts's 60s interactive GETs. What it must NOT be is absent:
   without a signal, a stalled Worker cold-start leaves the tile on "…" forever
   with its one proxy attempt already spent, which is precisely the failure
   slip.ts added slipFetch to stop ("a stalled cold-start / slow upload hangs
   the upload UI forever", slip.ts:66-88). */
const PHOTO_PROXY_TIMEOUT_MS = 30_000;

/* Bytes, not JSON — authedFetch unconditionally res.json()s its response, so
   this reuses the exported API_URL + the shared correlated transport directly.

   PARITY WITH slip.ts, STATED ACCURATELY: same transport (correlatedFetch),
   same bearer-token + company headers, and now the same deadline discipline —
   slip.ts routes every such call through slipFetch(..., timeout), and an
   earlier revision of this helper claimed parity while having no deadline at
   all. It differs deliberately in ONE respect: slip.ts returns an object URL
   its view-then-navigate callers never revoke, whereas a photo GRID mounts and
   unmounts on every drawer open. So this returns the raw Blob and lets the
   component own URL.createObjectURL / revokeObjectURL — that is what makes the
   bytes cacheable across mounts while each mount's object URL is still revoked
   exactly once. */
export async function fetchSoItemPhotoBlob(
  docNo: string,
  itemId: string,
  photoKey: string,
): Promise<Blob> {
  return fetchItemPhotoBlobAt(
    `/mfg-sales-orders/${encodeURIComponent(docNo)}/items/${encodeURIComponent(itemId)}`,
    photoKey,
  );
}

/* One transport for every line-photo proxy read. `itemBase` is the
   API-client-relative document/item prefix ("/mfg-sales-orders/:docNo/items/
   :itemId" or "/mfg-purchase-orders/:id/items/:itemId") — the routes mirror
   each other by design (mig 0274: the PO photo read path was built to the SO
   contract so one client code path drives both surfaces). */
async function fetchItemPhotoBlobAt(itemBase: string, photoKey: string): Promise<Blob> {
  const token = readAuthToken();
  if (!token) throw new PhotoProxyError(401, 'Your session has expired — please sign in again.');

  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(PHOTO_PROXY_TIMEOUT_MS); } catch { signal = undefined; }

  let res: Response;
  try {
    res = await correlatedFetch(
      `${API_URL}${itemBase}/photos/${encodeURIComponent(photoKey)}`,
      { headers: { authorization: `Bearer ${token}`, ...companyHeader() }, signal },
    );
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      /* 408 so the tile can tell a stall from a genuine 404 — a stall must not
         be remembered as "this photo has no thumb". */
      throw correlateError(
        new PhotoProxyError(408, 'The photo took too long to load — please try again.'),
        requestIdFromError(e),
      );
    }
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(
      new PhotoProxyError(res.status, humanApiError(res.status, text)),
      requestIdFromResponse(res),
    );
  }

  return consumeCorrelated(res, () => res.blob());
}

/* ── PO twins ──────────────────────────────────────────────────────────────
   Purchase-order lines carry the SAME photo keys (an SO→PO convert copies the
   key list; both point at one R2 object), served by mirrored routes on
   /mfg-purchase-orders/:id/items/:itemId (mig 0274). They live HERE because
   this file owns the photo wire contract — the payload union, PhotoProxyError
   and the proxy transport above — and a second copy of that contract is how
   the SO side originally shipped a surface that rendered nothing. */

export async function fetchPoItemPhotoSignedUrl(
  poId: string,
  itemId: string,
  photoKey: string,
): Promise<PhotoUrlPayload> {
  return authedFetch<PhotoUrlPayload>(
    `/mfg-purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}`
      + `/photos/${encodeURIComponent(photoKey)}/signed`,
  );
}

export async function fetchPoItemPhotoBlob(
  poId: string,
  itemId: string,
  photoKey: string,
): Promise<Blob> {
  return fetchItemPhotoBlobAt(
    `/mfg-purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}`,
    photoKey,
  );
}

/* PO WRITE twins (owner 2026-08-28: 如果我要 add on 照片在 PO 而已 — a purchaser
   attaches photos DIRECTLY on a PO line). Two ownership classes share the
   photo_urls column, told apart by key prefix: carried `so-items/...` keys are
   SO-owned (the server refuses deleting them here — manage on the SO);
   `po-items/...` keys are PO-authored, live only on the PO, and print only on
   the PO PDF. */
export const PO_OWNED_PHOTO_PREFIX = 'po-items/';
export const isPoOwnedPhotoKey = (key: string): boolean => key.startsWith(PO_OWNED_PHOTO_PREFIX);

export type UploadPoItemPhotoResult = { photoKey: string; photoUrls: string[] };

export async function uploadPoItemPhoto(
  poId: string,
  itemId: string,
  file: File,
): Promise<UploadPoItemPhotoResult> {
  /* WO-7 — downscale/re-encode + thumbnail in one decode pass. The thumb is
     what the PO PDF prints (pdf-item-photos fetches thumbs only), so sending
     it is not cosmetic. */
  const prepared = await prepareImageForUpload(file);
  const fd = new FormData();
  fd.append('file', prepared.file);
  if (prepared.thumb) fd.append('thumb', prepared.thumb);
  return authedFetch<UploadPoItemPhotoResult>(
    `/mfg-purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}/photos`,
    { method: 'POST', body: fd },
  );
}

export async function deletePoItemPhoto(
  poId: string,
  itemId: string,
  photoKey: string,
): Promise<{ photoUrls: string[] }> {
  return authedFetch<{ photoUrls: string[] }>(
    `/mfg-purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}`
      + `/photos/${encodeURIComponent(photoKey)}`,
    { method: 'DELETE' },
  );
}

/* Sofa Compartment hero photo — a DIFFERENT wire than the per-line item photos
   above: keyed by compartment CODE, served by the public
   /maintenance-config/sofa-compartments/:code/photo/:key proxy (singular
   "photo"), so it does not go through fetchItemPhotoBlobAt (which appends
   "/photos/:key"). Used to paint the real compartment picture into the PO's
   sofa-layout schematic. The auth header is sent when present but the route is
   public, so a signed-out preview still resolves. */
export async function fetchSofaCompartmentPhotoBlob(code: string, photoKey: string): Promise<Blob> {
  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(PHOTO_PROXY_TIMEOUT_MS); } catch { signal = undefined; }
  const token = readAuthToken();
  const res = await correlatedFetch(
    `${API_URL}/maintenance-config/sofa-compartments/${encodeURIComponent(code)}`
      + `/photo/${encodeURIComponent(photoKey)}`,
    { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...companyHeader() }, signal },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new PhotoProxyError(res.status, humanApiError(res.status, text));
  }
  return consumeCorrelated(res, () => res.blob());
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

/* Fetch every sofa-compartment hero photo into a `{ code: dataURL }` map for the
   PO PDF's sofa-layout schematic (drawSofaLayout's optional `photos` arg). Given
   the maintenance config's `sofaCompartmentMeta`, it fetches only compartments
   that HAVE an uploaded photo, in parallel, and simply omits any that fail — the
   PDF engine falls back to its drawn schematic for a missing code, so a partial
   or empty map is safe. A newly-uploaded compartment photo appears on the PO the
   next time it is printed, with no code change. */
export async function loadSofaCompartmentPhotos(
  meta: Record<string, { imageKey?: string }> | undefined | null,
): Promise<Record<string, string>> {
  if (!meta) return {};
  const withKey = Object.entries(meta)
    .filter((e): e is [string, { imageKey: string }] => typeof e[1].imageKey === 'string' && e[1].imageKey.length > 0);
  const out: Record<string, string> = {};
  await Promise.all(withKey.map(async ([code, m]) => {
    try {
      const blob = await fetchSofaCompartmentPhotoBlob(code, m.imageKey);
      const dataUrl = await blobToDataUrl(blob);
      if (dataUrl) out[code] = dataUrl;
    } catch {
      /* skip this compartment — the engine draws its schematic instead */
    }
  }));
  return out;
}
