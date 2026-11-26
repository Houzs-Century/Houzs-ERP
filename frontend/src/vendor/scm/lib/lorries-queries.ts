
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch, API_URL, humanApiError } from './authed-fetch';
import { readAuthToken } from '../../../lib/authToken';
import { companyHeader } from '../../../lib/activeCompany';
import { prepareImageForUpload } from '../../../lib/imagePipeline';
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromResponse,
} from '../../../lib/requestCorrelation';
import { writeFailed } from './mutation-error';

export const LORRY_TYPES = [
  'LORRY_10FT', 'LORRY_14FT', 'LORRY_17FT', 'LORRY_21FT', 'VAN', 'OUTSOURCE', 'OTHER',
] as const;
export type LorryType = (typeof LORRY_TYPES)[number];

export const LORRY_TYPE_LABEL: Record<LorryType, string> = {
  LORRY_10FT: '10ft Lorry',
  LORRY_14FT: '14ft Lorry',
  LORRY_17FT: '17ft Lorry',
  LORRY_21FT: '21ft Lorry',
  VAN: 'Van',
  OUTSOURCE: 'Outsource',
  OTHER: 'Other',
};

export type LorryRow = {
  id: string;
  plate: string;
  type: LorryType;
  is_internal?: boolean;
  isInternal?: boolean;
  warehouse_id?: string | null;
  warehouseId?: string | null;
  capacity_m3?: number | string | null;
  capacityM3?: number | string | null;
  capacity_kg?: number | string | null;
  capacityKg?: number | string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  model?: string | null;
  purchase_date?: string | null;
  purchase_price_sen?: number | null;
  cost_per_km_sen?: number | null;
  purchase_invoice_key?: string | null;
  purchase_invoice_name?: string | null;
  purchase_invoice_mime?: string | null;
  purchase_invoice_size?: number | null;
  road_tax_expiry?: string | null;
  insurance_expiry?: string | null;
  puspakom_expiry?: string | null;
  max_sets?: number | null;
  max_revenue_sen?: number | null;
  capacity_layer?: CapacityLayer | null;
  length_ft?: number | string | null;
  width_ft?: number | string | null;
  height_ft?: number | string | null;
  threepl_company_id?: string | null;
  threeplCompanyId?: string | null;
  warehouse_ids?: string[] | null;
  usual_driver_id?: string | null;
  usual_helper_id?: string | null;
};

export const CAPACITY_LAYERS = ['SETS', 'REVENUE', 'BOTH'] as const;
export type CapacityLayer = (typeof CAPACITY_LAYERS)[number];
export const CAPACITY_LAYER_LABEL: Record<CapacityLayer, string> = {
  SETS: 'Sets only',
  REVENUE: 'Revenue only',
  BOTH: 'Sets + Revenue',
};

export type NewLorry = {
  plate: string;
  type: LorryType;
  isInternal?: boolean;
  warehouseId?: string | null;
  warehouseIds?: string[];
  capacityM3?: number | null;
  capacityKg?: number | null;
  notes?: string;
  active?: boolean;
  model?: string | null;
  purchaseDate?: string | null;
  manufactureDate?: string | null;
  registrationDate?: string | null;
  inServiceDate?: string | null;
  purchasePriceSen?: number | null;
  costPerKmSen?: number | null;
  roadTaxExpiry?: string | null;
  insuranceExpiry?: string | null;
  puspakomExpiry?: string | null;
  maxSets?: number | null;
  maxRevenueSen?: number | null;
  capacityLayer?: CapacityLayer;
  lengthFt?: number | null;
  widthFt?: number | null;
  heightFt?: number | null;
  threeplCompanyId?: string | null;
  homeWarehouseId?: string | null;
  usualDriverId?: string | null;
  usualHelperId?: string | null;
};

export type FleetFilter = 'all' | 'internal' | 'outsourced';

export function useLorries(opts?: { includeInactive?: boolean; fleet?: FleetFilter }) {
  const fleet = opts?.fleet ?? 'all';
  return useQuery({
    queryKey: ['lorries', opts?.includeInactive ?? false, fleet],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.includeInactive) params.set('active', 'false');
      if (fleet !== 'all') params.set('fleet', fleet);
      const qs = params.toString();
      return authedFetch<{ lorries: LorryRow[] }>(
        `/lorries${qs ? `?${qs}` : ''}`,
      ).then((r) => r.lorries);
    },
    staleTime: 60_000,
  });
}

export function useCreateLorry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewLorry) =>
      authedFetch<{ lorry: LorryRow }>(`/lorries`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorries'] }),
  });
}

export function useUpdateLorry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<NewLorry> & { id: string }) =>
      authedFetch<{ lorry: LorryRow }>(`/lorries/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['lorries'] }), qc.invalidateQueries({ queryKey: ['lorry-capacity'] })]),
  });
}


export type LorryServiceRecord = {
  id: string;
  lorry_id: string;
  service_date: string;
  description: string;
  workshop: string | null;
  cost_sen: number;
  odometer_km: number | null;
  invoice_key: string | null;
  invoice_name: string | null;
  invoice_mime: string | null;
  invoice_size: number | null;
  next_service_date: string | null;
  next_service_km: number | null;
  notes: string | null;
  created_at: string;
  created_by: number | null;
};

export type NewLorryServiceRecord = {
  lorryId: string;
  serviceDate: string;
  description: string;
  workshop?: string | null;
  costSen?: number | null;
  odometerKm?: number | null;
  nextServiceDate?: string | null;
  nextServiceKm?: number | null;
  notes?: string | null;
};

/** Delete a lorry that never worked; the server refuses one with history (409). */
export function useDeleteLorry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true }>(`/lorries/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorries'] }),
  });
}

