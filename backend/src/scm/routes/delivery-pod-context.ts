/* The field crew's view of ONE delivery order: whose job it is, and what the
   phone's proof-of-delivery screen shows. Lives apart from delivery-planning.ts
   (the board) so the board file does not grow, and so delivery-orders-mfg.ts can
   reuse the crew lookup without importing the board. */
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { scopeToAllowedCompanies } from '../lib/companyScope';
import { resolveDeliveryScope, scopeMatchesAssignment, type CrewAssignment } from '../lib/deliveryScope';

const NOT_YOUR_JOB = "You can only update a delivery job assigned to you.";

export async function fetchDoCrewAssignment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  doId: string,
): Promise<CrewAssignment> {
  const [doRes, crewRes] = await Promise.all([
    sb.from('delivery_orders').select('driver_id').eq('id', doId).maybeSingle(),
    sb.from('delivery_order_crew').select('driver_1_id, driver_2_id, helper_1_id, helper_2_id').eq('do_id', doId).maybeSingle(),
  ]);
  const d = (doRes?.data ?? {}) as Record<string, unknown>;
  const cr = (crewRes?.data ?? {}) as Record<string, unknown>;
  return {
    driverIds: [
      (d.driverId ?? d.driver_id) as string | null,
      (cr.driver1Id ?? cr.driver_1_id) as string | null,
      (cr.driver2Id ?? cr.driver_2_id) as string | null,
    ],
    helperIds: [
      (cr.helper1Id ?? cr.helper_1_id) as string | null,
      (cr.helper2Id ?? cr.helper_2_id) as string | null,
    ],
  };
}

/* GET /delivery-planning/do/:doId/pod — the proof-of-delivery screen's read for a
   field-crew caller. The DO list/detail routes sit behind scm.sales.delivery,
   which a driver does not hold, so the phone's POD screen could not even load
   the delivery it was standing in front of. This returns only what that screen
   renders, and only for a DO the caller is crewed on (scope 'all' sees any DO
   of the active companies). */
export const doPodContextHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase');
  // The phone opens POD by DO NUMBER (that is what a stop card carries); a UUID
  // is accepted too.
  const doRef = c.req.param('doRef') ?? '';
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(doRef);
  const { data: header, error } = await scopeToAllowedCompanies(
    sb.from('delivery_orders')
      .select('id, do_number, so_doc_no, debtor_name, status, phone, city, state, customer_state, arrival_at, departure_at, pod_r2_key')
      .eq(byId ? 'id' : 'do_number', doRef),
    c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!header) return c.json({ error: 'not_found', reason: 'This delivery order could not be found.' }, 404);
  const doId = (header as { id: string }).id;
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  if (scope.mode !== 'all' && !scopeMatchesAssignment(scope, await fetchDoCrewAssignment(sb, doId)))
    return c.json({ error: 'not_your_job', reason: NOT_YOUR_JOB }, 403);
  const { data: items, error: itemsErr } = await sb.from('delivery_order_items')
    .select('id, so_item_id, description, description2, item_code, qty')
    .eq('delivery_order_id', doId)
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (itemsErr) return c.json({ error: 'load_failed', reason: itemsErr.message }, 500);
  // A line cancelled on its Sales Order is not on the driver's checklist.
  const soItemIds = (items ?? []).map((i: { so_item_id: string | null }) => i.so_item_id).filter(Boolean) as string[];
  const cancelledSoItems = new Set<string>();
  if (soItemIds.length) {
    const { data: soItems, error: soErr } = await sb.from('mfg_sales_order_items')
      .select('id').in('id', soItemIds).eq('cancelled', true);
    if (soErr) return c.json({ error: 'load_failed', reason: soErr.message }, 500);
    for (const s of soItems ?? []) cancelledSoItems.add((s as { id: string }).id);
  }
  return c.json({
    deliveryOrder: header,
    items: (items ?? []).map((i: { so_item_id: string | null }) => ({ ...i, cancelled: !!i.so_item_id && cancelledSoItems.has(i.so_item_id) })),
  });
};

/* A self-scoped caller's OWN Service Case and Project rows on the delivery board
   (the board's row scope matches only SO and DP rows). Returns their row keys.
     assr     the leg's stop sits on a trip the caller is crewed on
              (trip_stops.assr_case_id + stop_type -> leg)
     project  the caller is that leg's driver / helper on the project
              (public user ids — projects keep their own crew) */
