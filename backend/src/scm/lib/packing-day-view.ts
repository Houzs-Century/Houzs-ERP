import {
  packItemsByDo, type PackItemRow, type PackLabelRow, type PackSoItemRow, type PackingItem, type PackingList, type PackingStop,
} from './packing-list-view';
import { stateToRegionsFromConfig, type RegionConfig } from './delivery-board-regions';

export type DayDoRow = {
  id: string;
  do_number: string | null;
  status: string | null;
  so_doc_no: string | null;
  debtor_code: string | null;
  debtor_name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  state: string | null;
  customer_state: string | null;
  customer_country: string | null;
  phone: string | null;
  time_range: string | null;
  m3_total_milli: number | null;
  vehicle: string | null;
  driver_name: string | null;
};

/** scm.delivery_order_crew: the lorry and crew the Delivery Planning board put on one DO. */
export type DayCrewRow = {
  do_id: string;
  lorry_plate: string | null;
  driver_1_name: string | null;
  driver_1_contact: string | null;
  helper_1_name: string | null;
  helper_2_name: string | null;
};

/** A DO that is a stop on a non-cancelled trip dated the chosen day. */
export type DayTripStop = { do_id: string; trip_no: string | null; stop_no: number | null; lorry_plate: string | null };

export type DayItems = { items: readonly PackItemRow[]; racks: readonly PackLabelRow[]; soItems: readonly PackSoItemRow[] };

