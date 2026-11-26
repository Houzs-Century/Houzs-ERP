// ---------------------------------------------------------------------------
// dp-orders.ts — the DP Order (delivery-planning job) route.
//
// Owner spec 2026-07-18. Six job types, each auto-filling its party from a
// different master (scm/lib/dp-party.ts does the mapping); one flat snapshot in
// scm.dp_orders (mig 0129). The DP number is minted at SCHEDULE from the assigned
// lorry's plate + the trip date (scm/lib/dp-no.ts) — "schedule then DP number".
//
// Mounted at /api/scm/dp-orders. Reads scm.* via the PostgREST client and the
// PMS/service masters (public.projects / users / assr_cases) via c.env.DB raw
// SQL, exactly as delivery-planning.ts does for the ASSR union.
// ---------------------------------------------------------------------------

import { POSTCODE_REQUIRED_JOB_TYPES } from '../shared/dp-postcode-rule';
import { yymmFor } from '../../services/documentRefs';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../env';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
import {
  activeCompanyId,
  requireActiveCompanyId,
  scopeToCompanyId,
  scopeToAllowedCompanies,
  NOT_THIS_COMPANY,
} from '../lib/companyScope';
import {
  partyTypeFor, emptySnapshot, snapshotFromSo, snapshotFromSupplier,
  snapshotFromProject, snapshotFromAssr, snapshotFromWarehouse, snapshotFromThreepl,
  snapshotFromSavedLocation, snapshotFromWorkshop, snapshotFromWorkshopName,
  type DpJobType, type DpPartySnapshot,
} from '../lib/dp-party';
import { PROJECT_VENUE_COLS, PROJECT_VENUE_JOIN } from '../lib/project-venue-join';
import { assertTripInAllowedCompanies } from '../lib/ref-in-company';
import { mintNextDpNo, plateForLorry } from '../lib/dp-no-mint';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { setTripCrew } from '../lib/trip-crew-sync';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { dpLorryBlockReason } from '../lib/dp-lorry-block';
import { normalizePhone } from '../shared/phone';
import {
  resolveDeliveryScope, scopeMatchesAssignment,
  type CrewAssignment, type DeliveryScope,
} from '../lib/deliveryScope';
import { supabaseAuth } from '../middleware/auth';
import { ADDRESS_COLS } from '../lib/so-address-on-save';
import {
  dpDestFields, dpFromFields, fillDpRowsPostcode, fillPostcodeFields, localitiesForPostcodes,
  postcodesToLookUp, type PostcodeFields,
} from '../lib/postcode-from-address';

export const dpOrders = new Hono<{ Bindings: Env; Variables: Variables }>();

dpOrders.use('*', supabaseAuth);


const NOT_YOUR_JOB = 'You can only act on a delivery job assigned to you.';

const EMPTY_CREW: CrewAssignment = { driverIds: [], helperIds: [] };

