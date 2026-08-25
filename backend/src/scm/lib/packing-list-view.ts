// ----------------------------------------------------------------------------
// packing-list-view — assemble ONE DAY's packing lists out of the trip rows.
//
// A PACKING LIST IS A TRIP, RENDERED. It is not a document of its own and there
// is no `packing_lists` table: `scm.trips` already IS "one day + one lorry"
// (mig 0053 — `trip_date DATE`, `lorry_id`, indexed on both), and `trip_stops`
// already carries the ordered drop list with the delivery order hanging off each
// stop. Three lorries out today = three trips = three packing lists. Mixed
// companies work by construction, because each stop's DO carries its own
// company_id and the reads that resolve them carry the company predicate.
//
// PURE. No supabase, no Hono, no env — the route does the five reads and hands
// the rows here. That is what makes the ordering rule and the totals testable
// without a database, and it is why the reversal rule below has a test that
// fails if anyone "fixes" it.
//
// STOPS COME OUT IN DELIVERY ORDER (stop_no ascending) — the truth as the
// dispatcher sequenced it. The LOADING order is the reverse of it, and that
// reversal belongs to the thing that prints, not to the thing that reads: see
// frontend/src/vendor/scm/lib/packing-list-model.ts `loadingOrder`.
//
// EMPTY IS NOT ZERO. `m3_milli` is null — never 0 — when not one member DO
// carries a figure, because `delivery_orders.m3_total_milli` is a column that
// exists and is not necessarily filled, and a printed "0.00 m³" is a claim
// about the load rather than a report of what we hold. Same reason a stop whose
// DO did not come back carries `do_missing: true` instead of `units: 0`: the
// company predicate legitimately filters a DO out, and that is an unknown, not
// an empty lorry.
// ----------------------------------------------------------------------------

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
};

/** id -> printable label, for the two masters that only lend a name. */
export type PackLabelRow = { id: string; label: string | null };

export type PackingItem = {
  line_no: number;
  item_code: string;
  description: string | null;
  qty: number;
  /** The rack the LINE leaves from (scm.delivery_order_items.rack_id, mig 0118).
   *  Null when the line carries no explicit pick — dispatch auto-picks then, and
   *  a sheet that printed a rack anyway would be inventing one. */
  rack: string | null;
};

export type PackingStop = {
  stop_no: number;
  stop_type: string | null;
  customer_name: string | null;
  address: string | null;
  do_id: string | null;
  do_number: string | null;
  do_status: string | null;
  /** The stop names a delivery order that this caller's companies cannot read. */
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
  /** Σ m3_total_milli over the DISTINCT member DOs, or null when none carries one. */
  m3_milli: number | null;
  /** DELIVERY order — stop_no ascending. The print reverses it. */
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
      rack: it.rack_id ? rackById.get(String(it.rack_id)) ?? null : null,
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
    /* Sort by stop_no, ties broken by the stop's own id so the order is stable
       across two reads. `stop_no` is NOT NULL DEFAULT 1 (mig 0053), so a trip
       that was never sequenced has every stop on 1 and the tiebreak is what
       stops the sheet shuffling between prints. */
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

      /* Totals count each DELIVERY ORDER once. Two stops may legitimately name
         the same DO (a split drop), and adding its units twice would overstate
         what goes on the lorry. */
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