export type PackingDayDo = {
  do_id: string;
  do_number: string | null;
  do_status: string | null;
  so_doc_no: string | null;
  debtor_code: string | null;
  customer_name: string | null;
  address: string | null;
  phone: string | null;
  time_range: string | null;
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

const clean = (v: string | null | undefined): string | null => (v ?? '').trim() || null;
const byText = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/** "VJK  8821" and "vjk 8821" are one lorry. */
export const plateKey = (plate: string): string => plate.trim().toUpperCase().replace(/\s+/g, ' ');

function addressOf(d: DayDoRow): string | null {
  const parts = [d.address1, d.address2, [d.postcode, d.city].map((x) => (x ?? '').trim()).filter(Boolean).join(' '), d.state]
    .map((p) => (p ?? '').trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Minutes from midnight of a time slot's START ("9am - 11am" -> 540, "14:00-16:00" -> 840,
 * "2 - 4pm" -> 840), null when the text names no time. The slot is free text on the DO.
 */
export function timeSlotStart(range: string | null | undefined): number | null {
  const text = (range ?? '').toLowerCase();
  const re = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/g;
  const first = re.exec(text);
  if (!first) return null;
  let h = Number(first[1]);
  const m = first[2] ? Number(first[2]) : 0;
  const suffix = (hit: RegExpExecArray | null): string | null => (hit && hit[3] ? hit[3] : null);
  const meridiem = suffix(first) ?? suffix(re.exec(text));
  if (h > 23 || m > 59) return null;
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  return h * 60 + m;
}

/**
 * The DOs delivering on the day, each with its items and its lorry: the trip's lorry when the DO is
 * a stop on that day's trip, else the board crew's plate, else the DO's own vehicle. Cancelled DOs and
 * DOs with only service lines are dropped.
 */
export function assemblePackingDay(input: {
  deliveryOrders: readonly DayDoRow[];
  crew: readonly DayCrewRow[];
  tripStops: readonly DayTripStop[];
} & DayItems): PackingDayDo[] {
  const crewByDo = new Map<string, DayCrewRow>();
  for (const c of input.crew) if (c.do_id) crewByDo.set(String(c.do_id), c);
  const stopByDo = new Map<string, DayTripStop>();
  for (const s of input.tripStops) if (s.do_id && !stopByDo.has(s.do_id)) stopByDo.set(s.do_id, s);
  const { itemsByDo, soDocByDo } = packItemsByDo(input);

  const out: PackingDayDo[] = [];
  const seen = new Set<string>();
  for (const d of input.deliveryOrders) {
    const id = String(d.id);
    if (!id || seen.has(id)) continue;
    if (String(d.status ?? '').toUpperCase() === 'CANCELLED') continue;
    const items = itemsByDo.get(id) ?? [];
    if (items.length === 0) continue;
    seen.add(id);
    const crew = crewByDo.get(id) ?? null;
    const stop = stopByDo.get(id) ?? null;
    out.push({
      do_id: id,
      do_number: d.do_number,
      do_status: d.status,
      so_doc_no: clean(d.so_doc_no) ?? soDocByDo.get(id) ?? null,
      debtor_code: clean(d.debtor_code),
      customer_name: clean(d.debtor_name),
      address: addressOf(d),
      phone: clean(d.phone),
      time_range: clean(d.time_range),
      m3_milli: d.m3_total_milli,
      lorry_plate: clean(stop?.lorry_plate) ?? clean(crew?.lorry_plate) ?? clean(d.vehicle),
      driver_name: clean(crew?.driver_1_name) ?? clean(d.driver_name),
      driver_phone: clean(crew?.driver_1_contact),
      helper_1_name: clean(crew?.helper_1_name),
      helper_2_name: clean(crew?.helper_2_name),
      trip_no: stop?.trip_no ?? null,
      trip_stop_no: stop?.stop_no ?? null,
      state: clean(d.customer_state) ?? clean(d.state),
      country: clean(d.customer_country),
      units: items.reduce((n, it) => n + it.qty, 0),
      items,
    });
  }
  return out;
}

/** Delivery order for one lorry: trip stop numbers when every DO has one, else time slot start
 *  (earliest = 1, no slot last), then DO number. */
export function sequenceLorryDos(dos: readonly PackingDayDo[]): PackingDayDo[] {
  const allOnTrip = dos.length > 0 && dos.every((d) => d.trip_stop_no != null);
  return [...dos].sort((a, b) => {
    if (allOnTrip) return (a.trip_stop_no ?? 0) - (b.trip_stop_no ?? 0) || byText(a.do_number ?? '', b.do_number ?? '');
    const ta = timeSlotStart(a.time_range) ?? Number.POSITIVE_INFINITY;
    const tb = timeSlotStart(b.time_range) ?? Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return byText(a.do_number ?? '', b.do_number ?? '') || byText(a.do_id, b.do_id);
  });
}

const mostCommon = (vals: ReadonlyArray<string | null>): string | null => {
  const counts = new Map<string, number>();
  for (const v of vals) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n || (c === n && best !== null && byText(v, best) < 0)) { best = v; n = c; }
  return best;
};

function toStop(d: PackingDayDo, stopNo: number): PackingStop {
  return {
    stop_no: stopNo,
    stop_type: 'DELIVERY',
    customer_name: d.customer_name,
    address: d.address,
    do_id: d.do_id,
    do_number: d.do_number,
    do_status: d.do_status,
    do_missing: false,
    so_doc_no: d.so_doc_no,
    phone: d.phone,
    time_range: d.time_range,
    units: d.units,
    items: d.items,
  };
}

/**
 * One packing list per lorry for the day. Trip lists that carry at least one DO stay as they are (a
 * trip with only transfer stops has nothing to pick and is dropped); every other DO with a plate is
 * grouped by plate, joining the trip list of the same plate when there is one. DOs with no plate are
 * not a lorry and are left for the region view.
 */
export function mergeLorryLists(date: string, tripLists: readonly PackingList[], dayDos: readonly PackingDayDo[]): PackingList[] {
  const lists: PackingList[] = tripLists
    .filter((l) => l.stops.some((s) => s.do_id && !s.do_missing))
    .map((l) => ({ ...l, stops: [...l.stops] }));
  const onTrip = new Set(lists.flatMap((l) => l.stops.map((s) => s.do_id).filter((v): v is string => !!v)));
  const byPlate = new Map<string, PackingDayDo[]>();
  for (const d of dayDos) {
    if (onTrip.has(d.do_id) || !d.lorry_plate) continue;
    const key = plateKey(d.lorry_plate);
    byPlate.set(key, [...(byPlate.get(key) ?? []), d]);
  }

  for (const [key, group] of byPlate) {
    const ordered = sequenceLorryDos(group);
    const units = ordered.reduce((n, d) => n + d.units, 0);
    const m3s = ordered.map((d) => d.m3_milli).filter((v): v is number => v != null);
    const trip = lists.find((l) => l.lorry_plate && plateKey(l.lorry_plate) === key);
    if (trip) {
      const start = trip.stops.reduce((n, s) => Math.max(n, s.stop_no), 0);
      trip.stops.push(...ordered.map((d, i) => toStop(d, start + i + 1)));
      trip.stop_count += ordered.length;
      trip.do_count += ordered.length;
      trip.units += units;
      if (m3s.length > 0) trip.m3_milli = (trip.m3_milli ?? 0) + m3s.reduce((a, b) => a + b, 0);
      continue;
    }
    lists.push({
      trip_id: `crew:${key}`,
      trip_no: null,
      trip_date: date,
      trip_status: null,
      lorry_plate: mostCommon(ordered.map((d) => d.lorry_plate)),
      driver_name: mostCommon(ordered.map((d) => d.driver_name)),
      driver_phone: mostCommon(ordered.map((d) => d.driver_phone)),
      helper_1_name: mostCommon(ordered.map((d) => d.helper_1_name)),
      helper_2_name: mostCommon(ordered.map((d) => d.helper_2_name)),
      warehouse_name: null,
      stop_count: ordered.length,
      do_count: ordered.length,
      units,
      m3_milli: m3s.length > 0 ? m3s.reduce((a, b) => a + b, 0) : null,
      stops: ordered.map((d, i) => toStop(d, i + 1)),
      source: 'crew',
    });
  }
  return lists.sort((a, b) => byText(a.lorry_plate ?? '~', b.lorry_plate ?? '~') || byText(a.trip_no ?? '', b.trip_no ?? ''));
}

export type PackingRegion = {
  region: string;
  label: string;
  do_count: number;
  customer_count: number;
  units: number;
  lorry_plates: string[];
  not_arranged: number;
  dos: PackingDayDo[];
};

/** A state can map to several board tabs, but a DO is picked once, so it goes to the first. */
export function pickRegion(cfg: RegionConfig, d: Pick<PackingDayDo, 'state' | 'country'>): string {
  return stateToRegionsFromConfig(cfg, d.state, d.country)[0]!;
}

/** Lorry DOs first, by plate, then the ones with no lorry; customer name inside. The printed sheet
 *  numbers customers in this order, so it must be total. */
export function compareRegionDos(a: PackingDayDo, b: PackingDayDo): number {
  if (!!a.lorry_plate !== !!b.lorry_plate) return a.lorry_plate ? -1 : 1;
  return byText(a.lorry_plate ?? '', b.lorry_plate ?? '')
    || byText(a.customer_name ?? '', b.customer_name ?? '')
    || byText(a.do_number ?? '', b.do_number ?? '')
    || byText(a.do_id, b.do_id);
}

/** The day's DOs bucketed by the Delivery Planning regions, in the board's order, empty ones dropped. */
export function assemblePackingRegions(cfg: RegionConfig, dayDos: readonly PackingDayDo[], unassignedOnly: boolean): PackingRegion[] {
  const byRegion = new Map<string, PackingDayDo[]>();
  for (const d of dayDos) {
    if (unassignedOnly && d.lorry_plate) continue;
    const key = pickRegion(cfg, d);
    byRegion.set(key, [...(byRegion.get(key) ?? []), d]);
  }
  const labelOf = new Map(cfg.regions.map((r) => [r.key, r.label]));
  const order = [...cfg.regions.map((r) => r.key), ...[...byRegion.keys()].filter((k) => !labelOf.has(k)).sort()];
  const out: PackingRegion[] = [];
  for (const key of order) {
    const dos = byRegion.get(key);
    if (!dos || dos.length === 0) continue;
    dos.sort(compareRegionDos);
    out.push({
      region: key,
      label: labelOf.get(key) ?? key,
      do_count: dos.length,
      customer_count: new Set(dos.map((d) => (d.debtor_code ?? d.customer_name ?? d.do_id).toUpperCase())).size,
      units: dos.reduce((n, d) => n + d.units, 0),
      lorry_plates: [...new Set(dos.map((d) => d.lorry_plate).filter((p): p is string => !!p))].sort(byText),
      not_arranged: dos.filter((d) => !d.lorry_plate).length,
      dos,
    });
  }
  return out;
}
