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
  snapshotFromProject, snapshotFromAssr, snapshotFromWarehouse, snapshotFromWorkshop,
  snapshotFromWorkshopName, type DpJobType, type DpPartySnapshot,
} from '../lib/dp-party';
import { assertTripInAllowedCompanies } from '../lib/ref-in-company';
import { mintNextDpNo, plateForLorry } from '../lib/dp-no-mint';
import { dateOrNull, coerceEmptyDates } from '../lib/date-coerce';
import { dpLorryBlockReason } from '../lib/dp-lorry-block';
import { normalizePhone } from '../shared/phone';
import {
  resolveDeliveryScope, scopeMatchesAssignment,
  type CrewAssignment, type DeliveryScope,
} from '../lib/deliveryScope';
import { supabaseAuth } from '../middleware/auth';

export const dpOrders = new Hono<{ Bindings: Env; Variables: Variables }>();

// Attach the scm-scoped supabase-js client (c.get('supabase')) + the real Houzs
// caller (c.get('houzsUser')) that every handler below reads. Without this the
// sub-router never had them set: `c.get('supabase')` was undefined, so the first
// `sb.from(...)` in ANY endpoint threw a TypeError — surfacing as a generic 500
// ("Something went wrong. Please try again.") on the whole DP-Order feature. Same
// `.use('*', supabaseAuth)` line every other scm sub-router carries (e.g.
// delivery-planning.ts); this router was the one that shipped without it. Runs
// AFTER the parent `scm.use('/dp-orders/*', scmAreaGuard(...))` in scm/index.ts,
// which must read the real Houzs user BEFORE supabaseAuth swaps in the scm.staff
// system identity — the ordering the area-guard header documents.
dpOrders.use('*', supabaseAuth);

// ── Per-assignee row scope (owner rule, Lim Wei Siang) ──────────────────────
// A Driver / Helper may see and act on ONLY the delivery jobs assigned to them.
// PR #756 gave this treatment to the SO / trip / board rows but deliberately
// left the standalone DP-order surfaces (this router's list + write endpoints)
// unscoped, because this file was being written at the same time. This closes
// that gap by reusing the SAME resolveDeliveryScope / scopeMatchesAssignment
// primitives — no parallel mechanism. A DP order carries no crew of its own; its
// driver/helpers are the crew of the TRIP it was scheduled onto (dp_orders.trip_id
// → trips.driver_id / helper_1_id / helper_2_id), which is exactly how the board's
// applyDeliveryRowScope resolves a DP row. An unscheduled DP order (no trip) has
// no crew, so it never matches a self scope — same as any unassigned board row.

/** Plain-language 403 for a field-crew caller touching a job that is not theirs. */
const NOT_YOUR_JOB = 'You can only act on a delivery job assigned to you.';

const EMPTY_CREW: CrewAssignment = { driverIds: [], helperIds: [] };

/** Batch-load trip crew for a bounded set of trip ids (never the whole table).
 *  Dual-reads camelCase/snake_case for parity with the rest of the module. */
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

/** Write-ownership guard for the single-record write endpoints: a self-scoped
 *  caller may act on a DP order ONLY when its trip crew is theirs. Returns a 403
 *  Response to short-circuit, or null to proceed. Fails OPEN (null) for an `all`
 *  scope and for a row that does not exist (the handler's own not-found path then
 *  answers) — belt-and-braces on top of the area guard, which already needs
 *  `edit` on scm.transportation to reach any of these at all. */
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

/* Every value on scm.trip_stop_type. INSPECTION joined that enum in mig 0165
   and never reached this list, so a DP order could not be created for a job the
   database, the board's Type filter and the rate card all understand. Kept in
   step by `npm run audit:job-types`. */
const JOB_TYPES = [
  'DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP', 'INSPECTION',
  // Job types 8 and 9 (mig 0250, owner's 2026-08-03 list).
  'TRANSFER', 'LORRY_SERVICE',
] as const;

