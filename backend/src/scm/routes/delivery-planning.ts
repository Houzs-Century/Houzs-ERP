// ----------------------------------------------------------------------------
// /delivery-planning — the Delivery / TMS module board.
//
// PORTED 1:1 from 2990 apps/api/src/routes/delivery-planning.ts into the Houzs
// scm schema (migration 0053). Mirror 2990 — do NOT redesign. The Houzs
// adaptations vs 2990 are import paths only (../middleware/auth, ../env,
// ../lib/paginate-all, ../lib/doc-no, ../lib/so-readiness, ./delivery-orders-mfg
// are the vendored scm equivalents with matching signatures). c.get('supabase')
// is the scm-scoped service client, so .from('mfg_sales_orders') = scm.mfg_sales_
// orders. snake_case columns, no camelCase transform.
//
// The Delivery Planning board: which live Sales Orders still need delivering,
// bucketed into 4 DERIVED states (PENDING_DELIVERY / PENDING_SCHEDULE /
// OVERDUE / DELIVERED) and grouped by delivery REGION — config-driven buckets
// derived from the customer's STATE.
//
// NOTE: the "delivery leg" (multi-hop / dual-trip) sub-feature was REMOVED — it
// only served the China-goods / China-PO transit flow (not in use yet) and had a
// latent source_id bug (scm.delivery_legs.source_id is UUID NOT NULL but legs
// were keyed by SO doc_no STRINGS). The scm.delivery_legs TABLE is left in place
// (empty/unused) so it can be re-added later for the China-PO transit flow.
//
// delivery_state is DERIVED LIVE here (migration 0053 added a nullable
// mfg_sales_orders.delivery_state / delivery_orders.delivery_state column, but
// that is for manual overrides / caching only — never the source of truth):
//   - DELIVERED        — the SO's goods are fully handed over (status DELIVERED,
//                        or every deliverable line remaining == 0 once any qty
//                        has shipped).
//   - PENDING_SCHEDULE — ready to ship (summariseReadiness.isShipReady — every
//                        MAIN line READY, and the SO actually HAS lines) but not
//                        yet fully delivered.
//   - OVERDUE          — NOT ready AND today >= EFFECTIVE delivery date − 3 days
//                        (owner rule: "3 days before delivery and goods still
//                        not ready").
//   - PENDING_DELIVERY — NOT ready and not yet inside the 3-day window.
// A manual override stored on the SO header (delivery_state) wins when present.
//
// DELIVERY-DATE INTEGRITY (owner rule): the customer's ORIGINAL
// customer_delivery_date is NEVER overwritten. The schedule action writes the
// firm/new date to amended_delivery_date instead. The EFFECTIVE delivery date
// drives Days Left AND the OVERDUE window; Original still shows the customer's.
// scm/shared/effective-delivery.ts OWNS that rule — MRP and the stock allocator
// have read the same function since 2026-08-18; before that they ranked on the
// original alone, so a rescheduled order moved here and not in the stock queue.
//
// Region = CONFIG-DRIVEN, owner-maintained (migration 0053). The region buckets
//   are a master list (delivery_planning_regions) and the per-STATE → region(s)
//   classification is a MULTI mapping (state_delivery_regions) — a state can map
//   to SEVERAL regions, so an order surfaces under several tabs. Both are loaded
//   once per request (loadRegionConfig). An unmapped state falls back to the
//   default bucket. CRUD for the config lives in the sibling route
//   /delivery-planning-regions.
//
// VIEW-TRAP (CoE): the new SO cols (delivery_state, HC fields, amend dates) are
//   deliberately NOT in scm.mfg_sales_orders_with_payment_totals. This board
//   reads them straight off the BASE table mfg_sales_orders — NEVER add them to
//   the SO-list view-backed HEADER select in mfg-sales-orders.ts (it 500s the
//   Sales Orders list).
//
// DRAFT / CANCELLED SOs (and DRAFT / CANCELLED DOs) are excluded everywhere — an
// uncommitted doc must never enter delivery planning.
//
// Mounted at '/delivery-planning' in scm/index.ts.
// ----------------------------------------------------------------------------

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { todayMyt } from '../lib/my-time';
import { attachLineCategories } from '../lib/so-readiness-category';
import { deriveBranding } from '../lib/so-display-branding';
/* chunkIn on every id/doc-no filter: the list rides in the URL and an unbounded one is refused. */
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { summariseReadiness, normCategory, type ReadinessLine } from '../lib/so-readiness';
import { effectiveSoDelivery } from '../shared';
import { readinessRowFields, NO_STOCK_ROW } from '../lib/so-readiness-row';
import { boardDeliverableByDoc } from '../lib/board-deliverable';
import { readFailure, noteDegradedRead } from '../lib/read-failure';
import { soProcessingLocked } from './mfg-sales-orders';
import { soPoLocked, soPoLockedMany } from '../lib/so-po-lock';
import { activeCompanyId, scopeToCompany, scopeToAllowedCompanies, companyCodeMap } from '../lib/companyScope';
/* Service-Case rows on this board are company-scoped (owner ruling 2026-08-21).
   Both statements live in ONE module, with the reasoning, so the predicate is
   assertable and cannot be re-derived by hand here. */
import { assrBoardUnionSql, assrOpenCaseGuardSql } from '../lib/assr-board-scope';
import { recordSoAudit, type FieldChange } from '../lib/so-audit';
import { advanceSoGeneration } from '../lib/so-generation';
import { computeReleaseGate } from '../../services/agents/release-gate';
import { mintDpNoForLorry } from '../lib/dp-no-mint';
import { resolveDeliveryScope, scopeMatchesAssignment, type DeliveryScope, type CrewAssignment } from '../lib/deliveryScope';
import { deriveArrangementStage } from '../lib/arrangement-stage';
/* Option B side map (/geo): zone derivation + set counting + cache-first
   geocoding reuse the EXISTING single-owner modules — the zone map + fallback
   from the delivery-zones router, the packer's set fold, and the mig-0197
   geocode cache. No second copy of any rule. */
import { MAP_COLS as ZONE_MAP_COLS, toPrefixMap, type MapRow as ZoneMapRow } from './delivery-zones';
import { zoneForAddress } from '../lib/zone-classify';
import { deriveSetCount, type SetLine } from '../lib/set-count';
import { composeAddress, geocodeAddressCached, normalizeAddress } from '../lib/geocode';
import { dateOrNull } from '../lib/date-coerce';

export const deliveryPlanning = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryPlanning.use('*', supabaseAuth);


/* ── Region model ─────────────────────────────────────────────────────────
   CONFIG-DRIVEN (migration 0053). The region buckets are an owner-maintained
   master (delivery_planning_regions) and the per-state → region(s) classification
   is an owner-maintained MULTI mapping (state_delivery_regions) — a state can map
   to SEVERAL regions. Both are loaded once per request (loadRegionConfig). A
   Region is therefore an open string code (any code the owner adds), NOT a fixed
   union.

   stateToRegionsFromConfig() classifies an order's customer_state via the loaded
   mapping (default fallback KL when unmapped). */
export type Region = string;

/* The codes the fallback reproduces — used ONLY when the config tables are
   empty/unapplied so behaviour never regresses below today. Kept in sync with the
   live Delivery Regions buckets (KL/SEL / Northern / Southern / East Coast /
   East Malaysia; Singapore folds into Southern). NOTE: migration 0053's seed is
   the older SELANGOR/KL/NORTHERN/SOUTHERN/EAST_COAST/EAST_MY set, so a fresh env
   seeded from 0053 differs from prod until reconciled. */
const FALLBACK_DEFAULT_REGION = 'KL';
const FALLBACK_REGIONS: Array<{ key: Region; label: string }> = [
  { key: 'KL', label: 'KL/SEL' }, { key: 'NORTHERN', label: 'Northern' },
  { key: 'SOUTHERN', label: 'Southern' }, { key: 'EAST_COAST', label: 'East Coast' },
  { key: 'EM', label: 'East Malaysia' },
];

/* Normalize free-text for tolerant matching: upper, strip punctuation/accents,
   collapse whitespace. "Pulau  Pinang" / "P.Pinang" / "pulau-pinang" all align. */
function normState(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // drop accents
    .toUpperCase()
    .replace(/[._\-,/]/g, ' ')                            // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/* The region config loaded once per request from the two 0053 tables. */
type RegionConfig = {
  // Ordered, active region masters → the tab row (config-driven regionList()).
  regions: Array<{ key: Region; label: string }>;
  // The set of VALID region codes (active) for filtering/membership checks.
  validCodes: Set<Region>;
  // Normalised state NAME → region codes[]. Key = normState(state_key).
  byState: Map<string, Region[]>;
};

/* Load delivery_planning_regions (active, sorted) + state_delivery_regions into a
   RegionConfig. Best-effort: on any error / empty config, falls back to the
   seeded defaults so the board still works. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadRegionConfig(sb: any): Promise<RegionConfig> {
  // 1. Region master (id → code, ordered active list).
  const codeById = new Map<string, Region>();
  let regions: Array<{ key: Region; label: string }> = [];
  const validCodes = new Set<Region>();
  try {
    const { data: regRows } = await paginateAll<{
      id: string; code: string | null; name: string | null;
      sort_order?: number | null; sortOrder?: number | null; active?: boolean | null;
    }>((from, to) =>
      sb.from('delivery_planning_regions')
        .select('id, code, name, sort_order, active')
        .order('sort_order', { ascending: true })
        .order('code', { ascending: true })
        .range(from, to),
    );
    for (const r of (regRows ?? [])) {
      const code = (r.code ?? '').toUpperCase();
      if (!code) continue;
      codeById.set(r.id, code);
      if ((r.active ?? true) !== false) {
        /* DEDUPE by code: the board is a CROSS-COMPANY view, so this read spans
           both companies' region masters — post-mig-0176 each company carries
           its own copy of every bucket, so without this each chip rendered
           TWICE (owner screenshot 2026-07-24). codeById keeps EVERY row (both
           companies' ids) so state mappings from either company still resolve. */
        if (!validCodes.has(code)) {
          regions.push({ key: code, label: r.name ?? code });
          validCodes.add(code);
        }
      }
    }
  } catch { /* fall through to fallback below */ }

  // 2. Per-state mapping → normalised state NAME → region codes[].
  const byState = new Map<string, Region[]>();
  if (codeById.size > 0) {
    try {
      const { data: mapRows } = await paginateAll<{
        state_key?: string | null; stateKey?: string | null; region_id?: string | null; regionId?: string | null;
      }>((from, to) =>
        sb.from('state_delivery_regions').select('state_key, country, region_id').range(from, to),
      );
      for (const row of (mapRows ?? [])) {
        const stateKey = row.stateKey ?? row.state_key ?? '';
        const code = codeById.get(row.regionId ?? row.region_id ?? '');
        if (!stateKey || !code) continue;
        const k = normState(stateKey);
        const arr = byState.get(k) ?? [];
        if (!arr.includes(code)) arr.push(code);
        byState.set(k, arr);
      }
    } catch { /* mapping stays empty → fallback default applies per-order */ }
  }

  // 3. Fallback when the config tables are empty / unapplied — keep today's tabs.
  if (regions.length === 0) {
    regions = [...FALLBACK_REGIONS];
    for (const r of FALLBACK_REGIONS) validCodes.add(r.key);
  }
  return { regions, validCodes, byState };
}

/* customer_state (+ customer_country fallback) → region code(s) via the loaded
   config. Returns an ARRAY (a state can map to several regions). When the state
   isn't mapped, falls back to the default bucket (KL) so an unmapped/new state
   still lands somewhere. */
function stateToRegionsFromConfig(
  cfg: RegionConfig,
  state: string | null | undefined,
  country?: string | null | undefined,
): Region[] {
  // Try the state name first, then the country (covers a blank-state SG order
  // whose country is 'Singapore').
  const sKey = normState(state);
  const cKey = normState(country);
  const hit = (sKey && cfg.byState.get(sKey)) || (cKey && cfg.byState.get(cKey)) || null;
  if (hit && hit.length > 0) return hit;
  // Unmapped → default bucket (prefer a configured KL; else first region).
  const fallback = cfg.validCodes.has(FALLBACK_DEFAULT_REGION)
    ? FALLBACK_DEFAULT_REGION
    : (cfg.regions[0]?.key ?? FALLBACK_DEFAULT_REGION);
  return [fallback];
}

export type DeliveryState = 'PENDING_DELIVERY' | 'PENDING_SCHEDULE' | 'OVERDUE' | 'DELIVERED';
const DELIVERY_STATES: DeliveryState[] = ['PENDING_DELIVERY', 'PENDING_SCHEDULE', 'OVERDUE', 'DELIVERED'];

