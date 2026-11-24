// ----------------------------------------------------------------------------
// own-fleet-load — the reads behind the Own fleet tab (GET
// /delivery-rate-cards/own-fleet): our own lorries' trips in a date window,
// each delivery order with its order's facts, and the paying company's 3PL
// bills on orders that ran the same days, for the comparison.
//
// company-scope: the lorry fleet is one shared master and a lorry's day is one
// physical run (lorry-day-runs.ts), so trips, orders and crews are narrowed to
// the caller's ALLOWED companies, as /reconcile reads trips; the 3PL bills are
// the paying (active) company's, as the 3PL invoices tab reads them. Pricing is
// own-fleet-runs.ts.
// ----------------------------------------------------------------------------
import { chunkIn, paginateAll } from './paginate-all';
import { DO_NOT_DELIVERED_IN_LIST, doCountsAsDelivered } from '../shared/do-shipped-states';
import { doRunDate, isOwnLorryDoRun } from './own-lorry-do-run';
import { normalizePlate } from './plate-normalize';
import { zoneForAddress, type ZonePrefixRule } from './zone-classify';
import { doFacts, orderAddressText, setLineOf } from './threepl-do-charge';
import type { SetLine } from './set-count';
import type { TripStopRow } from './trip-stop-jobs';
import { customerKeyOf, type OwnDo, type OwnTrip } from './own-fleet-runs';
import type { DeliveryFacts } from './delivery-rate-card';

type Row = Record<string, unknown>;
// These scm tables are not all in the generated Supabase types; the same narrow
// bridge as delivery-rate-cards.ts rc().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (sb: unknown): any => sb;
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Narrows a read to the companies the caller may see (scopeToAllowedCompanies). */
export type ScopeFn = <Q>(query: Q) => Q;

/** A 3PL bill on one delivery order that ran in the window: what it billed, by carrier. */
export interface ThreePlBill {
  doId: string;
  runDate: string;
  facts: DeliveryFacts | null;
  /** One entry per carrier that billed it. */
  charges: Array<{ carrierId: string; billedSen: number }>;
}

export interface OwnFleetRead {
  trips: OwnTrip[];
  dos: OwnDo[];
  threePl: ThreePlBill[];
}

const DO_COLS = 'id, company_id, do_number, so_doc_no, status, do_date, delivered_at, created_at, is_dropship';
const SO_COLS = 'doc_no, company_id, amended_delivery_date, customer_delivery_date, debtor_code, debtor_name, address1, address2, address3, address4, city, postcode';

/** The instant a Malaysia day starts (UTC+8, no daylight saving), as an ISO string. */
export const myDayStartIso = (ymd: string): string => new Date(`${ymd}T00:00:00+08:00`).toISOString();
/** The Malaysia day an instant falls on. */
export const myDayOf = (iso: string | null): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 8 * 3600_000).toISOString().slice(0, 10) : null;
};
const nextDay = (ymd: string): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** A failed read stops the work: a guess would be a wrong cost shown as right. */
async function need<T>(what: string, p: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const r = await p;
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data ?? [];
}

/** Our own lorries' trips and orders in [from, to], and the paying company's 3PL bills
 *  on orders that ran then. Throws on a failed read. */