const createSchema = z.object({
  jobType: z.enum(JOB_TYPES),
  // At most one source reference — which one is expected depends on the type,
  // but the resolver tolerates any and falls back to a manual (empty) snapshot.
  soDocNo: z.string().optional(),
  doId: z.string().uuid().optional(),
  assrCaseId: z.number().int().optional(),
  supplierId: z.string().uuid().optional(),
  projectId: z.number().int().optional(),
  // TRANSFER: the transfer document being driven, and/or the destination
  // warehouse directly (an ad-hoc move has no document — owner asked for both
  // paths). LORRY_SERVICE: the lorry being serviced, plus the workshop it is
  // going to, either picked directly or read off a work order. Columns: mig 0251.
  stockTransferId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  lorryId: z.string().uuid().optional(),
  workshopId: z.string().uuid().optional(),
  workOrderId: z.string().uuid().optional(),
  requestedDate: z.string().optional(), // YYYY-MM-DD
  remark: z.string().optional(),
  // Manual overrides — applied ON TOP of the auto-filled snapshot so the operator
  // can correct any field the master got wrong.
  overrides: z.record(z.string(), z.string().nullable()).optional(),
});

/** Read the source master (if any) and map it to the party snapshot. Falls back
 *  to an empty snapshot of the right type for a manual order. */
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
    // public schema → raw SQL, like delivery-planning's ASSR union.
    const proj = await c.env.DB.prepare(
      'SELECT venue, venue_address, organizer, state, pic_id FROM projects WHERE id = ?',
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
      'SELECT customer_name, phone, addr1, addr2, addr3, addr4, location FROM assr_cases WHERE id = ?',
    ).bind(p.assrCaseId).first<Record<string, unknown>>();
    if (a) return snapshotFromAssr(a);
  }
  /* TRANSFER — the party is the DESTINATION. An explicit warehouseId wins (the
     operator picked where the fleet is going); otherwise resolve the transfer
     document's to_warehouse_id. A transfer whose destination row has been
     deleted falls through to the empty snapshot rather than a half-filled one. */
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
  /* LORRY_SERVICE — the party is the WORKSHOP. Picked directly, or read off the
     work order this trip serves. An older work order may name its workshop only
     as free text (mig 0241 deliberately left workshop_id unbackfilled), so that
     name still becomes the party rather than nothing. */
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

/* ── POST /api/scm/dp-orders — create (type-aware auto-fill) ───────────────── */
dpOrders.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;
  const jobType = p.jobType as DpJobType;

  const snap = await resolveSnapshot(c, jobType, p);
  // Manual overrides win over the auto-fill — only for keys the snapshot has.
  const merged: Record<string, unknown> = { ...snap };
  for (const [k, v] of Object.entries(p.overrides ?? {})) {
    if (k in merged) merged[k] = v;
  }

  const sb = c.get('supabase');
  const user = c.get('user') as { id?: string } | null;
  const insert = {
    company_id: activeCompanyId(c) ?? null,
    dp_no: null, // minted at schedule
    job_type: jobType,
    party_type: partyTypeFor(jobType),
    so_doc_no: p.soDocNo ?? null,
    do_id: p.doId ?? null,
    assr_case_id: p.assrCaseId ?? null,
    supplier_id: p.supplierId ?? null,
    project_id: p.projectId ?? null,
    stock_transfer_id: p.stockTransferId ?? null,
    warehouse_id: p.warehouseId ?? null,
    lorry_id: p.lorryId ?? null,
    workshop_id: p.workshopId ?? null,
    work_order_id: p.workOrderId ?? null,
    party_name: merged.party_name ?? null,
    contact_name: merged.contact_name ?? null,
    // Defensive E.164 normalisation at the DB write chokepoint. contact_phone
    // reaches here from a party snapshot (dp-party.ts copies phone/mobile raw)
    // or a client-supplied override — neither is guaranteed normalised, unlike
    // the SO/supplier/driver master columns. normalizePhone keeps an
    // unparseable value untouched (?? fallback), so nothing is rejected.
    contact_phone: normDpPhone(merged.contact_phone),
    address1: merged.address1 ?? null, address2: merged.address2 ?? null,
    address3: merged.address3 ?? null, address4: merged.address4 ?? null,
    city: merged.city ?? null, postcode: merged.postcode ?? null, state: merged.state ?? null,
    requested_date: dateOrNull(p.requestedDate),
    status: 'PENDING_SCHEDULE',
    remark: p.remark ?? null,
    created_by: user?.id ?? null,
  };
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

  // Per-assignee row scope: a self-scoped Driver/Helper keeps only their own
  // jobs; every ops/dispatcher/management caller resolves to `all` and the list
  // is returned untouched (fail-open — see the module header).
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const rows = (data ?? []) as Array<Record<string, unknown> & DpRowLike>;
  if (scope.mode === 'all') return c.json({ dpOrders: rows });
  const tripCrew = await tripCrewByIds(sb, rows.map((r) => (r.trip_id ?? r.tripId) ?? null));
  return c.json({ dpOrders: filterDpOrdersByScope(scope, rows, tripCrew) });
});