/* Whole-day difference (target − today) in integer days, both as YYYY-MM-DD. */
function daysBetween(fromISO: string, toISO: string | null | undefined): number | null {
  if (!toISO) return null;
  const a = new Date(`${fromISO}T00:00:00Z`).getTime();
  const b = new Date(`${String(toISO).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/* ── Shared 4-state derivation ────────────────────────────────────────────
   The SINGLE source of truth for an SO's planning state. Used BOTH here (the
   board) and by the /mfg-sales-orders LIST endpoint (the mobile Orders-list
   card's planning_state field) so the two can never drift.

   A manual override stored on the SO header (delivery_state) wins when it is one
   of the 4 enum values; else derive live:
     · DELIVERED        — status DELIVERED, or every deliverable line remaining
                          == 0 once any qty has shipped.
     · PENDING_SCHEDULE — ready to ship (summariseReadiness.isShipReady) but not
                          yet fully delivered.
     · OVERDUE          — NOT ready AND today >= EFFECTIVE delivery date − 3 days.
     · PENDING_DELIVERY — NOT ready and not yet inside the 3-day window.

   `readiness` carries ONLY the ship gate — narrowed so no caller can reach for
   isMainReady, vacuously true on a line-less SO (BUG-HISTORY 2026-08-14, #2186).
   `effectiveDD` comes from effectiveSoDelivery; `today` is MYT. Pure — no I/O. */
export function derivePlanningState(input: {
  storedOverride: string | null | undefined;
  status: string | null | undefined;
  readiness: { isShipReady: boolean };
  delivered: number;
  remaining: number;
  effectiveDD: string | null | undefined;
  today: string;
}): DeliveryState {
  const { storedOverride, status, readiness, delivered, remaining, effectiveDD, today } = input;
  const stored = storedOverride ?? null;
  if (stored && (DELIVERY_STATES as string[]).includes(stored)) return stored as DeliveryState;

  const st = String(status ?? '').toUpperCase();
  if (st === 'DELIVERED' || (delivered > 0 && remaining <= 0)) return 'DELIVERED';

  /* "Ready to ship" gate — see summariseReadiness.isShipReady. The narrowed
     parameter type above is what now keeps the wrong flag out of reach. */
  if (readiness.isShipReady) return 'PENDING_SCHEDULE';

  // NOT ready. OVERDUE once we're within 3 days of (or past) the EFFECTIVE
  // delivery date (amended ?? original) and the goods still aren't ready.
  const daysLeft = daysBetween(today, effectiveDD ?? null);
  return daysLeft != null && daysLeft <= 3 ? 'OVERDUE' : 'PENDING_DELIVERY';
}

/* Filter assembled board rows down to a self-scoped caller's OWN jobs. A no-op
   for an `all` scope (ops/dispatcher/management) — their board is returned
   unchanged. Kept as a standalone helper (not inline) so the assignment rule has
   ONE definition and the board handler stays readable. Generic over the row shape
   so it does not depend on the handler-local BoardRow type; it only reads
   `row_type` + `so_doc_no` (the board's unique row key). */
async function applyDeliveryRowScope<T extends { row_type: string; so_doc_no: string }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  scope: DeliveryScope,
  rows: T[],
  maps: {
    doByDoc: Map<string, Array<{ id: string; doNumber: string; status: string }>>;
    doDriverById: Map<string, string | null>;
    crewIdsByDo: Map<string, { driverIds: string[]; helperIds: string[] }>;
    dpTripIdByKey: Map<string, string | null>;
  },
): Promise<T[]> {
  if (scope.mode === 'all') return rows;

  /* DP rows reference their crew through a trip. Batch-load the crew ids for the
     trips actually on the board (bounded .in — never the whole table). */
  const tripCrewById = new Map<string, CrewAssignment>();
  const tripIds = [...new Set([...maps.dpTripIdByKey.values()].filter((x): x is string => !!x))];
  if (tripIds.length > 0) {
    const { data: tripRows } = await chunkIn<Record<string, unknown>>(tripIds, (batch, from, to) => sb.from('trips')
      .select('id, driver_id, helper_1_id, helper_2_id')
      .in('id', batch).order('id').range(from, to));
    for (const t of tripRows) {
      const id = String(t.id ?? '');
      if (!id) continue;
      tripCrewById.set(id, {
        driverIds: [(t.driverId ?? t.driver_id) as string | null],
        helperIds: [(t.helper1Id ?? t.helper_1_id) as string | null, (t.helper2Id ?? t.helper_2_id) as string | null],
      });
    }
  }

  const EMPTY: CrewAssignment = { driverIds: [], helperIds: [] };
  const assignmentFor = (row: T): CrewAssignment => {
    if (row.row_type === 'so') {
      const dos = maps.doByDoc.get(row.so_doc_no) ?? [];
      if (dos.length === 0) return EMPTY; // no DO cut yet → unassigned
      const latestDoId = dos[dos.length - 1]!.id; // crew follows the latest DO
      const crew = maps.crewIdsByDo.get(latestDoId) ?? { driverIds: [], helperIds: [] };
      return {
        driverIds: [...crew.driverIds, maps.doDriverById.get(latestDoId) ?? null],
        helperIds: crew.helperIds,
      };
    }
    if (row.row_type === 'dp') {
      const tripId = maps.dpTripIdByKey.get(row.so_doc_no);
      return (tripId && tripCrewById.get(tripId)) || EMPTY;
    }
    // ASSR (service-case) rows carry no crew → never a driver's own job.
    return EMPTY;
  };

  return rows.filter((row) => scopeMatchesAssignment(scope, assignmentFor(row)));
}

/* A single DO's crew assignment (header driver_id + delivery_order_crew ids),
   for the write-ownership check on the driver-facing step/POD endpoints. Returns
   an empty assignment (matches no self scope) when the DO or its crew is absent. */
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

/* Plain-language 403 for a field-crew caller acting on a job that is not theirs. */
const NOT_YOUR_JOB = "You can only update a delivery job assigned to you.";

/* ──────────────────────────────────────────────────────────────────────────
   GET /delivery-planning?region=<ALL|code>&state=<delivery_state|ALL>
   The board. Source = live (status NOT DRAFT/CANCELLED) mfg_sales_orders that
   need delivery (have a customer_delivery_date or processing_date) +
   their DOs. delivery_state derived LIVE per SO. Region classified from the
   customer's STATE (stateToRegionsFromConfig).
   ─────────────────────────────────────────────────────────────────────────*/
export const deliveryPlanningBoardHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase');
  const today = todayMyt();

  /* Per-assignee ROW SCOPE (owner rule): a Driver/Helper sees ONLY the jobs
     assigned to their own name; every dispatcher / ops / management caller keeps
     the whole board. resolveDeliveryScope narrows ONLY a policy-restricted caller
     with a resolvable fleet identity — see lib/deliveryScope.ts. `all` (the
     common case) leaves the entire assembly below untouched. */
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));

  const regionParam = (c.req.query('region') ?? 'ALL').trim().toUpperCase();
  const stateParam = (c.req.query('state') ?? 'ALL').trim().toUpperCase();

  /* 0. CONFIG-DRIVEN region model (migration 0053) — load the owner-maintained
        region master + per-state MULTI mapping once per request. regionList()
        (the tabs) + each order's region(s) derive from this. */
  const regionCfg = await loadRegionConfig(sb);

  /* 1. Warehouse master → code + name maps (read-only label lookup for the
        Warehouse column). */
  const { data: whRows, error: whErr } = await sb
    .from('warehouses')
    .select('id, code, name');
  if (whErr) return c.json(readFailure('warehouses', whErr), 500);
  const whCode = new Map<string, string>();
  const whName = new Map<string, string>();
  for (const w of (whRows ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
    const code = (w.code ?? '').trim();
    whCode.set(w.id, code);
    whName.set(w.id, w.name ?? code);
  }

  /* 2. Live SO headers needing delivery — NOT DRAFT / CANCELLED, and carrying a
        delivery date signal (customer_delivery_date or processing_date).
        Paginated so the 1000-row PostgREST cap never silently truncates. */
  type SoHeaderRow = {
    doc_no: string | null; debtor_code: string | null; debtor_name: string | null;
    // multi-company: which company this SO belongs to (shared queue tags rows).
    company_id: number | null;
    phone: string | null; branding: string | null; status: string | null; delivery_state: string | null;
    agent: string | null; salesperson_id: string | null; salespersonId?: string | null; venue: string | null;
    customer_state: string | null; customer_country: string | null;
    customer_delivery_date: string | null; processing_date: string | null;
    so_date: string | null; address1: string | null; address2: string | null;
    postcode: string | null; building_type: string | null;
    local_total_sen: number | null; balance_sen: number | null;
    // Amendment dates. The ORIGINAL customer_delivery_date is never overwritten;
    // amended_delivery_date drives the effective countdown. dual-read camelCase.
    amend_date_from_customer: string | null; amended_delivery_date: string | null;
    amendDateFromCustomer?: string | null; amendedDeliveryDate?: string | null;
    // HC "Amend Client Date Reason". dual-read camelCase below.
    amend_reason: string | null; amendReason?: string | null;
    // HC SO-context raw-data fields. dual-read camelCase below.
    possession_date: string | null; house_type: string | null;
    replacement_disposal: string | null; referral: string | null;
    possessionDate?: string | null; houseType?: string | null; replacementDisposal?: string | null;
  };
  /* CROSS-COMPANY = the caller's GRANTED companies; unscoped, this read took every tenant's. */
  const { data: soRowsRaw, error: soErr } = await paginateAll<SoHeaderRow>((from, to) =>
    scopeToAllowedCompanies(
      sb.from('mfg_sales_orders')
        /* NO `id` column here: scm.mfg_sales_orders is keyed by doc_no (TEXT PK) and
           has no `id` column: selecting it makes PostgREST reject the whole query and
           the board 500s. Identity here is doc_no; every join below keys on it. */
        .select('doc_no, company_id, debtor_code, debtor_name, phone, branding, status, delivery_state, agent, salesperson_id, venue, customer_state, customer_country, customer_delivery_date, amend_date_from_customer, amended_delivery_date, amend_reason, processing_date, so_date, address1, address2, postcode, building_type, local_total_sen, balance_sen, possession_date, house_type, replacement_disposal, referral')
        .neq('status', 'DRAFT')
        .neq('status', 'CANCELLED')
        .order('customer_delivery_date', { ascending: true, nullsFirst: false }),
      c,
    ).range(from, to),
  );
  if (soErr) return c.json(readFailure('sales_orders', soErr), 500);
  /* Only SOs that actually need delivering — they carry a date signal
     (customer_delivery_date OR processing_date). Filtered
     in JS (not a PostgREST .or()) to keep the paginated query's row type clean. */
  const soRows = (soRowsRaw ?? []).filter(
    (r) => r.customer_delivery_date != null || r.processing_date != null,
  );
  const docNos = soRows.map((r) => String(r.doc_no ?? '')).filter(Boolean);

  if (docNos.length === 0) {
    return c.json({ orders: [], counts: emptyCounts(), regions: regionCfg.regions });
  }

  /* 2b. LIVE balance per SO — same source-of-truth as the SO list Balance column
        (mfg_sales_orders_with_payment_totals.balance_sen_live = local_total −
        Σpayments). Looked up by doc_no; the base-table balance_sen above stays
        as the fallback when the view row is absent. */
  /* VIEW-TRAP (see backend/docs/scm-view-trap-coe.md): this select hits the
     VIEW. STRUCTURALLY SAFE today — only 2 cols, both view-native (doc_no +
     view-computed balance_sen_live), not a shared HEADER. KEEP IT THIS WAY:
     do NOT extend this select with base-table cols added after the view was
     last recreated (delivery_state, possession_date, house_type,
     replacement_disposal, referral, amend_date_from_customer, amended_
     delivery_date, amend_reason — all read off the BASE table mfg_sales_orders
     in the .from('mfg_sales_orders') select 50 lines above, never through the
     view). Adding any of those here will 500 the Delivery Planning board. */
  const liveBalanceByDoc = new Map<string, number>();
  {
    const { data: balRows, error: balErr } = await chunkIn<{ doc_no: string | null; balance_sen_live: number | null }>(docNos, (batch, from, to) =>
      sb.from('mfg_sales_orders_with_payment_totals')
        .select('doc_no, balance_sen_live')
        .in('doc_no', batch).order('doc_no').range(from, to),
    );
    noteDegradedRead('live_balance', balErr);
    for (const b of (balRows ?? [])) {
      if (b.doc_no != null && b.balance_sen_live != null) {
        liveBalanceByDoc.set(String(b.doc_no), Number(b.balance_sen_live));
      }
    }
  }

  /* 3. Per-line readiness + per-line warehouse. One batched, paginated read of
        the non-cancelled lines for every candidate SO. stock_status drives
        summariseReadiness (isMainReady = every MAIN line READY); warehouse_id
        (per SO line) drives the region grouping.
        Ordered (doc_no, line_no, created_at ASC) — IDENTICAL to the SO list's
        item fetch so the FIRST line we see per doc_no is its earliest-created
        one; that drives the SO-list-matching Branding derivation below. */
  const { data: itemRowsRaw, error: itemErr } = await chunkIn<{
    doc_no: string; item_group: string | null; item_code: string | null;
    stock_status: string | null; cancelled: boolean | null; warehouse_id: string | null;
    branding: string | null; created_at: string | null;
  }>(docNos, (batch, from, to) =>
    sb.from('mfg_sales_order_items')
      .select('doc_no, item_group, item_code, stock_status, cancelled, warehouse_id, branding, created_at')
      .in('doc_no', batch)
      .eq('cancelled', false)
      .order('doc_no')
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(from, to),
  );
  noteDegradedRead('so_lines', itemErr);
  const linesByDoc = new Map<string, ReadinessLine[]>();
  const warehousesByDoc = new Map<string, Set<string>>();
  /* Branding auto-derive — REPLICATES the SO list grid exactly. The Branding
     column follows the SO's FIRST line item, catalog-resolved + mains-first. */
  const firstCat = new Map<string, string>();
  const firstBranding = new Map<string, string | null>();
  const firstItemCode = new Map<string, string | null>();
  const allCodes = new Set<string>();
  for (const it of itemRowsRaw) {
    const dn = it.doc_no;
    if (!dn) continue;
    const arr = linesByDoc.get(dn) ?? [];
    arr.push({ item_group: it.item_group, item_code: it.item_code, stock_status: (it.stock_status ?? 'PENDING') as ReadinessLine['stock_status'], cancelled: it.cancelled });
    linesByDoc.set(dn, arr);
    if (it.warehouse_id) {
      const ws = warehousesByDoc.get(dn) ?? new Set<string>();
      ws.add(it.warehouse_id);
      warehousesByDoc.set(dn, ws);
    }
    if (it.item_code) allCodes.add(it.item_code);
    /* Rows arrive ordered by (doc_no, line_no, created_at ASC) so the first time
       we see a doc_no IS its earliest line — record it once. */
    if (!firstCat.has(dn)) {
      firstCat.set(dn, normCategory(it.item_group ?? ''));
      firstBranding.set(dn, it.branding ?? null);
      firstItemCode.set(dn, it.item_code ?? null);
    }
  }

  /* Catalog category + branding by item_code — the SAME product-branding fetch
     the SO list runs (mfg_products.category + mfg_products.branding), chunked by
     the codes in view (bounded .in, never the whole table). */
  const productCategory = new Map<string, string>();
  const productBranding = new Map<string, string>();
  {
    const codeList = [...allCodes];
    for (let i = 0; i < codeList.length; i += 300) {
      const chunk = codeList.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: prodRows } = await paginateAll<{ code: string; category: string | null; branding: string | null }>((from, to) =>
        scopeToCompany(
          sb.from('mfg_products')
            .select('code, category, branding')
            .in('code', chunk),
          c,
        ).range(from, to),
      );
      for (const p of (prodRows ?? [])) {
        if (p.category) productCategory.set(p.code, normCategory(p.category));
        if (p.branding && p.branding.trim()) productBranding.set(p.code, p.branding);
      }
    }
  }
  const resolveLineCat = (code: string | null, group: string): string =>
    (code ? productCategory.get(code) : undefined) ?? normCategory(group);
  /* isServiceLine's strongest signal onto the step-3 lines — no extra read. See lib/so-readiness-category.ts. */
  attachLineCategories(linesByDoc.values(), productCategory);
  const MAIN_CATS = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);
  /* First MAIN line per doc (catalog-resolved), re-iterating the already
     (doc_no, line_no, created_at)-ordered itemRows. Falls back to the earliest
     line captured above when an SO has no sofa/bedframe/mattress line. */
  const repCat = new Map<string, string>();
  const repBranding = new Map<string, string | null>();
  const repCode = new Map<string, string | null>();
  for (const it of itemRowsRaw) {
    const dn = it.doc_no;
    if (!dn || repCat.has(dn)) continue;
    const cat = resolveLineCat(it.item_code, it.item_group ?? '');
    if (MAIN_CATS.has(cat)) {
      repCat.set(dn, cat);
      repBranding.set(dn, it.branding ?? null);
      repCode.set(dn, it.item_code ?? null);
    }
  }

  /* Loud is right; anonymous is not — this reached the client as a bare 500. readFailure names the stage. */
  let deliveredByDoc: Map<string, number>;
  let remainingByDoc: Map<string, number>;
  try {
    ({ deliveredByDoc, remainingByDoc } = await boardDeliverableByDoc(sb, docNos));
  } catch (e) {
    return c.json(readFailure('delivered_sum', e), 500);
  }

  /* 5. DOs for these SOs — the cut DO doc_no + status + per-DO crew (driver /
        helper / lorry from delivery_order_crew). Non-DRAFT/CANCELLED. */
  /* HC DO-execution raw-data fields surface alongside the DO. dual-read
     camelCase (the pg driver camelCases result columns). */
  type DoExecOut = {
    time_range: string | null; time_confirmed: boolean | null;
    arrival_at: string | null; departure_at: string | null;
    shipout_date: string | null; customer_delivered_date: string | null;
    eta_arriving_port: string | null; delivery_substatus: string | null;
    // EM-region transit arrival date.
    arrives_em_warehouse_date: string | null;
    // The latest DO's OWN document date (delivery_orders.do_date) — surfaced as
    // the planning grid "DO Date" column. From the SAME latest-DO lookup as crew.
    do_date: string | null;
  };
  const { data: doRowsRaw, error: doErr } = await chunkIn<{
    id: string; do_number: string | null; so_doc_no: string | null; status: string | null;
    // driver_id — the DO header's quick-field driver, one half of the row-scope
    // assignment (the crew snapshot below carries the rest). dual-read camelCase.
    driver_id: string | null; driverId?: string | null;
    delivery_state: string | null; customer_delivery_date: string | null; do_date: string | null;
    time_range: string | null; time_confirmed: boolean | null;
    arrival_at: string | null; departure_at: string | null;
    shipout_date: string | null; customer_delivered_date: string | null;
    eta_arriving_port: string | null; delivery_substatus: string | null;
    arrives_em_warehouse_date: string | null;
    // camelCase aliases (pg driver) for dual-read
    doDate?: string | null;
    timeRange?: string | null; timeConfirmed?: boolean | null;
    arrivalAt?: string | null; departureAt?: string | null;
    shipoutDate?: string | null; customerDeliveredDate?: string | null;
    etaArrivingPort?: string | null; deliverySubstatus?: string | null;
    arrivesEmWarehouseDate?: string | null;
  }>(docNos, (batch, from, to) =>
    sb.from('delivery_orders')
      .select('id, do_number, so_doc_no, status, driver_id, delivery_state, customer_delivery_date, do_date, time_range, time_confirmed, arrival_at, departure_at, shipout_date, customer_delivered_date, eta_arriving_port, delivery_substatus, arrives_em_warehouse_date')
      .in('so_doc_no', batch).order('id').range(from, to),
  );
  noteDegradedRead('do_headers', doErr);
  const doByDoc = new Map<string, Array<{ id: string; doNumber: string; status: string }>>();
  /* DO header driver_id by DO id — half the row-scope assignment (crew ids are
     the other half). Only consulted when the caller is self-scoped. */
  const doDriverById = new Map<string, string | null>();
  /* Latest non-DRAFT/CANCELLED DO's HC exec fields, keyed by SO doc_no — the
     same DO whose crew is shown (the last in doByDoc). null when no DO. */
  const doExecByDoc = new Map<string, DoExecOut>();
  const doIds: string[] = [];
  for (const d of doRowsRaw) {
    const st = (d.status ?? '').toUpperCase();
    if (st === 'DRAFT' || st === 'CANCELLED') continue;  // exclude uncommitted / voided
    const dn = d.so_doc_no ?? '';
    if (!dn) continue;
    const arr = doByDoc.get(dn) ?? [];
    arr.push({ id: d.id, doNumber: d.do_number ?? '—', status: st });
    doByDoc.set(dn, arr);
    doIds.push(d.id);
    doDriverById.set(d.id, d.driverId ?? d.driver_id ?? null);
    // overwrite so the LAST DO wins (matches the crew = latest-DO convention)
    doExecByDoc.set(dn, {
      time_range: d.timeRange ?? d.time_range ?? null,
      time_confirmed: d.timeConfirmed ?? d.time_confirmed ?? null,
      arrival_at: d.arrivalAt ?? d.arrival_at ?? null,
      departure_at: d.departureAt ?? d.departure_at ?? null,
      shipout_date: d.shipoutDate ?? d.shipout_date ?? null,
      customer_delivered_date: d.customerDeliveredDate ?? d.customer_delivered_date ?? null,
      eta_arriving_port: d.etaArrivingPort ?? d.eta_arriving_port ?? null,
      delivery_substatus: d.deliverySubstatus ?? d.delivery_substatus ?? null,
      arrives_em_warehouse_date: d.arrivesEmWarehouseDate ?? d.arrives_em_warehouse_date ?? null,
      do_date: d.doDate ?? d.do_date ?? null,
    });
  }

  /* DP NUMBER per SO row. The number is minted onto the trip_stop at schedule
     time (lib/dp-no-mint.ts), so it is read back from there — a stop reaches its
     SO either directly (so_id, an SO scheduled with no DO) or via its DO (do_id).
     Both are resolved here so a job shows its number regardless of which shape it
     took. Best-effort: a failed read leaves dp_no null, which renders as "—" and
     is honest about not knowing, rather than inventing a number. */
  const dpNoByDoc = new Map<string, string>();
  /* Live trip per SO — the ARRANGEMENT-pipeline signal. An SO is "Time arranged"
     when a DELIVERY stop keyed on one of its DOs sits on a non-CANCELLED trip
     (the same do_id key scheduleOntoTrip writes and staleStopSweepFor sweeps).
     Best-effort like the dp_no read: a failed read leaves the map empty, so the
     stage degrades to PENDING_TIME/PENDING_DATE — never a guess. */
  const tripByDoc = new Map<string, { id: string; trip_no: string | null; trip_date: string | null; stop_no: number | null; eta_offset_s: number | null }>();
  {
    /* SO rows resolve their number through their DO. There is deliberately NO
       so_id lookup: scm.mfg_sales_orders has no `id`, so an SO can never be the
       target of trip_stops.so_id (that UUID column is only ever populated for a
       source that actually has a UUID id). A board-scheduled SO reaches a trip
       via its DO, and the stop carries do_id — which docByDoId resolves. */
    const docByDoId = new Map<string, string>();
    for (const [dn, arr] of doByDoc) for (const d of arr) docByDoId.set(d.id, dn);

    type StopRow = { dp_no?: string | null; do_id?: string | null; trip_id?: string | null; tripId?: string | null; stop_no?: number | null; stopNo?: number | null; eta_offset_s?: number | null; etaOffsetS?: number | null };
    const take = (rows: StopRow[] | null | undefined) => {
      for (const s of rows ?? []) {
        const no = s.dp_no;
        if (!no) continue;
        const dn = (s.do_id && docByDoId.get(s.do_id)) || null;
        // Last write wins = the most recent schedule, matching the crew = latest-DO
        // convention this board already uses.
        if (dn) dpNoByDoc.set(dn, no);
      }
    };
    try {
      if (doIds.length) {
        /* ONE widened read serves both maps. The dp_no rule is unchanged — the
           filter that used to live in the query (`dp_no IS NOT NULL`) now lives
           in take(), same rows either way. */
        const { data: stopRows } = await chunkIn<StopRow>(doIds, (batch, from, to) => sb.from('trip_stops')
          .select('dp_no, do_id, trip_id, stop_no, eta_offset_s').in('do_id', batch)
          .order('do_id').range(from, to));
        take(stopRows.filter((s) => s.dp_no != null));

        /* Resolve the stops' trips (bounded .in) and keep only live ones —
           a CANCELLED trip is no arrangement (the reverse reconcile already
           returns such orders to the queue). Last write wins, matching the
           latest-schedule convention above. */
        const tripIds = [...new Set(stopRows
          .map((s) => (s.tripId ?? s.trip_id) as string | null)
          .filter((x): x is string => !!x))];
        if (tripIds.length) {
          const { data: tripRowsRaw } = await chunkIn<Record<string, unknown>>(tripIds, (batch, from, to) => sb.from('trips')
            .select('id, trip_no, trip_date, status').in('id', batch).order('id').range(from, to));
          const liveTripById = new Map<string, { id: string; trip_no: string | null; trip_date: string | null }>();
          for (const t of tripRowsRaw as Array<{
            id: string; trip_no?: string | null; tripNo?: string | null;
            trip_date?: string | null; tripDate?: string | null; status?: string | null;
          }>) {
            if (String(t.status ?? '').toUpperCase() === 'CANCELLED') continue;
            liveTripById.set(String(t.id), {
              id: String(t.id),
              trip_no: (t.tripNo ?? t.trip_no ?? null) as string | null,
              trip_date: (t.tripDate ?? t.trip_date ?? null) as string | null,
            });
          }
          for (const s of stopRows) {
            const tripId = (s.tripId ?? s.trip_id) as string | null;
            const trip = tripId ? liveTripById.get(tripId) : undefined;
            const dn = (s.do_id && docByDoId.get(s.do_id)) || null;
            if (dn && trip) tripByDoc.set(dn, {
              ...trip,
              stop_no: (s.stopNo ?? s.stop_no ?? null) as number | null,
              eta_offset_s: (s.etaOffsetS ?? s.eta_offset_s ?? null) as number | null,
            });
          }
        }
      }
    } catch { /* leave the maps empty — rows render dp_no / trip null */ }
  }

  /* Crew snapshot per DO. Best-effort — read the assign-time snapshot so the
     board shows the driver/helper/lorry without joining the masters. */
  type CrewOut = {
    // legacy collapsed strings (kept for back-compat search / fallback)
    driver: string | null; helper: string | null; lorry: string | null;
    // expanded per-person fields (HC delivery-sheet columns, snapshot)
    driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
    driver_2_name: string | null;
    helper_1_name: string | null; helper_2_name: string | null;
    lorry_plate: string | null;
  };
  const crewByDo = new Map<string, CrewOut>();
  /* Crew driver/helper IDS by DO id — the row-scope assignment (the CrewOut
     above carries only NAMES, for display). Only consulted when self-scoped. */
  const crewIdsByDo = new Map<string, { driverIds: string[]; helperIds: string[] }>();
  if (doIds.length > 0) {
    const { data: crewRows } = await chunkIn<{
      do_id: string;
      driver_1_id: string | null; driver_2_id: string | null;
      helper_1_id: string | null; helper_2_id: string | null;
      driver_1_name: string | null; driver_1_ic: string | null; driver_1_contact: string | null;
      driver_2_name: string | null;
      helper_1_name: string | null; helper_2_name: string | null; lorry_plate: string | null;
      driver1Id?: string | null; driver2Id?: string | null; helper1Id?: string | null; helper2Id?: string | null;
    }>(doIds, (batch, from, to) =>
      sb.from('delivery_order_crew')
        .select('do_id, driver_1_id, driver_2_id, helper_1_id, helper_2_id, driver_1_name, driver_1_ic, driver_1_contact, driver_2_name, helper_1_name, helper_2_name, lorry_plate')
        .in('do_id', batch).order('do_id').range(from, to),
    );
    for (const cr of crewRows) {
      crewIdsByDo.set(cr.do_id, {
        driverIds: [cr.driver1Id ?? cr.driver_1_id, cr.driver2Id ?? cr.driver_2_id].filter((x): x is string => !!x),
        helperIds: [cr.helper1Id ?? cr.helper_1_id, cr.helper2Id ?? cr.helper_2_id].filter((x): x is string => !!x),
      });
      crewByDo.set(cr.do_id, {
        driver: [cr.driver_1_name, cr.driver_2_name].filter(Boolean).join(' / ') || null,
        helper: [cr.helper_1_name, cr.helper_2_name].filter(Boolean).join(' / ') || null,
        lorry: cr.lorry_plate ?? null,
        driver_1_name: cr.driver_1_name ?? null,
        driver_1_ic: cr.driver_1_ic ?? null,
        driver_1_contact: cr.driver_1_contact ?? null,
        driver_2_name: cr.driver_2_name ?? null,
        helper_1_name: cr.helper_1_name ?? null,
        helper_2_name: cr.helper_2_name ?? null,
        lorry_plate: cr.lorry_plate ?? null,
      });
    }
  }

  /* 6. (removed) delivery_legs read — the multi-hop / dual-trip "leg" feature was
        removed (China-PO transit flow, not in use yet; re-add later). The
        scm.delivery_legs table stays in place but is no longer read here. */

  /* 7. Assemble one board row per SO with its derived state + region. An SO's
        "home" bucket = stateToRegionsFromConfig(customer_state, customer_country). */
  /* multi-company: id → code map (HOUZS / 2990 / …) so each shared-queue row can
     carry a readable company_code label. Built once. */
  const codeMap = companyCodeMap(c);
  /* PO lock per row (owner 2026-08-12, 2990 only) — the drawer decides
     client-side whether a replacement_disposal change saves directly or routes
     into an amendment, and it decides from the row. Without this fact on the row
     the drawer would attempt the direct write, collect the guard's 409, and
     strand the operator with a change they were told to request and no way to
     request it. ONE batched chain for the whole board (see soPoLockedMany), not
     a per-row query; Houzs doc numbers are filtered out inside it, so a
     Houzs-only board costs nothing. */
  const poLockedDocs = await soPoLockedMany(sb, docNos);
  const orders = soRows.map((r) => {
    const docNo = String(r.doc_no ?? '');
    /* Branding — derived 1:1 with the SO list (never the empty header field).
       Pick the catalog-resolved first-MAIN line as the SO's representative
       (repCat), falling back to the earliest-created line (firstCat); a MATTRESS
       rep with a blank own-branding falls back to mfg_products.branding. Then map
       through the ported deriveBranding. */
    const hasRep = repCat.has(docNo);
    const fCat = (hasRep ? repCat.get(docNo) : firstCat.get(docNo)) ?? null;
    let fBranding = (hasRep ? repBranding.get(docNo) : firstBranding.get(docNo)) ?? null;
    if (fCat === 'MATTRESS' && (!fBranding || !fBranding.trim())) {
      const code = hasRep ? repCode.get(docNo) : firstItemCode.get(docNo);
      fBranding = (code && productBranding.get(code)) || fBranding;
    }
    /* Company comes PER ROW, not from the caller: this board is a SHARED queue,
       so labelling a Houzs order "2990 Sofa" because a 2990 user opened it is a
       WRONG label, not a missing one. The old `|| null` is gone — the rule
       cannot return blank now (owner 2026-08-17), so it could only restore the
       empty state. See scm/shared/so-branding-label.ts. */
    const branding = deriveBranding(fCat, fBranding, codeMap.get(Number(r.company_id)) ?? null);
    const readiness = summariseReadiness(linesByDoc.get(docNo) ?? []);
    const delivered = deliveredByDoc.get(docNo) ?? 0;
    const remaining = remainingByDoc.get(docNo) ?? 0;
    const status = String(r.status ?? '').toUpperCase();
    const customerDD = r.customer_delivery_date ?? null;
    const procDate = r.processing_date ?? null;
    /* Amendment dates. The ORIGINAL is never overwritten; the amended date (when
       set) is what we now commit to. effectiveSoDelivery is the ONE reader of that
       rule (shared/effective-delivery.ts) — this board's chain was right all along;
       MRP and the allocator stopped disagreeing with it on 2026-08-18. */
    const amendDateFromCustomer = r.amendDateFromCustomer ?? r.amend_date_from_customer ?? null;
    const amendedDD = r.amendedDeliveryDate ?? r.amended_delivery_date ?? null;
    const effectiveDD = effectiveSoDelivery(r);

    /* "Ready to ship" gate — see summariseReadiness.isShipReady. */
    const readyToShip = readiness.isShipReady;

    /* delivery_state derivation (the core rule) — shared with the SO list via
       derivePlanningState(). A manual override stored on the SO header wins; else
       compute live. */
    const stored = r.delivery_state ?? null;
    const state: DeliveryState = derivePlanningState({
      storedOverride: stored, status, readiness, delivered, remaining, effectiveDD, today,
    });

    /* Region(s) for this SO = its customer-STATE bucket(s) from the config
       mapping (a state can map to MANY). primaryRegion = the first mapped bucket. */
    const stateRegions = stateToRegionsFromConfig(regionCfg, r.customer_state, r.customer_country);
    const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
    const regionSet = new Set<Region>(stateRegions);

    const dos = doByDoc.get(docNo) ?? [];
    const crew = dos.length > 0 ? (crewByDo.get(dos[dos.length - 1]!.id) ?? null) : null;
    const warehouseIds = [...(warehousesByDoc.get(docNo) ?? new Set<string>())];
    const primaryWh = warehouseIds[0] ?? null;

    return {
      // Row discriminator + ASSR-parity fields. SO rows are always 'so' with no
      // Service-Case ref / job_kind. ADDITIVE — every existing SO field below is
      // untouched (see the ASSR union after this map for the 'assr' rows).
      row_type: 'so' as 'so' | 'assr' | 'dp' | 'project',
      ref: null as string | null,
      job_kind: null as 'customer_pickup' | 'delivery' | 'inspection' | null,
      // DP-Order job type (DELIVERY/PICKUP/SERVICE/SETUP/DISMANTLE/SUPPLIER_PICKUP)
      // — only 'dp' rows carry it; SO/ASSR rows are null (union parity).
      dp_job_type: null as string | null,
      /* SO rows DO carry a DP number now — it is minted onto their trip_stop at
         schedule time, same rule and same number space as a manual DP order.
         null = not scheduled yet (or the lorry was not known), never a guess. */
      dp_no: dpNoByDoc.get(docNo) ?? null,
      assr_id: null as number | null,
      so_doc_no: docNo,
      debtor_code: r.debtor_code ?? null,
      debtor_name: r.debtor_name ?? null,
      phone: r.phone ?? null,
      agent: r.agent ?? null, salesperson_id: r.salespersonId ?? r.salesperson_id ?? null, venue: r.venue ?? null,
      /* SO rows always carry a real label now; `| null` is union parity for the
         three non-SO BoardRow kinds (ASSR / DP / project) that pass null. */
      branding: branding as string | null,
      status,
      delivery_state: state,
      delivery_state_override: stored && (DELIVERY_STATES as string[]).includes(stored) ? stored : null,
      // money — balance / outstanding (centi). Live balance (= local_total −
      // Σpayments, from mfg_sales_orders_with_payment_totals view) is the SO list
      // source-of-truth; base-table balance_sen is the fallback.
      balance_sen: Number(r.balance_sen ?? 0),
      balance_sen_live: liveBalanceByDoc.has(docNo) ? liveBalanceByDoc.get(docNo)! : null,
      local_total_sen: Number(r.local_total_sen ?? 0),
      /* AR-005 delivery-release gate (docs/agents/operating-spec.md §7.10 —
         "provides payment gate to Fulfilment and Delivery"). ADVISORY + read-only:
         it reports RELEASE / RELEASE_WITH_COLLECTION (what POD must collect) / HOLD
         from the balance already computed above; it does NOT block the board or the
         DO path (that stays owner-gated). Default policy has a zero pre-dispatch
         floor, so a normal outstanding balance surfaces as a collection amount, not
         a hold. Live balance = GREEN; only the base-table fallback = AMBER. */
      release_gate: (() => {
        const total = Number(r.local_total_sen ?? 0);
        const live = liveBalanceByDoc.has(docNo) ? liveBalanceByDoc.get(docNo)! : null;
        const bal = live != null ? live : Number(r.balance_sen ?? 0);
        const g = computeReleaseGate({
          totalSen: total,
          paidSen: Math.max(0, total - bal),
          dataQuality: live != null ? 'GREEN' : 'AMBER',
        });
        return {
          decision: g.decision,
          remaining_sen: g.remainingSen,
          collect_on_delivery_sen: g.collectOnDeliverySen,
          reason: g.reason,
        };
      })(),
      // dates
      so_date: r.so_date ?? null,
      // ORIGINAL date (the customer's pick — never overwritten) stays here.
      customer_delivery_date: customerDD,
      // Amendment dates: the customer's requested new date and the date WE
      // confirmed. The Original column above is unchanged.
      amend_date_from_customer: amendDateFromCustomer,
      amended_delivery_date: amendedDD,
      // HC "Amend Client Date Reason" — paired with the amend dates. dual-read.
      amend_reason: r.amendReason ?? r.amend_reason ?? null,
      // EFFECTIVE date (amended ?? original) — what the countdown actually uses.
      effective_delivery_date: effectiveDD,
      processing_date: procDate,
      /* Feeds procLockActive in the drawer alongside processing_date. */
      po_locked: poLockedDocs.has(docNo),
      days_left: daysBetween(today, effectiveDD),
      // address (HC delivery-sheet columns)
      address: [r.address1, r.address2].filter(Boolean).join(', ') || null,
      postcode: r.postcode ?? null,
      building_type: r.building_type ?? null,
      // HC SO-context raw-data fields — dual-read camelCase.
      possession_date: r.possessionDate ?? r.possession_date ?? null,
      house_type: r.houseType ?? r.house_type ?? null,
      replacement_disposal: r.replacementDisposal ?? r.replacement_disposal ?? null,
      referral: r.referral ?? null,
      // HC DO-execution raw-data fields — from the latest DO, null when this SO
      // has no (non-DRAFT/CANCELLED) DO yet.
      time_range: doExecByDoc.get(docNo)?.time_range ?? null,
      time_confirmed: doExecByDoc.get(docNo)?.time_confirmed ?? null,
      arrival_at: doExecByDoc.get(docNo)?.arrival_at ?? null,
      departure_at: doExecByDoc.get(docNo)?.departure_at ?? null,
      shipout_date: doExecByDoc.get(docNo)?.shipout_date ?? null,
      customer_delivered_date: doExecByDoc.get(docNo)?.customer_delivered_date ?? null,
      eta_arriving_port: doExecByDoc.get(docNo)?.eta_arriving_port ?? null,
      delivery_substatus: doExecByDoc.get(docNo)?.delivery_substatus ?? null,
      // EM-region transit arrival date, from the latest DO.
      arrives_em_warehouse_date: doExecByDoc.get(docNo)?.arrives_em_warehouse_date ?? null,
      // The latest DO's OWN document date (delivery_orders.do_date), null when
      // this SO has no (non-DRAFT/CANCELLED) DO yet — drives the "DO Date" column.
      do_date: doExecByDoc.get(docNo)?.do_date ?? null,
      // stock — the four fields and why they differ: lib/so-readiness-row.ts
      ...readinessRowFields(readiness),
      // multi-company: readable company code for the shared-queue Company column
      // (HOUZS / 2990). null when unresolved (pre-migration / cold-start).
      company_code: codeMap.get(Number(r.company_id)) ?? null,
      // region(s): the customer-state bucket(s); plus the warehouse label (kept
      // for the Warehouse column, not the region).
      region: primaryRegion,
      regions: [...regionSet],
      warehouse_id: primaryWh as string | null,
      warehouse_code: primaryWh ? (whCode.get(primaryWh) ?? null) : null,
      warehouse_name: primaryWh ? (whName.get(primaryWh) ?? null) : null,
      customer_state: r.customer_state ?? null,
      // delivery progress
      delivered_qty: delivered,
      remaining_qty: remaining,
      // crew (from the latest DO) + the DOs themselves
      crew,
      delivery_orders: dos.map((d) => ({ id: d.id, do_number: d.doNumber, status: d.status })),
      /* ── Arrangement pipeline (derived, lib/arrangement-stage.ts) ─────────
         The live trip this order sits on (via its DO's DELIVERY stop, CANCELLED
         trips excluded) and the derived stage:
           PENDING_DATE  — in Pending Schedule, amended_delivery_date not set
           PENDING_TIME  — date confirmed (amended_delivery_date), no live stop
           TIME_ARRANGED — on a live trip
         null outside Pending Schedule (nothing to arrange / already delivered). */
      trip_id: tripByDoc.get(docNo)?.id ?? null,
      trip_no: tripByDoc.get(docNo)?.trip_no ?? null,
      trip_date: tripByDoc.get(docNo)?.trip_date ?? null,
      /* Time-of-run keys (owner 2026-08-08: within the same date/state/postcode
         group the Time queues also order by TIME) — the stop's sequence and
         ETA offset on its live trip; null off-trip. */
      trip_stop_no: tripByDoc.get(docNo)?.stop_no ?? null,
      trip_eta_offset_s: tripByDoc.get(docNo)?.eta_offset_s ?? null,
      arrangement_stage: deriveArrangementStage({
        deliveryState: state,
        dateConfirmed: amendedDD != null,
        onActiveTrip: tripByDoc.has(docNo),
      }),
    };
  });

  /* 7b. ADDITIVELY union in Service-Case (ASSR) rows. A Service Case appears on
        the board ONLY when it carries a relevant date — customer_pickup_at (we go
        collect the faulty item) OR do_date (we go deliver it back) — and is still
        OPEN (closed_at IS NULL AND archived_at IS NULL). Each SET trigger date
        emits ONE row (a case with BOTH dates shows two rows: one job_kind
        'customer_pickup', one 'delivery'), so each leg schedules independently.
        assr_cases lives in the PUBLIC schema (not scm) — read it via c.env.DB
        (the D1-shim raw SQL over Postgres public.*, the same path the SO
        active-venue lookup uses), NOT the scm-scoped supabase client — which is
        exactly why this union shipped company-BLIND until 2026-08-21; the
        predicate now lives in assrBoardUnionSql (scm/lib/assr-board-scope.ts).
        Wrapped defensively: any failure logs + leaves the SO rows untouched. */
  type BoardRow = (typeof orders)[number];
  const assrOrders: BoardRow[] = [];
  try {
    // Explicit lowercase aliases → deterministic snake_case result keys
    // (sidesteps any driver camelCasing). Only OPEN cases with a trigger date.
    const assrRows = await c.env.DB.prepare(assrBoardUnionSql(c)).all<{
      id: number | null; assr_no: string | null; company_id: number | null; status: string | null;
      customer_name: string | null; phone: string | null; location: string | null;
      customer_pickup_at: string | null; inspection_visit_at: string | null;
      inspection_by: string | null; do_date: string | null;
      addr1: string | null; addr2: string | null; addr3: string | null; addr4: string | null;
    }>();

    for (const a of (assrRows.results ?? [])) {
      const assrNo = String(a.assr_no ?? '').trim();
      if (!assrNo) continue;
      // Region buckets from the case LOCATION/state — REUSE the SAME config
      // mapping SO rows use (stateToRegionsFromConfig), so ASSR rows filter by
      // the region tab exactly like SOs.
      const stateRegions = stateToRegionsFromConfig(regionCfg, a.location, null);
      const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
      const regionSet = new Set<Region>(stateRegions);
      const address = [a.addr1, a.addr2, a.addr3, a.addr4].filter(Boolean).join(', ') || null;

      // One row per SET trigger date. job_kind = which date drives THIS row; the
      // effective/board date is that trigger date so it lands in the schedule
      // column. A date-but-not-yet-delivered case = PENDING_SCHEDULE (reuse the
      // existing enum). Stock columns are null/'—' for ASSR rows.
      const legs: Array<{ jobKind: 'customer_pickup' | 'delivery' | 'inspection'; date: string }> = [];
      if (a.customer_pickup_at) legs.push({ jobKind: 'customer_pickup', date: a.customer_pickup_at });
      // Own-team on-site inspection visit — a distinct fleet leg. Supplier-done
      // inspections are handled on the supplier side, so they never surface here
      // (the SELECT already gates this to inspection_by = 'own').
      if (a.inspection_visit_at && a.inspection_by === 'own') legs.push({ jobKind: 'inspection', date: a.inspection_visit_at });
      if (a.do_date)            legs.push({ jobKind: 'delivery',        date: a.do_date });

      for (const leg of legs) {
        // so_doc_no is the React rowKey on the board — a case with two legs must
        // yield two DISTINCT keys, so suffix with the job_kind.
        const rowKey = `${assrNo}#${leg.jobKind}`;
        assrOrders.push({
          row_type: 'assr',
          ref: assrNo,
          job_kind: leg.jobKind,
          dp_job_type: null,
          dp_no: null,
          assr_id: a.id != null ? Number(a.id) : null,
          so_doc_no: rowKey,
          debtor_code: null,
          debtor_name: a.customer_name ?? null,
          phone: a.phone ?? null, agent: null, salesperson_id: null, venue: null,
          branding: null,
          status: a.status ?? '',
          // A set date but not yet delivered → Pending Delivery (owner: a dated
          // service case surfaces under Pending Delivery until it's scheduled out).
          delivery_state: 'PENDING_DELIVERY',
          delivery_state_override: null,
          balance_sen: 0,
          balance_sen_live: null,
          local_total_sen: 0,
          /* Service cases carry no order balance, so the release gate is a plain
             RELEASE — parity with the SO row's field (the board unions the two
             shapes). Computed, not a literal, so the shape can never drift from
             the SO side. */
          release_gate: (() => {
            const g = computeReleaseGate({ totalSen: 0, paidSen: 0 });
            return {
              decision: g.decision,
              remaining_sen: g.remainingSen,
              collect_on_delivery_sen: g.collectOnDeliverySen,
              reason: 'service case — no order balance',
            };
          })(),
          so_date: null,
          // The trigger date maps into the board date fields so it lands in the
          // schedule / Days-Left column exactly like an SO's effective date.
          customer_delivery_date: leg.date,
          amend_date_from_customer: null,
          amended_delivery_date: leg.date,
          amend_reason: null,
          effective_delivery_date: leg.date,
          processing_date: leg.date,
          /* Synthetic job row — its so_doc_no is a ROW KEY, not a real SO doc
             number, and it carries no replacement_disposal for the drawer to
             lock. Always false; a Set lookup on a row key would be meaningless. */
          po_locked: false,
          days_left: daysBetween(today, leg.date),
          address,
          postcode: null,
          building_type: null,
          possession_date: null,
          house_type: null,
          replacement_disposal: null,
          referral: null,
          time_range: null,
          time_confirmed: null,
          arrival_at: null,
          departure_at: null,
          shipout_date: null,
          customer_delivered_date: null,
          eta_arriving_port: null,
          delivery_substatus: null,
          arrives_em_warehouse_date: null,
          do_date: leg.jobKind === 'delivery' ? leg.date : null,
          // Stock columns are not meaningful for a Service Case.
          ...NO_STOCK_ROW,
          /* The company chip, from the SAME codeMap the SO rows use. Was a hard
             `null` under the comment "no scm company_id yet" — wrong, and being
             wrong is what let the union ship unscoped: the column is bigint NOT
             NULL (production, 2026-08-21). */
          company_code: a.company_id != null ? (codeMap.get(Number(a.company_id)) ?? null) : null,
          region: primaryRegion,
          regions: [...regionSet],
          warehouse_id: null,
          warehouse_code: null,
          warehouse_name: null,
          customer_state: a.location ?? null,
          delivered_qty: 0,
          remaining_qty: 0,
          crew: null,
          delivery_orders: [],
          /* ASSR legs land PENDING_DELIVERY and schedule on their own document —
             they are outside the SO arrangement pipeline (stage null). */
          trip_id: null,
          trip_no: null,
          trip_date: null,
          trip_stop_no: null,
          trip_eta_offset_s: null,
          arrangement_stage: null,
        });
      }
    }
  } catch (e) {
    // Defensive: a malformed / edge ASSR case must NEVER break the SO rows.
    console.warn(`[delivery-planning] ASSR union skipped: ${String((e as Error).message).slice(0, 120)}`);
  }

  /* ── ASSR crew echo (P3) ──────────────────────────────────────────────────────
     An ASSR leg scheduled onto a trip (scheduleAssrOntoTrip) writes a trip_stop
     keyed by (assr_case_id, stop_type). Resolve that stop's trip crew so the board's
     Driver / Lorry cells reflect the assignment — not just optimistically, but on
     every load. Best-effort: any failure leaves the ASSR rows date-only. */
  try {
    const assrCaseIds = [...new Set(assrOrders.map((o) => o.assr_id).filter((x): x is number => x != null))];
    if (assrCaseIds.length) {
      const { data: stops } = await chunkIn<{ assr_case_id: number; stop_type: string; trip_id: string }, number>(assrCaseIds, (batch, from, to) => sb.from('trip_stops')
        .select('assr_case_id, stop_type, trip_id').in('assr_case_id', batch).order('assr_case_id').range(from, to));
      if (stops.length) {
        const tripIds = [...new Set(stops.map((s) => s.trip_id).filter(Boolean))];
        const { data: trips } = await chunkIn<{ id: string; driver_id: string | null; lorry_id: string | null }>(tripIds,
          (batch, from, to) => sb.from('trips').select('id, driver_id, lorry_id').in('id', batch).order('id').range(from, to));
        const tripById = new Map(trips.map((t) => [String(t.id), t]));
        const driverIds = [...new Set(trips.map((t) => t.driver_id).filter((x): x is string => !!x))];
        const lorryIds = [...new Set(trips.map((t) => t.lorry_id).filter((x): x is string => !!x))];
        const { data: drvRaw } = driverIds.length ? await sb.from('drivers').select('id, name').in('id', driverIds) : { data: [] };
        const { data: lryRaw } = lorryIds.length ? await sb.from('lorries').select('id, plate').in('id', lorryIds) : { data: [] };
        const driverName = new Map(((drvRaw ?? []) as Array<{ id: string; name: string | null }>).map((d) => [String(d.id), d.name]));
        const lorryPlate = new Map(((lryRaw ?? []) as Array<{ id: string; plate: string | null }>).map((l) => [String(l.id), l.plate]));
        const stopByKey = new Map<string, { driver: string | null; lorry: string | null }>();
        for (const s of stops) {
          const t = tripById.get(String(s.trip_id));
          stopByKey.set(`${s.assr_case_id}#${s.stop_type}`, {
            driver: t?.driver_id ? (driverName.get(String(t.driver_id)) ?? null) : null,
            lorry: t?.lorry_id ? (lorryPlate.get(String(t.lorry_id)) ?? null) : null,
          });
        }
        for (const o of assrOrders) {
          const st = o.job_kind === 'customer_pickup' ? 'PICKUP' : o.job_kind === 'inspection' ? 'INSPECTION' : 'DELIVERY';
          const hit = stopByKey.get(`${o.assr_id}#${st}`);
          if (hit && (hit.driver || hit.lorry)) {
            o.crew = {
              driver: hit.driver, helper: null, lorry: hit.lorry,
              driver_1_name: hit.driver, driver_1_ic: null, driver_1_contact: null,
              driver_2_name: null, helper_1_name: null, helper_2_name: null,
              lorry_plate: hit.lorry,
            };
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[delivery-planning] ASSR crew echo skipped: ${String((e as Error).message).slice(0, 120)}`);
  }

  /* ── DP Order union (mig 0129) ────────────────────────────────────────────────
     The MANUAL DP orders — SETUP / DISMANTLE / SUPPLIER_PICKUP and any DP order
     with no source document already on the board (so_doc_no / assr_case_id / do_id
     all null). SO/assr-backed DP orders are NOT unioned: their SO/ASSR row already
     represents them, so pulling the DP row too would double the line. Same
     defensive wrapper as the ASSR union — a bad DP row must never break the board.
     Region + date + release-gate mirror the ASSR row exactly (parity). */
  const dpBoardRows: BoardRow[] = [];
  /* DP-row key ("DP:<id>") → its trip_id, so a self-scoped caller's DP jobs can
     be resolved from the trip crew (a DP order carries no delivery_order_crew).
     Only consulted when self-scoped. */
  const dpTripIdByKey = new Map<string, string | null>();
  try {
    let dpQuery = sb.from('dp_orders')
      .select('id, dp_no, job_type, party_name, contact_phone, address1, address2, address3, address4, city, postcode, state, requested_date, status, trip_id')
      .is('so_doc_no', null).is('assr_case_id', null).is('do_id', null)
      .not('status', 'in', '("DELIVERED","CANCELLED")')
      .limit(1000);
    dpQuery = scopeToAllowedCompanies(dpQuery, c);
    const dpRes = await dpQuery;
    for (const d of (dpRes.data ?? []) as Array<Record<string, unknown>>) {
      const dpState = (d.state as string | null) ?? null;
      const stateRegions = stateToRegionsFromConfig(regionCfg, dpState, null);
      const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
      const regionSet = new Set<Region>(stateRegions);
      const date = (d.requested_date as string | null) ?? null;
      const address = [d.address1, d.address2, d.address3, d.address4, d.city, d.postcode, d.state]
        .filter(Boolean).join(', ') || null;
      const scheduled = String(d.status ?? '') === 'SCHEDULED';
      dpTripIdByKey.set(`DP:${String(d.id)}`, ((d.trip_id ?? (d as { tripId?: string | null }).tripId) as string | null) ?? null);
      dpBoardRows.push({
        row_type: 'dp',
        ref: (d.dp_no as string | null) ?? null,
        job_kind: null,
        dp_job_type: (d.job_type as string | null) ?? null,
        dp_no: (d.dp_no as string | null) ?? null,
        assr_id: null,
        // Stable, unique React key — DP orders have no SO doc number.
        so_doc_no: `DP:${String(d.id)}`,
        debtor_code: null,
        debtor_name: (d.party_name as string | null) ?? null,
        phone: (d.contact_phone as string | null) ?? null, agent: null, salesperson_id: null, venue: null,
        branding: null,
        status: String(d.status ?? ''),
        delivery_state: scheduled ? 'PENDING_DELIVERY' : 'PENDING_SCHEDULE',
        delivery_state_override: null,
        balance_sen: 0,
        balance_sen_live: null,
        local_total_sen: 0,
        // A DP job carries no order balance — plain RELEASE, computed for parity.
        release_gate: (() => {
          const g = computeReleaseGate({ totalSen: 0, paidSen: 0 });
          return { decision: g.decision, remaining_sen: g.remainingSen, collect_on_delivery_sen: g.collectOnDeliverySen, reason: 'DP job — no order balance' };
        })(),
        so_date: null,
        customer_delivery_date: date,
        amend_date_from_customer: null,
        amended_delivery_date: date,
        amend_reason: null,
        effective_delivery_date: date,
        processing_date: date,
        /* Synthetic DP job row — so_doc_no is `DP:<id>`, not a real SO doc
           number, and it carries no replacement_disposal for the drawer to lock. */
        po_locked: false,
        days_left: date ? daysBetween(today, date) : null,
        address,
        postcode: (d.postcode as string | null) ?? null,
        building_type: null,
        possession_date: null,
        house_type: null,
        replacement_disposal: null,
        referral: null,
        time_range: null,
        time_confirmed: null,
        arrival_at: null,
        departure_at: null,
        shipout_date: null,
        customer_delivered_date: null,
        eta_arriving_port: null,
        delivery_substatus: null,
        arrives_em_warehouse_date: null,
        do_date: null,
        ...NO_STOCK_ROW,
        company_code: null,
        region: primaryRegion,
        regions: [...regionSet],
        warehouse_id: null,
        warehouse_code: null,
        warehouse_name: null,
        customer_state: dpState,
        delivered_qty: 0,
        remaining_qty: 0,
        crew: null,
        delivery_orders: [],
        /* A manual DP job joins the pipeline while it is PENDING_SCHEDULE: its
           requested_date is its confirmed date (dp orders are created with the
           date in hand), so an unscheduled dated job is PENDING_TIME — it needs
           a lorry, which is exactly what the Time Arrangement inbox offers.
           Scheduling it (date+lorry in one act) flips its board state to
           PENDING_DELIVERY, which exits the pipeline (stage null). */
        trip_id: ((d.trip_id ?? (d as { tripId?: string | null }).tripId) as string | null) ?? null,
        trip_no: null,
        trip_date: null,
        trip_stop_no: null,
        trip_eta_offset_s: null,
        arrangement_stage: deriveArrangementStage({
          deliveryState: scheduled ? 'PENDING_DELIVERY' : 'PENDING_SCHEDULE',
          dateConfirmed: date != null,
          onActiveTrip: false, // an unscheduled DP job is never on a trip yet
        }),
      });
    }
  } catch (e) {
    console.warn(`[delivery-planning] DP-order union skipped: ${String((e as Error).message).slice(0, 120)}`);
  }

  /* ── PMS project SETUP / DISMANTLE union (READ-ONLY mirror) ───────────────────
     The fleet (drivers / lorries) is SHARED across deliveries, service cases AND
     exhibition projects, so a project's setup / dismantle window is a real fleet
     commitment the coordinator must SEE to avoid double-booking a lorry. This is a
     read-only mirror of what the PMS module already schedules (projects.setup_* /
     dismantle_*): scheduling + crew assignment stay in PMS, which owns that editor
     and its permission gates (SETUP_DISMANTLE). One row per SET window (a project
     with both a setup and a dismantle date shows two rows). Fleet is company-shared
     so this is intentionally NOT company-scoped. public.projects → c.env.DB raw SQL
     (same path as the ASSR union). Defensive: any failure logs + leaves the rest. */
  const projectOrders: BoardRow[] = [];
  try {
    const projRows = await c.env.DB.prepare(
      `SELECT p.id AS id, p.code AS code, p.name AS name,
              p.venue AS venue, p.venue_address AS venue_address, p.state AS state,
              p.setup_start_at     AS setup_start_at,
              p.dismantle_start_at AS dismantle_start_at,
              sd.name  AS setup_driver_name,     sl.plate AS setup_lorry_plate,
              dd.name  AS dismantle_driver_name, dl.plate AS dismantle_lorry_plate
         FROM projects p
         LEFT JOIN users   sd ON sd.id = p.setup_driver_user_id
         LEFT JOIN lorries sl ON sl.id = p.setup_lorry_id
         LEFT JOIN users   dd ON dd.id = p.dismantle_driver_user_id
         LEFT JOIN lorries dl ON dl.id = p.dismantle_lorry_id
        WHERE p.archived_at IS NULL
          AND (p.setup_start_at IS NOT NULL OR p.dismantle_start_at IS NOT NULL)`,
    ).all<{
      id: number | null; code: string | null; name: string | null;
      venue: string | null; venue_address: string | null; state: string | null;
      setup_start_at: string | null; dismantle_start_at: string | null;
      setup_driver_name: string | null; setup_lorry_plate: string | null;
      dismantle_driver_name: string | null; dismantle_lorry_plate: string | null;
    }>();

    for (const p of (projRows.results ?? [])) {
      const stateRegions = stateToRegionsFromConfig(regionCfg, p.state, null);
      const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
      const regionSet = new Set<Region>(stateRegions);
      const address = p.venue_address ?? p.venue ?? null;
      const partyName = p.venue ?? p.name ?? null;

      // One row per SET window; job type reuses the DP SETUP/DISMANTLE vocabulary
      // so the board's Type chip labels it via the same dpJobTypeLabel map.
      const legs: Array<{ jobType: 'SETUP' | 'DISMANTLE'; date: string; driver: string | null; lorry: string | null }> = [];
      if (p.setup_start_at)     legs.push({ jobType: 'SETUP',     date: String(p.setup_start_at).slice(0, 10),     driver: p.setup_driver_name,     lorry: p.setup_lorry_plate });
      if (p.dismantle_start_at) legs.push({ jobType: 'DISMANTLE', date: String(p.dismantle_start_at).slice(0, 10), driver: p.dismantle_driver_name, lorry: p.dismantle_lorry_plate });

      for (const leg of legs) {
        const rowKey = `PRJ:${String(p.id)}#${leg.jobType}`;
        projectOrders.push({
          row_type: 'project',
          ref: p.code ?? null,
          job_kind: null,
          dp_job_type: leg.jobType,
          dp_no: null,
          assr_id: null,
          so_doc_no: rowKey,
          debtor_code: null,
          debtor_name: partyName,
          phone: null, agent: null, salesperson_id: null, venue: p.venue ?? null, // a project's venue is real
          branding: null,
          status: 'PROJECT',
          // Read-only mirror: a project window is already crewed in PMS → it's a
          // committed fleet job, so it surfaces under Pending Delivery.
          delivery_state: 'PENDING_DELIVERY',
          delivery_state_override: null,
          balance_sen: 0,
          balance_sen_live: null,
          local_total_sen: 0,
          release_gate: (() => {
            const g = computeReleaseGate({ totalSen: 0, paidSen: 0 });
            return { decision: g.decision, remaining_sen: g.remainingSen, collect_on_delivery_sen: g.collectOnDeliverySen, reason: 'PMS project — no order balance' };
          })(),
          so_date: null,
          customer_delivery_date: leg.date,
          amend_date_from_customer: null,
          amended_delivery_date: leg.date,
          amend_reason: null,
          effective_delivery_date: leg.date,
          processing_date: leg.date,
          /* Synthetic job row — its so_doc_no is a ROW KEY, not a real SO doc
             number, and it carries no replacement_disposal for the drawer to
             lock. Always false; a Set lookup on a row key would be meaningless. */
          po_locked: false,
          days_left: daysBetween(today, leg.date),
          address,
          postcode: null,
          building_type: null,
          possession_date: null,
          house_type: null,
          replacement_disposal: null,
          referral: null,
          time_range: null,
          time_confirmed: null,
          arrival_at: null,
          departure_at: null,
          shipout_date: null,
          customer_delivered_date: null,
          eta_arriving_port: null,
          delivery_substatus: null,
          arrives_em_warehouse_date: null,
          do_date: null,
          ...NO_STOCK_ROW,
          company_code: null,
          region: primaryRegion,
          regions: [...regionSet],
          warehouse_id: null,
          warehouse_code: null,
          warehouse_name: null,
          customer_state: p.state ?? null,
          delivered_qty: 0,
          remaining_qty: 0,
          // Show the crew PMS already assigned to this window (read-only on the board).
          crew: (leg.driver || leg.lorry) ? {
            driver: leg.driver, helper: null, lorry: leg.lorry,
            driver_1_name: leg.driver, driver_1_ic: null, driver_1_contact: null,
            driver_2_name: null, helper_1_name: null, helper_2_name: null,
            lorry_plate: leg.lorry,
          } : null,
          delivery_orders: [],
          /* PMS windows are scheduled and crewed in Projects — a read-only
             mirror here, outside the arrangement pipeline. */
          trip_id: null,
          trip_no: null,
          trip_date: null,
          trip_stop_no: null,
          trip_eta_offset_s: null,
          arrangement_stage: null,
        });
      }
    }
  } catch (e) {
    console.warn(`[delivery-planning] project union skipped: ${String((e as Error).message).slice(0, 120)}`);
  }

  const allOrders = [...orders, ...assrOrders, ...dpBoardRows, ...projectOrders];

  /* 7c. PER-ASSIGNEE ROW SCOPE. For a self-scoped caller (Driver/Helper), keep
        ONLY the rows assigned to them; unassigned rows and other crews' jobs drop
        out. Ops/dispatcher/management resolve to `all` above, so this whole block
        is skipped and their board is byte-identical to before. A row's assignment:
          · SO row  → the latest DO's header driver_id + crew driver/helper ids.
          · DP row  → its trip's driver_id / helper_1_id / helper_2_id.
          · ASSR / DO-less SO → no assignment (empty) → never matches a self scope. */
  const scopedOrders = await applyDeliveryRowScope(sb, scope, allOrders, {
    doByDoc, doDriverById, crewIdsByDo, dpTripIdByKey,
  });

  /* 8. Counts per state — computed over the REGION-filtered set so the state
        tab badges reflect the active region. The state filter is applied AFTER
        counting (so switching state tabs doesn't change the badge numbers). The
        region param is validated against the config's region codes. */
  const regionFiltered = scopedOrders.filter((o) => matchesRegion(o, regionParam, regionCfg.validCodes));
  const counts = emptyCounts();
  for (const o of regionFiltered) counts[o.delivery_state] += 1;
  counts.ALL = regionFiltered.length;

  const stateFiltered = stateParam === 'ALL'
    ? regionFiltered
    : regionFiltered.filter((o) => o.delivery_state === stateParam);

  return c.json({ orders: stateFiltered, counts, regions: regionCfg.regions });
};
deliveryPlanning.get('/', deliveryPlanningBoardHandler);

/* ──────────────────────────────────────────────────────────────────────────
   GET /delivery-planning/geo?date=YYYY-MM-DD&region=<ALL|code>

   The Option B side-map read (owner decision 2026-08-08): ONE point per SO
   whose EFFECTIVE delivery date (amended ?? customer — the same rule the board
   derives days_left from) falls on the picked day. Company-scoped to the
   caller's ALLOWED companies (the shared queue reads both — WIDEN, never
   isolate, same as /:docNo/lines) and region-filtered EXACTLY like the board
   (same loadRegionConfig classification + matchesRegion). Per-assignee row
   scope applies like everywhere else on this router: a self-scoped Driver /
   Helper gets only their own day-pins (the board's latest-DO assignment rule).

   lat/lng resolve through the EXISTING scm.geocode_cache (mig 0197):
   ONE BATCHED cache read first, then AT MOST one Google call per never-seen
   address (geocodeAddressCached writes it back, so a given address geocodes
   once EVER — the /trips/day cost pattern, never a per-request storm; with no
   GOOGLE_MAPS_API_KEY nothing bills and only cached addresses pin). An address
   that cannot be located is returned in `ungeocoded` with a reason — never
   silently dropped. The depot is the day's majority line-warehouse, geocoded
   the same way; `depotReason` says why when it is null.

   READ-ONLY, no polling — the frontend fetches once per (date, region) with
   react-query staleTime like its siblings.

   MUST stay registered BEFORE '/:docNo/lines' — 'geo' would otherwise parse
   as a docNo (the same ordering rule /trips/day documents).
   ─────────────────────────────────────────────────────────────────────────*/
deliveryPlanning.get('/geo', async (c) => {
  const sb = c.get('supabase');
  const date = (c.req.query('date') ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'invalid_date', reason: 'date=YYYY-MM-DD is required' }, 400);
  }
  const regionParam = (c.req.query('region') ?? 'ALL').trim().toUpperCase();
  const configured = !!c.env.GOOGLE_MAPS_API_KEY;

  const regionCfg = await loadRegionConfig(sb);

  /* 1. The day's SOs — live (not DRAFT/CANCELLED) whose EFFECTIVE delivery
        date is the picked day: amended_delivery_date == date, OR no amended
        date AND customer_delivery_date == date. */
  type GeoSoRow = {
    doc_no: string | null; docNo?: string | null;
    debtor_name: string | null; debtorName?: string | null;
    customer_state: string | null; customerState?: string | null;
    customer_country: string | null; customerCountry?: string | null;
    address1: string | null; address2: string | null;
    postcode: string | null;
    local_total_sen: number | null; localTotalSen?: number | null;
  };
  const { data: soRowsRaw, error: soErr } = await paginateAll<GeoSoRow>((from, to) =>
    scopeToAllowedCompanies(
      sb.from('mfg_sales_orders')
        .select('doc_no, debtor_name, customer_state, customer_country, address1, address2, postcode, local_total_sen')
        .neq('status', 'DRAFT')
        .neq('status', 'CANCELLED')
        .or(`amended_delivery_date.eq.${date},and(amended_delivery_date.is.null,customer_delivery_date.eq.${date})`)
        .order('doc_no'),
      c,
    ).range(from, to),
  );
  if (soErr) return c.json({ error: 'load_failed', reason: soErr.message }, 500);

  /* Region filter — the SAME config classification + match rule as the board. */
  const regionsByDoc = new Map<string, Region[]>();
  const dayRows = (soRowsRaw ?? []).filter((r) => {
    const dn = String(r.docNo ?? r.doc_no ?? '');
    if (!dn) return false;
    const regions = stateToRegionsFromConfig(
      regionCfg,
      r.customerState ?? r.customer_state ?? null,
      r.customerCountry ?? r.customer_country ?? null,
    );
    regionsByDoc.set(dn, regions);
    return matchesRegion({ regions }, regionParam, regionCfg.validCodes);
  });
  let docNos = dayRows.map((r) => String(r.docNo ?? r.doc_no ?? '')).filter(Boolean);

  /* 1b. PER-ASSIGNEE ROW SCOPE — the board's latest-DO assignment rule. `all`
        (every dispatcher/ops caller) skips this entirely. */
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  if (scope.mode !== 'all' && docNos.length > 0) {
    const { data: doRows } = await chunkIn<{
      id: string; so_doc_no: string | null; status: string | null;
      driver_id: string | null; driverId?: string | null;
    }>(docNos, (batch, from, to) =>
      sb.from('delivery_orders')
        .select('id, so_doc_no, status, driver_id')
        .in('so_doc_no', batch).order('id').range(from, to),
    );
    const latestDoByDoc = new Map<string, { id: string; driverId: string | null }>();
    const scopeDoIds: string[] = [];
    for (const d of doRows) {
      const st = (d.status ?? '').toUpperCase();
      if (st === 'DRAFT' || st === 'CANCELLED') continue;
      const dn = d.so_doc_no ?? '';
      if (!dn) continue;
      latestDoByDoc.set(dn, { id: d.id, driverId: d.driverId ?? d.driver_id ?? null });
      scopeDoIds.push(d.id);
    }
    const crewByDoId = new Map<string, { driverIds: Array<string | null>; helperIds: Array<string | null> }>();
    if (scopeDoIds.length > 0) {
      const { data: crewRows } = await chunkIn<Record<string, unknown>>(scopeDoIds, (batch, from, to) =>
        sb.from('delivery_order_crew')
          .select('do_id, driver_1_id, driver_2_id, helper_1_id, helper_2_id')
          .in('do_id', batch).order('do_id').range(from, to),
      );
      for (const cr of crewRows) {
        crewByDoId.set(String(cr.do_id ?? cr.doId ?? ''), {
          driverIds: [(cr.driver1Id ?? cr.driver_1_id) as string | null, (cr.driver2Id ?? cr.driver_2_id) as string | null],
          helperIds: [(cr.helper1Id ?? cr.helper_1_id) as string | null, (cr.helper2Id ?? cr.helper_2_id) as string | null],
        });
      }
    }
    docNos = docNos.filter((dn) => {
      const latest = latestDoByDoc.get(dn);
      if (!latest) return false; // no DO cut yet → unassigned → not a self-scoped caller's job
      const crew = crewByDoId.get(latest.id) ?? { driverIds: [], helperIds: [] };
      return scopeMatchesAssignment(scope, {
        driverIds: [...crew.driverIds, latest.driverId],
        helperIds: crew.helperIds,
      });
    });
  }
  const docNoSet = new Set(docNos);
  const scopedRows = dayRows.filter((r) => docNoSet.has(String(r.docNo ?? r.doc_no ?? '')));

  if (scopedRows.length === 0) {
    return c.json({ date, region: regionParam, configured, points: [], depot: null, depotReason: 'no orders on this day', ungeocoded: [] });
  }

  /* 2. Zone map — the SAME company map + in-code default the delivery-zones
        router owns (exported helpers, one rule, two readers). */
  const { data: zoneRows } = await paginateAll<ZoneMapRow>((from, to) =>
    scopeToCompany(sb.from('delivery_zone_postcodes').select(ZONE_MAP_COLS), c).range(from, to),
  );
  const { map: zoneMap } = toPrefixMap(zoneRows ?? []);

  /* 3. Line items → set counts (the packer's derivation: catalog category
        first, item_group fallback, deriveSetCount) + the per-order primary
        warehouse for the depot vote. */
  const { data: itemRows } = await chunkIn<{
    doc_no: string; item_group: string | null; item_code: string | null;
    qty: number | null; cancelled: boolean | null;
    warehouse_id: string | null; warehouseId?: string | null;
  }>(docNos, (batch, from, to) =>
    scopeToAllowedCompanies(
      sb.from('mfg_sales_order_items')
        .select('doc_no, item_group, item_code, qty, cancelled, warehouse_id')
        .in('doc_no', batch)
        .eq('cancelled', false),
      c,
    ).order('doc_no').range(from, to),
  );
  const geoCodes = new Set<string>();
  for (const it of itemRows) if (it.item_code) geoCodes.add(it.item_code);
  const geoProductCategory = new Map<string, string>();
  {
    const codeList = [...geoCodes];
    for (let i = 0; i < codeList.length; i += 300) {
      const chunk = codeList.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: prodRows } = await paginateAll<{ code: string; category: string | null }>((from, to) =>
        scopeToCompany(sb.from('mfg_products').select('code, category').in('code', chunk), c).range(from, to),
      );
      for (const p of (prodRows ?? [])) if (p.category) geoProductCategory.set(p.code, normCategory(p.category));
    }
  }
  const setLinesByDoc = new Map<string, SetLine[]>();
  const primaryWhByDoc = new Map<string, string>();
  for (const it of itemRows) {
    const dn = String(it.doc_no ?? '');
    if (!dn) continue;
    const cat = (it.item_code ? geoProductCategory.get(it.item_code) : undefined) ?? normCategory(it.item_group ?? '');
    const arr = setLinesByDoc.get(dn) ?? [];
    arr.push({ category: cat, qty: it.qty, cancelled: it.cancelled });
    setLinesByDoc.set(dn, arr);
    const wh = it.warehouseId ?? it.warehouse_id;
    if (wh && !primaryWhByDoc.has(dn)) primaryWhByDoc.set(dn, String(wh));
  }

  /* 4. Depot = the day's MAJORITY primary warehouse (one vote per order, ties
        break to the first seen — the same deterministic rule the Time page's
        depotForDocNos uses), geocoded cache-first like everything else. */
  let depot: { warehouseId: string; name: string; code: string | null; lat: number; lng: number } | null = null;
  let depotReason: string | null = null;
  {
    const votes = new Map<string, { count: number; seen: number }>();
    let seen = 0;
    for (const dn of docNos) {
      const wh = primaryWhByDoc.get(dn);
      if (!wh) continue;
      const cur = votes.get(wh);
      if (cur) cur.count += 1;
      else votes.set(wh, { count: 1, seen: seen++ });
    }
    let best: { id: string; count: number; seen: number } | null = null;
    for (const [id, v] of votes) {
      if (!best || v.count > best.count || (v.count === best.count && v.seen < best.seen)) best = { id, ...v };
    }
    if (!best) depotReason = "the day's orders carry no warehouse";
    else {
      const { data: whRow } = await sb.from('warehouses')
        .select('id, name, code, location, city, state, postcode')
        .eq('id', best.id)
        .maybeSingle();
      const w = (whRow ?? {}) as Record<string, unknown>;
      const whName = String(w.name ?? '');
      const whAddr = composeAddress({
        address1: (w.location ?? null) as string | null,
        address2: (w.city ?? null) as string | null,
        postcode: (w.postcode ?? null) as string | null,
        state: (w.state ?? null) as string | null,
      });
      const hit = whAddr ? await geocodeAddressCached(sb, c.env, whAddr) : null;
      if (hit) {
        depot = { warehouseId: best.id, name: whName, code: (w.code ?? null) as string | null, lat: hit.lat, lng: hit.lng };
      } else {
        depotReason = whName
          ? `depot warehouse "${whName}" could not be geocoded — fill in its address in the Warehouses master`
          : 'depot warehouse could not be geocoded';
      }
    }
  }

  /* 5. Point geocodes — ONE batched cache read over the day's normalized
        addresses, then geocodeAddressCached ONLY for the misses (each miss is
        one Google call, once ever; with no key, misses stay ungeocoded). */
  const addrByDoc = new Map<string, string>();
  for (const r of scopedRows) {
    const dn = String(r.docNo ?? r.doc_no ?? '');
    const addr = composeAddress({
      address1: r.address1,
      address2: r.address2,
      postcode: r.postcode,
      state: r.customerState ?? r.customer_state ?? null,
      country: r.customerCountry ?? r.customer_country ?? null,
    });
    if (dn && addr) addrByDoc.set(dn, addr);
  }
  const cachedByKey = new Map<string, { lat: number; lng: number }>();
  {
    const keys = [...new Set([...addrByDoc.values()].map((a) => normalizeAddress(a)).filter((k) => k !== ''))];
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200);
      if (chunk.length === 0) continue;
      const { data: hits } = await sb.from('geocode_cache')
        .select('normalized_address, lat, lng')
        .in('normalized_address', chunk);
      for (const h of ((hits ?? []) as Array<Record<string, unknown>>)) {
        const key = String(h.normalizedAddress ?? h.normalized_address ?? '');
        const lat = Number(h.lat);
        const lng = Number(h.lng);
        if (key && Number.isFinite(lat) && Number.isFinite(lng)) cachedByKey.set(key, { lat, lng });
      }
    }
  }

  /* 6. Assemble the points; every failure lands in `ungeocoded` with a reason. */
  const points: Array<{
    ref: string; so_doc_no: string; lat: number; lng: number;
    zone: string | null; region: Region; state: string | null; postcode: string | null;
    sets: number; revenueSen: number; customer: string | null; address: string;
  }> = [];
  const ungeocoded: Array<{ ref: string; reason: string }> = [];
  const missResolved = new Map<string, { lat: number; lng: number } | null>();
  for (const r of scopedRows) {
    const dn = String(r.docNo ?? r.doc_no ?? '');
    const addr = addrByDoc.get(dn);
    if (!addr) { ungeocoded.push({ ref: dn, reason: 'no address on the order' }); continue; }
    const key = normalizeAddress(addr);
    let hit = cachedByKey.get(key) ?? null;
    if (!hit) {
      if (missResolved.has(key)) {
        hit = missResolved.get(key) ?? null;
      } else if (configured) {
        const g = await geocodeAddressCached(sb, c.env, addr);
        hit = g ? { lat: g.lat, lng: g.lng } : null;
        missResolved.set(key, hit);
      } else {
        missResolved.set(key, null);
      }
    }
    if (!hit) {
      ungeocoded.push({
        ref: dn,
        reason: configured
          ? 'address could not be geocoded — check the address'
          : 'not in the geocode cache and GOOGLE_MAPS_API_KEY is not set',
      });
      continue;
    }
    const zr = zoneForAddress({ postcode: r.postcode, address1: r.address1, address2: r.address2 }, zoneMap);
    const sc = deriveSetCount(setLinesByDoc.get(dn) ?? []);
    points.push({
      ref: dn,
      so_doc_no: dn,
      lat: hit.lat,
      lng: hit.lng,
      zone: zr.zone,
      region: (regionsByDoc.get(dn) ?? [])[0] ?? FALLBACK_DEFAULT_REGION,
      state: r.customerState ?? r.customer_state ?? null,
      postcode: r.postcode ?? null,
      sets: sc.sets,
      revenueSen: Number(r.localTotalSen ?? r.local_total_sen ?? 0) || 0,
      customer: r.debtorName ?? r.debtor_name ?? null,
      address: addr,
    });
  }

  return c.json({ date, region: regionParam, configured, points, depot, depotReason, ungeocoded });
});

