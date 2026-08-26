// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — ONLY the
// Delivery-Order (mfg) read / detail / status / item / payment hooks the
// vendored DO list / new / from-so / detail pages use. The SI / DR hooks that
// share the same source module are intentionally NOT vendored here.
//
// HOUZS VENDOR NOTES:
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The 409 short-stock "ship anyway?" prompt and
//     the sofa whole-set hard-block live inside authedFetch, so the DO create /
//     item mutations get them for free (mirrors the source).
//   - serviceNotify (the non-React error toast bridge) maps to the vendored
//     dialog-service serviceNotify.
//   - The source's releaseSoSideQueries cross-invalidation (SO list/detail +
//     the deliverable-so-lines picker) is preserved verbatim so a released qty
//     immediately re-appears in the SO-side menus.
//   - useMfgSalesOrderDetail + useSalesOrderPayments are NOT re-defined here:
//     the New-DO prefill imports them, but they already live in the vendored
//     sales-order-queries module — re-exported below so the page's single
//     import site keeps working.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { writeFailedAs } from './mutation-error';
import { invalidateSoLists } from './sales-order-queries';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

// Re-export the SO-side prefill hooks the New-DO page pulls from this module in
// the source (they live in the vendored SO slice — single source of truth).
export { useMfgSalesOrderDetail, useSalesOrderPayments } from './sales-order-queries';

/* ── Deliverable SO lines (line-level partial-delivery picker) ───────────── */
export type DeliverableSoLine = {
  soItemId: string;
  docNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  unitPriceSen: number;
  unitCostSen: number;
  discountSen: number;
  variants: unknown;
  delivered: number;
  returned: number;
  remaining: number;
};

