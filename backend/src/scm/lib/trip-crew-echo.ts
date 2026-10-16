/* A board row riding a lorry run shows that run's crew. A DP job (setup,
   dismantle, supplier pickup, transfer) carries no delivery_order_crew of its
   own, so before this its Driver / Helper / Lorry cells stayed blank even when
   Last Mile had a crew on the run. The run is the one store of who drives it. */
import { chunkIn } from './paginate-all';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every route helper
type Sb = any;

type CrewEcho = {
  driver: string | null; helper: string | null; lorry: string | null;
  driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
  driver_2_name: string | null; helper_1_name: string | null; helper_2_name: string | null;
  lorry_plate: string | null;
};
type RunRow = { trip_id: string | null; crew: CrewEcho | null; trip_no: string | null; trip_date: string | null };
type Trip = { id: string; trip_no: string | null; trip_date: string | null; status: string | null; driver_id: string | null; helper_1_id: string | null; helper_2_id: string | null; lorry_id: string | null };

export async function echoTripCrew(sb: Sb, rows: RunRow[]): Promise<void> {
  const tripIds = [...new Set(rows.map((r) => r.trip_id).filter((x): x is string => !!x))];
  if (!tripIds.length) return;
  const { data: trips, error } = await chunkIn<Trip>(tripIds, (batch, from, to) => sb.from('trips')
    .select('id, trip_no, trip_date, status, driver_id, helper_1_id, helper_2_id, lorry_id').in('id', batch).order('id').range(from, to));
  if (error) throw new Error(error.message);
  const ids = (k: 'driver_id' | 'helper_1_id' | 'helper_2_id' | 'lorry_id') => [...new Set(trips.map((t) => t[k]).filter((x): x is string => !!x))];
  const helperIds = [...new Set([...ids('helper_1_id'), ...ids('helper_2_id')])];
  const [dr, hr, lr] = await Promise.all([
    ids('driver_id').length ? sb.from('drivers').select('id, name, ic_number, phone').in('id', ids('driver_id')) : { data: [], error: null },
    helperIds.length ? sb.from('helpers').select('id, name').in('id', helperIds) : { data: [], error: null },
    ids('lorry_id').length ? sb.from('lorries').select('id, plate').in('id', ids('lorry_id')) : { data: [], error: null },
  ]);
  for (const r of [dr, hr, lr]) if (r.error) throw new Error(r.error.message);
  const drv = new Map(((dr.data ?? []) as Array<{ id: string; name: string | null; ic_number: string | null; phone: string | null }>).map((d) => [d.id, d]));
  const hlp = new Map(((hr.data ?? []) as Array<{ id: string; name: string | null }>).map((h) => [h.id, h.name]));
  const lry = new Map(((lr.data ?? []) as Array<{ id: string; plate: string | null }>).map((l) => [l.id, l.plate]));
  const byId = new Map(trips.map((t) => [t.id, t]));
  for (const r of rows) {
    const t = r.trip_id ? byId.get(r.trip_id) : undefined;
    if (!t || t.status === 'CANCELLED') continue;
    const d = t.driver_id ? drv.get(t.driver_id) : undefined;
    const h1 = t.helper_1_id ? hlp.get(t.helper_1_id) ?? null : null;
    const h2 = t.helper_2_id ? hlp.get(t.helper_2_id) ?? null : null;
    const plate = t.lorry_id ? lry.get(t.lorry_id) ?? null : null;
    r.trip_no = t.trip_no;
    r.trip_date = t.trip_date ? String(t.trip_date).slice(0, 10) : null;
    r.crew = {
      driver: d?.name ?? null, helper: h1, lorry: plate,
      driver_1_name: d?.name ?? null, driver_1_ic: d?.ic_number ?? null, driver_1_contact: d?.phone ?? null,
      driver_2_name: null, helper_1_name: h1, helper_2_name: h2, lorry_plate: plate,
    };
  }
}