/* ──────────────────────────────────────────────────────────────────────────
   GET /delivery-planning/:docNo/lines
   The expand-row line items for one SO on the SHARED cross-company board.

   WHY A DEDICATED ENDPOINT: the board is a SHARED queue that reads BOTH
   companies' SOs (unscoped). Expanding a row used to call the PER-COMPANY SO
   detail (GET /mfg-sales-orders/:docNo), which scopeToCompany-filters to the
   ACTIVE company — so a 2990 row opened while browsing as Houzs 404'd ("That
   item could no longer be found"). This endpoint instead scopes to the caller's
   ALLOWED companies (scopeToAllowedCompanies — WIDEN, never isolate) so a
   cross-company row expands fine. It must NOT use scopeToCompany.

   Returns the same `{ items: [...] }` shape the SO-detail expand consumed; the
   frontend filters cancelled lines + reads item_group / item_code / description
   / variants off each item exactly as before. ─────────────────────────────── */
deliveryPlanning.get('/:docNo/lines', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
  /* Same column set the SO-detail expand consumes (see ITEM in
     mfg-sales-orders.ts): id + group/code/description + variants + the money +
     cancelled flag. line_no drives the SO's own listing order (NULLS LAST →
     pre-line_no docs fall back to created_at), IDENTICAL to the detail read. */
  const { data: items, error } = await scopeToAllowedCompanies(
    sb.from('mfg_sales_order_items')
      .select('id, doc_no, item_group, item_code, description, description2, uom, qty, unit_price_sen, discount_sen, total_sen, variants, stock_status, cancelled')
      .eq('doc_no', docNo),
    c,
  )
    .order('line_no', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ items: items ?? [] });
});

