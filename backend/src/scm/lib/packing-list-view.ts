
// @ts-expect-error - plain .mjs, the one stamp rule shared with the DO detail and scripts/stamp-do-shipped-from.mjs
import { stampRackLabel } from '../../../scripts/lib/do-shipped-from.mjs';

export type PackTripRow = {
  id: string;
  trip_no: string | null;
  trip_date: string | null;
  status: string | null;
  lorry_id: string | null;
  driver_id: string | null;
  warehouse_id: string | null;
};

export type PackStopRow = {
  id: string;
  trip_id: string;
  stop_no: number | null;
  stop_type: string | null;
  do_id: string | null;
  customer_name: string | null;
  address: string | null;
};

export type PackDoRow = {
  id: string;
  do_number: string | null;
  status: string | null;
  m3_total_milli: number | null;
};

export type PackItemRow = {
  delivery_order_id: string;
  line_no: number | null;
  item_code: string | null;
  description: string | null;
  qty: number | null;
  rack_id: string | null;
  shipped_from: unknown;
};

/** id -> printable label, for the two masters that only lend a name. */
export type PackLabelRow = { id: string; label: string | null };

export type PackingItem = {
  line_no: number;
  item_code: string;
  description: string | null;
  qty: number;
  rack: string | null;
  rack_locked: boolean;
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
  units: number;
  items: PackingItem[];
};

export type PackingList = {
  trip_id: string;
  trip_no: string | null;
  trip_date: string | null;
  trip_status: string | null;
  lorry_plate: string | null;
  driver_name: string | null;
  warehouse_name: string | null;
  stop_count: number;
  do_count: number;
  units: number;
  m3_milli: number | null;
  stops: PackingStop[];
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const labelMap = (rows: readonly PackLabelRow[]): Map<string, string> => {
  const m = new Map<string, string>();
  for (const r of rows) {
    const label = (r.label ?? '').trim();
    if (r.id && label) m.set(String(r.id), label);
  }
  return m;
};

export type AssembleInput = {
  trips: readonly PackTripRow[];
  stops: readonly PackStopRow[];
  deliveryOrders: readonly PackDoRow[];
  items: readonly PackItemRow[];
  racks: readonly PackLabelRow[];
  lorries: readonly PackLabelRow[];
  drivers: readonly PackLabelRow[];
  warehouses: readonly PackLabelRow[];
};

function packRack(it: PackItemRow, rackById: Map<string, string>): { rack: string | null; rack_locked: boolean } {
  const locked: string | null = stampRackLabel(it.shipped_from, it.item_code ?? null);
  if (locked) return { rack: locked, rack_locked: true };
  return { rack: it.rack_id ? rackById.get(String(it.rack_id)) ?? null : null, rack_locked: false };
}

export function assemblePackingLists(input: AssembleInput): PackingList[] {
  const rackById = labelMap(input.racks);
  const lorryById = labelMap(input.lorries);
  const driverById = labelMap(input.drivers);
  const warehouseById = labelMap(input.warehouses);

  const doById = new Map<string, PackDoRow>();
  for (const d of input.deliveryOrders) if (d.id) doById.set(String(d.id), d);

  const itemsByDo = new Map<string, PackingItem[]>();
  for (const it of input.items) {
    const key = String(it.delivery_order_id ?? '');
    if (!key) continue;
    const arr = itemsByDo.get(key) ?? [];
    arr.push({
      line_no: num(it.line_no) || arr.length + 1,
      item_code: (it.item_code ?? '').trim() || '—',
      description: it.description ?? null,
      qty: num(it.qty),
      ...packRack(it, rackById),
    });
    itemsByDo.set(key, arr);
  }
  for (const arr of itemsByDo.values()) arr.sort((a, b) => a.line_no - b.line_no);

  const stopsByTrip = new Map<string, PackStopRow[]>();
  for (const s of input.stops) {
    const key = String(s.trip_id ?? '');
    if (!key) continue;
    const arr = stopsByTrip.get(key) ?? [];
    arr.push(s);
    stopsByTrip.set(key, arr);
  }

  return input.trips.map((t) => {
    const raw = (stopsByTrip.get(String(t.id)) ?? []).slice();
    raw.sort((a, b) => num(a.stop_no) - num(b.stop_no) || String(a.id).localeCompare(String(b.id)));

    const seenDo = new Set<string>();
    let units = 0;
    let m3 = 0;
    let m3Known = false;

    const stops: PackingStop[] = raw.map((s, i) => {
      const doId = s.do_id ? String(s.do_id) : null;
      const row = doId ? doById.get(doId) ?? null : null;
      const items = doId && row ? itemsByDo.get(doId) ?? [] : [];
      const stopUnits = items.reduce((n, it) => n + it.qty, 0);

      if (doId && row && !seenDo.has(doId)) {
        seenDo.add(doId);
        units += stopUnits;
        if (row.m3_total_milli != null) { m3 += num(row.m3_total_milli); m3Known = true; }
      }

      return {
        stop_no: num(s.stop_no) || i + 1,
        stop_type: s.stop_type ?? null,
        customer_name: s.customer_name ?? null,
        address: s.address ?? null,
        do_id: doId,
        do_number: row?.do_number ?? null,
        do_status: row?.status ?? null,
        do_missing: !!doId && !row,
        units: stopUnits,
        items,
      };
    });

    return {
      trip_id: String(t.id),
      trip_no: t.trip_no ?? null,
      trip_date: t.trip_date ?? null,
      trip_status: t.status ?? null,
      lorry_plate: t.lorry_id ? lorryById.get(String(t.lorry_id)) ?? null : null,
      driver_name: t.driver_id ? driverById.get(String(t.driver_id)) ?? null : null,
      warehouse_name: t.warehouse_id ? warehouseById.get(String(t.warehouse_id)) ?? null : null,
      stop_count: stops.length,
      do_count: seenDo.size,
      units,
      m3_milli: m3Known ? m3 : null,
      stops,
    };
  });
}
