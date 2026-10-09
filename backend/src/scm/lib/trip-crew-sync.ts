/* One crew per lorry run, the same on every page (owner, 2026-10-07: Delivery
   Planning, Date / Time Arrangement and Last Mile must show the same date,
   time, driver and helper, both ways, and the driver's phone follows).

   A lorry run is scm.trips (driver_id, helper_1_id, helper_2_id, lorry_id); its
   DOs carry their own copy in scm.delivery_order_crew + the DO header driver.
   Before this, Last Mile wrote the trip and only the DOs of rows it happened to
   hold, and a crew edit on Delivery Planning wrote one DO and never the trip, so
   the two drifted and the phone (scoped by the trip for DP / Service Case legs,
   by the DO crew for orders) showed different people the same stop. */
import { normalizePhone } from '../shared/phone';
import { scopeToCompanyId, scopeToCompanyIdOrOpen } from './companyScope';
import { resolveCrewSeats } from './crew-seats';
import { ASSR_LEG_BY_STOP } from './assr-board-scope';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every route helper
type Sb = any;

export type CrewSeats = {
  driver1Id: string | null; driver2Id: string | null;
  helper1Id: string | null; helper2Id: string | null;
  lorryId: string | null;
};

/** The latest live DO of a sales order (anything but cancelled — a draft DO is
 *  what the board's crew cells write to as well), or null. */
export async function latestLiveDoIdForSo(sb: Sb, companyId: number | null, soDocNo: string): Promise<string | null> {
  const q = sb.from('delivery_orders').select('id, status').eq('so_doc_no', soDocNo)
    .neq('status', 'CANCELLED').order('created_at', { ascending: false }).limit(1);
  const { data, error } = await scopeToCompanyIdOrOpen(q, companyId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

/** The trip a DO's newest stop rides, or null. */
export async function tripOfDo(sb: Sb, doId: string): Promise<string | null> {
  const { data, error } = await sb.from('trip_stops').select('trip_id').eq('do_id', doId)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ trip_id: string | null }>)[0]?.trip_id ?? null;
}

/** Set a trip's crew. Seats passed as undefined are left as they are. */
export async function setTripCrew(sb: Sb, tripId: string, crew: { driverId?: string | null; helper1Id?: string | null; helper2Id?: string | null; lorryId?: string | null }): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (crew.driverId !== undefined) patch.driver_id = crew.driverId;
  if (crew.helper1Id !== undefined) patch.helper_1_id = crew.helper1Id;
  if (crew.helper2Id !== undefined) patch.helper_2_id = crew.helper2Id;
  if (crew.lorryId !== undefined && crew.lorryId !== null) patch.lorry_id = crew.lorryId;
  const { error } = await sb.from('trips').update(patch).eq('id', tripId);
  if (error) throw new Error(error.message);
}

/* Write one DO's crew row + header driver from master snapshots — the same
   shape PUT /delivery-orders-mfg/:id/crew writes. */