const ASSR_LEG_BY_STOP: Record<string, string> = {
  PICKUP: 'customer_pickup', INSPECTION: 'inspection', DELIVERY: 'delivery', SERVICE: 'delivery',
};
export async function ownServiceAndProjectRowKeys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  env: Env,
  scope: { driverIds: ReadonlySet<string>; helperIds: ReadonlySet<string> },
  userId: number,
  rows: Array<{ row_type: string; so_doc_no: string; assr_id?: number | null; job_kind?: string | null; dp_job_type?: string | null }>,
): Promise<Set<string>> {
  const own = new Set<string>();
  const assrRows = rows.filter((r) => r.row_type === 'assr' && r.assr_id != null);
  if (assrRows.length) {
    const ids = [...new Set(assrRows.map((r) => Number(r.assr_id)))];
    const { data: stops, error } = await sb.from('trip_stops').select('assr_case_id, stop_type, trip_id').in('assr_case_id', ids);
    if (error) throw new Error(error.message);
    const tripIds = [...new Set(((stops ?? []) as Array<{ trip_id: string | null }>).map((s) => s.trip_id).filter(Boolean))];
    const { data: trips, error: tErr } = tripIds.length
      ? await sb.from('trips').select('id, driver_id, helper_1_id, helper_2_id').in('id', tripIds)
      : { data: [], error: null };
    if (tErr) throw new Error(tErr.message);
    const mine = new Set(((trips ?? []) as Array<Record<string, string | null>>)
      .filter((t) => scopeMatchesAssignment({ mode: 'self', ...scope }, {
        driverIds: [t.driver_id ?? null], helperIds: [t.helper_1_id ?? null, t.helper_2_id ?? null],
      })).map((t) => t.id));
    const ownLegs = new Set(((stops ?? []) as Array<{ assr_case_id: number; stop_type: string; trip_id: string | null }>)
      .filter((s) => s.trip_id && mine.has(s.trip_id))
      .map((s) => `${s.assr_case_id}#${ASSR_LEG_BY_STOP[s.stop_type] ?? ''}`));
    for (const r of assrRows) if (ownLegs.has(`${r.assr_id}#${r.job_kind}`)) own.add(r.so_doc_no);
  }
  const projectRows = rows.filter((r) => r.row_type === 'project' && r.so_doc_no.startsWith('PRJ:'));
  if (projectRows.length && Number.isFinite(userId)) {
    const ids = [...new Set(projectRows.map((r) => Number(r.so_doc_no.slice(4).split('#')[0])))].filter(Number.isFinite);
    // company-scope: crew lookup for project ids already on the caller's board, which reads projects across companies on purpose (delivery-planning.ts project rows)
    const res = await env.DB.prepare(
      `SELECT id, setup_driver_user_id, setup_helper_1_id, setup_helper_2_id,
              dismantle_driver_user_id, dismantle_helper_1_id, dismantle_helper_2_id
         FROM projects WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all<Record<string, number | null>>();
    const byId = new Map((res.results ?? []).map((p) => [Number(p.id), p]));
    for (const r of projectRows) {
      const [id, leg] = r.so_doc_no.slice(4).split('#');
      const p = byId.get(Number(id));
      if (!p) continue;
      const crew = leg === 'SETUP'
        ? [p.setup_driver_user_id, p.setup_helper_1_id, p.setup_helper_2_id]
        : [p.dismantle_driver_user_id, p.dismantle_helper_1_id, p.dismantle_helper_2_id];
      if (crew.some((v) => v != null && Number(v) === userId)) own.add(r.so_doc_no);
    }
  }
  return own;
}

/* GET /delivery-orders-mfg/:id/pod-photo — the proof-of-delivery photo of one DO,
   for anyone who may read that DO (the route's area guard) in its company. The
   photo sits in the shared houzs-erp bucket under the key the POD stored; no
   page could show it before, so a delivered DO read as if it had no evidence. */
export const doPodPhotoHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase');
  const { data, error } = await scopeToAllowedCompanies(
    sb.from('delivery_orders').select('pod_r2_key').eq('id', c.req.param('id') ?? ''), c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const key = (data as { pod_r2_key: string | null } | null)?.pod_r2_key;
  if (!key) return c.json({ error: 'not_found', reason: 'This delivery order has no POD photo.' }, 404);
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: 'not_found', reason: 'The POD photo file is missing from storage.' }, 404);
  return new Response(obj.body, {
    headers: { 'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg', 'cache-control': 'private, max-age=300' },
  });
};
