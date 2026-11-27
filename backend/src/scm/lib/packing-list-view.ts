
// @ts-expect-error - plain .mjs, the one stamp rule shared with the DO detail and scripts/stamp-do-shipped-from.mjs
import { stampRackLabel, stampFitsLine } from '../../../scripts/lib/do-shipped-from.mjs';
import { isServiceLine } from '../shared/service-sku';

export type PackTripRow = {
  id: string;
  trip_no: string | null;
  trip_date: string | null;
  status: string | null;
  lorry_id: string | null;
  driver_id: string | null;
  helper_1_id: string | null;
  helper_2_id: string | null;
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
  so_doc_no: string | null;
  phone: string | null;
  time_range: string | null;
};

export type PackItemRow = {
  delivery_order_id: string;
  line_no: number | null;
  item_code: string | null;
  description: string | null;
  qty: number | null;
  rack_id: string | null;
  shipped_from: unknown;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  description2: string | null;
  so_item_id: string | null;
  committed_po_batch_no: string | null;
  worked: { pos: string[]; racks: string[] } | null;
};

/** The sales-order line a DO line was cut from: its position on the SO. */
export type PackSoItemRow = { id: string; doc_no: string | null; line_no: number | null };

/** A crew master row: name plus the phone the crew box prints. */
export type PackCrewRow = { id: string; name: string | null; phone: string | null };

/** id -> printable label, for the two masters that only lend a name. */
export type PackLabelRow = { id: string; label: string | null };

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

export type PackingList = {
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
  soItems: readonly PackSoItemRow[];
  lorries: readonly PackLabelRow[];
  drivers: readonly PackCrewRow[];
  helpers: readonly PackCrewRow[];
  warehouses: readonly PackLabelRow[];
};

/* Rack (owner 2026-11-28): the rack(s) locked at dispatch, else the operator's pick, else the
   rack(s) worked out the way the DO detail works them out (the rack this DO left, else the GRN
   rack of the line's source PO). */
function packRack(it: PackItemRow, rackById: Map<string, string>): { rack: string | null; rack_locked: boolean } {
  const locked: string | null = stampRackLabel(it.shipped_from, it.item_code ?? null);
  if (locked) return { rack: locked, rack_locked: true };
  const picked = it.rack_id ? rackById.get(String(it.rack_id)) ?? null : null;
  if (picked) return { rack: picked, rack_locked: false };
  const worked = [...new Set(it.worked?.racks ?? [])];
  return { rack: worked.length > 0 ? worked.join(', ') : null, rack_locked: false };
}

/* PO (owner 2026-11-27, 2026-11-28): the stamp's POs when the line was locked at dispatch (the
   same stamp the rack comes from), else the PO batch the line was committed to, else the PO(s)
   worked out from the stock ledger / the SO line's bound PO, exactly as the DO detail shows them.
   None = null and the sheet prints a dash. */
function packPo(it: PackItemRow): { po: string | null; po_locked: boolean } {
  const stamp = it.shipped_from as { pos?: Array<{ po?: unknown }> } | null;
  if (stampFitsLine(stamp, it.item_code ?? null)) {
    const pos = [...new Set((stamp?.pos ?? [])
      .map((p) => (typeof p.po === 'string' ? p.po.trim() : ''))
      .filter(Boolean))];
    if (pos.length > 0) return { po: pos.join(', '), po_locked: true };
  }
  const committed = (it.committed_po_batch_no ?? '').trim();
  if (committed) return { po: committed, po_locked: false };
  const worked = [...new Set(it.worked?.pos ?? [])];
  return { po: worked.length > 0 ? worked.join(', ') : null, po_locked: false };
}

function packSources(it: PackItemRow, rackById: Map<string, string>) {
  const rack = packRack(it, rackById);
  const po = packPo(it);
  const worked_out = (!!rack.rack && !rack.rack_locked) || (!!po.po && !po.po_locked);
  return { ...rack, ...po, worked_out };
}