export type NewServiceRecord = { serviceDate: string; description: string; workshop: string | null; costSen: number; odometerKm: number | null; nextServiceDate: string | null; nextServiceKm: number | null; notes: string | null };

export function useCreateLorryServiceRecord(lorryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewServiceRecord) =>
      authedFetch<{ record: LorryServiceRecord }>(`/lorry-service-records`, { method: 'POST', body: JSON.stringify({ lorryId, ...body }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorry-service-records', lorryId] }),
  });
}

export function useLorryServiceRecords(lorryId: string | null) {
  return useQuery({
    queryKey: ['lorry-service-records', lorryId],
    enabled: !!lorryId,
    queryFn: () =>
      authedFetch<{ records: LorryServiceRecord[] }>(
        `/lorry-service-records?lorryId=${encodeURIComponent(lorryId!)}`,
      ).then((r) => r.records),
    staleTime: 60_000,
  });
}

export function useUpdateLorryServiceRecord(lorryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<Omit<NewLorryServiceRecord, 'lorryId'>> & { id: string }) =>
      authedFetch<{ record: LorryServiceRecord }>(`/lorry-service-records/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorry-service-records', lorryId] }),
    onError: writeFailed,
  });
}

export function useDeleteLorryServiceRecord(lorryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/lorry-service-records/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorry-service-records', lorryId] }),
  });
}

/** The record's invoice as a blob object URL, for `window.open` / `<a href>`.
 *
 *  A correlated raw-body fetch rather than authedFetch: that helper JSON-parses its response
 *  and this endpoint streams bytes. Mirrors slip.ts's fetchSlipAsObjectUrl —
 *  the established shape for an authed binary in this tree — and reuses
 *  authed-fetch's exported API_URL rather than declaring a fourth copy of it.
 *
 *  The endpoint is behind auth (an invoice is a financial document), which is
 *  why this cannot be a plain <a href> the way the product-photo proxy can.
 *  The object URL is not revoked, matching slip.ts's accepted trade-off for
 *  view-then-navigate callers. */
export async function fetchServiceInvoiceUrl(recordId: string): Promise<{ url: string; contentType: string }> {
  const token = readAuthToken();
  if (!token) throw new Error('Your session has expired — please sign in again.');
  const res = await correlatedFetch(`${API_URL}/lorry-service-records/${encodeURIComponent(recordId)}/invoice`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...companyHeader(),
    },
  });
  if (!res.ok) throw correlateError(
    new Error(humanApiError(res.status, await res.text().catch(() => ''))),
    requestIdFromResponse(res),
  );
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  return consumeCorrelated(res, async () => ({
    url: URL.createObjectURL(await res.blob()),
    contentType,
  }));
}

/** Upload / replace a record's invoice. FormData on purpose: authedFetch only
 *  stamps `content-type: application/json` for string bodies, so the multipart
 *  boundary survives (authed-fetch.ts:161). Do not set content-type here. */
export function useUploadServiceInvoice(lorryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const prepared = await prepareImageForUpload(file, { wantThumb: false });
      const fd = new FormData();
      fd.append('file', prepared.file);
      return authedFetch<{ record: LorryServiceRecord }>(
        `/lorry-service-records/${id}/invoice`, { method: 'PUT', body: fd },
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorry-service-records', lorryId] }),
  });
}

export type LorryPosition = {
  lorry_id: string;
  plate: string;
  lat: number;
  lng: number;
  speed_kmh: number | null;
  heading: number | null;
  ignition: boolean | null;
  street: string | null;
  recorded_at: string;
  received_at: string;
};

export type LorryKmCost = {
  lorry_id: string;
  plate: string;
  km: number;
  cost_per_km_sen: number | null;
  cost_sen: number | null;
};

export function useLorryKmCost() {
  return useQuery({
    queryKey: ['lorries', 'km-cost', 'today'],
    queryFn: () => authedFetch<{ lorries: LorryKmCost[] }>('/lorries/km-cost').then((r) => r.lorries),
    refetchInterval: 5 * 60_000,
  });
}

export function useLorryPositions() {
  return useQuery({
    queryKey: ['lorries', 'positions', 'latest'],
    queryFn: () => authedFetch<{ positions: LorryPosition[] }>('/lorries/positions/latest').then((r) => r.positions),
    refetchInterval: 60_000,
  });
}

export type LorryTrack = {
  date: string;
  km: number;
  fixes: Array<{ lat: number; lng: number; recorded_at: string; speed_kmh: number | null; street: string | null }>;
};

export function useLorryTrack(lorryId: string, date: string) {
  return useQuery({
    queryKey: ['lorries', 'track', lorryId, date],
    queryFn: () => authedFetch<LorryTrack>(`/lorries/${encodeURIComponent(lorryId)}/track?date=${date}`),
    enabled: !!lorryId,
    refetchInterval: 5 * 60_000,
  });
}
