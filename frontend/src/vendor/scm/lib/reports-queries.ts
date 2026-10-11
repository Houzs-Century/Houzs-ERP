// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — ONLY the four
// AutoCount-style Detail Listing reads (SO / DO / SI / DR) that the vendored
// report pages render. Copied verbatim from the source's "Reports (PR-H)"
// block; the only change is the import of the vendored authedFetch
// (→ /api/scm/reports/...) instead of 2990's.
//
// The DO/SI/DR hooks share one DetailListingFilters shape + one qs builder;
// the SO hook has its own richer filter/row types (cost + margin + variant +
// payment-ledger columns the listing surfaces).

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

/* ════════════════════════════════════════════════════════════════════════
   Reports (PR-H) — AutoCount-style reporting endpoints
   ════════════════════════════════════════════════════════════════════════ */

export type SoDetailListingFilters = {
  dateFrom?: string;
  dateTo?: string;
  docNo?: string;
  debtorCode?: string;
  itemCode?: string;
  deliveryDateFrom?: string;
  deliveryDateTo?: string;
  groupBy?: 'none' | 'branding' | 'agent' | 'debtor' | 'item_group';
  sortBy?: 'date' | 'doc_no' | 'item_code';
};

export type SoDetailListingRow = Record<string, unknown> & {
  id: string;
  doc_no: string;
  line_date: string | null;
  so_date: string | null;
  debtor_code: string | null;
  debtor_name: string | null;
  agent: string | null;
  branding: string | null;
  item_group: string;
  item_code: string;
  description: string | null;
  description2: string | null;
  uom: string;
  location: string | null;
  qty: number;
  unit_price_centi: number;
  discount_centi: number;
  total_centi: number;
  tax_centi: number;
  total_inc_centi: number;
  balance_centi: number;
  cancelled: boolean;
  currency: string;
  status: string | null;
  local_total_centi: number;
  remark4: string | null;
  remark2: string | null;
  remark3: string | null;
  sales_exemption_expiry: string | null;
  customer_delivery_date: string | null;
  /** Live paid total summed from mfg_sales_order_payments (replaces legacy paid_centi). */
  paid_total_centi: number;
  /* Task #121 — country snapshot, auto-derived from customer_state via
     my_localities at SO create/PATCH time (migration 0082). */
  customer_state: string | null;
  customer_country: string | null;
  /* Task #114 — per-line cost snapshot (from mfg_products.cost_price_sen
     server-side) + derived line cost + margin. Used by the listing
     report's cost columns + 6-tile KPI bar. */
  unit_cost_centi: number;
  line_cost_centi: number;
  line_margin_centi: number;
  /* Task #63 — Houzs port gap closure. Line-level variant + payment-ledger
     fields surfaced by the API so the Detail Listing's Fabric / Divan
     Height / Leg Height / Specials / Account Sheet / Approval Code / Last
     Payment / Collected By columns render typed data (no `r as Record<>`
     hack). custom_specials is a jsonb array — element shape varies
     (string | { label } | { description }) so the type stays loose. */
  fabric: string | null;
  /* SO-SKU spec P5 — heights now also extract from line variants; values can
     be non-numeric picks ('No Leg'), so the server passes number when
     parseable, else the raw string. */
  divan_height: number | string | null;
  leg_height: number | string | null;
  custom_specials: unknown;
  last_payment_at: string | null;
  account_sheet: string | null;
  approval_code: string | null;
  collected_by: string | null;
};

export const useSalesOrderDetailListing = (filters: SoDetailListingFilters) => {
  const params = new URLSearchParams();
  if (filters.dateFrom)         params.set('dateFrom',         filters.dateFrom);
  if (filters.dateTo)           params.set('dateTo',           filters.dateTo);
  if (filters.docNo)            params.set('docNo',            filters.docNo);
  if (filters.debtorCode)       params.set('debtorCode',       filters.debtorCode);
  if (filters.itemCode)         params.set('itemCode',         filters.itemCode);
  if (filters.deliveryDateFrom) params.set('deliveryDateFrom', filters.deliveryDateFrom);
  if (filters.deliveryDateTo)   params.set('deliveryDateTo',   filters.deliveryDateTo);
  if (filters.groupBy)          params.set('groupBy',          filters.groupBy);
  if (filters.sortBy)           params.set('sortBy',           filters.sortBy);
  const qs = params.toString();
  return useQuery({
    queryKey: ['reports', 'sales-order-detail-listing', qs],
    queryFn: () => authedFetch<{ rows: SoDetailListingRow[] }>(
      `/reports/sales-order-detail-listing${qs ? `?${qs}` : ''}`,
    ),
    placeholderData: (prev) => prev,  // TanStack v5 equivalent of keepPreviousData
    staleTime: 30_000,
  });
};

/* ── Task #120 — L2 Detail Listings for DO / SI / DR ────
   Mirrors the SO Detail Listing pattern (one row per line item, header
   denormalised onto each row). Server-side endpoints in
   apps/api/src/routes/reports.ts. */

export type DetailListingFilters = {
  dateFrom?: string;
  dateTo?: string;
  docNo?: string;
  debtorCode?: string;
  itemCode?: string;
};

/* Each module emits a Record<string, unknown> — the column accessor reads
   fields by name. Common fields produced by the server flatten step are
   typed here; module-specific fields stay loose for column accessors. */
export type DetailListingRow = Record<string, unknown> & {
  id: string;
  doc_no: string;
  line_date: string | null;
  debtor_code?: string | null;
  debtor_name?: string | null;
  item_code: string;
  description?: string | null;
  qty?: number;
  unit_price_centi?: number;
  total_centi?: number;
  balance_centi?: number;
  status?: string | null;
};

const buildDetailListingQs = (filters: DetailListingFilters): string => {
  const params = new URLSearchParams();
  if (filters.dateFrom)   params.set('dateFrom',   filters.dateFrom);
  if (filters.dateTo)     params.set('dateTo',     filters.dateTo);
  if (filters.docNo)      params.set('docNo',      filters.docNo);
  if (filters.debtorCode) params.set('debtorCode', filters.debtorCode);
  if (filters.itemCode)   params.set('itemCode',   filters.itemCode);
  return params.toString();
};

export const useDeliveryOrderDetailListing = (filters: DetailListingFilters) => {
  const qs = buildDetailListingQs(filters);
  return useQuery({
    queryKey: ['reports', 'delivery-order-detail-listing', qs],
    queryFn: () => authedFetch<{ rows: DetailListingRow[] }>(
      `/reports/delivery-order-detail-listing${qs ? `?${qs}` : ''}`,
    ),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
};

export const useSalesInvoiceDetailListing = (filters: DetailListingFilters) => {
  const qs = buildDetailListingQs(filters);
  return useQuery({
    queryKey: ['reports', 'sales-invoice-detail-listing', qs],
    queryFn: () => authedFetch<{ rows: DetailListingRow[] }>(
      `/reports/sales-invoice-detail-listing${qs ? `?${qs}` : ''}`,
    ),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
};

export const useDeliveryReturnDetailListing = (filters: DetailListingFilters) => {
  const qs = buildDetailListingQs(filters);
  return useQuery({
    queryKey: ['reports', 'delivery-return-detail-listing', qs],
    queryFn: () => authedFetch<{ rows: DetailListingRow[] }>(
      `/reports/delivery-return-detail-listing${qs ? `?${qs}` : ''}`,
    ),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
};
