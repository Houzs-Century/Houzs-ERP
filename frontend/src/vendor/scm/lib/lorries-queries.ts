// Vendored from apps/backend/src/lib/lorries-queries.ts — Lorries CRUD hooks.
// TMS fleet master (scm.lorries). is_internal is the In-house / Outsource
// marker; the list hook accepts a fleet filter (all / internal / outsourced).
//
// HOUZS VENDOR NOTE: the source has no `import { supabase } from './supabase'`
// to drop (it only imports authedFetch + react-query). Everything else is
// copied verbatim from 2990.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch, API_URL, humanApiError } from './authed-fetch';
// See authed-fetch.ts's import note: the token may be in sessionStorage, so the
// read must come from the shared accessor, never an inlined localStorage hit.
import { readAuthToken } from '../../../lib/authToken';
import { companyHeader } from '../../../lib/activeCompany';
import { prepareImageForUpload } from '../../../lib/imagePipeline';
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromResponse,
} from '../../../lib/requestCorrelation';

// Matches the lorry_type enum in migration 0195 / Houzs scm 0053.
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
  // Migration 0195 — true = in-house fleet, false = outsourced.
  //
  // The camel twins below are DEAD and kept only because every vendored SCM
  // consumer still dual-reads them. The claim that used to sit here ("the pg
  // driver camelCases result cols") is HOOKKA's rule and is false for Houzs:
  // pg.ts:5-10 deliberately does not install that transform, and these rows
  // never touch the pg driver anyway — they come from PostgREST over
  // /api/scm/lorries, which returns exactly the snake_case names in the route's
  // COLS. Only the snake half ever resolves. Do not restore the claim.
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
  // ── Migration 0121: purchase record + compliance expiries ─────────────────
  // NOT a revival of the old public.lorries columns (mig 0015) — that table was
  // dropped by mig 0055. These are new columns on scm.lorries.
  model?: string | null;
  purchase_date?: string | null;
  purchase_price_centi?: number | null;
  purchase_invoice_key?: string | null;
  purchase_invoice_name?: string | null;
  purchase_invoice_mime?: string | null;
  purchase_invoice_size?: number | null;
  /** YYYY-MM-DD, as printed on the document. Renews yearly. */
  road_tax_expiry?: string | null;
  /** YYYY-MM-DD, as printed on the cover note. Renews yearly. */
  insurance_expiry?: string | null;
  /** YYYY-MM-DD. Commercial goods vehicles: every 6 months. */
  puspakom_expiry?: string | null;
  // ── Fleet A1 (mig 0205): per-lorry delivery capacity ceilings ─────────────
  // NULL max_* => the auto-propose packer uses its config default (10 sets /
  // RM30k). capacity_layer picks which ceiling(s) bind on a lorry-day.
  max_sets?: number | null;
  max_revenue_centi?: number | null;
  capacity_layer?: CapacityLayer | null;
  // ── WS3 (mig 0209): cargo-box dimensions (ft). capacity_m3 is derived from
  // these when all three are set. NUMERIC comes back from PostgREST as a string.
  length_ft?: number | string | null;
  width_ft?: number | string | null;
  height_ft?: number | string | null;
  // ── WS4a (mig 0210): the 3PL carrier company this lorry belongs to (NULL = own
  // fleet / not attached).
  threepl_company_id?: string | null;
  threeplCompanyId?: string | null;
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
  capacityM3?: number | null;
  capacityKg?: number | null;
  notes?: string;
  active?: boolean;
  model?: string | null;
  purchaseDate?: string | null;
  purchasePriceCenti?: number | null;
  roadTaxExpiry?: string | null;
  insuranceExpiry?: string | null;
  puspakomExpiry?: string | null;
  maxSets?: number | null;
  maxRevenueCenti?: number | null;
  capacityLayer?: CapacityLayer;
  // WS3: box dimensions (ft). Sending all three re-derives capacity_m3 server-side.
  lengthFt?: number | null;
  widthFt?: number | null;
  heightFt?: number | null;
  // WS4a: the 3PL carrier company this lorry belongs to (null = own fleet).
  threeplCompanyId?: string | null;
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lorries'] }),
  });
}

// ── Service / repair records (migration 0121) ────────────────────────────────
// HOUZS-AUTHORED, not vendored from 2990 — 2990 has no equivalent. Kept in this
// file rather than a new one because it is the same master's detail and every
// consumer already imports from here.

export type LorryServiceRecord = {
  id: string;
  lorry_id: string;
  service_date: string;
  description: string;
  workshop: string | null;
  cost_centi: number;
  /** Odometer AT THE TIME OF SERVICE. The only mileage source in the system —
   *  see vendor/shared/lorry-compliance.ts before deriving anything from it. */
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
  costCenti?: number | null;
  odometerKm?: number | null;
  nextServiceDate?: string | null;
  nextServiceKm?: number | null;
  notes?: string | null;
};

export function useLorryServiceRecords(lorryId: string | null) {
  return useQuery({
    queryKey: ['lorry-service-records', lorryId],
    // OFF, not hide: with no lorry selected the detail is not open, so the
    // query must not fire at all rather than fetch and discard.
    enabled: !!lorryId,
    queryFn: () =>
      authedFetch<{ records: LorryServiceRecord[] }>(
        `/lorry-service-records?lorryId=${encodeURIComponent(lorryId!)}`,
      ).then((r) => r.records),
    staleTime: 60_000,
  });
}

export function useCreateLorryServiceRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewLorryServiceRecord) =>
      authedFetch<{ record: LorryServiceRecord }>(`/lorry-service-records`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['lorry-service-records', v.lorryId] }),
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
  /* Surfaces through the caller's `err.message` — a sentence, not the marker
     `not_authenticated` (same fix as authed-fetch / slip). */
  if (!token) throw new Error('Your session has expired — please sign in again.');
  // Correlated transport (main); the inline localStorage re-read of
  // 'houzs.activeCompanyId' is gone — companyHeader() below is the one accessor.
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
      /* WO-7 — workshop invoices are usually phone photos; compress before
         upload (PDFs pass through untouched). Viewed one-at-a-time, so no
         thumbnail. */
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