export async function loadOwnFleet(input: {
  sb: unknown;
  scope: ScopeFn;
  payingCompanyId: number;
  from: string;
  to: string;
  zoneMap: readonly ZonePrefixRule[];
}): Promise<OwnFleetRead> {
  const { sb, scope, payingCompanyId, from, to, zoneMap } = input;
  const byCo = (companyId: unknown, doc: unknown) => `${Number(companyId)}|${String(doc ?? '')}`;

  // 1. The lorry master (shared): a crew's plate resolves to its lorry.
  const lorries = await need<Row>('lorries', paginateAll<Row>((lo, hi) =>
    scope(db(sb).from('lorries').select('id, plate, is_internal')).order('id').range(lo, hi)));
  const lorryById = new Map(lorries.map((l) => [String(l.id), l]));
  const lorryIdByPlate = new Map(lorries.map((l) => [normalizePlate(str(l.plate)), String(l.id)]));

  // 2. Our own Delivery Planning trips in the window, and their stops.
  const tripRows = await need<Row>('trips', paginateAll<Row>((lo, hi) =>
    scope(db(sb).from('trips').select('id, company_id, trip_no, trip_date, lorry_id'))
      .eq('is_outsourced', false).neq('status', 'CANCELLED').gte('trip_date', from).lte('trip_date', to)
      .order('trip_date').order('id').range(lo, hi)));
  const stopRows = await need<Row>('trip stops', chunkIn<Row>(tripRows.map((t) => String(t.id)), (b, lo, hi) =>
    scope(db(sb).from('trip_stops').select('trip_id, stop_type, do_id, assr_case_id, address, stop_no'))
      .in('trip_id', b).order('trip_id').order('stop_no').range(lo, hi)));
  const stopsByTrip = new Map<string, Row[]>();
  for (const s of stopRows) (stopsByTrip.get(String(s.trip_id)) ?? stopsByTrip.set(String(s.trip_id), []).get(String(s.trip_id))!).push(s);

  // 3. The orders that may have run in the window: SOs due in it, DOs dated or delivered in it.
  const dueRows = await need<Row>('orders due', paginateAll<Row>((lo, hi) =>
    scope(db(sb).from('mfg_sales_orders').select('doc_no'))
      .or(`and(amended_delivery_date.gte.${from},amended_delivery_date.lte.${to}),and(amended_delivery_date.is.null,customer_delivery_date.gte.${from},customer_delivery_date.lte.${to})`)
      .order('doc_no').range(lo, hi)));
  const datedDos = await need<Row>('delivery orders dated', paginateAll<Row>((lo, hi) =>
    scope(db(sb).from('delivery_orders').select(DO_COLS))
      .not('status', 'in', DO_NOT_DELIVERED_IN_LIST)
      .or(`and(do_date.gte.${from},do_date.lte.${to}),and(delivered_at.gte.${myDayStartIso(from)},delivered_at.lt.${myDayStartIso(nextDay(to))})`)
      .order('id').range(lo, hi)));
  const soDocs = [...new Set([...dueRows.map((r) => String(r.doc_no)), ...datedDos.map((d) => str(d.so_doc_no)).filter((x): x is string => !!x)])];

  // 4. Every live DO of those orders (the newest is the one Last Mile shows), and the orders.
  const siblingDos = await need<Row>('delivery orders of the orders', chunkIn<Row>(soDocs, (b, lo, hi) =>
    scope(db(sb).from('delivery_orders').select(DO_COLS)).in('so_doc_no', b).neq('status', 'CANCELLED').order('id').range(lo, hi)));
  const soRows = await need<Row>('orders', chunkIn<Row>(soDocs, (b, lo, hi) =>
    scope(db(sb).from('mfg_sales_orders').select(SO_COLS)).in('doc_no', b).order('doc_no').range(lo, hi)));
  const soByKey = new Map(soRows.map((so) => [byCo(so.company_id, so.doc_no), so]));
  const doById = new Map<string, Row>();
  for (const d of [...datedDos, ...siblingDos]) doById.set(String(d.id), d);
  const latestLive = new Map<string, Row>();
  for (const d of doById.values()) {
    if (String(d.status ?? '').toUpperCase() === 'CANCELLED' || !str(d.so_doc_no)) continue;
    const k = byCo(d.company_id, d.so_doc_no);
    const had = latestLive.get(k);
    const newer = !had || String(d.created_at ?? '') > String(had.created_at ?? '')
      || (String(d.created_at ?? '') === String(had.created_at ?? '') && String(d.id) > String(had.id));
    if (newer) latestLive.set(k, d);
  }
  /* The dates doRunDate picks from: the order's due date when this is the DO
     Last Mile shows, else the day it was delivered, else its DO date. */
  const datesOf = (d: Row) => {
    const so = str(d.so_doc_no) ? soByKey.get(byCo(d.company_id, d.so_doc_no)) : undefined;
    return {
      so_due_date: str(so?.amended_delivery_date) ?? str(so?.customer_delivery_date),
      is_latest_live: str(d.so_doc_no) ? latestLive.get(byCo(d.company_id, d.so_doc_no))?.id === d.id : null,
      delivered_day: myDayOf(str(d.delivered_at)),
      do_date: str(d.do_date),
    };
  };
  const ran = [...doById.values()]
    .filter((d) => doCountsAsDelivered(str(d.status)))
    .map((d) => { const dates = datesOf(d); return { d, dates, runDate: doRunDate(dates) }; })
    .filter((x): x is { d: Row; dates: ReturnType<typeof datesOf>; runDate: string } => !!x.runDate && x.runDate >= from && x.runDate <= to);
  const ranIds = ran.map((x) => String(x.d.id));

  // 5. Their crews, their 3PL bills, and any live trip that carries them.
  const [crewRows, chargeRows, carriedBy] = await Promise.all([
    need<Row>('crews', chunkIn<Row>(ranIds, (b, lo, hi) =>
      scope(db(sb).from('delivery_order_crew').select('do_id, lorry_id, lorry_plate')).in('do_id', b).order('do_id').range(lo, hi))),
    need<Row>('3PL bills', chunkIn<Row>(ranIds, (b, lo, hi) =>
      scope(db(sb).from('threepl_do_charges').select('do_id, company_id, threepl_company_id, billed_sen')).in('do_id', b).order('do_id').range(lo, hi))),
    need<Row>('trip stops of the orders', chunkIn<Row>(ranIds, (b, lo, hi) =>
      scope(db(sb).from('trip_stops').select('do_id, trip_id')).in('do_id', b).order('do_id').range(lo, hi))),
  ]);
  const carryingTrips = await need<Row>('trips of the orders', chunkIn<Row>([...new Set(carriedBy.map((s) => String(s.trip_id)))], (b, lo, hi) =>
    scope(db(sb).from('trips').select('id, status')).in('id', b).order('id').range(lo, hi)));
  const liveTrip = new Set(carryingTrips.filter((t) => String(t.status ?? '').toUpperCase() !== 'CANCELLED').map((t) => String(t.id)));
  const onLiveTrip = new Set(carriedBy.filter((s) => liveTrip.has(String(s.trip_id))).map((s) => String(s.do_id)));
  const crewByDo = new Map(crewRows.map((r) => [String(r.do_id), r]));
  const billed = new Set(chargeRows.map((r) => String(r.do_id)));

  // 6. The DO stops of our own trips: those orders ran that day, on that lorry.
  const tripDoIds = new Set(stopRows.filter((s) => String(s.stop_type ?? '').toUpperCase() === 'DELIVERY' && str(s.do_id)).map((s) => String(s.do_id)));
  const missing = [...tripDoIds].filter((id) => !doById.has(id));
  if (missing.length) {
    for (const d of await need<Row>('delivery orders on trips', chunkIn<Row>(missing, (b, lo, hi) =>
      scope(db(sb).from('delivery_orders').select(DO_COLS)).in('id', b).order('id').range(lo, hi)))) doById.set(String(d.id), d);
  }

  const lorryOf = (lorryId: string | null, plate: string | null) => {
    const id = lorryId && lorryById.has(lorryId) ? lorryId : (lorryIdByPlate.get(normalizePlate(plate)) ?? null);
    const master = id ? lorryById.get(id) : undefined;
    return { lorryId: id, plate: str(master?.plate) ?? (plate ?? '').trim(), internal: master ? master.is_internal !== false : null };
  };

  const ownDos: Array<Omit<OwnDo, 'facts' | 'customerKey'> & { so: string | null }> = [];
  for (const { d, dates, runDate } of ran) {
    const id = String(d.id);
    const crew = crewByDo.get(id);
    const lorry = lorryOf(str(crew?.lorry_id), str(crew?.lorry_plate));
    const own = isOwnLorryDoRun({
      do_id: id, do_status: str(d.status), ...dates,
      is_dropship: d.is_dropship === true, has_3pl: billed.has(id), on_live_trip: onLiveTrip.has(id),
      crew_plate: str(crew?.lorry_plate), lorry_plate: lorry.lorryId ? lorry.plate : null, lorry_internal: lorry.internal,
    }, tripDoIds);
    if (own) ownDos.push({ doId: id, doNumber: str(d.do_number), companyId: Number(d.company_id), runDate, lorryId: lorry.lorryId, plate: lorry.plate, tripId: null, so: str(d.so_doc_no) });
  }
  const trips: OwnTrip[] = tripRows.map((t) => {
    const lorry = lorryOf(str(t.lorry_id), null);
    const stops = stopsByTrip.get(String(t.id)) ?? [];
    for (const s of stops) {
      const d = str(s.do_id) ? doById.get(String(s.do_id)) : undefined;
      if (!d || String(s.stop_type ?? '').toUpperCase() !== 'DELIVERY' || String(d.status ?? '').toUpperCase() === 'CANCELLED') continue;
      ownDos.push({ doId: String(d.id), doNumber: str(d.do_number), companyId: Number(d.company_id), runDate: String(t.trip_date).slice(0, 10), lorryId: lorry.lorryId, plate: lorry.plate, tripId: String(t.id), so: str(d.so_doc_no) });
    }
    return {
      tripId: String(t.id), tripNo: str(t.trip_no), tripDate: String(t.trip_date).slice(0, 10), lorryId: lorry.lorryId, plate: lorry.plate || null,
      stops: stops.map((s): TripStopRow => ({ stopType: str(s.stop_type), doId: str(s.do_id), assrCaseId: str(s.assr_case_id), address: str(s.address) })),
    };
  });

  // 7. The paying company's 3PL bills on orders that ran in the window.
  const charges = new Map<string, Map<string, number>>();
  for (const r of chargeRows) {
    if (Number(r.company_id) !== payingCompanyId) continue;
    const per = charges.get(String(r.do_id)) ?? charges.set(String(r.do_id), new Map()).get(String(r.do_id))!;
    const carrier = String(r.threepl_company_id);
    per.set(carrier, (per.get(carrier) ?? 0) + Number(r.billed_sen ?? 0));
  }
  const threePlRan = ran.filter((x) => charges.has(String(x.d.id)));

  // 8. Each order's facts: its lines (sets / items) and its address (zone).
  const docKeys = new Map<string, { companyId: number; doc: string }>();
  for (const d of ownDos) if (d.so) docKeys.set(byCo(d.companyId, d.so), { companyId: d.companyId, doc: d.so });
  for (const { d } of threePlRan) if (str(d.so_doc_no)) docKeys.set(byCo(d.company_id, d.so_doc_no), { companyId: Number(d.company_id), doc: String(d.so_doc_no) });
  const factDocs = [...new Set([...docKeys.values()].map((k) => k.doc))];
  const unreadSo = factDocs.filter((doc) => [...docKeys.values()].some((k) => k.doc === doc && !soByKey.has(byCo(k.companyId, doc))));
  if (unreadSo.length) {
    for (const so of await need<Row>('orders on trips', chunkIn<Row>(unreadSo, (b, lo, hi) =>
      scope(db(sb).from('mfg_sales_orders').select(SO_COLS)).in('doc_no', b).order('doc_no').range(lo, hi)))) soByKey.set(byCo(so.company_id, so.doc_no), so);
  }
  const lineRows = await need<Row>('order lines', chunkIn<Row>(factDocs, (b, lo, hi) =>
    scope(db(sb).from('mfg_sales_order_items').select('doc_no, company_id, item_group, qty, cancelled')).in('doc_no', b).order('doc_no').range(lo, hi)));
  const linesBySo = new Map<string, SetLine[]>();
  for (const l of lineRows) {
    const k = byCo(l.company_id, l.doc_no);
    (linesBySo.get(k) ?? linesBySo.set(k, []).get(k)!).push(setLineOf(l));
  }
  const factsOf = (companyId: number, doc: string | null): DeliveryFacts | null => {
    const so = doc ? soByKey.get(byCo(companyId, doc)) : undefined;
    if (!so || !doc) return null;
    const zone = zoneForAddress({ postcode: str(so.postcode), address1: str(so.address1), address2: str(so.address2) }, zoneMap).zone;
    return doFacts(linesBySo.get(byCo(companyId, doc)) ?? [], zone, orderAddressText(so));
  };

  return {
    trips,
    dos: ownDos.map(({ so, ...d }) => {
      const order = so ? soByKey.get(byCo(d.companyId, so)) : undefined;
      return { ...d, facts: factsOf(d.companyId, so), customerKey: order ? customerKeyOf(order) : `do:${d.doId}` };
    }),
    threePl: threePlRan.map(({ d, runDate }) => ({
      doId: String(d.id),
      runDate,
      facts: factsOf(Number(d.company_id), str(d.so_doc_no)),
      charges: [...(charges.get(String(d.id)) ?? new Map<string, number>())].map(([carrierId, billedSen]) => ({ carrierId, billedSen })),
    })),
  };
}