const crewMap = (rows: readonly PackCrewRow[]): Map<string, { name: string; phone: string | null }> => {
  const m = new Map<string, { name: string; phone: string | null }>();
  for (const r of rows) {
    const name = (r.name ?? '').trim();
    if (r.id && name) m.set(String(r.id), { name, phone: (r.phone ?? '').trim() || null });
  }
  return m;
};

/* Line order per owner 2026-11-27: the SALES ORDER's line order, then the DO's own line_no for lines with no SO line behind them. */
function compareSoOrder(a: PackingItem, b: PackingItem): number {
  const sa = a.so_line_no ?? Number.POSITIVE_INFINITY;
  const sb = b.so_line_no ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.line_no - b.line_no;
}

export type PackedLines = { itemsByDo: Map<string, PackingItem[]>; soDocByDo: Map<string, string> };

/** DO lines -> printable items per DO, service lines dropped, SO line order. Shared by the lorry and region views. */
export function packItemsByDo(input: Pick<AssembleInput, 'items' | 'racks' | 'soItems'>): PackedLines {
  const rackById = labelMap(input.racks);
  const soItemById = new Map<string, PackSoItemRow>();
  for (const r of input.soItems) if (r.id) soItemById.set(String(r.id), r);
  const soDocByDo = new Map<string, string>();

  const itemsByDo = new Map<string, PackingItem[]>();
  for (const it of input.items) {
    const key = String(it.delivery_order_id ?? '');
    if (!key) continue;
    if (isServiceLine({ itemGroup: it.item_group, itemCode: it.item_code })) continue;
    const soItem = it.so_item_id ? soItemById.get(String(it.so_item_id)) ?? null : null;
    if (soItem?.doc_no && !soDocByDo.has(key)) soDocByDo.set(key, soItem.doc_no);
    const soLine = soItem?.line_no != null && Number.isFinite(Number(soItem.line_no)) ? Number(soItem.line_no) : null;
    const arr = itemsByDo.get(key) ?? [];
    arr.push({
      line_no: num(it.line_no) || arr.length + 1,
      item_code: (it.item_code ?? '').trim() || '—',
      description: it.description ?? null,
      qty: num(it.qty),
      ...packSources(it, rackById),
      item_group: it.item_group ?? null,
      variants: it.variants && typeof it.variants === 'object' && !Array.isArray(it.variants) ? it.variants : null,
      description2: it.description2 ?? null,
      so_line_no: soLine,
    });
    itemsByDo.set(key, arr);
  }
  for (const arr of itemsByDo.values()) arr.sort(compareSoOrder);
  return { itemsByDo, soDocByDo };
}

export function assemblePackingLists(input: AssembleInput): PackingList[] {
  const lorryById = labelMap(input.lorries);
  const driverById = crewMap(input.drivers);
  const helperById = crewMap(input.helpers);
  const warehouseById = labelMap(input.warehouses);
  const { itemsByDo, soDocByDo } = packItemsByDo(input);

  const doById = new Map<string, PackDoRow>();
  for (const d of input.deliveryOrders) if (d.id) doById.set(String(d.id), d);

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
        so_doc_no: (row?.so_doc_no ?? '').trim() || (doId ? soDocByDo.get(doId) ?? null : null),
        phone: (row?.phone ?? '').trim() || null,
        time_range: (row?.time_range ?? '').trim() || null,
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
      driver_name: t.driver_id ? driverById.get(String(t.driver_id))?.name ?? null : null,
      driver_phone: t.driver_id ? driverById.get(String(t.driver_id))?.phone ?? null : null,
      helper_1_name: t.helper_1_id ? helperById.get(String(t.helper_1_id))?.name ?? null : null,
      helper_2_name: t.helper_2_id ? helperById.get(String(t.helper_2_id))?.name ?? null : null,
      warehouse_name: t.warehouse_id ? warehouseById.get(String(t.warehouse_id)) ?? null : null,
      stop_count: stops.length,
      do_count: seenDo.size,
      units,
      m3_milli: m3Known ? m3 : null,
      stops,
      source: 'trip' as const,
    };
  });
}