async function tripCrewByIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  tripIds: Array<string | null | undefined>,
): Promise<Map<string, CrewAssignment>> {
  const out = new Map<string, CrewAssignment>();
  const ids = [...new Set(tripIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return out;
  const { data } = await sb.from('trips')
    .select('id, driver_id, helper_1_id, helper_2_id')
    .in('id', ids);
  for (const t of (data ?? []) as Array<Record<string, unknown>>) {
    const id = String(t.id ?? '');
    if (!id) continue;
    out.set(id, {
      driverIds: [(t.driverId ?? t.driver_id) as string | null],
      helperIds: [(t.helper1Id ?? t.helper_1_id) as string | null, (t.helper2Id ?? t.helper_2_id) as string | null],
    });
  }
  return out;
}

/** The minimal DP-row shape the scope filter reads — just the trip link. */
export interface DpRowLike { trip_id?: string | null; tripId?: string | null }

/** Keep only the DP orders visible to `scope`. `all` (every ops/dispatcher/
 *  management caller) → rows unchanged. `self` (a linked Driver/Helper) → only
 *  the rows whose trip crew includes the caller's fleet id; a DP order with no
 *  trip never matches. Pure + exported so the visibility rule is unit-testable. */
export function filterDpOrdersByScope<T extends DpRowLike>(
  scope: DeliveryScope,
  rows: T[],
  tripCrewById: Map<string, CrewAssignment>,
): T[] {
  if (scope.mode === 'all') return rows;
  return rows.filter((r) => {
    const tid = (r.trip_id ?? r.tripId) ?? null;
    const crew = (tid && tripCrewById.get(String(tid))) || EMPTY_CREW;
    return scopeMatchesAssignment(scope, crew);
  });
}

async function denyIfNotOwnDpJob(
  c: Ctx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  id: string,
): Promise<Response | null> {
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  if (scope.mode === 'all') return null;
  const { data } = await sb.from('dp_orders').select('trip_id').eq('id', id).maybeSingle();
  if (!data) return null;
  const tid = ((data as DpRowLike).trip_id ?? (data as DpRowLike).tripId) ?? null;
  const crew = (tid && (await tripCrewByIds(sb, [tid])).get(String(tid))) || EMPTY_CREW;
  if (scopeMatchesAssignment(scope, crew)) return null;
  return c.json({ error: NOT_YOUR_JOB }, 403);
}

const JOB_TYPES = [
  'DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP', 'INSPECTION',
  // Job types 8 and 9 (mig 0250, owner's 2026-08-03 list).
  'TRANSFER', 'LORRY_SERVICE',
] as const;

const createSchema = z.object({
  jobType: z.enum(JOB_TYPES),
  soDocNo: z.string().optional(),
  doId: z.string().uuid().optional(),
  assrCaseId: z.number().int().optional(),
  supplierId: z.string().uuid().optional(),
  projectId: z.number().int().optional(),
  stockTransferId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  // TRANSFER to an OUTSOURCED warehouse (owner 2026-11-02): the destination is a
  // 3PL company we don't own, so it is picked from the carrier master instead of
  // scm.warehouses. Mutually exclusive with warehouseId in the UI. Column: mig
  // 20261102T1300.
  threeplCompanyId: z.string().uuid().optional(),
  // TRANSFER destination picked from the saved-locations address book (owner
  // 2026-11-02 方案2). Mutually exclusive with warehouseId / threeplCompanyId in
  // the UI. Column: mig 20261102T1700.
  savedLocationId: z.string().uuid().optional(),
  lorryId: z.string().uuid().optional(),
  workshopId: z.string().uuid().optional(),
  workOrderId: z.string().uuid().optional(),
  // TRANSFER ORIGIN ("from where", owner 2026-11-02 方案1): the pickup point the
  // fleet loads from — our warehouse, an outsourced 3PL, or a saved location (方案2),
  // picked the same way as the destination. Optional: only a move between two chosen
  // points sets it. Columns: mig 20261102T1500 / 20261102T1700.
  fromWarehouseId: z.string().uuid().optional(),
  fromThreeplCompanyId: z.string().uuid().optional(),
  fromSavedLocationId: z.string().uuid().optional(),
  fromOverrides: z.record(z.string(), z.string().nullable()).optional(),
  requestedDate: z.string().optional(),
  remark: z.string().optional(),
  salesAmountSen: z.number().int().min(0).max(100_000_000_00).nullable().optional(),
  overrides: z.record(z.string(), z.string().nullable()).optional(),
});

/* Owner 2026-10-05: a job with no address cannot be saved. A street line is
   the address; city / postcode / state alone do not tell a driver where to go.
   Every job type is held to it — TRANSFER and LORRY_SERVICE get theirs from the
   warehouse / workshop master, and the operator types it when that is blank. */
const ADDRESS_LINES = ADDRESS_COLS;
const hasAddress = (row: Record<string, unknown>): boolean =>
  ADDRESS_LINES.some((k) => String(row[k] ?? '').trim() !== '');
const ADDRESS_REQUIRED = {
  error: 'address_required',
  message: 'A delivery job needs an address. Fill in the address before saving.',
};

/* Owner 2026-11-17: a supplier such as HOOKKA keeps its postcode inside the
   address text with the postcode / state columns empty, so the job showed a dash
   and fell out of every region. An empty postcode is taken from the one known
   postcode written in the address, and an empty state / city from that postcode
   (scm/lib/postcode-from-address.ts). Returns only the columns it fills. */
async function detectedPostcodeCols(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped scm client, as across this route
  sb: any, sets: Array<{ fields: PostcodeFields; cols: { postcode: string; state: string; city: string } }>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const lookups = sets.flatMap((x) => postcodesToLookUp(x.fields));
  if (lookups.length === 0) return out;
  const known = await localitiesForPostcodes(sb, lookups);
  for (const { fields, cols } of sets) {
    const fill = fillPostcodeFields(fields, known);
    const blank = (v: unknown) => v == null || String(v).trim() === '';
    if (blank(fields.postcode) && fill.postcode) out[cols.postcode] = fill.postcode;
    if (blank(fields.state) && fill.state) out[cols.state] = fill.state;
    if (blank(fields.city) && fill.city) out[cols.city] = fill.city;
  }
  return out;
}
const DEST_COLS = { postcode: 'postcode', state: 'state', city: 'city' };

/* Owner 2026-11-17: the postcode is compulsory, checked AFTER detection so a
   master that writes it only in the address passes without typing. Which job
   types: ../shared/dp-postcode-rule.ts. */
export { POSTCODE_REQUIRED_JOB_TYPES };
const POSTCODE_REQUIRED = {
  error: 'postcode_required',
  message: 'A delivery job needs a postcode. Type the postcode, or write it in the address.',
};
const hasPostcode = (row: Record<string, unknown>): boolean => String(row.postcode ?? '').trim() !== '';
const FROM_COLS = { postcode: 'from_postcode', state: 'from_state', city: 'from_city' };

const dpStopAddress = (dp: Record<string, unknown>): string | null =>
  [dp.address1, dp.address2, dp.address3, dp.address4, dp.city, dp.postcode, dp.state]
    .filter(Boolean).join(', ') || null;

/* A service case keeps no postcode; its sales order does (owner 2026-11-17).
   The SO is matched the way the board's ASSR union matches it (doc_no, else the
   AutoCount linked_ac_docno), inside the caller's companies. No SO, or an SO
   without one, leaves the postcode to detection from the case address. */
async function withCaseSoPlace(c: Ctx, snap: DpPartySnapshot, docNo: string | null): Promise<DpPartySnapshot> {
  if (!docNo) return snap;
  const sb = c.get('supabase');
  let so: Record<string, unknown> | null = null;
  for (const col of ['doc_no', 'linked_ac_docno']) {
    const { data, error } = await scopeToAllowedCompanies(
      sb.from('mfg_sales_orders').select('city, postcode, customer_state').eq(col, docNo).limit(1), c,
    ).maybeSingle();
    if (error) throw error;
    if (data) { so = data as Record<string, unknown>; break; }
  }
  if (!so) return snap;
  const t = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  return {
    ...snap,
    postcode: t(so.postcode) ?? snap.postcode,
    state: t(so.customer_state) ?? snap.state,
    city: snap.city ?? t(so.city),
  };
}

async function resolveSnapshot(
  c: Ctx,
  jobType: DpJobType,
  p: z.infer<typeof createSchema>,
): Promise<DpPartySnapshot> {
  const sb = c.get('supabase');
  if (p.soDocNo) {
    const { data } = await sb.from('mfg_sales_orders')
      .select('debtor_name, phone, address1, address2, address3, address4, city, postcode, customer_state')
      .eq('doc_no', p.soDocNo).maybeSingle();
    if (data) return snapshotFromSo(data as Record<string, unknown>);
  }
  if (p.supplierId) {
    const { data } = await sb.from('suppliers')
      .select('name, contact_person, attention, phone, mobile, address, address1, address2, address3, address4, city, postcode, state')
      .eq('id', p.supplierId).maybeSingle();
    if (data) return snapshotFromSupplier(data as Record<string, unknown>);
  }
  if (p.projectId != null) {
    const proj = await c.env.DB.prepare(
      `SELECT p.venue, p.venue_address, p.organizer, p.state, p.pic_id, ${PROJECT_VENUE_COLS}
         FROM projects p ${PROJECT_VENUE_JOIN} WHERE p.id = ?`,
    ).bind(p.projectId).first<Record<string, unknown>>();
    if (proj) {
      let picUser: Record<string, unknown> | null = null;
      if (proj.pic_id != null) {
        picUser = await c.env.DB.prepare('SELECT name, phone FROM users WHERE id = ?')
          .bind(proj.pic_id).first<Record<string, unknown>>();
      }
      return snapshotFromProject(proj, picUser);
    }
  }
  if (p.assrCaseId != null) {
    const a = await c.env.DB.prepare(
      'SELECT customer_name, phone, addr1, addr2, addr3, addr4, location, doc_no, ca.postcode, ca.city, ca.state FROM assr_cases LEFT JOIN assr_case_address ca ON ca.assr_id = assr_cases.id WHERE assr_cases.id = ?',
    ).bind(p.assrCaseId).first<Record<string, unknown>>();
    if (a) {
      const snap = await withCaseSoPlace(c, snapshotFromAssr(a), (a.doc_no as string | null) ?? null);
      const own = (v: unknown) => (v == null || String(v).trim() === '' ? null : String(v).trim());
      return { ...snap, postcode: own(a.postcode) ?? snap.postcode, city: own(a.city) ?? snap.city, state: own(a.state) ?? snap.state };
    }
  }
  /* TRANSFER destination from the saved-locations address book (owner 2026-11-02
     方案2). Checked first so a picked saved location wins; its structured address
     fills the snapshot. Error bound, never swallowed. */
  if (p.savedLocationId) {
    const { data, error } = await sb.from('saved_locations')
      .select('name, contact_name, contact_phone, address1, address2, city, postcode, state')
      .eq('id', p.savedLocationId).maybeSingle();
    if (error) throw error;
    if (data) return snapshotFromSavedLocation(data as Record<string, unknown>);
  }
  /* TRANSFER to an OUTSOURCED warehouse (owner 2026-11-02): the destination is a
     3PL company, not one of our warehouses. Checked before the warehouse branch
     so a 3PL pick wins outright; its single free-text address fills the snapshot
     and party_type stays WAREHOUSE. */
  if (p.threeplCompanyId) {
    const { data, error } = await sb.from('threepl_companies')
      .select('code, name, contact_name, contact_phone, office_phone, address, postcode, city, state')
      .eq('id', p.threeplCompanyId).maybeSingle();
    if (error) throw error;
    if (data) return snapshotFromThreepl(data as Record<string, unknown>);
  }
  if (p.warehouseId || p.stockTransferId) {
    let warehouseId = p.warehouseId ?? null;
    if (!warehouseId && p.stockTransferId) {
      const { data: tr } = await sb.from('stock_transfers')
        .select('to_warehouse_id').eq('id', p.stockTransferId).maybeSingle();
      warehouseId = (tr as { to_warehouse_id?: string } | null)?.to_warehouse_id ?? null;
    }
    if (warehouseId) {
      const { data } = await sb.from('warehouses')
        .select('code, name, location, city, postcode, state')
        .eq('id', warehouseId).maybeSingle();
      if (data) return snapshotFromWarehouse(data as Record<string, unknown>);
    }
  }
  if (p.workshopId || p.workOrderId) {
    let workshopId = p.workshopId ?? null;
    let workshopText: unknown = null;
    if (!workshopId && p.workOrderId) {
      const { data: wo } = await sb.from('lorry_work_orders')
        .select('workshop_id, workshop').eq('id', p.workOrderId).maybeSingle();
      const row = wo as { workshop_id?: string | null; workshop?: string | null } | null;
      workshopId = row?.workshop_id ?? null;
      workshopText = row?.workshop ?? null;
    }
    if (workshopId) {
      const { data } = await sb.from('workshops')
        .select('code, name, contact_name, contact_phone, office_phone, address')
        .eq('id', workshopId).maybeSingle();
      if (data) return snapshotFromWorkshop(data as Record<string, unknown>);
    }
    if (workshopText) return snapshotFromWorkshopName(workshopText);
  }
  return emptySnapshot(jobType);
}

/** Resolve the ORIGIN ("from") snapshot for a TRANSFER (owner 2026-11-02 方案1) —
 *  our warehouse or a 3PL carrier, the same two masters the destination draws on,
 *  else an empty snapshot the operator types over. Errors are bound and surfaced,
 *  never swallowed (a read blip must not silently drop the pickup point). */
async function resolveOrigin(c: Ctx, p: z.infer<typeof createSchema>): Promise<DpPartySnapshot> {
  const sb = c.get('supabase');
  if (p.fromSavedLocationId) {
    const { data, error } = await sb.from('saved_locations')
      .select('name, contact_name, contact_phone, address1, address2, city, postcode, state')
      .eq('id', p.fromSavedLocationId).maybeSingle();
    if (error) throw error;
    if (data) return snapshotFromSavedLocation(data as Record<string, unknown>);
  }
  if (p.fromThreeplCompanyId) {
    const { data, error } = await sb.from('threepl_companies')
      .select('code, name, contact_name, contact_phone, office_phone, address, postcode, city, state')
      .eq('id', p.fromThreeplCompanyId).maybeSingle();
    if (error) throw error;
    if (data) return snapshotFromThreepl(data as Record<string, unknown>);
  }
  if (p.fromWarehouseId) {
    const { data, error } = await sb.from('warehouses')
      .select('code, name, location, city, postcode, state')
      .eq('id', p.fromWarehouseId).maybeSingle();
    if (error) throw error;
    if (data) return snapshotFromWarehouse(data as Record<string, unknown>);
  }
  return emptySnapshot('TRANSFER');
}

dpOrders.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  const jobType = p.jobType as DpJobType;

  const snap = await resolveSnapshot(c, jobType, p);
  const merged: Record<string, unknown> = { ...snap };
  for (const [k, v] of Object.entries(p.overrides ?? {})) {
    if (k in merged) merged[k] = v;
  }
  if (!hasAddress(merged)) return c.json(ADDRESS_REQUIRED, 400);

  const fromSnap = jobType === 'TRANSFER' ? await resolveOrigin(c, p) : emptySnapshot('TRANSFER');
  const fromMerged: Record<string, unknown> = { ...fromSnap };
  for (const [k, v] of Object.entries(p.fromOverrides ?? {})) {
    if (k in fromMerged) fromMerged[k] = v;
  }

  const sb = c.get('supabase');
  const user = c.get('user') as { id?: string } | null;
  const insert = {
    company_id: activeCompanyId(c) ?? null,
    dp_no: null,
    job_type: jobType,
    party_type: partyTypeFor(jobType),
    so_doc_no: p.soDocNo ?? null,
    do_id: p.doId ?? null,
    sales_amount_sen: p.salesAmountSen ?? null,
    assr_case_id: p.assrCaseId ?? null,
    supplier_id: p.supplierId ?? null,
    project_id: p.projectId ?? null,
    stock_transfer_id: p.stockTransferId ?? null,
    warehouse_id: p.warehouseId ?? null,
    threepl_company_id: p.threeplCompanyId ?? null,
    saved_location_id: p.savedLocationId ?? null,
    lorry_id: p.lorryId ?? null,
    workshop_id: p.workshopId ?? null,
    work_order_id: p.workOrderId ?? null,
    party_name: merged.party_name ?? null,
    contact_name: merged.contact_name ?? null,
    contact_phone: normDpPhone(merged.contact_phone),
    address1: merged.address1 ?? null, address2: merged.address2 ?? null,
    address3: merged.address3 ?? null, address4: merged.address4 ?? null,
    city: merged.city ?? null, postcode: merged.postcode ?? null, state: merged.state ?? null,
    from_name: fromMerged.party_name ?? null,
    from_address1: fromMerged.address1 ?? null, from_address2: fromMerged.address2 ?? null,
    from_city: fromMerged.city ?? null, from_postcode: fromMerged.postcode ?? null, from_state: fromMerged.state ?? null,
    from_warehouse_id: p.fromWarehouseId ?? null,
    from_threepl_company_id: p.fromThreeplCompanyId ?? null,
    from_saved_location_id: p.fromSavedLocationId ?? null,
    requested_date: dateOrNull(p.requestedDate),
    status: 'PENDING_SCHEDULE',
    remark: p.remark ?? null,
    created_by: user?.id ?? null,
  };
  Object.assign(insert, await detectedPostcodeCols(sb, [
    { fields: dpDestFields(insert), cols: DEST_COLS },
    ...(jobType === 'TRANSFER' ? [{ fields: dpFromFields(insert), cols: FROM_COLS }] : []),
  ]));
  if (POSTCODE_REQUIRED_JOB_TYPES.has(jobType) && !hasPostcode(insert)) return c.json(POSTCODE_REQUIRED, 400);
  const { data, error } = await sb.from('dp_orders').insert(insert).select('*').maybeSingle();
  if (error) return c.json({ error: 'create_failed', reason: error.message }, 500);
  return c.json({ dpOrder: data }, 201);
});

