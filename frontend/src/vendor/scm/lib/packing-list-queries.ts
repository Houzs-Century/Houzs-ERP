
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type PackingItem = {
  line_no: number;
  item_code: string;
  description: string | null;
  qty: number;
  rack: string | null;
  rack_locked: boolean;
  po: string | null;
  po_locked: boolean;
  worked_out: boolean;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  description2: string | null;
  so_line_no: number | null;
};

export type PackingStop = {
  stop_no: number;
  stop_type: string | null;
  customer_name: string | null;
  address: string | null;
  do_id: string | null;
  do_number: string | null;
  do_status: string | null;
  do_missing: boolean;
  so_doc_no: string | null;
  phone: string | null;
  time_range: string | null;
  units: number;
  items: PackingItem[];
};

export type PackingListRow = {
  trip_id: string;
  trip_no: string | null;
  trip_date: string | null;
  trip_status: string | null;
  lorry_plate: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  helper_1_name: string | null;
  helper_2_name: string | null;
  warehouse_name: string | null;
  stop_count: number;
  do_count: number;
  units: number;
  m3_milli: number | null;
  stops: PackingStop[];
  source: 'trip' | 'crew';
};

export type PackingListsResponse = {
  date: string;
  lists: PackingListRow[];
};

/** The request path, exported so it can be asserted without a React tree. */
export function packingListsPath(date: string, warehouseId: string | null): string {
  const p = new URLSearchParams();
  p.set('date', date);
  if (warehouseId) p.set('warehouseId', warehouseId);
  return `/trips/packing?${p.toString()}`;
}

/** One day's packing lists. Disabled until a date is set, like useFleetDay. */
export function usePackingLists(opts: { date: string | null; warehouseId?: string | null }) {
  const { date, warehouseId } = opts;
  return useQuery({
    queryKey: ['packing-lists', date ?? '', warehouseId ?? ''],
    queryFn: () => authedFetch<PackingListsResponse>(packingListsPath(date as string, warehouseId ?? null)),
    enabled: !!date,
    staleTime: 30_000,
  });
}

export type PackingRegionDo = {
  do_id: string;
  do_number: string | null;
  do_status: string | null;
  so_doc_no: string | null;
  customer_name: string | null;
  address: string | null;
  phone: string | null;
  time_range: string | null;
  debtor_code: string | null;
  m3_milli: number | null;
  lorry_plate: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  helper_1_name: string | null;
  helper_2_name: string | null;
  trip_no: string | null;
  trip_stop_no: number | null;
  state: string | null;
  country: string | null;
  units: number;
  items: PackingItem[];
};

export type PackingRegionRow = {
  region: string;
  label: string;
  do_count: number;
  customer_count: number;
  units: number;
  lorry_plates: string[];
  not_arranged: number;
  dos: PackingRegionDo[];
};

export type PackingRegionsResponse = {
  date: string;
  unassigned_only: boolean;
  regions: PackingRegionRow[];
};

export function packingRegionsPath(date: string, unassignedOnly: boolean): string {
  const p = new URLSearchParams();
  p.set('date', date);
  p.set('unassignedOnly', unassignedOnly ? '1' : '0');
  return `/trips/packing-regions?${p.toString()}`;
}

/** One day's DOs by Delivery Planning region, lorry or not. */
export function usePackingRegions(opts: { date: string | null; unassignedOnly: boolean; enabled: boolean }) {
  const { date, unassignedOnly, enabled } = opts;
  return useQuery({
    queryKey: ['packing-regions', date ?? '', unassignedOnly],
    queryFn: () => authedFetch<PackingRegionsResponse>(packingRegionsPath(date as string, unassignedOnly)),
    enabled: enabled && !!date,
    staleTime: 30_000,
  });
}

/** The most delivery orders one packing list QR covers (backend LORRY_DAY_MAX_DOS). */
export const PACKING_QR_MAX_DOS = 60;

/** One lorry's or region's packing list scan times for a day (owner 2026-11-28):
 *  prepared = first scan of the sheet QR, loaded = second scan. */
export type PackingScanStatus = {
  kind: 'lorry' | 'region';
  key: string;
  prepared_at: string | null;
  loaded_at: string | null;
  parts_total: number;
  parts_prepared: number;
  parts_loaded: number;
};

/** "1 of 2 parts" while a sheet printed in parts is only partly scanned, else null.
 *  Before any part is scanned, `expectedParts` (from the DO count) says how many there are. */
export function scanPartsLine(
  times: PackingScanStatus | null,
  what: 'prepared' | 'loaded',
  expectedParts: number,
): string | null {
  const total = times?.parts_total ?? expectedParts;
  if (total <= 1) return null;
  const done = (what === 'loaded' ? times?.parts_loaded : times?.parts_prepared) ?? 0;
  return `${done} of ${total} parts`;
}

export type PackingScanStatusResponse = { date: string; sheets: PackingScanStatus[] };

export function packingScanStatusPath(date: string): string {
  return `/trips/packing-scan-status?${new URLSearchParams({ date }).toString()}`;
}

/** The day's scan times, polled every 30 s so a scan at the lorry shows in the office. */
export function usePackingScanStatus(date: string | null) {
  return useQuery({
    queryKey: ['packing-scan-status', date ?? ''],
    queryFn: () => authedFetch<PackingScanStatusResponse>(packingScanStatusPath(date as string)),
    enabled: !!date,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/** The server's plate key: letters and digits only, uppercased (backend plate-normalize.ts). */
export function packingPlateKey(plate: string | null | undefined): string {
  return String(plate ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** The scan times for one lorry (by plate) or one region (by region key), or null. */
export function packingScanTimesFor(
  sheets: readonly PackingScanStatus[] | undefined,
  kind: 'lorry' | 'region',
  key: string | null,
): PackingScanStatus | null {
  const want = kind === 'lorry' ? packingPlateKey(key) : String(key ?? '').trim();
  if (!want || !sheets) return null;
  return sheets.find((s) => s.kind === kind && s.key === want) ?? null;
}
