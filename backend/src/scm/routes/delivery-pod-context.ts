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