/* ── GET /api/scm/dp-orders — list ──────────────────────────────────────────
   Cross-company VIEW module (see the module header): widen to the caller's
   allowed set via scopeToAllowedCompanies rather than a manual per-active-
   company filter. Owner audit 2026-07-22: the previous
   `if (companyId != null) …` was FAIL-OPEN on cold-start (unresolved company)
   which would leak every company's dp_orders to any caller during a brief
   pre-migration / master-blip window. scopeToAllowedCompanies handles the
   three-state gate correctly (unresolved → degrade to no predicate for
   single-company installs; restricted-to-nothing → empty). */
dpOrders.get('/', async (c) => {
  const sb = c.get('supabase');
  const status = c.req.query('status');
  let q = sb.from('dp_orders').select('*').order('created_at', { ascending: false }).limit(500);
  if (status) q = q.eq('status', status);
  q = scopeToAllowedCompanies(q, c);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const rows = (data ?? []) as Array<Record<string, unknown> & DpRowLike>;
  await fillDpRowsPostcode(sb, rows);

  /* Sales context off the source SO (owner 2026-08-19, parity with the planning
     board's Salesperson / Venue / Processing Date / Total Amount columns): an
     SO-sourced job answers them from its SO, batch-read once by doc_no (TEXT PK,
     ≤500 rows so one .in() is bounded). Manual / supplier / project / case rows
     have no SO → the so_* fields stay null and the list renders a dash. A failed
     SO read degrades to null rather than 500ing the registry. */
  {
    const docNos = [...new Set(rows
      .map((r) => ((r.soDocNo ?? r.so_doc_no) as string | null) ?? null)
      .filter((x): x is string => !!x))];
    const soByDoc = new Map<string, Record<string, unknown>>();
    if (docNos.length > 0) {
      const { data: soRows, error: soErr } = await sb.from('mfg_sales_orders')
        .select('doc_no, agent, salesperson_id, venue, processing_date, local_total_sen')
        .in('doc_no', docNos);
      if (soErr) {
        console.error('[dp-orders] sales-context SO read failed; so_* fields degrade to null:', soErr.message);
      }
      for (const s of (soRows ?? []) as Array<Record<string, unknown>>) {
        const doc = String(s.docNo ?? s.doc_no ?? '');
        if (doc) soByDoc.set(doc, s);
      }
    }
    for (const r of rows) {
      const s = soByDoc.get(String((r.soDocNo ?? r.so_doc_no) ?? ''));
      r.so_agent = (s?.agent as string | null) ?? null;
      r.so_salesperson_id = ((s?.salespersonId ?? s?.salesperson_id) as string | null) ?? null;
      r.so_venue = (s?.venue as string | null) ?? null;
      r.so_processing_date = ((s?.processingDate ?? s?.processing_date) as string | null) ?? null;
      r.so_total_sen = s ? Number((s.localTotalSen ?? s.local_total_sen) ?? 0) : null;
    }
  }
  if (scope.mode === 'all') return c.json({ dpOrders: rows });
  const tripCrew = await tripCrewByIds(sb, rows.map((r) => (r.trip_id ?? r.tripId) ?? null));
  return c.json({ dpOrders: filterDpOrdersByScope(scope, rows, tripCrew) });
});