/* ── PATCH /api/scm/dp-orders/:id — edit an unscheduled job ────────────────────
   Only while PENDING_SCHEDULE: once a DP number is minted and the job sits on a
   trip, its details are on a manifest a driver may already be holding — changing
   them silently is the "silent date change" the spec forbids. Cancel and raise a
   new one instead. */
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
  requestedDate: z.string().nullable().optional(),
  remark: z.string().nullable().optional(),
});

/* E.164 at the write boundary. A null/blank clears cleanly; an unparseable
 * value is kept as typed (normalizePhone → null → ?? fallback) rather than
 * rejected, matching the suppliers.ts / mfg-sales-orders.ts convention. */
const normDpPhone = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  if (!s) return null;
  return normalizePhone(s) ?? s;
};

const PATCH_COLS: Record<keyof z.infer<typeof patchSchema>, string> = {
  partyName: 'party_name', contactName: 'contact_name', contactPhone: 'contact_phone',
  address1: 'address1', address2: 'address2', address3: 'address3', address4: 'address4',
  city: 'city', postcode: 'postcode', state: 'state',
  requestedDate: 'requested_date', remark: 'remark',
};

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
  // Same E.164 normalisation the create path applies — a PATCH carries a raw
  // client value straight through PATCH_COLS otherwise.
  if (updates.contact_phone !== undefined) updates.contact_phone = normDpPhone(updates.contact_phone);
  /* A cleared requested date arrives as "" — the schema accepts any string —
     and Postgres rejects it on the date column, 500ing the save. */
  coerceEmptyDates(updates);
  if (Object.keys(updates).length === 1) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  // Company scope (owner audit 2026-07-22): denyIfNotOwnDpJob only guards
  // field-crew; ops/dispatch/manager callers bypass, so id-only WHERE would
  // let a caller in A edit B's dp_order details by knowing the UUID.
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const denied = await denyIfNotOwnDpJob(c, sb, id);
  if (denied) return denied;
  const { data, error } = await scopeToCompanyId(
    sb.from('dp_orders').update(updates).eq('id', id).eq('status', 'PENDING_SCHEDULE'),
    co.companyId,
  ).select('*').maybeSingle();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  if (!data) {
    return c.json({ error: 'not_editable', message: 'Only a job that is still pending schedule can be edited. Cancel it and raise a new one.' }, 409);
  }
  return c.json({ dpOrder: data });
});

/* ── POST /api/scm/dp-orders/:id/cancel — cancel a job ─────────────────────────
   Cancelling a SCHEDULED job also removes its trip_stop: leaving the stop behind
   would keep a cancelled job on the driver's route, which is the worst possible
   place to discover it. Reported if that removal fails — never silently. */
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
      // trip_stops is the CROSS-COMPANY shared queue, so its predicate is the
      // allowed set (same rule as trips.ts) — not "no predicate at all".
      const del = await scopeToAllowedCompanies(sb.from('trip_stops').delete().eq('id', stopId), c);
      stopRemoved = del.error
        ? { removed: false, failed: true, reason: del.error.message }
        : { removed: true, failed: false };
    } catch (e) {
      stopRemoved = { removed: false, failed: true, reason: String((e as Error)?.message ?? e).slice(0, 140) };
    }
  }

  /* Give the lorry back. A cancelled service that left its availability window
     behind would keep a perfectly free lorry off the board indefinitely — the
     mirror of the stop-left-behind problem above, and just as invisible.

     Matched on the EXACT reason this job wrote (dp-lorry-block.ts), so it can
     only ever remove its own window: never a hand-entered repair, never another
     job's, never the Repair Days dashboard's. A job cancelled before it was
     scheduled has no dp_no and wrote no window — nothing to undo. */
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
  tripDate: z.string(), // YYYY-MM-DD
  tripId: z.string().uuid().optional(),
});