/* Region match: ALL → everything; else a configured region code → orders whose
   region set (customer-state buckets) includes it. validCodes is the active
   region master from the config; an unknown param is a defensive no-op (so an
   old bookmarked tab never empties the board). The frontend tabs send
   ALL | <any configured region code>. */
function matchesRegion(
  o: { regions: Region[] },
  regionParam: string,
  validCodes: Set<Region>,
): boolean {
  if (regionParam === 'ALL' || regionParam === '') return true;
  if (validCodes.has(regionParam)) {
    return o.regions.includes(regionParam);
  }
  return true;   // unknown param → no-op filter (defensive)
}

function emptyCounts(): Record<'ALL' | DeliveryState, number> {
  return { ALL: 0, PENDING_DELIVERY: 0, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: 0 };
}

/* LEGS CRUD (POST/PATCH/DELETE /legs) was REMOVED along with the rest of the
   "delivery leg" (multi-hop / dual-trip) sub-feature — China-PO transit flow,
   not in use yet; re-add later. scm.delivery_legs is left in place (unused). */

/* ──────────────────────────────────────────────────────────────────────────
   PATCH /delivery-planning/:type/:id/fields — set the HC delivery-sheet raw-data
   fields. :type = so | do; :id = SO doc_no or DO id.
   - SO-CONTEXT fields (possession_date, house_type, replacement_disposal,
     referral) always update mfg_sales_orders, keyed by doc_no.
   - DO-EXECUTION fields (time_range, time_confirmed, arrival_at, departure_at,
     shipout_date, customer_delivered_date, eta_arriving_port, delivery_substatus)
     update the delivery_orders ROW — directly when :type=do, else the latest
     non-DRAFT/CANCELLED DO for the SO. Skipped (with a hint) when no DO exists.
   Field names are whitelisted; only present keys are written; idempotent.
   ─────────────────────────────────────────────────────────────────────────*/