/* ── PATCH /api/scm/dp-orders/:id — edit a job ─────────────────────────────────
   The party, contact, address, postcode / state and remark can be corrected at
   any status except CANCELLED (owner 2026-11-17: a scheduled supplier pickup
   showed no postcode and could not be fixed). When the job rides a trip, that
   stop's address snapshot follows, so the driver's manifest shows the fix.
   The requested date stays PENDING_SCHEDULE only: once a DP number is minted the
   date is on a manifest, and changing it silently is the "silent date change"
   the spec forbids. Cancel and raise a new one instead. */
const patchSchema = z.object({
  partyName: z.string().nullable().optional(),
  contactName: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  address1: z.string().nullable().optional(),
  address2: z.string().nullable().optional(),
  address3: z.string().nullable().optional(),
  address4: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  postcode: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  // Origin ("from") fields — TRANSFER only, editable like the destination (owner
  // 2026-11-02 方案1). Null clears a line; the address-required check guards the
  // DESTINATION only, so the origin may be blank.
  fromName: z.string().nullable().optional(),
  fromAddress1: z.string().nullable().optional(),
  fromAddress2: z.string().nullable().optional(),
  fromCity: z.string().nullable().optional(),
  fromPostcode: z.string().nullable().optional(),
  fromState: z.string().nullable().optional(),
  requestedDate: z.string().nullable().optional(),
  remark: z.string().nullable().optional(),
  salesAmountSen: z.number().int().min(0).max(100_000_000_00).nullable().optional(),
});

