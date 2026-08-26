// /loading-list — the WAREHOUSE loading queue (2026-08-25, owner: "仓库线只扫码
// 置 LOADED 不见价格").
//
// The one screen a storekeeper needs to work a shift: which delivery orders are
// waiting to load, WHAT is on each (product + quantity), where it is going, and
// which lorry is taking it — with NO money on it at all. The load action itself
// stays where C1 put it (the scan → PATCH /:id/status LOADED, gated on the
// editable scm.do.load capability); this route is the READ half that tells the
// storekeeper what to scan.
//
// WHY A SEPARATE ROUTE, not a filter on /delivery-orders-mfg. That router gates
// its reads on scm.sales.delivery (inheriting scm.sales.orders), which a pure
// Storekeeper does not hold — their grant is scm.warehouse.inventory +
// scm.transportation (positionPolicy.STOREKEEPER_ROWS). So the queue lives on a
// warehouse-gated mount they already reach, and its projection is a HAND-PICKED
// allowlist with not one `*_sen` / cost column in it: the no-price guarantee is
// structural (the columns are never selected), not a strip applied after the
// fact. loadingListPayloadHasNoMoney.test.ts pins that.
//
// Mounted at '/loading-list' in scm/index.ts behind
// scmAreaGuard('scm.warehouse.inventory').

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { scopeToCompany } from '../lib/companyScope';
import { buildVariantSummary } from '../shared';
import { soLineGroupRank } from '../shared/so-line-display';

export const loadingList = new Hono<{ Bindings: Env; Variables: Variables }>();
// Attach the Supabase (Hyperdrive/PostgREST) client + the pinned scm.staff
// identity, exactly like every other SCM sub-router. Runs AFTER the area guard
// in scm/index.ts (which reads the intact Houzs AuthUser before this replaces
// c.get('user')).
loadingList.use('*', supabaseAuth);

/* HEADER allowlist — identity, customer, destination, schedule, assigned lorry.
   NOTHING priced: no local_total_sen, no per-category revenue/cost, no margin.
   The storekeeper loads goods; the value of those goods is not their business. */
const HEADER =
  'id, do_number, status, debtor_code, debtor_name, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'do_date, customer_delivery_date, expected_delivery_at, ' +
  'driver_name, vehicle, warehouse_id, is_dropship, line_count, branding, note, so_doc_no';

/* LINE allowlist — what to pull and how much of it. item_code + description name
   the product; qty is the count; item_group + variants render the spec via
   buildVariantSummary. unit_price_sen / line_total_sen / *_cost_sen are
   DELIBERATELY absent — a picker does not price the pick. */
const ITEM =
  'id, delivery_order_id, item_code, description, description2, uom, qty, ' +
  'item_group, variants, rack_id';

type HeaderRow = {
  id: string;
  status: string | null;
  vehicle: string | null;
  driver_name: string | null;
  [k: string]: unknown;
};
type ItemRow = {
  id: string;
  delivery_order_id: string;
  item_code: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  rack_id: string | null;
};

// The warehouse cares about two buckets: what still needs loading (DRAFT), and
// what it has already loaded (LOADED, awaiting the truck). A DO that has shipped
// is off the dock, so the queue never reaches past LOADED.
const STATUS_FILTERS: Record<string, string[]> = {
  to_load: ['DRAFT'],
  loaded: ['LOADED'],
  all: ['DRAFT', 'LOADED'],
};

// ── GET /loading-list ────────────────────────────────────────────────────────
// ?status=to_load|loaded|all (default to_load) · ?from / ?to bound the customer
// delivery date. Company-scoped like every SCM document read.
//
// Exported so loadingListPayloadHasNoMoney.test.ts can drive it with a fake
// PostgREST — supabaseAuth cannot run in the vitest harness.
export const loadingListHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase');

  const statusParam = (c.req.query('status') ?? 'to_load').toLowerCase();
  const wanted = STATUS_FILTERS[statusParam] ?? STATUS_FILTERS.to_load;

  let q = sb
    .from('delivery_orders')
    .select(HEADER)
    .in('status', wanted)
    // Soonest-due first; nulls last so an undated backlog DO does not jump the
    // queue. do_number is the stable tiebreaker.
    .order('customer_delivery_date', { ascending: true, nullsFirst: false })
    .order('do_number', { ascending: true })
    .limit(500);
  q = scopeToCompany(q, c); // per-company document — never leak the other company's queue
  const from = c.req.query('from');
  if (from) q = q.gte('customer_delivery_date', from);
  const to = c.req.query('to');
  if (to) q = q.lte('customer_delivery_date', to);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const headers = (data ?? []) as unknown as HeaderRow[];
  if (headers.length === 0) return c.json({ deliveryOrders: [] });

  const ids = headers.map((h) => h.id);
  // Lines (no money) + the crew's assigned lorry, in parallel. The crew table
  // (mig 0053) is the authoritative lorry assignment the Delivery Planning board
  // writes; the header vehicle/driver_name are the older snapshot we fall back
  // to when a DO was never routed through the board.
  const [lineRes, crewRes] = await Promise.all([
    sb.from('delivery_order_items').select(ITEM).in('delivery_order_id', ids),
    sb
      .from('delivery_order_crew')
      .select('do_id, lorry_plate, driver_1_name')
      .in('do_id', ids),
  ]);
  if (lineRes.error) return c.json({ error: 'load_failed', reason: lineRes.error.message }, 500);
  // Crew is a best-effort ENRICHMENT (lorry plate): a failure here must not blank
  // the whole queue, so it is logged and the header snapshot stands in. The line
  // read above is load-bearing (a picker with no lines is useless) and DOES fail
  // the request.
  if (crewRes.error) {
    console.error('[loading-list] crew read failed:', crewRes.error.message);
  }

  const linesByDo = new Map<string, ItemRow[]>();
  for (const l of ((lineRes.data ?? []) as unknown as ItemRow[])) {
    const arr = linesByDo.get(l.delivery_order_id) ?? [];
    arr.push(l);
    linesByDo.set(l.delivery_order_id, arr);
  }
  const crewByDo = new Map<string, { lorry_plate: string | null; driver_1_name: string | null }>();
  for (const cr of ((crewRes.data ?? []) as unknown as Array<{ do_id: string; lorry_plate: string | null; driver_1_name: string | null }>)) {
    crewByDo.set(cr.do_id, { lorry_plate: cr.lorry_plate ?? null, driver_1_name: cr.driver_1_name ?? null });
  }

  const deliveryOrders = headers.map((h) => {
    const crew = crewByDo.get(h.id);
    const lines = (linesByDo.get(h.id) ?? [])
      // Same display order as the DO / SO: mattress/sofa builds first, then
      // bedframe, accessories, service. Stable within a rank.
      .sort((a, b) => soLineGroupRank(a.item_group) - soLineGroupRank(b.item_group))
      .map((l) => ({
        id: l.id,
        itemCode: l.item_code,
        description: l.description,
        description2: l.description2,
        uom: l.uom,
        qty: l.qty,
        variantSummary: buildVariantSummary(l.item_group, l.variants),
        rackId: l.rack_id,
      }));
    return {
      ...h,
      // Prefer the board's lorry assignment; fall back to the header snapshot.
      lorry_plate: crew?.lorry_plate ?? h.vehicle ?? null,
      crew_driver_name: crew?.driver_1_name ?? h.driver_name ?? null,
      loading_lines: lines,
      loading_qty_total: lines.reduce((s, l) => s + (Number(l.qty) || 0), 0),
    };
  });

  return c.json({ deliveryOrders });
};

loadingList.get('/', loadingListHandler);

export default loadingList;