const HC_SUBSTATUS_VALUES = [
  'Pending Pickup', 'Done Shipout', 'Arrives EM Warehouse',
  'Done Delivered', 'Confirm', 'House Not Ready', 'Request Hold',
] as const;

const fieldsSchema = z.object({
  // SO-context (→ mfg_sales_orders)
  possessionDate: z.string().nullable().optional(),       // YYYY-MM-DD
  houseType: z.string().nullable().optional(),            // New House / Replacement (free text)
  replacementDisposal: z.string().nullable().optional(),
  referral: z.string().nullable().optional(),
  // Amendment dates — the customer's ORIGINAL customer_delivery_date is NEVER
  // edited here; only the amendment columns are.
  amendDateFromCustomer: z.string().nullable().optional(),  // YYYY-MM-DD (customer's ask)
  amendedDeliveryDate: z.string().nullable().optional(),    // YYYY-MM-DD (we confirm)
  // DO-execution (→ delivery_orders)
  timeRange: z.string().nullable().optional(),
  timeConfirmed: z.boolean().nullable().optional(),
  arrivalAt: z.string().nullable().optional(),            // ISO datetime
  departureAt: z.string().nullable().optional(),
  shipoutDate: z.string().nullable().optional(),          // YYYY-MM-DD
  customerDeliveredDate: z.string().nullable().optional(),
  etaArrivingPort: z.string().nullable().optional(),      // port / shipment ref
  deliverySubstatus: z.string().nullable().optional(),    // HC "Remark 4" (whitelisted, blank allowed)
  arrivesEmWarehouseDate: z.string().nullable().optional(),  // YYYY-MM-DD
});