const normDpPhone = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  if (!s) return null;
  return normalizePhone(s) ?? s;
};

const PATCH_COLS: Record<keyof z.infer<typeof patchSchema>, string> = {
  partyName: 'party_name', contactName: 'contact_name', contactPhone: 'contact_phone',
  address1: 'address1', address2: 'address2', address3: 'address3', address4: 'address4',
  city: 'city', postcode: 'postcode', state: 'state',
  fromName: 'from_name', fromAddress1: 'from_address1', fromAddress2: 'from_address2',
  fromCity: 'from_city', fromPostcode: 'from_postcode', fromState: 'from_state',
  requestedDate: 'requested_date', remark: 'remark', salesAmountSen: 'sales_amount_sen',
};

export const EDITABLE_ANY_STATUS = new Set([
  'party_name', 'contact_name', 'contact_phone',
  'address1', 'address2', 'address3', 'address4', 'city', 'postcode', 'state',
  'from_name', 'from_address1', 'from_address2', 'from_city', 'from_postcode', 'from_state',
  'remark', 'sales_amount_sen',
]);

/** Why this edit is refused at this status, or null when it may go ahead. PURE. */
export function dpEditRefusal(status: string | null, changedCols: readonly string[]): string | null {
  if (status === 'CANCELLED') return 'A cancelled job cannot be edited.';
  if (status === 'PENDING_SCHEDULE') return null;
  const locked = changedCols.filter((col) => !EDITABLE_ANY_STATUS.has(col));
  return locked.length === 0
    ? null
    : 'A scheduled job keeps its date. Only its contact, address, postcode, state, remark and sales amount can be changed.';
}

const ADDRESSISH = ['party_name', ...ADDRESS_LINES, 'city', 'postcode', 'state'];
const FROM_ADDRESSISH = ['from_address1', 'from_address2', 'from_city', 'from_postcode', 'from_state'];

dpOrders.patch('/:id', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, col] of Object.entries(PATCH_COLS)) {
    const v = (parsed.data as Record<string, unknown>)[k];
    if (v !== undefined) updates[col] = v;
  }
  if (updates.contact_phone !== undefined) updates.contact_phone = normDpPhone(updates.contact_phone);
  coerceEmptyDates(updates);
  if (Object.keys(updates).length === 1) return c.json({ error: 'no_changes' }, 400);
  const changedCols = Object.keys(updates).filter((k) => k !== 'updated_at');

  const sb = c.get('supabase');
  // Company scope (owner audit 2026-07-22): denyIfNotOwnDpJob only guards
  // field-crew; ops/dispatch/manager callers bypass, so id-only WHERE would
  // let a caller in A edit B's dp_order details by knowing the UUID.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const denied = await denyIfNotOwnDpJob(c, sb, id);
  if (denied) return denied;

  const { data: curData, error: curErr } = await scopeToCompanyId(
    sb.from('dp_orders').select(
      'status, job_type, trip_stop_id, party_name, address1, address2, address3, address4, city, postcode, state, from_address1, from_address2, from_city, from_postcode, from_state',
    ).eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (curErr) return c.json({ error: 'load_failed', reason: curErr.message }, 500);
  if (!curData) return c.json({ error: 'not_found' }, 404);
  const cur = curData as Record<string, unknown>;
  const refusal = dpEditRefusal((cur.status as string | null) ?? null, changedCols);
  if (refusal) return c.json({ error: 'not_editable', message: refusal }, 409);

  if (ADDRESS_LINES.some((k) => updates[k] !== undefined) && !hasAddress({ ...cur, ...updates })) {
    return c.json(ADDRESS_REQUIRED, 400);
  }
  const merged = { ...cur, ...updates };
  const touched = (cols: string[]) => cols.some((k) => updates[k] !== undefined);
  Object.assign(updates, await detectedPostcodeCols(sb, [
    ...(touched(ADDRESSISH) ? [{ fields: dpDestFields(merged), cols: DEST_COLS }] : []),
    ...(touched(FROM_ADDRESSISH) && cur.job_type === 'TRANSFER' ? [{ fields: dpFromFields(merged), cols: FROM_COLS }] : []),
  ]));
  if (POSTCODE_REQUIRED_JOB_TYPES.has(String(cur.job_type ?? '')) && touched([...ADDRESS_LINES, 'city', 'postcode', 'state'])
    && !hasPostcode({ ...merged, ...updates })) {
    return c.json(POSTCODE_REQUIRED, 400);
  }

  const pendingOnly = changedCols.some((col) => !EDITABLE_ANY_STATUS.has(col));
  const base = sb.from('dp_orders').update(updates).eq('id', id);
  const { data, error } = await scopeToCompanyId(
    pendingOnly ? base.eq('status', 'PENDING_SCHEDULE') : base.neq('status', 'CANCELLED'),
    co.companyId,
  ).select('*').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) {
    return c.json({ error: 'not_editable', message: 'This job changed while you were editing it. Reload and try again.' }, 409);
  }

  const row = data as Record<string, unknown>;
  const stopId = (row.trip_stop_id as string | null) ?? null;
  let tripStop: { updated: boolean; failed: boolean; reason?: string } = { updated: false, failed: false };
  if (stopId && touched(ADDRESSISH)) {
    const { error: stopErr } = await scopeToCompanyId(
      sb.from('trip_stops').update({ address: dpStopAddress(row), customer_name: (row.party_name as string | null) ?? null }).eq('id', stopId),
      co.companyId,
    );
    tripStop = stopErr ? { updated: false, failed: true, reason: stopErr.message } : { updated: true, failed: false };
  }
  return c.json({ dpOrder: row, tripStop });
});