export const useDeliverableSoLines = () => useQuery({
  queryKey: ['mfg-delivery-orders', 'deliverable-so-lines'],
  queryFn: () => authedFetch<{ lines: DeliverableSoLine[] }>(
    `/delivery-orders-mfg/deliverable-so-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* SO customer/delivery header for the New-DO form's PREFILL. Reads the dedicated
   company-UNSCOPED backend endpoint (GET /delivery-orders-mfg/so-convert-header)
   rather than the full, company+sales-scoped /mfg-sales-orders/:docNo detail: a
   2990-mirrored SO (company 2) is routinely converted while browsing as Houzs,
   and the scoped detail 404s for that cross-company doc — which used to leave
   the desktop DO form's customer name/phone/email/address/salesperson blank even
   though the line items carried over. This mirrors what POST /from-sos already
   reads server-side, so the reviewable form prefills the SAME customer the
   server-side conversion would stamp. */
export type SoConvertHeader = {
  doc_no: string;
  debtor_code: string | null;
  debtor_name: string | null;
  agent: string | null;
  salesperson_id: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  customer_state: string | null;
  postcode: string | null;
  phone: string | null;
  email: string | null;
  customer_type: string | null;
  building_type: string | null;
  venue: string | null;
  venue_id: string | null;
  ref: string | null;
  po_doc_no: string | null;
  customer_so_no: string | null;
  sales_location: string | null;
  customer_delivery_date: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
};

export const useSoConvertHeader = (docNo: string | null) => useQuery({
  queryKey: ['mfg-delivery-orders', 'so-convert-header', docNo],
  enabled: !!docNo,
  queryFn: () => authedFetch<{ header: SoConvertHeader }>(
    `/delivery-orders-mfg/so-convert-header/${encodeURIComponent(docNo!)}`,
  ).then((r) => r.header),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* Remaining deliverable lines scoped to ONE Sales Order — feeds the SO-linked
   DO Detail "Add Line" picker so it can only add the SO's still-undelivered
   lines (qty capped to remaining), matching the line-level convert picker.
   Disabled when the DO has no parent SO (ad-hoc DO keeps the free add). */
export const useDeliverableSoLinesForDoc = (docNo: string | null) => useQuery({
  queryKey: ['mfg-delivery-orders', 'deliverable-so-lines', docNo],
  enabled: !!docNo,
  queryFn: () => authedFetch<{ lines: DeliverableSoLine[] }>(
    `/delivery-orders-mfg/deliverable-so-lines?docNos=${encodeURIComponent(docNo!)}`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── SO → DO conversion source (Create-DO prefill) ────────────────────────
   The header fields a Delivery Order copies off its source Sales Order.

   WHY NOT useMfgSalesOrderDetail, which this page used to call. That endpoint
   (GET /mfg-sales-orders/:docNo) is wrapped in scopeToCompany. A MIRRORED SO
   carries company_id = 2 ("2990-" doc prefix, stamped by so-mirror.ts), so read
   while the active company is HOUZS it answers 404 — and the prefill effect bailed
   on `!so` with no error path, leaving EVERY header field blank while the
   "Converted from <doc>" badge and the document-flow strip, both derived from the
   ?fromSo= query STRING rather than from this fetch, kept rendering the linkage.
   Blank document, perfect linkage. That was the bug.

   /so-source/:docNo is the converter's OWN read: same columns, same mapping and
   the same cross-company reach as POST /from-sos, which has always loaded the
   source SO this way ("a 2990 SO may be converted while browsing as Houzs").
   `missing` names the fields the SOURCE genuinely lacks, so the form can say so
   instead of showing an empty box that looks like a fresh document. */
export type SoConversionSource = {
  soDocNo: string | null;
  companyId: number | null;
  debtorCode: string | null;
  customerName: string | null;
  customerSoRef: string | null;
  phone: string | null;
  email: string | null;
  customerType: string | null;
  salesperson: string | null;
  salespersonId: string | null;
  agent: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  customerState: string | null;
  postcode: string | null;
  customerCountry: string | null;
  salesLocation: string | null;
  buildingType: string | null;
  branding: string | null;
  venue: string | null;
  venueId: string | null;
  customerDeliveryDate: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelationship: string | null;
  currency: string;
};

export const useSoConversionSource = (docNo: string | null) => useQuery({
  queryKey: ['mfg-delivery-orders', 'so-source', docNo],
  enabled: !!docNo,
  queryFn: () => authedFetch<{ source: SoConversionSource; missing: string[] }>(
    `/delivery-orders-mfg/so-source/${encodeURIComponent(docNo!)}`,
  ),
  staleTime: 30_000,
  retry: 1,
});

/* ── DO (mfg) ─────────────────────────────────────────────────────────── */

/* Any DO write that changes a delivered qty (create / cancel / add-line /
   qty-change / delete-line) moves the SO line's live remaining-to-deliver. The
   SO list's "still has undelivered" flag (which shows/hides the Issue-DO menu)
   and the SO-scoped convert pickers read off that number, so they must refetch
   too — otherwise a released qty looks stuck and the menu stays hidden until a
   hard refresh. Mirrors the explicit refetch useConvertSoLinesToDo already does. */
const releaseSoSideQueries = (qc: ReturnType<typeof useQueryClient>) => {
  // Both list keys: the "still has undelivered" flag above lives on the V2 paged
  // list, which is a sibling key of ['mfg-sales-orders'], not nested under it.
  invalidateSoLists(qc);
  qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail'] });
  qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', 'deliverable-so-lines'], refetchType: 'all' });
};

export const useMfgDeliveryOrders = (status?: string) => useQuery({
  queryKey: ['mfg-delivery-orders', status ?? 'all'],
  queryFn: () => authedFetch<{ deliveryOrders: any[] }>(`/delivery-orders-mfg${status ? `?status=${status}` : ''}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

// Opt-in server-side pagination + search + sort + status-counts (mirrors
// useMfgSalesOrdersPaged). Sending `page` switches the /delivery-orders-mfg
// endpoint into its paginated contract ({ deliveryOrders, total, page,
// pageSize, statusCounts }); the legacy useMfgDeliveryOrders above (no page)
// still returns the historical unpaginated list.
// `status` here is the RESOLVED delivery_orders.status DB value (UPPERCASE) —
// the caller maps its compressed filter-pill bucket to a DB status first, and
// passes undefined for multi-status buckets the single-status filter can't
// express (open/in_transit/delivered), so those show all rows still counted.
export function useMfgDeliveryOrdersPaged(params: { page: number; pageSize: number; status?: string; q?: string; sort?: string }) {
  const { page, pageSize, status, q, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status) usp.set('status', status);
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery({
    queryKey: ['mfg-delivery-orders-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    queryFn: ({ signal }) => authedFetch<{ deliveryOrders: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; open: number; in_transit: number; delivered: number; cancelled: number } }>(`/delivery-orders-mfg?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

export const useMfgDeliveryOrderDetail = (id: string | null) => useQuery({
  queryKey: ['mfg-delivery-order-detail', id],
  queryFn: () => authedFetch<{ deliveryOrder: any; items: any[] }>(`/delivery-orders-mfg/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a DO field. Pass one per DO intent (see
   lib/idempotency.ts): the middleware then replays the first response — the SAME
   doNumber — instead of raising a second DO that ships the goods twice.
   Omitting it is exactly today's behaviour (the middleware no-ops).

   Mirrors useAddDeliveryOrderPayment 130 lines below, which has been idempotent
   since #657 while the DO the payment hangs off was not — the split this PR
   closes. A duplicate DO is not just a duplicate row: it decrements stock again
   and carries into SI. */
export const useCreateMfgDeliveryOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; doNumber: string }>(
        `/delivery-orders-mfg`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

/* PROOF OF DELIVERY, as the status write's own payload.

   This type is the fix for a divergence that looked like four careless call
   sites and was actually ONE missing parameter. A delivery order can be closed
   from five screens; until 2026-08-21 exactly one of them — the driver's POD
   screen — attached the customer's signature and the GPS fix, and it did so by
   BYPASSING this hook with a raw authedFetch, because the hook was declared
   `{ id, status }` and posted `JSON.stringify({ status })`. Evidence could not
   travel through it. So the bypass was not sloppiness; it was the only way to
   send a signature at all, and every screen that used the hook properly filed
   a delivery with no customer-side proof and said nothing about it.

   Widening the type is therefore the whole repair. A second bypass would have
   made three implementations of one PATCH — the duplication class this repo
   keeps closing — so the capability moves INTO the shared home instead.

   Every field is OPTIONAL and absent means absent. The backend writes each
   column only `if present` (delivery-orders-mfg.ts, patchDeliveryOrderStatusHandler),
   precisely so a plain status change never blanks a POD already on the row;
   sending `''` or `null` here would defeat that guard from the client side.
   `JSON.stringify` drops `undefined`, so a partially-captured POD serialises to
   exactly the fields that were captured.

   NOT a validation surface. Range-checking lives on the server, which
   deliberately DROPS an out-of-range fix rather than refusing the write — "a
   bad sensor reading must never be the reason a driver cannot close a
   delivery". The client must not be stricter than that. */
export type DoDeliveryEvidence = {
  /** Customer signature, base64 PNG data URL → `delivery_orders.signature_data`. */
  signatureData?: string;
  /** R2 key of the delivery photo → `delivery_orders.pod_r2_key`. */
  podKey?: string;
  /** Where it was signed (mig 0249). Written server-side as a PAIR or not at all. */
  podLat?: number;
  podLng?: number;
  /** Radius in metres — what tells a street GPS fix from an indoor wifi guess. */
  podAccuracyM?: number;
  /** The READING's own time, which can be minutes older than `delivered_at`. */
  podLocatedAt?: string;
};

export const useUpdateMfgDeliveryOrderStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, evidence }: { id: string; status: string; evidence?: DoDeliveryEvidence }) =>
      authedFetch(`/delivery-orders-mfg/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status, ...(evidence ?? {}) }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      /* A status advance into a shipped state deducts inventory — refresh
         the inventory queries so the on-hand drilldown reflects the OUT. */
      qc.invalidateQueries({ queryKey: ['inventory'] });
      /* CANCEL releases the delivered qty back to the SO. */
      releaseSoSideQueries(qc);
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/* DO REVERT — the Ops-lead exception power (undo a wrong scan / accidental
   dispatch). POSTs to the dedicated revert route, NOT the status PATCH (which
   refuses a shipped→pre-ship move). The server enforces the capability, the legal
   transitions, the downstream lock and the inventory reversal; this hook just
   invalidates the same queries a status change does — a revert to DRAFT restores
   stock and releases the SO. */
export const useRevertMfgDeliveryOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, toStatus, reason }: { id: string; toStatus: 'LOADED' | 'DRAFT'; reason: string }) =>
      authedFetch(`/delivery-orders-mfg/${id}/revert`, {
        method: 'POST', body: JSON.stringify({ toStatus, reason }),
      }),
    onSuccess: (_, vars) => {
      // void — same fire-and-forget invalidation the sibling status hook does;
      // marked so this new hook adds no floating promise to the file's ratchet.
      void qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      void qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      releaseSoSideQueries(qc);
    },
    onError: (err) => {
      void serviceNotify({ title: 'Revert failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/* DO header PATCH — editable SO-style fields (debtor / salesperson / address /
   dates / driver / emergency contact / venue). Mirrors
   useUpdateMfgSalesOrderHeader. */
export const useUpdateMfgDeliveryOrderHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/delivery-orders-mfg/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
    },
  });
};

/* DO line-item CRUD — mirrors the SO item hooks. Each mutation recomputes the
   DO totals server-side, so we invalidate both the detail + list. */
export const useAddMfgDeliveryOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/delivery-orders-mfg/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

export const useUpdateMfgDeliveryOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/delivery-orders-mfg/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

export const useDeleteMfgDeliveryOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/delivery-orders-mfg/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders'] });
      releaseSoSideQueries(qc);
    },
  });
};

/* DO payments ledger — mirror of the SO payments hooks. The DO Create + Detail
   screens render the same Houzs PaymentsTable; these hooks back the persisted
   (Detail) path. */
export type DoPayment = {
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

export const useDeliveryOrderPayments = (id: string | null) => useQuery({
  queryKey: ['mfg-delivery-orders', id, 'payments'],
  queryFn: () => authedFetch<{ payments: DoPayment[] }>(`/delivery-orders-mfg/${id}/payments`).then((r) => r.payments),
  enabled: Boolean(id),
  staleTime: 2 * 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* `idempotencyKey` — optional, destructured OUT of the body. See
   useAddSalesOrderPayment / lib/idempotency.ts for the one-key-per-intent rule. */
export const useAddDeliveryOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey, ...body }: { id: string; idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ payment: DoPayment }>(`/delivery-orders-mfg/${id}/payments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
    },
    onError: writeFailedAs('Payment not recorded'),
  });
};

export const useDeleteDeliveryOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paymentId }: { id: string; paymentId: string }) =>
      authedFetch<{ ok: boolean }>(`/delivery-orders-mfg/${id}/payments/${paymentId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['mfg-delivery-orders', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['mfg-delivery-order-detail', vars.id] });
    },
    onError: writeFailedAs('Payment not deleted'),
  });
};