/* Map the camelCase request keys → the snake_case columns, split by table. */
const SO_FIELD_COLS: Record<string, string> = {
  possessionDate: 'possession_date',
  houseType: 'house_type',
  replacementDisposal: 'replacement_disposal',
  referral: 'referral',
  // Amendment dates — NEVER customer_delivery_date (the original).
  amendDateFromCustomer: 'amend_date_from_customer',
  amendedDeliveryDate: 'amended_delivery_date',
};
const DO_FIELD_COLS: Record<string, string> = {
  timeRange: 'time_range',
  timeConfirmed: 'time_confirmed',
  arrivalAt: 'arrival_at',
  departureAt: 'departure_at',
  shipoutDate: 'shipout_date',
  customerDeliveredDate: 'customer_delivered_date',
  etaArrivingPort: 'eta_arriving_port',
  deliverySubstatus: 'delivery_substatus',
  arrivesEmWarehouseDate: 'arrives_em_warehouse_date',
};

deliveryPlanning.patch('/:type/:id/fields', async (c) => {
  const type = c.req.param('type').toLowerCase();
  const id = c.req.param('id');
  if (type !== 'so' && type !== 'do') return c.json({ error: 'bad_type', reason: 'type must be so | do' }, 400);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = fieldsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data as Record<string, unknown>;

  // Whitelist delivery_substatus to the known HC values (blank/null always ok).
  if (p.deliverySubstatus != null && p.deliverySubstatus !== '' &&
      !(HC_SUBSTATUS_VALUES as readonly string[]).includes(String(p.deliverySubstatus))) {
    return c.json({ error: 'invalid_substatus', reason: `delivery_substatus must be one of: ${HC_SUBSTATUS_VALUES.join(', ')} (or blank).` }, 400);
  }

  const sb = c.get('supabase');

  // Split the present keys into the two column maps.
  const soUpdates: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(SO_FIELD_COLS)) {
    if (p[k] !== undefined) soUpdates[col] = p[k] === '' ? null : p[k];
  }
  const doUpdates: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(DO_FIELD_COLS)) {
    if (p[k] !== undefined) doUpdates[col] = p[k] === '' ? null : p[k];
  }
  if (Object.keys(soUpdates).length === 0 && Object.keys(doUpdates).length === 0) {
    return c.json({ error: 'no_changes' }, 400);
  }

  // Resolve the SO doc_no + the target DO id (latest non-DRAFT/CANCELLED).
  let soDocNo: string | null = null;
  let doId: string | null = null;
  /* COMPANY GATE for the whole handler: everything below keys off soDocNo /
     doId, both taken from the caller-supplied :id. Resolve the document ONCE,
     scoped, and refuse before any write. */
  if (type === 'so') {
    const { data: own, error: ownErr } = await scopeToCompany(
      sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', id), c,
    ).maybeSingle();
    if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
    if (!own) return c.json({ error: 'not_found' }, 404);
  } else {
    const { data: own, error: ownErr } = await scopeToCompany(
      sb.from('delivery_orders').select('id').eq('id', id), c,
    ).maybeSingle();
    if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
    if (!own) return c.json({ error: 'not_found' }, 404);
  }

  if (type === 'so') {
    soDocNo = id;
    if (Object.keys(doUpdates).length > 0) {
      const { data: doRows, error: doRowsErr } = await scopeToCompany(sb.from('delivery_orders')
        .select('id, status').eq('so_doc_no', id), c);
      if (doRowsErr) return c.json({ error: 'lookup_failed', reason: doRowsErr.message }, 500);
      const live = ((doRows ?? []) as Array<{ id: string; status: string | null }>)
        .filter((d) => { const s = (d.status ?? '').toUpperCase(); return s !== 'DRAFT' && s !== 'CANCELLED'; });
      doId = live.length > 0 ? live[live.length - 1]!.id : null;
    }
  } else {
    doId = id;
    const { data: doRow } = await sb.from('delivery_orders')
      .select('so_doc_no').eq('id', id).maybeSingle();
    soDocNo = (doRow as { soDocNo?: string | null; so_doc_no?: string | null } | null)
      ? ((doRow as { soDocNo?: string | null; so_doc_no?: string | null }).soDocNo
         ?? (doRow as { so_doc_no?: string | null }).so_doc_no ?? null)
      : null;
  }

  /* WRITE OWNERSHIP (owner rule): a field-crew caller (Driver/Helper) may submit
     a step / POD update ONLY on a job assigned to them. Ops/dispatcher/management
     resolve to `all` and pass untouched. The job is identified by its DO's crew;
     a field-crew caller acting where no assigned DO can be found is denied (they
     have no job to act on here). This layers UNDER the area-guard's edit gate, so
     for a view-only Driver it is belt-and-braces; it becomes the load-bearing gate
     the moment a transportation-edit grant lets field crew reach this write. */
  {
    const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
    if (scope.mode === 'self') {
      let ownDoId = doId;
      if (type === 'so' && !ownDoId) {
        const { data: doRows } = await sb.from('delivery_orders')
          .select('id, status').eq('so_doc_no', id);
        const live = ((doRows ?? []) as Array<{ id: string; status: string | null }>)
          .filter((d) => { const s = (d.status ?? '').toUpperCase(); return s !== 'DRAFT' && s !== 'CANCELLED'; });
        ownDoId = live.length > 0 ? live[live.length - 1]!.id : null;
      }
      const assignment = ownDoId ? await fetchDoCrewAssignment(sb, ownDoId) : { driverIds: [], helperIds: [] };
      if (!scopeMatchesAssignment(scope, assignment)) return c.json({ error: NOT_YOUR_JOB }, 403);
    }
  }

  /* Two-lane phase 2 (owner 2026-07-27): replacement_disposal is a CONTROLLED
     SO field — on a processing-locked order it "appears in SO Amendment;
     Logistics reviews → approves" (owner's words), never a board direct-write.
     The drawer routes the change into an amendment client-side; this 409 is
     the control for anything that bypasses the drawer. The other SO-context
     fields here (possession/house type/referral/DP amend dates) stay FREE. */
  if (soUpdates['replacement_disposal'] !== undefined && soDocNo) {
    const { data: lockRow } = await sb.from('mfg_sales_orders')
      .select('processing_date, status')
      .eq('doc_no', soDocNo).maybeSingle();
    const before = await sb.from('mfg_sales_orders')
      .select('replacement_disposal').eq('doc_no', soDocNo).maybeSingle();
    const current = (before.data as { replacement_disposal?: string | null } | null)?.replacement_disposal ?? null;
    const requested = (soUpdates['replacement_disposal'] ?? null) as string | null;
    const genuineChange = String(current ?? '') !== String(requested ?? '');
    /* Owner 2026-08-12 — the PO lock (2990 only) is the same soft lock reached
       by the other road, so the board write must respect it identically or the
       drawer's amendment routing has a hole exactly where a supplier is already
       building. ONE 409 body for both: from this board the operator's next
       action is the same either way ("raise it as an amendment, Logistics
       approves"), and the error CODE is what the SCM client maps to a curated
       sentence — a second code here would need its own entry to avoid surfacing
       raw. */
    const dpLocked = genuineChange && (
      soProcessingLocked(lockRow as { processing_date?: string | null; status: string | null } | null)
      || await soPoLocked(sb, soDocNo)
    );
    if (dpLocked) {
      return c.json({
        error: 'so_locked_processing',
        reason: 'Replacement / disposal is locked on this order — request the change as an amendment instead (it goes to Logistics for approval in SO Amendments).',
      }, 409);
    }
  }

  const written: { so: boolean; do: boolean } = { so: false, do: false };
  let noDoHint: string | null = null;

  // SO-context update.
  if (Object.keys(soUpdates).length > 0 && soDocNo) {
    /* History audit (owner requirement) — these are SO header writes made from
       the Delivery Planning board, so the SO History timeline must record WHO
       changed WHICH field old→new. Snapshot the before-values, diff after the
       update succeeds. Best-effort: an audit failure never blocks the save. */
    let beforeRow: Record<string, unknown> = {};
    try {
      const { data: beforeData } = await sb.from('mfg_sales_orders')
        .select(`status, ${Object.values(SO_FIELD_COLS).join(', ')}`)
        .eq('doc_no', soDocNo).maybeSingle();
      beforeRow = (beforeData ?? {}) as unknown as Record<string, unknown>;
    } catch { /* best-effort */ }
    const generation = await advanceSoGeneration(sb, soDocNo, soUpdates);
    if (!generation.applied) {
      return c.json({ error: 'so_version_conflict', currentVersion: generation.currentVersion }, 409);
    }
    written.so = true;
    {
      const fieldChanges: FieldChange[] = [];
      for (const [camel, snake] of Object.entries(SO_FIELD_COLS)) {
        if (!(snake in soUpdates)) continue;
        const from = beforeRow[snake] ?? null;
        const to = soUpdates[snake] ?? null;
        if (String(from ?? '') !== String(to ?? '')) fieldChanges.push({ field: camel, from, to });
      }
      if (fieldChanges.length > 0) {
        const user = c.get('user');
        await recordSoAudit(sb, {
          docNo: soDocNo,
          action: 'UPDATE_DETAILS',
          actorId: user.id,
          actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
          fieldChanges,
          statusSnapshot: (beforeRow as { status?: string }).status ?? null,
          source: 'delivery-planning',
        });
      }
    }
  }

  // DO-execution update — only when a DO exists; otherwise hint, don't error.
  if (Object.keys(doUpdates).length > 0) {
    if (doId) {
      doUpdates.updated_at = new Date().toISOString();
      /* The board is a CROSS-COMPANY view, so the predicate WIDENS to the
         caller's granted companies rather than pinning the active one — but it
         is still a predicate. Without it, this service-role write reaches a DO
         in a company the caller holds no grant for; nothing else re-checks.
         Scoped again HERE and not only at the gate above, because doId can come
         from the so_doc_no lookup and a scoped read never protects the write
         that follows it (MULTICOMPANY-MODULE-MAP rule 1).

         UNSETTLED, left visible: the gate at the top of this handler is
         scopeToCompany (ACTIVE company), NARROWER than this line, so the
         widening cannot admit a second company today. But
         MULTICOMPANY-MODULE-MAP.md rule 3 says Delivery Planning is one unified
         board across companies, which is what this line was written for.
         Whoever settles it should change the GATE, not this predicate. */
      const { error } = await scopeToAllowedCompanies(sb.from('delivery_orders').update(doUpdates).eq('id', doId), c);
      if (error) {
        /* DEAD BRANCH, here and at every other 42501 site in this file. 42501 is
           Postgres permission-denied (RLS), and RLS cannot fire here: mig 0061
           enabled it with NO policies and the SCM client is SERVICE-ROLE, which
           bypasses RLS. No scm function raises 42501 either. Not a permission
           check and not scoping — the only boundary is this route's predicate. */
        if (error.code === '42501') return c.json({ error: 'forbidden', reason: error.message }, 403);
        return c.json({ error: 'update_failed', reason: error.message }, 500);
      }
      written.do = true;
    } else {
      noDoHint = 'No delivery order exists yet for this order — DO-execution fields were not saved. Create a DO first.';
    }
  }

  return c.json({ ok: true, written, do_id: doId, so_doc_no: soDocNo, no_do_hint: noDoHint });
});

/* ──────────────────────────────────────────────────────────────────────────
   PATCH /delivery-planning/:type/:id/schedule — set the concrete schedule date
   (+ optional manual delivery_state override) on an SO or DO. :type = so | do;
   :id = SO doc_no or DO id.
   ─────────────────────────────────────────────────────────────────────────*/
const scheduleSchema = z.object({
  // The firm trip date the coordinator commits to. Written to the header's
  // amended_delivery_date — NEVER customer_delivery_date, which stays the
  // customer's ORIGINAL pick. effectiveSoDelivery reads the pair.
  scheduleDate: z.string().nullable().optional(),  // YYYY-MM-DD
  // Optional MANUAL override of the derived delivery_state (cache column).
  deliveryState: z.enum(['PENDING_DELIVERY', 'PENDING_SCHEDULE', 'OVERDUE', 'DELIVERED']).nullable().optional(),
  // ASSR ONLY (type='assr'): which driving date the board row represents, so the
  // scheduleDate write-back targets the matching assr_cases column
  // (customer_pickup_at vs do_date). Ignored for so | do.
  jobKind: z.enum(['customer_pickup', 'delivery', 'inspection']).nullable().optional(),
  // ── Optional trip wiring ───────────────────────────────────────────────────
  // Scheduling an order onto a trip. Either tripId (append to an existing trip)
  // OR {lorryId, driverId, tripDate?} (find-or-create a trip for that lorry+date).
  // When given, a trip_stops row (stop_type DELIVERY, do_id/so_id, revenue from
  // the DO/SO local_total_sen) is created. With no trip info, behaviour is
  // unchanged (date only).
  tripId: z.string().uuid().nullable().optional(),
  lorryId: z.string().uuid().nullable().optional(),
  driverId: z.string().uuid().nullable().optional(),
  // Fleet A2: the crew the assigner (or the dispatcher's override) paired to this
  // lorry-day. Set on a trip CREATE only (like driverId) — appending a stop to an
  // existing trip never rewrites its crew. Existing scm.trips columns; additive,
  // so a schedule that omits them behaves exactly as before.
  helper1Id: z.string().uuid().nullable().optional(),
  helper2Id: z.string().uuid().nullable().optional(),
  tripDate: z.string().nullable().optional(),       // trip date if creating (defaults to scheduleDate)
  warehouseId: z.string().uuid().nullable().optional(),  // trip origin region (defaults from the DO warehouse)
  // ── Phase 3 "Propose times + route" apply ────────────────────────────────
  // When the dispatcher applies a PROPOSED sequence, the drawer sends each
  // stop's 1-based position and its ETA offset (drive seconds from depart) so
  // the stops land in the proposed ORDER with their computed times, instead of
  // the plain max+1 append. Purely optional — a normal schedule omits them and
  // behaves exactly as before. eta_offset_s is an OFFSET from the trip's depart,
  // never a wall clock (the trip start can move), matching mig 0134 / optimize-route.
  stopNo: z.number().int().min(1).max(999).optional(),
  etaOffsetS: z.number().int().min(0).nullable().optional(),
  legDistanceM: z.number().int().min(0).nullable().optional(),
  legDurationS: z.number().int().min(0).nullable().optional(),
  // ── Fleet A3: 3PL overflow ─────────────────────────────────────────────────
  // The CAPTURED cost (integer sen) of a trip assigned to a 3PL carrier — an
  // OUTSOURCE lorry (is_internal=false). Written on a trip CREATE only, alongside
  // the derived is_outsourced flag. This is the SEAM Module C's rate-card will
  // compute against. Omitted on an own-fleet schedule -> NULL, behaviour unchanged.
  threePlCostSen: z.number().int().min(0).nullable().optional(),
});