async function writeDoCrewRow(sb: Sb, companyId: number, doId: string, s: CrewSeats, assignedBy: string | null): Promise<void> {
  const driverIds = [...new Set([s.driver1Id, s.driver2Id].filter((x): x is string => !!x))];
  const helperIds = [...new Set([s.helper1Id, s.helper2Id].filter((x): x is string => !!x))];
  const [dr, hr, lr] = await Promise.all([
    driverIds.length ? sb.from('drivers').select('id, name, ic_number, phone, vehicle').in('id', driverIds) : Promise.resolve({ data: [], error: null }),
    helperIds.length ? sb.from('helpers').select('id, name, contact').in('id', helperIds) : Promise.resolve({ data: [], error: null }),
    s.lorryId ? sb.from('lorries').select('id, plate').eq('id', s.lorryId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  for (const r of [dr, hr, lr]) if (r.error) throw new Error(r.error.message);
  const drv = new Map(((dr.data ?? []) as Array<Record<string, string | null>>).map((d) => [d.id, d]));
  const hlp = new Map(((hr.data ?? []) as Array<Record<string, string | null>>).map((h) => [h.id, h]));
  const d1 = s.driver1Id ? drv.get(s.driver1Id) : undefined;
  const d2 = s.driver2Id ? drv.get(s.driver2Id) : undefined;
  const h1 = s.helper1Id ? hlp.get(s.helper1Id) : undefined;
  const h2 = s.helper2Id ? hlp.get(s.helper2Id) : undefined;
  const plate = (lr.data as { plate?: string | null } | null)?.plate ?? null;
  const tel = (v: string | null | undefined) => (v ? normalizePhone(v) ?? v : null);
  const now = new Date().toISOString();
  const { error } = await sb.from('delivery_order_crew').upsert({
    company_id: companyId, do_id: doId,
    driver_1_id: s.driver1Id, driver_2_id: s.driver2Id, helper_1_id: s.helper1Id, helper_2_id: s.helper2Id, lorry_id: s.lorryId,
    driver_1_name: d1?.name ?? null, driver_1_ic: d1?.ic_number ?? null, driver_1_contact: tel(d1?.phone),
    driver_2_name: d2?.name ?? null, driver_2_ic: d2?.ic_number ?? null, driver_2_contact: tel(d2?.phone),
    helper_1_name: h1?.name ?? null, helper_1_contact: tel(h1?.contact),
    helper_2_name: h2?.name ?? null, helper_2_contact: tel(h2?.contact),
    lorry_plate: plate, assigned_by: assignedBy, updated_at: now,
  }, { onConflict: 'do_id' });
  if (error) throw new Error(error.message);
  const { error: hErr } = await scopeToCompanyId(sb.from('delivery_orders').update({
    driver_id: s.driver1Id, driver_name: d1?.name ?? null, vehicle: d1?.vehicle ?? plate, updated_at: now,
  }).eq('id', doId), companyId);
  if (hErr) throw new Error(hErr.message);
}

/** Copy a trip's crew onto every DO it carries (except `exceptDoId`, already
 *  written by the caller). A DO keeps its own second driver — a trip has one. */
export async function syncTripCrewToDos(sb: Sb, tripId: string, exceptDoId: string | null, assignedBy: string | null): Promise<number> {
  const [{ data: trip, error: tErr }, { data: stops, error: sErr }] = await Promise.all([
    sb.from('trips').select('company_id, driver_id, helper_1_id, helper_2_id, lorry_id').eq('id', tripId).maybeSingle(),
    sb.from('trip_stops').select('do_id').eq('trip_id', tripId),
  ]);
  if (tErr) throw new Error(tErr.message);
  if (sErr) throw new Error(sErr.message);
  if (!trip) return 0;
  const t = trip as Record<string, string | null>;
  // The trip's own company bounds every DO written: a stop of another company's DO is never touched.
  const companyId = Number(t.company_id);
  if (!Number.isFinite(companyId)) return 0;
  const doIds = [...new Set(((stops ?? []) as Array<{ do_id: string | null }>).map((x) => x.do_id).filter((x): x is string => !!x && x !== exceptDoId))];
  if (!doIds.length) return 0;
  const { data: own, error: oErr } = await scopeToCompanyId(
    sb.from('delivery_orders').select('id, status').in('id', doIds).not('status', 'in', '("CANCELLED")'), companyId,
  );
  if (oErr) throw new Error(oErr.message);
  const live = ((own ?? []) as Array<{ id: string }>).map((d) => d.id);
  const { data: crews, error: cErr } = live.length
    ? await sb.from('delivery_order_crew').select('do_id, driver_2_id').in('do_id', live)
    : { data: [], error: null };
  if (cErr) throw new Error(cErr.message);
  const d2 = new Map(((crews ?? []) as Array<{ do_id: string; driver_2_id: string | null }>).map((x) => [x.do_id, x.driver_2_id]));
  for (const doId of live) {
    await writeDoCrewRow(sb, companyId, doId, {
      driver1Id: t.driver_id ?? null, driver2Id: d2.get(doId) ?? null,
      helper1Id: t.helper_1_id ?? null, helper2Id: t.helper_2_id ?? null, lorryId: t.lorry_id ?? null,
    }, assignedBy);
  }
  return live.length;
}

/** An order's date moved while it rides a run of ANOTHER day: the run it should
 *  now ride is the same lorry on the new day, so the schedule re-places it there
 *  (the old stop is swept by scheduleOntoTrip). The crew comes along only when
 *  that lorry has no run on the new day yet — an existing run keeps its crew.
 *  null when the order is on no run, or already on one of the new day. */
export async function staleRunOfSo(sb: Sb, companyId: number | null, soDocNo: string, newDate: string): Promise<{ lorryId: string; driverId?: string | null; helper1Id?: string | null; helper2Id?: string | null } | null> {
  const doId = await latestLiveDoIdForSo(sb, companyId, soDocNo);
  const tripId = doId ? await tripOfDo(sb, doId) : null;
  if (!tripId) return null;
  const { data: trip, error } = await sb.from('trips').select('trip_date, lorry_id, driver_id, helper_1_id, helper_2_id').eq('id', tripId).maybeSingle();
  if (error) throw new Error(error.message);
  const t = trip as { trip_date: string | null; lorry_id: string | null; driver_id: string | null; helper_1_id: string | null; helper_2_id: string | null } | null;
  if (!t?.lorry_id || String(t.trip_date ?? '').slice(0, 10) === newDate) return null;
  const { data: there, error: e2 } = await sb.from('trips').select('id').eq('lorry_id', t.lorry_id).eq('trip_date', newDate).neq('status', 'CANCELLED').limit(1);
  if (e2) throw new Error(e2.message);
  if ((there ?? []).length) return { lorryId: t.lorry_id };
  return { lorryId: t.lorry_id, driverId: t.driver_id, helper1Id: t.helper_1_id, helper2Id: t.helper_2_id };
}

/** A DO's crew changed: the lorry run it rides gets the same crew, and so does
 *  every other DO on that run. Returns the trip id, or null when the DO is on no run. */
export async function propagateDoCrewToTrip(sb: Sb, doId: string, seats: CrewSeats, assignedBy: string | null): Promise<string | null> {
  const tripId = await tripOfDo(sb, doId);
  if (!tripId) return null;
  await setTripCrew(sb, tripId, { driverId: seats.driver1Id, helper1Id: seats.helper1Id, helper2Id: seats.helper2Id, lorryId: seats.lorryId });
  await syncTripCrewToDos(sb, tripId, doId, assignedBy);
  return tripId;
}

type SeatPatch = { driverId?: string | null; helper1Id?: string | null; helper2Id?: string | null };
export const hasSeatPatch = (p: SeatPatch): boolean =>
  p.driverId !== undefined || p.helper1Id !== undefined || p.helper2Id !== undefined;

/** A schedule placed an order on a run: crew named in the request goes onto the
 *  run (an existing run included), then the run's crew lands on every DO it
 *  carries, which is what the driver's phone is scoped by. */
export async function applyScheduleCrew(sb: Sb, tripId: string, p: SeatPatch, assignedBy: string | null): Promise<void> {
  if (hasSeatPatch(p)) await setTripCrew(sb, tripId, { driverId: p.driverId, helper1Id: p.helper1Id, helper2Id: p.helper2Id });
  await syncTripCrewToDos(sb, tripId, null, assignedBy);
}

/** Driver / helper picked for an order with no lorry in the request (the bulk
 *  bar, a single cell): written to the order's latest live DO crew, keeping the
 *  other seats, and carried to its run. null when the order has no live DO. */
export async function assignSoCrew(sb: Sb, companyId: number, soDocNo: string, p: SeatPatch, assignedBy: string | null): Promise<{ doId: string; tripId: string | null } | null> {
  const doId = await latestLiveDoIdForSo(sb, companyId, soDocNo);
  if (!doId) return null;
  const { data: before, error } = await sb.from('delivery_order_crew')
    .select('driver_1_id, driver_2_id, helper_1_id, helper_2_id, lorry_id').eq('do_id', doId).maybeSingle();
  if (error) throw new Error(error.message);
  const body: Record<string, unknown> = {};
  if (p.driverId !== undefined) body.driver1Id = p.driverId;
  if (p.helper1Id !== undefined) body.helper1Id = p.helper1Id;
  if (p.helper2Id !== undefined) body.helper2Id = p.helper2Id;
  const seats = resolveCrewSeats(body, (before ?? {}) as Record<string, unknown>);
  await writeDoCrewRow(sb, companyId, doId, seats, assignedBy);
  return { doId, tripId: await propagateDoCrewToTrip(sb, doId, seats, assignedBy) };
}

const stopTypesOfLeg = (leg: string): string[] =>
  Object.entries(ASSR_LEG_BY_STOP).filter(([, l]) => l === leg).map(([t]) => t);

/** Driver / helper edit of a Service Case leg: the crew of the run carrying that
 *  leg changes. null when the leg is on no run yet (a lorry has to be picked first). */
export async function setAssrLegCrew(sb: Sb, caseId: number, jobKind: string, p: SeatPatch): Promise<string | null> {
  const { data, error } = await sb.from('trip_stops').select('trip_id')
    .eq('assr_case_id', caseId).in('stop_type', stopTypesOfLeg(jobKind))
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const tripId = ((data ?? []) as Array<{ trip_id: string | null }>)[0]?.trip_id ?? null;
  if (!tripId) return null;
  await setTripCrew(sb, tripId, p);
  return tripId;
}
