/* GET /api/scm/logistic-overview/on-time — the reads behind the on-time KPI
   (lib/on-time-delivery.ts holds the rules). Company scope: every read is scoped to
   the active company (companyScope.ts), the DOs, the SOs, their crews and runs. */
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { chunkIn, paginateAll } from './paginate-all';
import { scopeToCompany } from './companyScope';
import { todayMyt } from './my-time';
import { normalizePlate } from './plate-normalize';
import { offPeninsula } from './lorry-day-runs';
import { regionOf } from '../shared/logistic-region';
import type { SwrBuild } from './kv-swr';
import { latestLiveDo, onTimeSummary, promisedDateOf, type OnTimeOrderIn } from './on-time-delivery';

type Row = Record<string, unknown>;
const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const str = (v: unknown) => (v == null || v === '' ? null : String(v));
/* An SO in one of these is done with, whatever its DOs say. */
const SO_CLOSED = new Set(['DELIVERED', 'INVOICED', 'CLOSED']);

export async function buildOnTime(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<SwrBuild> {
  const sb = c.get('supabase');
  const today = todayMyt();
  const qFrom = c.req.query('from'); const qTo = c.req.query('to');
  const from = qFrom && ISO.test(qFrom) ? qFrom : `${today.slice(0, 7)}-01`;
  const to = qTo && ISO.test(qTo) ? qTo : today;
  const wq = c.req.query('warehouse') ?? '';
  const warehouseId = /^[0-9a-f-]{36}$/i.test(wq) ? wq : null;
  const fail = (what: string, e: { message: string }): SwrBuild => ({ ok: false, status: 500, body: { error: 'load_failed', reason: `${what}: ${e.message}` } });

  /* 1. DOs closed as delivered around the period. delivered_at is a UTC stamp, so a day
     either side is read and the Malaysia date decides. */
  const delivered = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('delivery_orders')
    .select('so_doc_no').eq('status', 'DELIVERED').gte('delivered_at', addDays(from, -1)).lt('delivered_at', addDays(to, 2)), c).order('id').range(f, t));
  if (delivered.error) return fail('delivered orders', delivered.error);
  /* 2. Orders promised in the period, up to yesterday: the candidates for late-open. */
  const last = to < today ? to : addDays(today, -1);
  const promised = last < from ? { data: [] as Row[], error: null } : await paginateAll<Row>((f, t) => scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no').not('status', 'in', '(DRAFT,CANCELLED)')
    .or(`and(amended_delivery_date.gte.${from},amended_delivery_date.lte.${last}),and(amended_delivery_date.is.null,customer_delivery_date.gte.${from},customer_delivery_date.lte.${last})`), c).order('doc_no').range(f, t));
  if (promised.error) return fail('orders due', promised.error);
  const docNos = [...new Set([...(delivered.data ?? []), ...(promised.data ?? [])].map((r) => str(r.so_doc_no ?? r.doc_no)).filter((x): x is string => !!x))];

  const sos = await chunkIn<Row>(docNos, (b, f, t) => scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no, debtor_name, status, amended_delivery_date, customer_delivery_date, customer_state, customer_country').in('doc_no', b), c).order('doc_no').range(f, t));
  if (sos.error) return fail('sales orders', sos.error);
  const dos = await chunkIn<Row>(docNos, (b, f, t) => scopeToCompany(sb.from('delivery_orders')
    .select('id, so_doc_no, status, created_at, delivered_at, driver_name, vehicle, warehouse_id').in('so_doc_no', b), c).order('id').range(f, t));
  if (dos.error) return fail('delivery orders', dos.error);
  const dosOf = new Map<string, Array<{ id: string; status: string | null; created_at: string | null; row: Row }>>();
  for (const d of dos.data) {
    const k = String(d.so_doc_no);
    const list = dosOf.get(k) ?? [];
    list.push({ id: String(d.id), status: str(d.status), created_at: str(d.created_at), row: d });
    dosOf.set(k, list);
  }
  const latest = new Map<string, Row>();
  for (const [k, list] of dosOf) { const l = latestLiveDo(list); if (l) latest.set(k, l.row); }
  const latestIds = [...latest.values()].map((d) => String(d.id));

  /* 3. Who carried it: the latest DO's crew (lorry, driver 1), else the live run it rides,
     else the Vehicle and Driver typed on the DO. */
  const crew = await chunkIn<Row>(latestIds, (b, f, t) => scopeToCompany(sb.from('delivery_order_crew')
    .select('do_id, lorry_id, lorry_plate, driver_1_name').in('do_id', b), c).order('id').range(f, t));
  if (crew.error) return fail('delivery crews', crew.error);
  const stops = await chunkIn<Row>(latestIds, (b, f, t) => scopeToCompany(sb.from('trip_stops')
    .select('do_id, trip_id').in('do_id', b), c).order('id').range(f, t));
  if (stops.error) return fail('lorry run stops', stops.error);
  const trips = await chunkIn<Row>([...new Set(stops.data.map((s) => String(s.trip_id)))], (b, f, t) => scopeToCompany(sb.from('trips')
    .select('id, lorry_id').in('id', b).neq('status', 'CANCELLED'), c).order('id').range(f, t));
  if (trips.error) return fail('lorry runs', trips.error);
  const fleet = await scopeToCompany(sb.from('lorries').select('id, plate'), c);
  if (fleet.error) return fail('lorries', fleet.error);
  const plateOf = new Map((fleet.data as Row[]).map((l) => [String(l.id), String(l.plate ?? '')]));
  const idOfPlate = new Map((fleet.data as Row[]).map((l) => [normalizePlate(String(l.plate ?? '')), String(l.id)]));
  const lorryOfTrip = new Map(trips.data.map((t) => [String(t.id), str(t.lorry_id)]));
  const tripLorry = new Map<string, string>();
  for (const s of stops.data) { const l = lorryOfTrip.get(String(s.trip_id)); if (l) tripLorry.set(String(s.do_id), l); }
  const crewOf = new Map(crew.data.map((r) => [String(r.do_id), r]));

  /* ?warehouse=: an order counts where its latest DO ships from; with no DO yet, where
     its first line ships from. */
  const lineWh = new Map<string, string>();
  if (warehouseId) {
    const noDo = docNos.filter((d) => !latest.has(d));
    const items = await chunkIn<Row>(noDo, (b, f, t) => scopeToCompany(sb.from('mfg_sales_order_items')
      .select('doc_no, warehouse_id').in('doc_no', b), c).order('doc_no').range(f, t));
    if (items.error) return fail('order lines', items.error);
    for (const it of items.data) if (it.warehouse_id && !lineWh.has(String(it.doc_no))) lineWh.set(String(it.doc_no), String(it.warehouse_id));
  }

  const orders: OnTimeOrderIn[] = [];
  for (const so of sos.data) {
    const dn = String(so.doc_no);
    const d = latest.get(dn) ?? null;
    if (warehouseId && (d ? str(d.warehouse_id) : lineWh.get(dn) ?? null) !== warehouseId) continue;
    const cr = d ? crewOf.get(String(d.id)) : undefined;
    const crewLorry = str(cr?.lorry_id);
    const typedPlate = str(cr?.lorry_plate) ?? str(d?.vehicle);
    const lorryId = crewLorry ?? (d ? tripLorry.get(String(d.id)) ?? null : null) ?? (typedPlate ? idOfPlate.get(normalizePlate(typedPlate)) ?? null : null);
    const isDelivered = !!d && String(d.status ?? '').toUpperCase() === 'DELIVERED' && !!str(d.delivered_at);
    orders.push({
      soDocNo: dn, customer: str(so.debtor_name),
      promised: promisedDateOf({ amended_delivery_date: str(so.amended_delivery_date), customer_delivery_date: str(so.customer_delivery_date) }),
      deliveredAt: isDelivered ? str(d!.delivered_at) : null,
      closedWithoutTime: !isDelivered && (SO_CLOSED.has(String(so.status ?? '').toUpperCase()) || String(d?.status ?? '').toUpperCase() === 'DELIVERED'),
      region: regionOf(str(so.customer_state)), offPeninsula: offPeninsula(str(so.customer_state), str(so.customer_country)),
      lorryId, lorry: (lorryId ? plateOf.get(lorryId) || null : null) ?? typedPlate,
      driver: str(cr?.driver_1_name) ?? str(d?.driver_name),
    });
  }
  return { ok: true, body: { today, ...onTimeSummary(orders, from, to, today) } };
}