/* is_outsourced derives from the lorry's is_internal (NOT is_internal). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deriveTripOutsourced(sb: any, lorryId: string | null): Promise<boolean> {
  if (!lorryId) return false;
  const { data } = await sb.from('lorries').select('is_internal').eq('id', lorryId).maybeSingle();
  if (!data) return false;
  return ((data as { isInternal?: boolean | null; is_internal?: boolean | null }).isInternal
    ?? (data as { is_internal?: boolean | null }).is_internal) === false;
}

/* Next TRIP-YYMM-NNN (mirrors trips.ts nextTripNo). max+1 via the shared
   mintMonthlyDocNo — never count+1, and never a capped scan. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function nextTripNo(sb: any): Promise<string> {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return mintMonthlyDocNo(sb, 'trips', 'trip_no', `TRIP-${yymm}`);
}

/* NO resolveDeliveryScope HERE — DELIBERATE, NOT AN OVERSIGHT (owner ruling
   2026-07-22). Scheduling is a ONE-PERSON function: a single dispatcher assigns
   driver / lorry / trip for the WHOLE operation. Narrowing this handler to the
   caller's own assignments would lock that dispatcher out of every job they did
   not already own — i.e. out of essentially the entire board — which is the
   exact opposite of what the business needs. The handler is meant to serve the
   whole board, and the area guard's `edit` level on
   `scm.transportation.drivers` (index.ts:436) is the intended and complete gate.

   THE ASYMMETRY WITH `/fields` (:1553) IS THE POINT, NOT AN INCONSISTENCY TO
   RESTORE. `/fields` narrows because editing a job's OWN data (steps, POD,
   execution timestamps) is a per-owner act — the field crew touching their own
   job. Assignment is the opposite act: deciding WHOSE job it becomes. One is
   scoped by ownership; the other creates ownership, so it cannot be scoped by
   it. Adding the scope call here to make the two routes "match" would be a
   behaviour change against a standing ruling, not a consistency fix.

   WHAT WOULD JUSTIFY REVISITING: if scheduling ever stops being one person —
   per-region or per-depot dispatchers, each owning their own slice of the board
   — then resolveDeliveryScope is the mechanism to reach for, extended with a
   region/depot mode rather than the existing `self` (which keys on crew
   assignment and would still be the wrong axis). Until the operation actually
   splits, unscoped is correct. */