dpOrders.get('/:id', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  const { data, error } = await scopeToAllowedCompanies(
    sb.from('dp_orders').select('*').eq('id', id), c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found' }, 404);
  const denied = await denyIfNotOwnDpJob(c, sb, id);
  if (denied) return denied;
  const row = data as Record<string, unknown>;
  await fillDpRowsPostcode(sb, [row]);
  return c.json({ dpOrder: row });
});

dpOrders.post('/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const sb = c.get('supabase');
  // Company scope (owner audit 2026-07-22): same class as PATCH above.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const denied = await denyIfNotOwnDpJob(c, sb, id);
  if (denied) return denied;

  const { data, error } = await scopeToCompanyId(
    sb.from('dp_orders')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .eq('id', id).neq('status', 'CANCELLED'),
    co.companyId,
  ).select('*').maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found_or_already_cancelled' }, 409);

  let stopRemoved: { removed: boolean; failed: boolean; reason?: string } = { removed: false, failed: false };
  const stopId = (data as { trip_stop_id?: string | null }).trip_stop_id ?? null;
  if (stopId) {
    try {
      const del = await scopeToAllowedCompanies(sb.from('trip_stops').delete().eq('id', stopId), c);
      stopRemoved = del.error
        ? { removed: false, failed: true, reason: del.error.message }
        : { removed: true, failed: false };
    } catch (e) {
      stopRemoved = { removed: false, failed: true, reason: String((e as Error)?.message ?? e).slice(0, 140) };
    }
  }

  let lorryUnblocked: { removed: boolean; failed: boolean; reason?: string } = { removed: false, failed: false };
  const dc = data as Record<string, unknown>;
  const cancelledLorryId = (dc.lorry_id ?? (dc as { lorryId?: string | null }).lorryId) as string | null ?? null;
  const cancelledDpNo = (dc.dp_no ?? (dc as { dpNo?: string | null }).dpNo) as string | null ?? null;
  if (String(dc.job_type ?? '') === 'LORRY_SERVICE' && cancelledLorryId && cancelledDpNo) {
    try {
      const del = await sb.from('lorry_maintenance').delete()
        .eq('lorry_id', cancelledLorryId)
        .eq('reason', dpLorryBlockReason(cancelledDpNo));
      lorryUnblocked = del.error
        ? { removed: false, failed: true, reason: del.error.message }
        : { removed: true, failed: false };
    } catch (e) {
      lorryUnblocked = { removed: false, failed: true, reason: String((e as Error)?.message ?? e).slice(0, 140) };
    }
  }
  return c.json({ dpOrder: data, stopRemoved, lorryUnblocked });
});

const scheduleSchema = z.object({
  lorryId: z.string().uuid(),
  tripDate: z.string(),
  tripId: z.string().uuid().optional(),
  // The driver for the run (owner 2026-10-30: pick the driver when scheduling, so
  // Driver + Lorry fill in on the board). Optional — the run can be crewed later.
  driverId: z.string().uuid().nullable().optional(),
});

async function resolveScheduleTrip(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono ctx + the untyped scm client, as across this route
  c: any, sb: any, lorryId: string | null, tripDate: string, namedTripId: string | null,
): Promise<{ tripId: string } | { error: string }> {
  if (namedTripId) return { tripId: namedTripId };
  if (lorryId) {
    const { data: found, error: fErr } = await scopeToAllowedCompanies(
      sb.from('trips').select('id').eq('lorry_id', lorryId).eq('trip_date', tripDate).neq('status', 'CANCELLED').limit(1), c,
    );
    if (fErr) return { error: fErr.message };
    const hit = ((found ?? []) as Array<{ id: string }>)[0];
    if (hit) return { tripId: hit.id };
  }
  const user = c.get('user') as { id?: string } | null;
  let isOutsourced = false;
  if (lorryId) {
    const { data: lorryRow, error: lErr } = await sb.from('lorries').select('is_internal').eq('id', lorryId).maybeSingle();
    isOutsourced = !lErr && (((lorryRow as { isInternal?: boolean | null; is_internal?: boolean | null } | null)?.isInternal
      ?? (lorryRow as { is_internal?: boolean | null } | null)?.is_internal) === false);
  }
  const yymm = yymmFor();
  const { data: created, error: tErr } = await insertWithDocNoRetry<{ id: string }>(
    () => mintMonthlyDocNo(sb, 'trips', 'trip_no', `TRIP-${yymm}`),
    (tripNo) => sb.from('trips').insert({
      company_id: activeCompanyId(c), trip_no: tripNo, trip_date: tripDate, lorry_id: lorryId,
      trip_type: 'DELIVERY', status: 'PLANNED', is_outsourced: isOutsourced, created_by: user?.id ?? null,
    }).select('id').single(),
  );
  if (tErr || !created) {
    return { error: tErr ? String((tErr as { message?: string }).message ?? tErr).slice(0, 160) : 'trip insert returned no row' };
  }
  return { tripId: (created as { id: string }).id };
}