/* ── POST /api/scm/dp-orders/:id/schedule — assign lorry+date, MINT the DP no ─ */
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

  /* THE TRIP IS A BODY FIELD. The dp_order itself is proved ours above, but
     `p.tripId` was used unchecked to read the trip's stops and then to INSERT a
     trip_stop stamped with OUR company_id — putting our job on the other
     company's driver route, as a row their own scoped reads cannot explain.
     Trips are the cross-company shared queue, so the predicate is the caller's
     ALLOWED set, not the active company (trips.ts:423 reads them the same way).
     See lib/ref-in-company.ts. Before the dp_no is minted, so a bad trip id
     never burns a number. */
  const tripCheck = await assertTripInAllowedCompanies(sb, p.tripId ?? null, c);
  if (!tripCheck.ok) return c.json(tripCheck.body, tripCheck.status);

  const plate = await plateForLorry(sb, p.lorryId);
  if (!plate) return c.json({ error: 'lorry_not_found' }, 404);

  /* Mint from the SHARED registry. This read used to cover `dp_orders` alone,
     which was complete only while this handler was the only minter. Now that a
     board-scheduled delivery also takes a number (onto trip_stops), reading one
     table would hand the same number to two different jobs. */
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
      .eq('id', id).eq('status', 'PENDING_SCHEDULE'), // claim: only schedule an unscheduled one
    co.companyId,
  ).select('*').maybeSingle();
  if (error) return c.json({ error: 'schedule_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_pending', reason: 'DP order is not pending schedule (already scheduled or gone)' }, 409);

  /* Put the DP order ONTO the trip as a stop, so it flows into the trip view and
     the route optimiser. job_type IS a scm.trip_stop_type (SUPPLIER_PICKUP was
     added in 0128), so it maps straight through. The structured address is
     flattened to the stop's single `address` line — the form the optimiser
     geocodes. Only when a trip was named; a header-only schedule (dp_no minted,
     no trip) is valid too.

     Best-effort like the board's scheduleOntoTrip — the schedule already
     committed — but the outcome is REPORTED (tripStop.failed), never a silent
     null, per the #720 lesson. */
  let tripStop: { id: string | null; failed: boolean; reason?: string } = { id: null, failed: false };
  if (p.tripId) {
    try {
      const d = data as Record<string, unknown>;
      const stops = await sb.from('trip_stops').select('stop_no').eq('trip_id', p.tripId);
      const nextStopNo = ((stops.data ?? []) as Array<{ stop_no?: number }>)
        .reduce((m, r) => Math.max(m, Number(r.stop_no ?? 0)), 0) + 1;
      const address = [d.address1, d.address2, d.address3, d.address4, d.city, d.postcode, d.state]
        .filter(Boolean).join(', ') || null;
      const ins = await sb.from('trip_stops').insert({
        company_id: activeCompanyId(c) ?? null,
        trip_id: p.tripId,
        stop_no: nextStopNo,
        stop_type: d.job_type,
        customer_name: (d.party_name as string | null) ?? null,
        address,
        revenue_centi: 0,
        /* The SAME number the order header carries — a mirror, not a second
           identity. Writing it here is also what keeps trip_stops the complete
           registry the minter scans. */
        dp_no: dpNo,
      }).select('id').maybeSingle();
      const stopId = (ins.data as { id?: string } | null)?.id ?? null;
      if (ins.error || !stopId) {
        tripStop = { id: null, failed: true, reason: ins.error?.message ?? 'trip_stop insert returned no row' };
      } else {
        await sb.from('dp_orders').update({ trip_stop_id: stopId }).eq('id', id);
        tripStop = { id: stopId, failed: false };
      }
    } catch (e) {
      tripStop = { id: null, failed: true, reason: `trip_stop wiring failed: ${String((e as Error)?.message ?? e).slice(0, 140)}` };
    }
  }

  /* A scheduled LORRY_SERVICE takes its subject lorry OFF THE ROAD for that day.
     Write the availability window both readers already consult (fleet-availability
     "is this lorry out today", lorry-capacity's repair days) so the board stops
     offering a lorry that is at a workshop — see dp-lorry-block.ts for why the
     reason string carries the DP number.

     NOTE the two different lorries: p.lorryId is the lorry PERFORMING the job
     (it drives to the workshop and mints the DP plate letters); d.lorry_id is
     the lorry BEING SERVICED, which is the one that becomes unavailable. They
     are usually the same vehicle — a lorry drives itself in — but a towed one
     is not, and blocking the wrong plate would be worse than blocking none.

     Best-effort like the trip-stop wiring above (the schedule already committed)
     and REPORTED the same way: a silent failure here would leave a lorry looking
     available on the day it is in the workshop. */
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

export default dpOrders;