deliveryPlanning.patch('/:type/:id/schedule', async (c) => {
  const type = c.req.param('type').toLowerCase();
  const id = c.req.param('id');
  if (type !== 'so' && type !== 'do' && type !== 'assr') {
    return c.json({ error: 'bad_type', reason: 'type must be so | do | assr' }, 400);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;

  /* ── ASSR (Service Case) schedule write-back + trip wiring ───────────────────
     Writing scheduleDate updates the case's DRIVING date on public.assr_cases
     (jobKind → column: customer_pickup → customer_pickup_at, inspection →
     inspection_visit_at, delivery → do_date). P3: an ASSR leg scheduled WITH a
     lorry is ALSO wired onto a trip (scheduleAssrOntoTrip) so it consumes real
     fleet capacity — parity with SO/DO. Kept SEPARATE from the SO/DO path below,
     which stays byte-for-byte unchanged. assr_cases is PUBLIC → c.env.DB; trips /
     trip_stops are scm → the supabase client. */
  if (type === 'assr') {
    const assrWantsTrip = p.tripId != null || p.lorryId != null;
    if (p.scheduleDate === undefined && !assrWantsTrip) return c.json({ error: 'no_changes' }, 400);
    const caseId = Number(id);
    if (!Number.isFinite(caseId)) return c.json({ error: 'bad_id', reason: 'assr id must be numeric' }, 400);
    const jobKind: 'customer_pickup' | 'delivery' | 'inspection' =
      p.jobKind === 'customer_pickup' ? 'customer_pickup'
      : p.jobKind === 'inspection' ? 'inspection'
      : 'delivery';
    const col = jobKind === 'customer_pickup' ? 'customer_pickup_at'
      : jobKind === 'inspection' ? 'inspection_visit_at'
      : 'do_date';
    /* The case must EXIST and be OPEN before ANYTHING is written. The date write
       below carries that guard in its own WHERE clause, but a crew-only edit (a
       lorry with no scheduleDate — now reachable because the board's Driver /
       Lorry cells are editable for ASSR) skips that write entirely. Without this
       check such a call would mint a trip, a trip_stop and a DP number for a
       closed / archived / non-existent case: fleet capacity consumed by work that
       is finished or was never there, and invisible on the board because the
       board has no row for it. Fails the same way the date path already does.
       It is ALSO the company gate for everything below: assrOpenCaseGuardSql
       carries the caller's granted-company predicate, so an out-of-scope case
       404s here (owner ruling 2026-08-21). */
    const openCase = (await c.env.DB.prepare(
      assrOpenCaseGuardSql(c),
    ).bind(caseId).first()) as { id: number } | null;
    if (!openCase) return c.json({ error: 'not_found' }, 404);

    // Write the driving date when the date cell was the edit (unchanged behaviour).
    if (p.scheduleDate !== undefined) {
      try {
        const res = await c.env.DB.prepare(
          `UPDATE assr_cases SET ${col} = ?, updated_at = datetime('now')
            WHERE id = ? AND closed_at IS NULL AND archived_at IS NULL`,
        ).bind(p.scheduleDate, caseId).run();
        if (!res.meta.changes) return c.json({ error: 'not_found' }, 404);
      } catch (e) {
        return c.json({ error: 'update_failed', reason: String((e as Error).message).slice(0, 200) }, 500);
      }
    }
    // P3: wire the leg onto a trip when a lorry/trip was chosen. Best-effort +
    // REPORTED — the date write already committed (same rule as the SO/DO path).
    const sb = c.get('supabase');
    const wiring: TripWiring = assrWantsTrip
      ? await scheduleAssrOntoTrip(c, sb, caseId, jobKind, p)
      : { state: 'NOT_REQUESTED' };
    return c.json({ ok: true, assr: { id: caseId, job_kind: jobKind, [col]: p.scheduleDate ?? null }, ...tripFieldsFor(wiring) });
  }

  const wantsTrip = p.tripId != null || p.lorryId != null;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  /* DELIVERY-DATE INTEGRITY (owner rule): the customer's ORIGINAL
     customer_delivery_date must NEVER be overwritten by the schedule action. The
     firm/new trip date is the AMENDED date — write it to amended_delivery_date on
     the SO (which exists only on mfg_sales_orders). For a :type=do schedule the SO
     header is not the target; the DO carries no amend column, so a date is a no-op
     there (the schedule date flows to the trip / leg below, not onto the DO date). */
  /* scheduleDate is nullable+optional in zod, so "" reaches a DATE column; dateOrNull clears it. */
  if (p.scheduleDate !== undefined && type === 'so') updates.amended_delivery_date = dateOrNull(p.scheduleDate);
  if (p.deliveryState !== undefined) updates.delivery_state = p.deliveryState;
  // A trip-only schedule (no date/state) is still a valid change — only 400 when
  // there's NOTHING to do at all.
  if (Object.keys(updates).length === 1 && !wantsTrip) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  const table = type === 'so' ? 'mfg_sales_orders' : 'delivery_orders';
  const keyCol = type === 'so' ? 'doc_no' : 'id';
  const selectCols = type === 'so'
    ? 'doc_no, customer_delivery_date, amended_delivery_date, amend_date_from_customer, delivery_state, status'
    : 'id, do_number, customer_delivery_date, delivery_state, status';

  let data: Record<string, unknown> | null = null;
  // Skip the header UPDATE when only trip info changed (nothing to write to the
  // header) — just re-read it so the response shape is unchanged.
  if (Object.keys(updates).length > 1) {
    /* History audit (owner requirement) — a :type=so schedule writes
       amended_delivery_date / delivery_state on the SO header. Snapshot the
       before-values so the timeline shows old→new. Best-effort. */
    let scheduleBefore: Record<string, unknown> = {};
    if (type === 'so') {
      try {
        const { data: b } = await sb.from('mfg_sales_orders')
          .select('amended_delivery_date, delivery_state, status').eq('doc_no', id).maybeSingle();
        scheduleBefore = (b ?? {}) as Record<string, unknown>;
      } catch { /* best-effort */ }
    }
    const res = type === 'so'
      ? await (async () => {
          const generation = await advanceSoGeneration(sb, id, updates);
          if (!generation.applied) {
            return { data: null, error: { code: 'SO409', message: 'Sales Order changed while scheduling.' } };
          }
          return sb.from('mfg_sales_orders').select(selectCols).eq('doc_no', id).single();
        })()
      : await sb.from(table).update(updates).eq(keyCol, id).select(selectCols).single();
    if (res.error) {
      if (res.error.code === 'SO409') return c.json({ error: 'so_version_conflict', reason: res.error.message }, 409);
      if (res.error.code === '42501') return c.json({ error: 'forbidden', reason: res.error.message }, 403);
      return c.json({ error: 'update_failed', reason: res.error.message }, 500);
    }
    data = res.data as unknown as Record<string, unknown> | null;
    if (type === 'so') {
      const fieldChanges: FieldChange[] = [];
      for (const [camel, snake] of [
        ['amendedDeliveryDate', 'amended_delivery_date'],
        ['deliveryState',       'delivery_state'],
      ] as const) {
        if (!(snake in updates)) continue;
        const from = scheduleBefore[snake] ?? null;
        const to = updates[snake] ?? null;
        if (String(from ?? '') !== String(to ?? '')) fieldChanges.push({ field: camel, from, to });
      }
      if (fieldChanges.length > 0) {
        const user = c.get('user');
        await recordSoAudit(sb, {
          docNo: id,
          action: 'UPDATE_DETAILS',
          actorId: user.id,
          actorName: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
          fieldChanges,
          statusSnapshot: (scheduleBefore as { status?: string }).status ?? null,
          source: 'delivery-planning',
          note: 'Delivery scheduled from the planning board',
        });
      }
    }
  } else {
    const res = await sb.from(table).select(selectCols).eq(keyCol, id).maybeSingle();
    data = res.data as unknown as Record<string, unknown> | null;
  }
  if (!data) return c.json({ error: 'not_found' }, 404);

  // ── Trip wiring — find-or-create a trip, append a stop.
  const wiring: TripWiring = wantsTrip
    ? await scheduleOntoTrip(c, sb, type, id, p)
    : { state: 'NOT_REQUESTED' };

  /* `trip` keeps its exact wire shape — the board reads it, and a failure still
     means no trip. What is NEW is `tripWiring`, present ONLY on failure, so the
     absence that used to mean two things now means one. Still 200: the header
     date IS stored, and saying otherwise would invite a re-press that rewrites
     it. Report, don't repair. */
  return c.json({ ok: true, [type]: data, ...tripFieldsFor(wiring) });
});

/* THREE STATES, never two — `null` was carrying two opposite meanings.
   WIRED / NOT_REQUESTED / FAILED. The old signature returned
   `{id,trip_no} | null`, and the caller could not tell "the coordinator did not
   ask for a trip" from "the coordinator asked and the wiring blew up": both are
   `trip: null` next to `ok: true`, byte for byte. Same collapse as
   services/agents/agent-company.ts's UNRESOLVED-vs-STALE_PIN, and it is quiet
   for the same reason — the two states agree on every field a caller reads. */
export type TripWiring =
  | { state: 'WIRED'; trip: { id: string; trip_no: string }; stopCreated?: boolean; stopSkippedReason?: string }
  | { state: 'NOT_REQUESTED' }
  | { state: 'FAILED'; reason: string };

/**
 * The wire shape of a schedule response's trip fields.
 *
 * Exported and pure ONLY because this mapping is where the bug lived: every
 * non-WIRED state has to answer `trip: null`, so the mapping is the exact place
 * the two opposite meanings used to become one. Keeping it inline would mean the
 * distinction is only asserted by reading the code. `tripWiring` is present ONLY
 * on FAILED — an absent key means "no trip was asked for", which is the one
 * reading `trip: null` still carries on its own.
 */
export function tripFieldsFor(wiring: TripWiring): {
  trip: { id: string; trip_no: string } | null;
  tripWiring?: { failed: true; reason: string };
} {
  switch (wiring.state) {
    case 'WIRED':
      return { trip: wiring.trip };
    case 'NOT_REQUESTED':
      return { trip: null };
    case 'FAILED':
      return { trip: null, tripWiring: { failed: true, reason: wiring.reason } };
  }
}

/* The stop type the SO/DO path writes. A named constant ONLY because the sweep
   below has to filter on the same value the insert stamps: two independent
   'DELIVERY' literals could drift apart in a rename, and the failure mode of that
   drift is a delete whose stop_type arm silently matches nothing — the stranding
   bug back, with the fix still visibly in the file. */
const SO_DO_STOP_TYPE = 'DELIVERY';

/* WHICH ROWS A RE-SCHEDULE MAY DELETE — the dangerous half of the fix, made pure
   so it can be asserted without a database. Exported for the same reason
   `tripFieldsFor` is: this is exactly where the bug lives.

   A SO/DO stop is identified by the uuid the insert below puts on it — `do_id`
   for a DO, `so_id` for an SO. That is NOT the ASSR path's shape: an ASSR stop
   keys on `assr_case_id` (mig 0166) because a service case has no scm uuid at
   all. Do not read the two as mirrors.

   The NO_KEY arm is load-bearing, not defensive filler. On a `type: 'so'`
   schedule `soId` is hard-set to null — scm.mfg_sales_orders has a TEXT PK
   (doc_no) and no `id` column, so there is no uuid to write and the insert below
   is skipped entirely by its own `(doId || soId)` guard. With no key there is
   nothing to sweep, and a sweep attempted anyway would send
   `.eq('do_id', null)` to PostgREST — a filter that constrains nothing the way a
   reader expects. Refusing is the only safe answer. */
export type StaleStopSweep =
  | { state: 'SWEEP'; column: 'do_id' | 'so_id'; value: string; stopType: string }
  | { state: 'NO_KEY'; reason: string };

export function staleStopSweepFor(doId: string | null, soId: string | null): StaleStopSweep {
  /* Same precedence as the de-dup select and the insert below (`doId ? … : …`),
     deliberately: the sweep must key on the SAME column the stop was written by,
     or it looks for the row under a name nothing ever stored it under. */
  if (doId) return { state: 'SWEEP', column: 'do_id', value: doId, stopType: SO_DO_STOP_TYPE };
  if (soId) return { state: 'SWEEP', column: 'so_id', value: soId, stopType: SO_DO_STOP_TYPE };
  return {
    state: 'NO_KEY',
    reason: 'the order has no do_id/so_id uuid, so no stop was written for it and none can be stranded',
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   scheduleOntoTrip — the trip integration. Find-or-create the trip and append a
   DELIVERY trip_stop for this order (revenue from the DO/SO local_total_sen).
   Idempotent on re-schedule: an existing stop for the same (trip, do_id|so_id)
   is reused, not duplicated, and the order's stops on every OTHER trip are
   dropped so a re-point cannot leave one behind.

   STILL best-effort, and deliberately so: the header schedule has ALREADY
   COMMITTED by the time this runs, so throwing here would report "your schedule
   failed" about a date that is now stored — a worse lie than the one being fixed,
   and one that invites a re-press. What changes is that a failure is now
   REPORTED rather than returned as an absence. Report, don't repair — the same
   call as mfg-purchase-orders.ts's `dropped[]`.
   ─────────────────────────────────────────────────────────────────────────*/
async function scheduleOntoTrip(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  type: 'so' | 'do',
  id: string,
  p: z.infer<typeof scheduleSchema>,
): Promise<TripWiring> {
  try {
    const user = c.get('user') as { id?: string } | null;

    /* Resolve the order: its uuid (do_id / so_id), grand total → revenue, and a
       customer/address snapshot. SO id is its uuid; the SO is keyed by doc_no. */
    let doId: string | null = null;
    let soId: string | null = null;
    let soDocNo: string | null = null;
    let revenueSen = 0;
    let customerName: string | null = null;
    let address: string | null = null;
    let tripWarehouseId: string | null = p.warehouseId ?? null;

    if (type === 'do') {
      doId = id;
      const { data: doRow } = await sb.from('delivery_orders')
        .select('local_total_sen, debtor_name, address1, address2, warehouse_id').eq('id', id).maybeSingle();
      if (doRow) {
        const r = doRow as Record<string, unknown>;
        revenueSen = Number((r.localTotalSen ?? r.local_total_sen) ?? 0);
        customerName = (r.debtorName ?? r.debtor_name ?? null) as string | null;
        address = [r.address1, r.address2].filter(Boolean).join(', ') || null;
        if (!tripWarehouseId) tripWarehouseId = (r.warehouseId ?? r.warehouse_id ?? null) as string | null;
      }
    } else {
      soDocNo = id;
      /* NO `id` in this select: scm.mfg_sales_orders has no `id` column (TEXT PK =
         doc_no). Selecting it errored the whole read, so the customer / address /
         revenue snapshot below silently came back empty on every SO-direct
         schedule. An SO therefore has no UUID to put in trip_stops.so_id — it stays
         null, and the stop reaches its SO through the DO (do_id) instead. */
      const { data: soRow } = await sb.from('mfg_sales_orders')
        .select('local_total_sen, debtor_name, address1, address2').eq('doc_no', id).maybeSingle();
      if (soRow) {
        const r = soRow as Record<string, unknown>;
        soId = null;
        revenueSen = Number((r.localTotalSen ?? r.local_total_sen) ?? 0);
        customerName = (r.debtorName ?? r.debtor_name ?? null) as string | null;
        address = [r.address1, r.address2].filter(Boolean).join(', ') || null;
      }
    }
    revenueSen = Math.max(0, Math.round(revenueSen) || 0);

    /* Find-or-create the trip. tripId given → use it; else find an existing
       PLANNED trip for (lorry, date) or create one. */
    /* `??` is nullish: a blank tripDate/scheduleDate walked into trips.trip_date
       (`DATE NOT NULL`, mig 0053). Blank now falls to today like an absent key. */
    const tripDate = dateOrNull(p.tripDate) ?? dateOrNull(p.scheduleDate) ?? todayMyt();
    let tripId = p.tripId ?? null;
    if (!tripId && p.lorryId) {
      const { data: found } = await sb.from('trips').select('id, trip_no')
        .eq('lorry_id', p.lorryId).eq('trip_date', tripDate).neq('status', 'CANCELLED').limit(1);
      const hit = ((found ?? []) as Array<{ id: string; trip_no?: string; tripNo?: string }>)[0];
      if (hit) tripId = hit.id;
    }
    if (!tripId) {
      /* Nothing to create a trip from — genuinely "no trip was asked for", not a
         failure. Unreachable from the only caller (it guards on
         `wantsTrip = tripId != null || lorryId != null`, and tripId is null here),
         so this is defensive; it is typed as the state it means rather than
         collapsed back into the failure bucket. */
      if (!p.lorryId) return { state: 'NOT_REQUESTED' };
      const isOutsourced = await deriveTripOutsourced(sb, p.lorryId);
      const { data: created, error: tErr } = await insertWithDocNoRetry<{ id: string; trip_no: string }>(
        () => nextTripNo(sb),
        (tripNo) => sb.from('trips').insert({
        company_id:    activeCompanyId(c),
        trip_no:       tripNo,
        trip_date:     tripDate,
        lorry_id:      p.lorryId,
        driver_id:     p.driverId ?? null,
        helper_1_id:   p.helper1Id ?? null,
        helper_2_id:   p.helper2Id ?? null,
        warehouse_id:  tripWarehouseId,
        trip_type:     'DELIVERY',
        status:        'PLANNED',
        is_outsourced: isOutsourced,
        /* A3: the captured 3PL cost — only meaningful for an outsourced trip. Kept
           NULL for an own-fleet trip even if a value slipped through, so the seam
           column never carries a cost against internal capacity. */
        three_pl_cost_sen: isOutsourced ? (p.threePlCostSen ?? null) : null,
        created_by:    user?.id ?? null,
        }).select('id, trip_no').single(),
      );
      /* The trip INSERT failed. `tErr` is a real database error and was being
         DISCARDED — the coordinator picked a lorry, no trip exists, and the
         response said `ok: true, trip: null`, which is what a header-only
         schedule says. Carry the reason out. */
      if (tErr || !created) {
        return {
          state: 'FAILED',
          reason: tErr
            ? `could not create the trip: ${String((tErr as { message?: string }).message ?? tErr).slice(0, 160)}`
            : 'could not create the trip: the insert returned no row',
        };
      }
      tripId = (created as { id: string }).id;
    }
    const tripIdStr = tripId as string;

    /* Append the DELIVERY stop — idempotent: reuse an existing stop for the same
       (trip, do_id|so_id) instead of duplicating on re-schedule. */
    const stopFilter = sb.from('trip_stops').select('id').eq('trip_id', tripIdStr);
    const { data: existingStops } = await (doId
      ? stopFilter.eq('do_id', doId)
      : stopFilter.eq('so_id', soId));
    const already = ((existingStops ?? []) as Array<{ id: string }>)[0];

    /* Phase 3 apply: the proposed ORDER + ETA the dispatcher committed to. When
       a stop already exists (re-apply of a proposed route), refresh its position
       and route metrics so the sequence reflects the latest proposal. Omitted on
       a normal schedule -> untouched (behaviour unchanged). */
    if (already && p.stopNo != null) {
      const routeUpdate: Record<string, unknown> = { stop_no: p.stopNo };
      if (p.etaOffsetS !== undefined) routeUpdate.eta_offset_s = p.etaOffsetS;
      if (p.legDistanceM !== undefined) routeUpdate.leg_distance_m = p.legDistanceM;
      if (p.legDurationS !== undefined) routeUpdate.leg_duration_s = p.legDurationS;
      if (p.etaOffsetS != null) routeUpdate.route_optimised_at = new Date().toISOString();
      await sb.from('trip_stops').update(routeUpdate).eq('id', already.id);
    }

    if (!already && (doId || soId)) {
      const { data: cntRows } = await sb.from('trip_stops').select('stop_no').eq('trip_id', tripIdStr);
      const appendStopNo = ((cntRows ?? []) as Array<{ stop_no?: number; stopNo?: number }>)
        .reduce((m, r) => Math.max(m, Number(r.stopNo ?? r.stop_no ?? 0)), 0) + 1;
      /* Use the PROPOSED position when the dispatcher applied a route; else the
         plain max+1 append. */
      const nextStopNo = p.stopNo ?? appendStopNo;

      /* MINT THE DP NUMBER. Until now only the manual path (dp-orders) numbered a
         job, so the owner's DP-YYMMDD-<plate><NN> rule covered the MINORITY of
         jobs — a delivery scheduled from this board got none. The lorry may have
         been named directly (p.lorryId) or inherited from an existing trip, so it
         is resolved from the trip when absent. */
      let dpNo: string | null = null;
      let lorryIdForNo = p.lorryId ?? null;
      if (!lorryIdForNo) {
        const { data: tRow } = await sb.from('trips').select('lorry_id').eq('id', tripIdStr).maybeSingle();
        const tr = tRow as { lorry_id?: string | null; lorryId?: string | null } | null;
        lorryIdForNo = (tr?.lorryId ?? tr?.lorry_id ?? null) as string | null;
      }
      dpNo = await mintDpNoForLorry(sb, { tripDate, lorryId: lorryIdForNo });

      /* dp_no stays NULL when the lorry is unknown or the registry could not be
         read. An unnumbered stop is visibly incomplete and can be renumbered; a
         DUPLICATE number is a silent corruption that surfaces as two drivers
         holding the same job sheet. Never guess a number. */
      await sb.from('trip_stops').insert({
        company_id:    activeCompanyId(c),
        trip_id:       tripIdStr,
        stop_no:       nextStopNo,
        stop_type:     SO_DO_STOP_TYPE,
        do_id:         doId,
        so_id:         soId,
        customer_name: customerName,
        address,
        revenue_sen: revenueSen,
        dp_no:         dpNo,
        /* Phase 3 apply — persist the proposed ETA + leg metrics (mig 0134
           columns) so the route survives the round-trip without re-billing
           Google. NULL when this is a plain (non-proposed) schedule. */
        eta_offset_s:       p.etaOffsetS ?? null,
        leg_distance_m:     p.legDistanceM ?? null,
        leg_duration_s:     p.legDurationS ?? null,
        route_optimised_at: p.stopNo != null && p.etaOffsetS != null ? new Date().toISOString() : null,
      });
    }

    /* ONE ORDER = ONE STOP. The de-dup above is scoped to a SINGLE trip, so it
       only catches a re-press of the same lorry on the same date. A real
       re-schedule — a different lorry, or the same lorry on another day —
       resolves to a DIFFERENT trip, and the stop written for the previous one
       simply stays behind. The order then sits on two trips at once and
       lorry-capacity counts it against BOTH: two deliveries, and its revenue
       added twice (lorry-capacity.ts sums revenue_sen per DELIVERY stop).
       That inflates the fleet numbers this feature exists to make honest, and it
       puts the job on a driver's route who was re-pointed off it.

       Drop the order's stops on every other trip so the newest assignment is the
       only one. The filter is keyed on the order's OWN uuid plus the stop type,
       which is what keeps it surgical: another document's stops carry a
       different uuid; an ASSR stop carries assr_case_id with do_id/so_id NULL, so
       a null can never match a concrete uuid; a manual DP job (dp-orders.ts)
       writes do_id/so_id NULL for the same reason; and this order's stops of any
       OTHER type are excluded by stop_type. When there is no uuid to key on the
       sweep is REFUSED rather than widened — see staleStopSweepFor.

       Consequence, accepted deliberately: a stop for this order placed by hand on
       a second trip (POST /trips/:id/stops) is also cleared. Splitting one
       document across two lorries is precisely the shape that double-counts, and
       the board's schedule is the single dispatcher of record. Same call #947
       made for ASSR legs. */
    const sweep = staleStopSweepFor(doId, soId);
    if (sweep.state === 'SWEEP') {
      const { error: staleErr } = await sb.from('trip_stops').delete()
        .eq(sweep.column, sweep.value).eq('stop_type', sweep.stopType).neq('trip_id', tripIdStr);
      /* REPORTED, never swallowed. The new stop is written, so the operator sees
         a scheduled job — while the old one is still on another lorry's sheet and
         still in its capacity. That is the exact silence this whole function was
         rewritten to stop; the state is worth naming out loud. */
      if (staleErr) {
        return {
          state: 'FAILED',
          reason: `the order was placed on the new trip but the previous one could not be cleared — it may be counted twice: ${String((staleErr as { message?: string }).message ?? staleErr).slice(0, 120)}`,
        };
      }
    }

    /* (removed) delivery_leg trip-linking — the leg feature was removed; the
       order surfaces on the trip via its trip_stops row above. */

    /* Echo the trip_no for the response. */
    const { data: tNo } = await sb.from('trips').select('id, trip_no').eq('id', tripIdStr).maybeSingle();
    const tr = tNo as { id?: string; trip_no?: string; tripNo?: string } | null;
    /* The stop is written; the trip EXISTS. A blank trip_no here means only that
       the echo read came back empty, so this stays WIRED — the wiring is what is
       being reported, not the label. */

    /* SAY WHEN NO STOP WAS WRITTEN. The insert above is guarded by
       `!already && (doId || soId)`, and on the SO-DIRECT path BOTH are null —
       doId because there is no DO, soId because it is set to null right above
       (scm.mfg_sales_orders has a TEXT doc_no PK and no uuid, while
       trip_stops.so_id is a uuid). So scheduling an SO straight from the board
       creates no stop at all, and this returned WIRED anyway: the dispatcher
       saw success, the driver's sheet stayed empty, and lorry capacity counted
       nothing.

       The stop is NOT invented — there is genuinely no key to file it under,
       and guessing one would put a job on a route that cannot be traced back
       to its order. What changes is that the answer stops lying. The existing
       fields are untouched so no caller breaks; a caller that reads
       stopCreated can now tell the operator the job still needs its DO. */
    const stopCreated = Boolean(already) || Boolean(doId || soId);
    return {
      state: 'WIRED',
      trip: tr
        ? { id: tripIdStr, trip_no: (tr.tripNo ?? tr.trip_no ?? '') }
        : { id: tripIdStr, trip_no: '' },
      stopCreated,
      ...(stopCreated ? {} : {
        stopSkippedReason:
          'This Sales Order has no Delivery Order yet, so there is no stop to put on the lorry — the date is saved, but the job will not appear on a driver sheet until the DO exists.',
      }),
    };
  } catch (e) {
    /* Still best-effort — the header schedule already committed, so throwing
       would report a failure about a date that is now stored. But the operator
       is told, instead of reading `trip: null` as "I didn't ask for one". */
    return {
      state: 'FAILED',
      reason: `trip wiring failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`,
    };
  }
}

/* ── ASSR trip integration (P3) ────────────────────────────────────────────────
   The ASSR-leg twin of scheduleOntoTrip. An ASSR pickup / delivery / inspection
   leg scheduled with a lorry gets a real trip_stop, so it consumes fleet capacity
   (lorry-capacity counts stops) and shows on the Trips view — parity with SO/DO.
   Kept SEPARATE so scheduleOntoTrip (the SO/DO path) stays byte-for-byte unchanged.
   Links the stop to the case via trip_stops.assr_case_id (mig 0166); idempotent on
   re-schedule — an existing stop for (trip, case, stop_type) is reused. Best-effort
   + REPORTED like scheduleOntoTrip: the date write already committed. */
const ASSR_STOP_TYPE: Record<'customer_pickup' | 'delivery' | 'inspection', string> = {
  customer_pickup: 'PICKUP',
  delivery:        'DELIVERY',
  inspection:      'INSPECTION',
};

async function scheduleAssrOntoTrip(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  caseId: number,
  jobKind: 'customer_pickup' | 'delivery' | 'inspection',
  p: z.infer<typeof scheduleSchema>,
): Promise<TripWiring> {
  try {
    const user = c.get('user') as { id?: string } | null;
    const stopType = ASSR_STOP_TYPE[jobKind];
    const dateCol = jobKind === 'customer_pickup' ? 'customer_pickup_at'
      : jobKind === 'inspection' ? 'inspection_visit_at'
      : 'do_date';

    /* Case snapshot (customer / address) + the leg's own date, from public.assr_cases
       via c.env.DB (same path the ASSR board union uses). The leg date is the trip's
       default date so a crew-only edit (no scheduleDate) still lands on the right day.
       company-scope: deliberately UNSCOPED, and safe — reachable only after the
       ASSR branch's assrOpenCaseGuardSql has 404'd any case outside the caller's
       granted companies. Same shape as routes/assr.ts (:2672, :1116). */
    const a = (await c.env.DB.prepare(
      `SELECT customer_name AS customer_name, ${dateCol} AS leg_date,
              addr1 AS addr1, addr2 AS addr2, addr3 AS addr3, addr4 AS addr4
         FROM assr_cases WHERE id = ?`,
    ).bind(caseId).first()) as {
      customer_name: string | null; leg_date: string | null;
      addr1: string | null; addr2: string | null; addr3: string | null; addr4: string | null;
    } | null;
    const customerName = a?.customer_name ?? null;
    const address = [a?.addr1, a?.addr2, a?.addr3, a?.addr4].filter(Boolean).join(', ') || null;

    /* Find-or-create the trip — same rule as scheduleOntoTrip. */
    const tripDate = dateOrNull(p.tripDate) ?? dateOrNull(p.scheduleDate) ?? dateOrNull(a?.leg_date) ?? todayMyt();
    let tripId = p.tripId ?? null;
    if (!tripId && p.lorryId) {
      const { data: found } = await sb.from('trips').select('id, trip_no')
        .eq('lorry_id', p.lorryId).eq('trip_date', tripDate).neq('status', 'CANCELLED').limit(1);
      const hit = ((found ?? []) as Array<{ id: string }>)[0];
      if (hit) tripId = hit.id;
    }
    if (!tripId) {
      if (!p.lorryId) return { state: 'NOT_REQUESTED' };
      const isOutsourced = await deriveTripOutsourced(sb, p.lorryId);
      const { data: created, error: tErr } = await insertWithDocNoRetry<{ id: string; trip_no: string }>(
        () => nextTripNo(sb),
        (tripNo) => sb.from('trips').insert({
          company_id:    activeCompanyId(c),
          trip_no:       tripNo,
          trip_date:     tripDate,
          lorry_id:      p.lorryId,
          driver_id:     p.driverId ?? null,
          warehouse_id:  p.warehouseId ?? null,
          trip_type:     'DELIVERY',
          status:        'PLANNED',
          is_outsourced: isOutsourced,
          created_by:    user?.id ?? null,
        }).select('id, trip_no').single(),
      );
      if (tErr || !created) {
        return {
          state: 'FAILED',
          reason: tErr
            ? `could not create the trip: ${String((tErr as { message?: string }).message ?? tErr).slice(0, 160)}`
            : 'could not create the trip: the insert returned no row',
        };
      }
      tripId = (created as { id: string }).id;
    }
    const tripIdStr = tripId as string;

    /* Append the stop — idempotent on (trip, case, stop_type). */
    const { data: existing } = await sb.from('trip_stops').select('id')
      .eq('trip_id', tripIdStr).eq('assr_case_id', caseId).eq('stop_type', stopType).limit(1);
    const already = ((existing ?? []) as Array<{ id: string }>)[0];
    if (!already) {
      const { data: cntRows } = await sb.from('trip_stops').select('stop_no').eq('trip_id', tripIdStr);
      const nextStopNo = ((cntRows ?? []) as Array<{ stop_no?: number; stopNo?: number }>)
        .reduce((m, r) => Math.max(m, Number(r.stopNo ?? r.stop_no ?? 0)), 0) + 1;

      /* Mint the DP number from the trip's lorry — parity with the SO/DO path.
         Never guess: a null dp_no is renumberable; a duplicate is a silent corruption. */
      let lorryIdForNo = p.lorryId ?? null;
      if (!lorryIdForNo) {
        const { data: tRow } = await sb.from('trips').select('lorry_id').eq('id', tripIdStr).maybeSingle();
        const tr = tRow as { lorry_id?: string | null; lorryId?: string | null } | null;
        lorryIdForNo = (tr?.lorryId ?? tr?.lorry_id ?? null) as string | null;
      }
      const dpNo = await mintDpNoForLorry(sb, { tripDate, lorryId: lorryIdForNo });

      await sb.from('trip_stops').insert({
        company_id:    activeCompanyId(c),
        trip_id:       tripIdStr,
        stop_no:       nextStopNo,
        stop_type:     stopType,
        assr_case_id:  caseId,
        customer_name: customerName,
        address,
        revenue_sen: 0,
        dp_no:         dpNo,
      });
    }

    /* ONE LEG = ONE STOP. The de-dup above is scoped to a single trip, so it only
       catches a re-press of the SAME lorry on the SAME date. A real re-schedule —
       a different lorry, or the same lorry on another day — resolves to a
       DIFFERENT trip, and the stop written for the previous one would simply stay
       behind: the leg then sits on two trips at once and lorry-capacity counts it
       against BOTH, inflating the fleet numbers this feature exists to make
       honest. Drop the leg's stops on every other trip so the newest assignment
       is the only one. Scoped to assr_case_id + stop_type, so it can never touch
       an SO/DO stop (their assr_case_id is null) or this case's other legs. */
    const { error: staleErr } = await sb.from('trip_stops').delete()
      .eq('assr_case_id', caseId).eq('stop_type', stopType).neq('trip_id', tripIdStr);
    if (staleErr) {
      return {
        state: 'FAILED',
        reason: `the leg was placed on the new trip but the previous one could not be cleared — it may be counted twice: ${String((staleErr as { message?: string }).message ?? staleErr).slice(0, 120)}`,
      };
    }

    const { data: tNo } = await sb.from('trips').select('id, trip_no').eq('id', tripIdStr).maybeSingle();
    const tr = tNo as { trip_no?: string; tripNo?: string } | null;
    return { state: 'WIRED', trip: { id: tripIdStr, trip_no: (tr?.tripNo ?? tr?.trip_no ?? '') } };
  } catch (e) {
    return {
      state: 'FAILED',
      reason: `ASSR trip wiring failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`,
    };
  }
}
