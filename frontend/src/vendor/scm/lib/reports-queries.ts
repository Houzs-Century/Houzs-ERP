
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';


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
  unit_price_sen: number;
  discount_sen: number;
  total_sen: number;
  tax_sen: number;
  total_inc_sen: number;
  balance_sen: number;
  cancelled: boolean;
  currency: string;
  status: string | null;
  local_total_sen: number;
  remark4: string | null;
  remark2: string | null;
  remark3: string | null;
  sales_exemption_expiry: string | null;
  customer_delivery_date: string | null;
  paid_total_sen: number;
  customer_state: string | null;
  customer_country: string | null;
  unit_cost_sen: number;
  line_cost_sen: number;
  line_margin_sen: number;
  fabric: string | null;
  divan_height: number | string | null;
  leg_height: number | string | null;
  custom_specials: unknown;
  last_payment_at: string | null;
  account_sheet: string | null;
  approval_code: string | null;
  collected_by: string | null;
  ref?: string | null;
  customer_so_no?: string | null;
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
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
};


export type DetailListingFilters = {
  dateFrom?: string;
  dateTo?: string;
  docNo?: string;
  debtorCode?: string;
  itemCode?: string;
};

export type DetailListingRow = Record<string, unknown> & {
  id: string;
  doc_no: string;
  line_date: string | null;
  debtor_code?: string | null;
  debtor_name?: string | null;
  item_code: string;
  description?: string | null;
  qty?: number;
  unit_price_sen?: number;
  total_sen?: number;
  balance_sen?: number;
  status?: string | null;
  so_ref?: string | null;
  so_customer_so_no?: string | null;
  ref?: string | null;
  customer_so_no?: string | null;
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