async function appendDpStop(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono ctx + the untyped scm client, as across this route
  c: any, sb: any, dp: Record<string, unknown>, tripId: string, dpNo: string | null,
): Promise<{ id: string | null; failed: boolean; reason?: string }> {
  try {
    const stops = await sb.from('trip_stops').select('stop_no').eq('trip_id', tripId);
    const nextStopNo = ((stops.data ?? []) as Array<{ stop_no?: number }>)
      .reduce((m: number, r: { stop_no?: number }) => Math.max(m, Number(r.stop_no ?? 0)), 0) + 1;
    const address = dpStopAddress(dp);
    const ins = await sb.from('trip_stops').insert({
      company_id: activeCompanyId(c) ?? null,
      trip_id: tripId,
      stop_no: nextStopNo,
      stop_type: dp.job_type,
      customer_name: (dp.party_name as string | null) ?? null,
      address,
      revenue_sen: 0,
      dp_no: dpNo,
    }).select('id').maybeSingle();
    const stopId = (ins.data as { id?: string } | null)?.id ?? null;
    if (ins.error || !stopId) {
      return { id: null, failed: true, reason: ins.error?.message ?? 'trip_stop insert returned no row' };
    }
    await sb.from('dp_orders').update({ trip_stop_id: stopId }).eq('id', dp.id);
    return { id: stopId, failed: false };
  } catch (e) {
    return { id: null, failed: true, reason: `trip wiring failed: ${String((e as Error)?.message ?? e).slice(0, 140)}` };
  }
}

dpOrders.post('/:id/schedule', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  const sb = c.get('supabase');
  // Company scope (owner audit 2026-07-22): same class as PATCH + cancel.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const denied = await denyIfNotOwnDpJob(c, sb, id);
  if (denied) return denied;

  const tripCheck = await assertTripInAllowedCompanies(sb, p.tripId ?? null, c);
  if (!tripCheck.ok) return c.json(tripCheck.body, tripCheck.status);

  const plate = await plateForLorry(sb, p.lorryId);
  if (!plate) return c.json({ error: 'lorry_not_found' }, 404);

  const dpNo = await mintNextDpNo(sb, { tripDate: p.tripDate, plate });
  if (!dpNo) {
    return c.json({
      error: 'dp_no_unavailable',
      reason: 'could not read the DP number registry, so a number could not be issued safely — nothing was scheduled',
    }, 503);
  }

  const { data, error } = await scopeToCompanyId(
    sb.from('dp_orders')
      .update({ dp_no: dpNo, trip_id: p.tripId ?? null, status: 'SCHEDULED', updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'PENDING_SCHEDULE'),
    co.companyId,
  ).select('*').maybeSingle();
  if (error) return c.json({ error: 'schedule_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_pending', reason: 'DP order is not pending schedule (already scheduled or gone)' }, 409);

  let tripStop: { id: string | null; failed: boolean; reason?: string } = { id: null, failed: false };
  const d = data as Record<string, unknown>;
  const trip = await resolveScheduleTrip(c, sb, p.lorryId, p.tripDate, p.tripId ?? null);
  if ('error' in trip) {
    tripStop = { id: null, failed: true, reason: `could not place the job on a trip: ${trip.error}` };
  } else {
    try {
      const effectiveTripId = trip.tripId;
      if (effectiveTripId !== (p.tripId ?? null)) {
        await sb.from('dp_orders').update({ trip_id: effectiveTripId, updated_at: new Date().toISOString() }).eq('id', id);
      }
      tripStop = await appendDpStop(c, sb, d, effectiveTripId, dpNo);
      // Set the driver the operator picked at schedule time (owner 2026-10-30), so
      // Driver + Lorry show on the board without a second step. Best-effort.
      if (p.driverId !== undefined) await setTripCrew(sb, effectiveTripId, { driverId: p.driverId });
    } catch (e) {
      tripStop = { id: null, failed: true, reason: `trip wiring failed: ${String((e as Error)?.message ?? e).slice(0, 140)}` };
    }
  }

  let lorryBlocked: { blocked: boolean; failed: boolean; reason?: string } = { blocked: false, failed: false };
  const d0 = data as Record<string, unknown>;
  const subjectLorryId = (d0.lorry_id ?? (d0 as { lorryId?: string | null }).lorryId) as string | null ?? null;
  if (String(d0.job_type ?? '') === 'LORRY_SERVICE' && subjectLorryId) {
    try {
      const user = c.get('user') as { id?: string } | null;
      const ins = await sb.from('lorry_maintenance').insert({
        company_id: activeCompanyId(c) ?? null,
        lorry_id: subjectLorryId,
        unavailable_from: p.tripDate,
        unavailable_to: p.tripDate,
        reason: dpLorryBlockReason(dpNo),
        created_by: user?.id ?? null,
      });
      lorryBlocked = ins.error
        ? { blocked: false, failed: true, reason: ins.error.message }
        : { blocked: true, failed: false };
    } catch (e) {
      lorryBlocked = { blocked: false, failed: true, reason: String((e as Error)?.message ?? e).slice(0, 140) };
    }
  }
  return c.json({ dpOrder: data, dp_no: dpNo, tripStop, lorryBlocked });
});

async function moveStopToTrip(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono ctx + the untyped scm client, as across this route
  c: any, sb: any, stopId: string, newTripId: string,
): Promise<{ failed: boolean; reason?: string }> {
  try {
    const { data: stops, error: stopsErr } = await sb.from('trip_stops').select('stop_no').eq('trip_id', newTripId);
    if (stopsErr) return { failed: true, reason: stopsErr.message };
    const nextStopNo = ((stops ?? []) as Array<{ stop_no?: number }>)
      .reduce((m: number, r: { stop_no?: number }) => Math.max(m, Number(r.stop_no ?? 0)), 0) + 1;
    const { error } = await scopeToAllowedCompanies(
      sb.from('trip_stops').update({ trip_id: newTripId, stop_no: nextStopNo }).eq('id', stopId), c,
    );
    if (error) return { failed: true, reason: error.message };
    return { failed: false };
  } catch (e) {
    return { failed: true, reason: `stop move failed: ${String((e as Error)?.message ?? e).slice(0, 140)}` };
  }
}

/* ── POST /:id/crew — inline crew edit on a DP row (owner 2026-10-31) ───────────
   The board's Driver / Lorry / Helper cells write DP jobs the way they write SO
   rows now, with no "Schedule…" drawer. A DP job's crew IS its RUN's crew
   (scm.trips) — a DP has no delivery_order_crew — so this ensures the job rides a
   run first (its confirmed date, the picked lorry or none yet), then sets the seat.
   A run needs a date (trips.trip_date NOT NULL): a DP with no requested_date 409s
   "set the delivery date first". When a lorry is on the run and the job has no
   number yet, the number is minted and the job flips to SCHEDULED — the same end
   state the drawer reached, so the board's "not scheduled" clears the moment a
   lorry is picked (a DP number embeds the plate, so a crew-first job with no lorry
   stays numberless, correctly, until one is set). */
const crewSchema = z.object({
  driverId: z.string().uuid().nullable().optional(),
  helper1Id: z.string().uuid().nullable().optional(),
  helper2Id: z.string().uuid().nullable().optional(),
  lorryId: z.string().uuid().nullable().optional(),
});

dpOrders.post('/:id/crew', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = crewSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  if (p.driverId === undefined && p.helper1Id === undefined && p.helper2Id === undefined && p.lorryId === undefined) {
    return c.json({ error: 'no_changes' }, 400);
  }
  const sb = c.get('supabase');
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const denied = await denyIfNotOwnDpJob(c, sb, id);
  if (denied) return denied;

  const { data: dp, error: dpErr } = await scopeToCompanyId(
    sb.from('dp_orders').select(
      'id, requested_date, trip_id, trip_stop_id, dp_no, status, job_type, party_name, address1, address2, address3, address4, city, postcode, state',
    ).eq('id', id),
    co.companyId,
  ).maybeSingle();
  if (dpErr) return c.json({ error: 'lookup_failed', reason: dpErr.message }, 500);
  if (!dp) return c.json({ error: 'not_found' }, 404);
  const d = dp as Record<string, unknown>;
  const requestedDate = (d.requested_date as string | null) ?? null;
  let tripId = (d.trip_id as string | null) ?? null;

  let tripStop: { id: string | null; failed: boolean; reason?: string } = { id: null, failed: false };
  if (!tripId) {
    if (!requestedDate) {
      return c.json({ error: 'no_date', reason: 'Set the delivery date first — the crew rides that day\'s run.' }, 409);
    }
    const trip = await resolveScheduleTrip(c, sb, p.lorryId ?? null, requestedDate, null);
    if ('error' in trip) return c.json({ error: 'trip_failed', reason: trip.error }, 500);
    tripId = trip.tripId;
    await sb.from('dp_orders').update({ trip_id: tripId, updated_at: new Date().toISOString() }).eq('id', id);
    tripStop = await appendDpStop(c, sb, d, tripId, (d.dp_no as string | null) ?? null);
  }

  /* PEEL (owner 2026-11-17): a crew edit on a DP that SHARES its run with other
     jobs must change ONLY this job — not rewrite the whole run's crew, which moved
     every job on it together (the three same-lorry supplier pickups the owner saw
     all flip driver at once). When this run carries another stop, split THIS job
     onto its own run first, then set the seat there; the old run keeps the other
     jobs untouched. A run holding only this job is edited in place, as before — no
     needless churn of its lorry/driver.

     A different driver means a different lorry (one lorry runs one driver a day):
     a LORRY change moves the job onto that lorry's run (joining it when it already
     exists); a driver/helper change with no lorry peels onto a FRESH lorryless run,
     so the board shows this job needing its own lorry rather than silently
     splitting the shared one. */
  if (tripId && requestedDate) {
    let otherQ = sb.from('trip_stops').select('id').eq('trip_id', tripId).limit(1);
    if (d.trip_stop_id) otherQ = otherQ.neq('id', d.trip_stop_id as string);
    const { data: otherStops, error: othErr } = await scopeToAllowedCompanies(otherQ, c);
    if (othErr) return c.json({ error: 'lookup_failed', reason: othErr.message }, 500);
    if (((otherStops ?? []) as Array<unknown>).length > 0) {
      const ownRun = await resolveScheduleTrip(c, sb, p.lorryId ?? null, requestedDate, null);
      if ('error' in ownRun) return c.json({ error: 'trip_failed', reason: ownRun.error }, 500);
      if (ownRun.tripId !== tripId) {
        if (d.trip_stop_id) {
          const moved = await moveStopToTrip(c, sb, String(d.trip_stop_id), ownRun.tripId);
          if (moved.failed) return c.json({ error: 'peel_failed', reason: moved.reason }, 500);
        } else {
          tripStop = await appendDpStop(c, sb, d, ownRun.tripId, (d.dp_no as string | null) ?? null);
          if (tripStop.failed) return c.json({ error: 'peel_failed', reason: tripStop.reason }, 500);
        }
        await scopeToCompanyId(
          sb.from('dp_orders').update({ trip_id: ownRun.tripId, updated_at: new Date().toISOString() }).eq('id', id),
          co.companyId,
        );
        tripId = ownRun.tripId;
      }
    }
  }

  try {
    await setTripCrew(sb, tripId, {
      ...(p.driverId !== undefined ? { driverId: p.driverId } : {}),
      ...(p.helper1Id !== undefined ? { helper1Id: p.helper1Id } : {}),
      ...(p.helper2Id !== undefined ? { helper2Id: p.helper2Id } : {}),
      ...(p.lorryId != null ? { lorryId: p.lorryId } : {}),
    });
  } catch (e) {
    return c.json({ error: 'crew_save_failed', reason: String((e as Error)?.message ?? e).slice(0, 200) }, 500);
  }

  let dpNo = (d.dp_no as string | null) ?? null;
  if (!dpNo && requestedDate) {
    const { data: tripRow, error: tripRowErr } = await sb.from('trips').select('lorry_id').eq('id', tripId).maybeSingle();
    const lorryOnRun = tripRowErr ? null : (((tripRow as { lorry_id?: string | null } | null)?.lorry_id) ?? null);
    const plate = lorryOnRun ? await plateForLorry(sb, lorryOnRun) : null;
    const minted = plate ? await mintNextDpNo(sb, { tripDate: requestedDate, plate }) : null;
    if (minted) {
      await scopeToCompanyId(
        sb.from('dp_orders').update({ dp_no: minted, status: 'SCHEDULED', updated_at: new Date().toISOString() }).eq('id', id),
        co.companyId,
      );
      const stopId = tripStop.id ?? (d.trip_stop_id as string | null) ?? null;
      if (stopId) await sb.from('trip_stops').update({ dp_no: minted }).eq('id', stopId);
      dpNo = minted;
    }
  }
  return c.json({ ok: true, trip_id: tripId, dp_no: dpNo, tripStop });
});

export default dpOrders;
