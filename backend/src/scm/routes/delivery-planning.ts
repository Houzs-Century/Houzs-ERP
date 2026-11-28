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
//   - OVERDUE          — the Sales Exemption Expiry (the last date the
//                        salesperson promised) has passed, ready or not (owner
//                        2026-11-13); or NOT ready AND today >= EFFECTIVE
//                        delivery date (owner 2026-11-10).
//   - PENDING_DELIVERY — NOT ready and the delivery day is still ahead.
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

import { yymmFor } from '../../services/documentRefs';
import { dpBoardState } from '../lib/dp-board-state';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { HC_SUBSTATUS_VALUES, HC_MESSAGE_STATUS_VALUES, fieldsSchema, SO_FIELD_COLS, DO_FIELD_COLS, } from './delivery-planning-fields';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { todayMyt } from '../lib/my-time';
import { docsEnteringPendingSchedule, stampPendingScheduleAfterResponse } from '../lib/pending-schedule-stays';
import { boardSlice, addSkippedDelivered, parseOnlyDocs, onlyDocsFilter } from '../lib/delivery-board-slice';
import { parseBand, planBoardSoRows, bandFilter, bandRows, countsByRegion } from '../lib/delivery-board-window';
import { boardChangesHandler } from './delivery-planning-changes';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { summariseReadiness, normCategory } from '../lib/so-readiness';
import { effectiveSoDelivery } from '../shared';
import { NO_STOCK_ROW } from '../lib/so-readiness-row';
import { kickOffSubBoardReads, flattenProjectCrew, SUB_BOARD_SKIPPED } from '../lib/delivery-planning-board-reads';
import { readFailure, noteDegradedRead } from '../lib/read-failure';
import { soProcessingLocked } from './mfg-sales-orders';
import { soPoLocked } from '../lib/so-po-lock';
import { activeCompanyId, scopeToCompany, scopeToAllowedCompanies, companyCodeMap, allowedCompanyIds } from '../lib/companyScope';
/* Service-Case rows on this board are company-scoped (owner ruling 2026-08-21).
   Both statements live in ONE module, with the reasoning, so the predicate is
   assertable and cannot be re-derived by hand here. */
import { assrBoardLocation, assrLegGuardSql, assrLegOpen, ASSR_BOARD_LEGS, ASSR_CONFIRMED_COL, assrConfirmDateSql, assrBoardLegs, assrCaseClosed, ASSR_LEG_TIME_COL, ASSR_LEG_MSG_COL, ASSR_LEG_REMARK_COL, ASSR_LEG_AMEND_REASON_COL } from '../lib/assr-board-scope'; import { overlayAssrChatState } from '../lib/assr-arrangement-message';
import { logActivity, attachDeliveryOrders } from '../../services/assr';
import { orderDoNumbers } from '../../services/assrOrderDos';
import { recordSoAudit, type FieldChange } from '../lib/so-audit';
import { advanceSoGeneration } from '../lib/so-generation';
import { computeReleaseGate } from '../../services/agents/release-gate';
import { mintDpNoForLorry } from '../lib/dp-no-mint';
import { staleLegProgressReset } from '../lib/stale-leg-progress';
import { scheduleDpDate, writeNonSoFields, writeAssrLegStatus } from '../lib/delivery-planning-nonso-edit';
import { resolveDeliveryScope, scopeMatchesAssignment, type DeliveryScope, type CrewAssignment } from '../lib/deliveryScope';
import { lorryPlatesByIds } from '../lib/lorry-plate-lookup';
import { fetchDoCrewAssignment, doPodContextHandler, ownServiceAndProjectRowKeys } from './delivery-pod-context';
import { deriveArrangementStage } from '../lib/arrangement-stage';
import { MAP_COLS as ZONE_MAP_COLS, toPrefixMap, type MapRow as ZoneMapRow } from './delivery-zones';
import { zoneForAddress } from '../lib/zone-classify';
import { deriveSetCount, type SetLine } from '../lib/set-count';
import { composeAddress, geocodeAddressCached } from '../lib/geocode';
import { loadJobStops, locateStops, soCandidates, type GeoCandidate } from '../lib/stop-geo';
import { loadLorryDepots } from '../lib/lorry-depots';
import { dateOrNull } from '../lib/date-coerce';
import { echoTripCrew, echoAssrCrew } from '../lib/trip-crew-echo';
import { latestLiveDoIdForSo, applyScheduleCrew, assignSoCrew, setAssrLegCrew, staleRunOfSo, hasSeatPatch, soCompanyWithinGrants } from '../lib/trip-crew-sync';
import { pgrestIn } from '../lib/pgrest-in-list';
import { stepClock } from '../../lib/step-timing';
import { loadRegionConfig, stateToRegionsFromConfig, FALLBACK_DEFAULT_REGION, type Region, type RegionConfig } from '../lib/delivery-board-regions';
import { assembleSoOrders } from '../lib/delivery-board-so-rows';
import { formatCaseAddress } from '../shared/assr-case-address';
import { fillDpRowsPostcode } from '../lib/postcode-from-address';
import { boardSourceOf, loadBoardHead, kickOffRestBoardReads, loadBoardMaps, scheduleBoardShadow } from '../lib/delivery-board-source';
import { projectBoardAddress } from '../lib/project-venue-join';

export const deliveryPlanning = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryPlanning.use('*', supabaseAuth);

export type { Region } from '../lib/delivery-board-regions';

export type DeliveryState = 'PENDING_DELIVERY' | 'PENDING_SCHEDULE' | 'OVERDUE' | 'DELIVERED';
const DELIVERY_STATES: DeliveryState[] = ['PENDING_DELIVERY', 'PENDING_SCHEDULE', 'OVERDUE', 'DELIVERED'];

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
                          yet fully delivered, whatever the dates.
     · OVERDUE          — NOT ready and the day it should be delivered has come
                          (owner 2026-11-17: "Overdue = the date has come but the
                          stock is not complete"). That day is the customer's
                          amended date, else the Sales Exemption Expiry (the
                          original promise), else the effective date. Not the
                          current customer_delivery_date alone: the HC Delivery
                          sheet's Overdue tab pushes it to today+3 every morning,
                          so it never comes (41 of 49 Overdue rows on 2026-11-16).
     · PENDING_DELIVERY — NOT ready and that day is still ahead.

   `salesExemptionExpiry` is the value the board's "Sales Exemption Expiry Date"
   column shows (soExemptionExpiryOf, lib/so-exemption-expiry.ts); every caller
   passes it, so the board, its counts, the SO list and the agent agree.

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
  amendedDD: string | null | undefined;
  salesExemptionExpiry: string | null;
  today: string;
}): DeliveryState {
  const { storedOverride, status, readiness, delivered, remaining, effectiveDD, amendedDD, salesExemptionExpiry, today } = input;
  const stored = storedOverride ?? null;
  const st = String(status ?? '').toUpperCase();
  if (st === 'DELIVERED' || (delivered > 0 && remaining <= 0)) return 'DELIVERED';
  if (stored && (DELIVERY_STATES as string[]).includes(stored)) return stored as DeliveryState;

  if (readiness.isShipReady) return 'PENDING_SCHEDULE';

  const due = amendedDD || salesExemptionExpiry || effectiveDD || null;
  const daysLeft = daysBetween(today, due ? due.slice(0, 10) : null);
  return daysLeft != null && daysLeft <= 0 ? 'OVERDUE' : 'PENDING_DELIVERY';
}

async function applyDeliveryRowScope<T extends { row_type: string; so_doc_no: string }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  scope: DeliveryScope,
  rows: T[],
  maps: {
    doByDoc: Map<string, Array<{ id: string; doNumber: string; status: string }>>;
    doDriverById: Map<string, string | null>;
    crewIdsByDo: Map<string, { driverIds: string[]; helperIds: string[]; lorryPlate: string | null }>;
    dpTripIdByKey: Map<string, string | null>;
  },
): Promise<T[]> {
  if (scope.mode === 'all') return rows;

  const tripCrewById = new Map<string, CrewAssignment>();
  const tripIds = [...new Set([...maps.dpTripIdByKey.values()].filter((x): x is string => !!x))];
  if (tripIds.length > 0) {
    const { data: tripRows } = await chunkIn<Record<string, unknown>>(tripIds, (batch, from, to) => sb.from('trips')
      .select('id, driver_id, helper_1_id, helper_2_id, lorry_id')
      .in('id', batch).order('id').range(from, to));
    // trips.lorry_id → plate, so a lorry account matches its DP (trip) rows by plate (owner 2026-11-28).
    const tripPlates = await lorryPlatesByIds(sb, tripRows.map((t) => (t.lorryId ?? t.lorry_id) as string | null));
    for (const t of tripRows) {
      const id = String(t.id ?? '');
      if (!id) continue;
      const lid = (t.lorryId ?? t.lorry_id) as string | null;
      tripCrewById.set(id, {
        driverIds: [(t.driverId ?? t.driver_id) as string | null],
        helperIds: [(t.helper1Id ?? t.helper_1_id) as string | null, (t.helper2Id ?? t.helper_2_id) as string | null],
        lorryPlate: lid ? tripPlates.get(String(lid)) ?? null : null,
      });
    }
  }

  const EMPTY: CrewAssignment = { driverIds: [], helperIds: [] };
  const assignmentFor = (row: T): CrewAssignment => {
    if (row.row_type === 'so') {
      const dos = maps.doByDoc.get(row.so_doc_no) ?? [];
      if (dos.length === 0) return EMPTY;
      const latestDoId = dos[dos.length - 1]!.id;
      const crew = maps.crewIdsByDo.get(latestDoId) ?? { driverIds: [], helperIds: [], lorryPlate: null };
      return {
        driverIds: [...crew.driverIds, maps.doDriverById.get(latestDoId) ?? null],
        helperIds: crew.helperIds,
        lorryPlate: crew.lorryPlate,
      };
    }
    if (row.row_type === 'dp') {
      const tripId = maps.dpTripIdByKey.get(row.so_doc_no);
      return (tripId && tripCrewById.get(tripId)) || EMPTY;
    }
    return EMPTY;
  };

  return rows.filter((row) => scopeMatchesAssignment(scope, assignmentFor(row)));
}


const NOT_YOUR_JOB = "You can only update a delivery job assigned to you.";

export const deliveryPlanningBoardHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const sb = c.get('supabase');
  const today = todayMyt(); const lap = stepClock(); // HC-0002: board time as Server-Timing steps
  const source = boardSourceOf(c); const t0 = Date.now();

  const scope = await resolveDeliveryScope(sb, c.get('houzsUser')); lap('dp-scope');

  const regionParam = (c.req.query('region') ?? 'ALL').trim().toUpperCase();
  const stateParam = (c.req.query('state') ?? 'ALL').trim().toUpperCase();
  const onlyDocs = parseOnlyDocs(c.req.query('docs'));
  if (onlyDocs?.length === 0) return c.json({ orders: [], counts: emptyCounts(), regions: [] });
  const band = parseBand(c.req.query('band'), c.req.query('page'));
  if (band === 'invalid') return c.json({ error: 'bad_request', reason: 'band must be 1-5, with a page number.' }, 400);
  const countsOnly = c.req.query('counts_only') === '1' && scope.mode === 'all' && !onlyDocs && !band;

  const head = await loadBoardHead(c, sb, source, { onlyDocs, band, today, lap });
  if ('err' in head) return c.json(readFailure(head.stage, head.err), 500);
  const { regionCfg, whRows, soRowsRaw } = head.ok;
  const whCode = new Map<string, string>();
  const whName = new Map<string, string>();
  for (const w of whRows) {
    const code = (w.code ?? '').trim();
    whCode.set(w.id, code);
    whName.set(w.id, w.name ?? code);
  }
  const datedRows = soRowsRaw.filter(
    (r) => r.customer_delivery_date != null || r.processing_date != null,
  );
  const plan = await planBoardSoRows(sb, c, { rows: datedRows, stateParam, scope, band, countsOnly }); lap('dp-plan');
  if ('err' in plan) return c.json(readFailure(plan.stage, plan.err), 500);
  const { kept: soRows, skipped: skippedDelivered } = plan;
  const docNos = soRows.map((r) => String(r.doc_no ?? '')).filter(Boolean);
  if (docNos.length === 0 && scope.mode === 'all' && skippedDelivered.length === 0 && !band) return c.json({ orders: [], counts: emptyCounts(), regions: regionCfg.regions });

  /* OPEN-TIME (owner 2026-10-20 "开得慢"): the per-SO reads (balance, lines, deliverable
     sums, DOs, PO numbers) start together and overlap the sub-board reads below; on the
     sql path they are one statement instead (loadBoardMaps). */
  const restReads = kickOffRestBoardReads(sb, source, docNos, soRows, !countsOnly);
  // A closed service case's done legs stay on the Delivered tab 30 days, then drop off; open
  // cases are never time-bound (owner 2026-11-06: 90 -> 30). Separate from the SO 90-day rule.
  const recentClosedSince = new Date(new Date(`${today}T00:00:00Z`).getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const { assrRowsP, dpResP, projRowsP } = kickOffSubBoardReads(c, sb, recentClosedSince, onlyDocs !== null || (band !== null && band.page > 0));

  const mapsRes = await loadBoardMaps(c, sb, source, { docNos, soRows, display: !countsOnly, rest: restReads, lap });
  if ('err' in mapsRes) return c.json(readFailure(mapsRes.stage, mapsRes.err), 500);
  const maps = mapsRes.ok;

  const codeMap = companyCodeMap(c);
  const rowCtx = { today, codeMap, deliveryStates: DELIVERY_STATES, deriveState: derivePlanningState, daysLeft: daysBetween };
  const orders = assembleSoOrders(soRows, maps, { ...rowCtx, regionCfg, whCode, whName });

  type BoardRow = (typeof orders)[number];
  const assrOrders: BoardRow[] = [];
  try {
    const assrR = await assrRowsP; lap('dp-assr');
    if ('err' in assrR) throw assrR.err;
    const assrRows = assrR.ok;

    for (const a of (assrRows.results ?? [])) a.company_code = codeMap.get(Number(a.company_id)) ?? null;
    await attachDeliveryOrders(c.env, (assrRows.results ?? []) as unknown as Record<string, unknown>[]);

    for (const a of (assrRows.results ?? [])) {
      const assrNo = String(a.assr_no ?? '').trim();
      if (!assrNo) continue;
      const { state: realState, postcode: realPostcode } = assrBoardLocation(a.addr3, a.addr4, a.so_state, a.so_postcode,
        { postcode: a.case_postcode, state: a.case_state });
      const stateRegions = stateToRegionsFromConfig(regionCfg, realState, a.so_country);
      const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
      const regionSet = new Set<Region>(stateRegions);
      const address = formatCaseAddress({ ...a, postcode: a.case_postcode, city: a.case_city, state: a.case_state });
      const caseClosed = assrCaseClosed(a);

      const caseRef = String(a.ref_no ?? '').trim();
      const soRefBackfill = (/[A-Za-z0-9]/.test(caseRef) ? caseRef : '')
        || String(a.so_ref_src ?? '').trim() || String(a.so_custso_src ?? '').trim() || null;
      const doNos = orderDoNumbers(a);
      const relatedDoNos = doNos.length ? doNos : null;

      for (const leg of assrBoardLegs(a, caseClosed, today)) {
        const legDate = leg.confirmed ?? leg.requested;
        // A CLOSED case's leg only shows when it is recent (owner 2026-10-21: last
        // 90 days); older done service work stays off the board.
        if (leg.state === 'DELIVERED' && (legDate ?? '').slice(0, 10) < recentClosedSince) continue;
        const rowKey = `${assrNo}#${leg.jobKind}`;
        assrOrders.push({
          row_type: 'assr',
          ref: assrNo, so_ref: soRefBackfill, related_do_nos: relatedDoNos,
          job_kind: leg.jobKind,
          dp_job_type: null,
          dp_no: null,
          dp_from_name: null,
          assr_id: a.id != null ? Number(a.id) : null,
          so_doc_no: rowKey,
          debtor_code: null,
          debtor_name: a.customer_name ?? null,
          phone: a.phone ?? null, agent: null, salesperson_id: null, venue: null,
          branding: null,
          status: a.status ?? '',
          // Closed case's dated leg = done → Delivered; an open dated leg surfaces
          // under Pending Delivery until it's scheduled out (owner 2026-10-21).
          delivery_state: leg.state,
          delivery_state_override: null,
          balance_sen: 0,
          balance_sen_live: null,
          local_total_sen: 0,
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
          customer_delivery_date: leg.requested, sales_exemption_expiry: null,
          amend_date_from_customer: null,
          amended_delivery_date: leg.confirmed,
          amend_reason: a[ASSR_LEG_AMEND_REASON_COL[leg.jobKind]] ?? null, amend_reason_from_customer: null,
          effective_delivery_date: legDate,
          processing_date: legDate,
          po_locked: false,
          days_left: daysBetween(today, legDate),
          address,
          postcode: realPostcode,
          building_type: null,
          possession_date: null,
          house_type: null,
          replacement_disposal: null,
          referral: null,
          delivery_message_status: a[ASSR_LEG_MSG_COL[leg.jobKind]] ?? null,
          disposal_request: null,
          dp_remark: a[ASSR_LEG_REMARK_COL[leg.jobKind]] ?? null,
          remark_locked: false,
          time_range: a[ASSR_LEG_TIME_COL[leg.jobKind]] ?? null,
          time_confirmed: null,
          arrival_at: null,
          departure_at: null,
          shipout_date: null,
          customer_delivered_date: null,
          eta_arriving_port: null,
          delivery_substatus: null,
          arrives_em_warehouse_date: null,
          em_delivery_status: null, consignment_no: null, vessel_voyage: null,
          etd_port_klang: null, bs_delivery_date: null, esb_remarks: null,
          bs_remarks: null, ctn: null, em_delivered_date: null,
          do_date: leg.jobKind === 'delivery' ? legDate : null,
          delivered_at: null, pod_r2_key: null, pod_lat: null, has_pod: false,
          ...NO_STOCK_ROW,
          company_code: a.company_id != null ? (codeMap.get(Number(a.company_id)) ?? null) : null,
          region: primaryRegion,
          regions: [...regionSet],
          warehouse_id: null,
          warehouse_code: null,
          warehouse_name: null,
          customer_state: realState, customer_country: null,
          delivered_qty: 0,
          remaining_qty: 0,
          crew: null,
          delivery_orders: [],
          trip_id: null,
          trip_no: null,
          trip_date: null,
          trip_stop_no: null,
          trip_eta_offset_s: null,
          arrangement_stage: leg.state === 'PENDING_SCHEDULE' ? 'PENDING_DATE' : null,
        });
      }
    }
  } catch (e) {
    if (e !== SUB_BOARD_SKIPPED) console.warn(`[delivery-planning] ASSR union skipped: ${String((e as Error).message).slice(0, 120)}`);
  }

  /* An ASSR leg on a trip shows that run's crew — driver, lorry and helpers
     (owner 2026-10-29) — resolved from the leg's trip_stop. Best-effort. */
  const assrShown = bandRows(assrOrders, band, today);
  const assrEchoP = (async () => {
    await echoAssrCrew(sb, assrShown).catch((e: Error) => console.warn(`[delivery-planning] ASSR crew echo skipped: ${e.message.slice(0, 120)}`)); lap('dp-assr-crew');
    await overlayAssrChatState(sb, assrShown); // HC-0171: the customer's WhatsApp answer on ASSR rows
  })();
  if (source !== 'sql') await assrEchoP;

  const dpBoardRows: BoardRow[] = [];
  const dpTripIdByKey = new Map<string, string | null>();
  try {
    const dpR = await dpResP;
    if ('err' in dpR) throw dpR.err; lap('dp-dp-rows');
    const dpRes = dpR.ok;
    const dpRows = (dpRes.data ?? []) as Array<Record<string, unknown>>;
    await fillDpRowsPostcode(sb, dpRows);
    for (const d of dpRows) {
      const dpState = (d.state as string | null) ?? null;
      const stateRegions = stateToRegionsFromConfig(regionCfg, dpState, null);
      const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
      const regionSet = new Set<Region>(stateRegions);
      const date = (d.requested_date as string | null) ?? null;
      const address = [d.address1, d.address2, d.address3, d.address4, d.city, d.postcode, d.state]
        .filter(Boolean).join(', ') || null;
      const boardState = dpBoardState((d.status as string | null) ?? null);
      dpTripIdByKey.set(`DP:${String(d.id)}`, ((d.trip_id ?? (d as { tripId?: string | null }).tripId) as string | null) ?? null);
      dpBoardRows.push({
        row_type: 'dp',
        ref: (d.dp_no as string | null) ?? null, so_ref: null, related_do_nos: null,
        job_kind: null,
        dp_job_type: (d.job_type as string | null) ?? null,
        dp_no: (d.dp_no as string | null) ?? null,
        dp_from_name: (d.from_name as string | null) ?? null,
        assr_id: null,
        so_doc_no: `DP:${String(d.id)}`,
        debtor_code: null,
        debtor_name: (d.party_name as string | null) ?? null,
        phone: (d.contact_phone as string | null) ?? null, agent: null, salesperson_id: null, venue: null,
        branding: null,
        status: String(d.status ?? ''),
        delivery_state: boardState,
        delivery_state_override: null,
        balance_sen: 0,
        balance_sen_live: null,
        local_total_sen: 0,
        release_gate: (() => {
          const g = computeReleaseGate({ totalSen: 0, paidSen: 0 });
          return { decision: g.decision, remaining_sen: g.remainingSen, collect_on_delivery_sen: g.collectOnDeliverySen, reason: 'DP job — no order balance' };
        })(),
        so_date: null,
        customer_delivery_date: date, sales_exemption_expiry: null,
        amend_date_from_customer: null,
        amended_delivery_date: date,
        amend_reason: null, amend_reason_from_customer: null,
        effective_delivery_date: date,
        processing_date: date,
        po_locked: false,
        days_left: date ? daysBetween(today, date) : null,
        address,
        postcode: (d.postcode as string | null) ?? null,
        building_type: null,
        possession_date: null,
        house_type: null,
        replacement_disposal: null,
        referral: null,
        delivery_message_status: (d.delivery_message_status as string | null) ?? null,
        disposal_request: null,
        dp_remark: (d.remark as string | null) ?? null,
        remark_locked: false,
        time_range: (d.time_range as string | null) ?? null,
        time_confirmed: null,
        arrival_at: null,
        departure_at: null,
        shipout_date: null,
        customer_delivered_date: null,
        eta_arriving_port: null,
        delivery_substatus: null,
        arrives_em_warehouse_date: null,
        em_delivery_status: null, consignment_no: null, vessel_voyage: null,
        etd_port_klang: null, bs_delivery_date: null, esb_remarks: null,
        bs_remarks: null, ctn: null, em_delivered_date: null,
        do_date: null,
        delivered_at: null, pod_r2_key: null, pod_lat: null, has_pod: false,
        ...NO_STOCK_ROW,
        company_code: null,
        region: primaryRegion,
        regions: [...regionSet],
        warehouse_id: null,
        warehouse_code: null,
        warehouse_name: null,
        customer_state: dpState, customer_country: null,
        delivered_qty: 0,
        remaining_qty: 0,
        crew: null,
        delivery_orders: [],
        trip_id: ((d.trip_id ?? (d as { tripId?: string | null }).tripId) as string | null) ?? null,
        trip_no: null,
        trip_date: null,
        trip_stop_no: null,
        trip_eta_offset_s: null,
        arrangement_stage: deriveArrangementStage({
          deliveryState: boardState,
          dateConfirmed: date != null,
          onActiveTrip: false,
        }),
      });
    }
  } catch (e) {
    if (e !== SUB_BOARD_SKIPPED) console.warn(`[delivery-planning] DP-order union skipped: ${String((e as Error).message).slice(0, 120)}`);
  }
  await Promise.all([echoTripCrew(sb, bandRows(dpBoardRows, band, today)).catch((e: Error) => console.warn(`[delivery-planning] DP crew echo skipped: ${e.message.slice(0, 120)}`)), assrEchoP]); lap('dp-crew-echo');

  const projectOrders: BoardRow[] = [];
  const writableCompanies = allowedCompanyIds(c);
  try {
    const projR = await projRowsP;
    if ('err' in projR) throw projR.err; lap('dp-projects');
    const projRows = projR.ok;

    for (const p of (projRows.results ?? [])) {
      const projState = p.state ?? p.venue_state ?? null;
      const stateRegions = stateToRegionsFromConfig(regionCfg, projState, null);
      const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
      const regionSet = new Set<Region>(stateRegions);
      const address = projectBoardAddress(p.venue_address ?? p.venue ?? null, p.venue_city, p.venue_postcode);
      const partyName = p.venue ?? p.name ?? null;

      const legs: Array<{ jobType: 'SETUP' | 'DISMANTLE'; date: string; driver: string | null; lorry: string | null }> = [];
      if (p.setup_start_at)     legs.push({ jobType: 'SETUP',     date: String(p.setup_start_at).slice(0, 10),     driver: p.setup_driver_name,     lorry: p.setup_lorry_plate });
      if (p.dismantle_start_at) legs.push({ jobType: 'DISMANTLE', date: String(p.dismantle_start_at).slice(0, 10), driver: p.dismantle_driver_name, lorry: p.dismantle_lorry_plate });

      for (const leg of legs) {
        const rowKey = `PRJ:${String(p.id)}#${leg.jobType}`;
        const fc = flattenProjectCrew(leg.jobType === 'SETUP' ? p.setup_crew : p.dismantle_crew);
        const d1 = fc.drivers[0] ?? null;
        const crewDriver = d1?.name ?? leg.driver ?? null;
        const crewLorry = fc.plates.length ? fc.plates.join(' / ') : (leg.lorry ?? null);
        const crewDriver2 = fc.drivers[1]?.name ?? null;
        const crewHelper1 = fc.helpers[0] ?? null;
        const crewHelper2 = fc.helpers[1] ?? null;
        projectOrders.push({
          row_type: 'project',
          ref: p.code ?? null, so_ref: null, related_do_nos: null,
          job_kind: null,
          dp_job_type: leg.jobType,
          dp_no: null,
          dp_from_name: null,
          assr_id: null,
          so_doc_no: rowKey,
          debtor_code: null,
          debtor_name: partyName,
          phone: null, agent: null, salesperson_id: null, venue: p.venue ?? null,
          branding: (p.brand && p.brand.trim()) ? p.brand.trim() : null,
          status: 'PROJECT',
          // Read-only mirror of a PMS-crewed window. A window whose date has
          // already passed is done → Delivered; an upcoming one is a committed
          // fleet job → Pending Delivery (owner 2026-10-21: the Delivered tab
          // shows every job type, not only SO deliveries).
          delivery_state: leg.date < today ? 'DELIVERED' : 'PENDING_DELIVERY',
          delivery_state_override: null,
          balance_sen: 0,
          balance_sen_live: null,
          local_total_sen: 0,
          release_gate: (() => {
            const g = computeReleaseGate({ totalSen: 0, paidSen: 0 });
            return { decision: g.decision, remaining_sen: g.remainingSen, collect_on_delivery_sen: g.collectOnDeliverySen, reason: 'PMS project — no order balance' };
          })(),
          so_date: null,
          customer_delivery_date: leg.date, sales_exemption_expiry: null,
          amend_date_from_customer: null,
          amended_delivery_date: leg.date,
          amend_reason: null, amend_reason_from_customer: null,
          effective_delivery_date: leg.date,
          processing_date: leg.date,
          po_locked: false,
          days_left: daysBetween(today, leg.date),
          address,
          postcode: p.venue_postcode ?? null,
          building_type: null,
          possession_date: null,
          house_type: null,
          replacement_disposal: null,
          referral: null,
          delivery_message_status: null,
          disposal_request: null,
          dp_remark: p.delivery_remark ?? null,
          remark_locked: writableCompanies !== undefined && !writableCompanies.includes(Number(p.company_id)),
          time_range: null,
          time_confirmed: null,
          arrival_at: null,
          departure_at: null,
          shipout_date: null,
          customer_delivered_date: null,
          eta_arriving_port: null,
          delivery_substatus: null,
          arrives_em_warehouse_date: null,
          em_delivery_status: null, consignment_no: null, vessel_voyage: null,
          etd_port_klang: null, bs_delivery_date: null, esb_remarks: null,
          bs_remarks: null, ctn: null, em_delivered_date: null,
          do_date: null,
          delivered_at: null, pod_r2_key: null, pod_lat: null, has_pod: false,
          ...NO_STOCK_ROW,
          company_code: null,
          region: primaryRegion,
          regions: [...regionSet],
          warehouse_id: null,
          warehouse_code: null,
          warehouse_name: null,
          customer_state: projState, customer_country: null,
          delivered_qty: 0,
          remaining_qty: 0,
          crew: (crewDriver || crewLorry || crewDriver2 || crewHelper1 || crewHelper2) ? {
            driver: crewDriver, helper: crewHelper1, lorry: crewLorry,
            driver_1_name: crewDriver, driver_1_ic: null, driver_1_contact: d1?.phone ?? null,
            driver_2_name: crewDriver2, helper_1_name: crewHelper1, helper_2_name: crewHelper2,
            lorry_plate: crewLorry,
          } : null,
          delivery_orders: [],
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
    if (e !== SUB_BOARD_SKIPPED) console.warn(`[delivery-planning] project union skipped: ${String((e as Error).message).slice(0, 120)}`);
  }

  const soServed = orders.map((o) => ({ ...o, ac_sales_exemption_expiry: maps.acExpiryByDoc.get(o.so_doc_no) ?? null, po_nos: maps.poNosByDoc.get(o.so_doc_no) ?? [] }));
  const allOrders = bandRows([...soServed, ...assrOrders, ...dpBoardRows, ...projectOrders], band, today); lap('dp-union');

  const scopedBase = new Set(await applyDeliveryRowScope(sb, scope, allOrders, {
    doByDoc: maps.doByDoc, doDriverById: maps.doDriverById, crewIdsByDo: maps.crewIdsByDo, dpTripIdByKey,
  })); lap('dp-row-scope');
  const ownExtra = scope.mode === 'all' ? null
    : await ownServiceAndProjectRowKeys(sb, c.env, scope, Number(c.get('houzsUser')?.id), c.get('houzsUser')?.name ?? null, allOrders);
  const scopedOrders = allOrders.filter((o) => scopedBase.has(o) || !!ownExtra?.has(o.so_doc_no));

  if (scope.mode === 'all') {
    const entering = docsEnteringPendingSchedule(allOrders);
    if (!band) await stampPendingScheduleAfterResponse(c, sb, entering);
    const stamped = new Set(entering);
    for (const o of allOrders) if (stamped.has(o.so_doc_no) && o.row_type === 'so') o.delivery_state_override = 'PENDING_SCHEDULE';
  }
  if (source === 'shadow') scheduleBoardShadow(c, { query: new URL(c.req.url).search, served: structuredClone(soServed), docNos, display: !countsOnly, onlyDocs, band, restMs: Date.now() - t0, ctx: rowCtx });
  const regionFiltered = scopedOrders.filter((o) => matchesRegion(o, regionParam, regionCfg.validCodes));
  const counts = emptyCounts();
  for (const o of regionFiltered) counts[o.delivery_state] += 1;
  counts.ALL = regionFiltered.length;

  const slice = boardSlice(regionFiltered, stateParam);
  const regionsOfRow = (r: { customer_state: string | null; customer_country: string | null }) => stateToRegionsFromConfig(regionCfg, r.customer_state, r.customer_country);
  addSkippedDelivered(skippedDelivered, regionsOfRow, regionParam, counts, slice.deliveredByRegion);
  if (countsOnly) return c.json({ counts_by_region: countsByRegion(scopedOrders, skippedDelivered, regionCfg.regions.map((r) => r.key), (o, k) => matchesRegion(o, k, regionCfg.validCodes), regionsOfRow, emptyCounts), regions: regionCfg.regions });
  return c.json({ orders: slice.orders, counts, regions: regionCfg.regions, ...(slice.deliveredByRegion ? { delivered_by_region: slice.deliveredByRegion } : {}), ...(band ? { band: { band: band.band, page: band.page, page_count: plan.pageCount } } : {}) });
};
deliveryPlanning.get('/', deliveryPlanningBoardHandler);
deliveryPlanning.get('/changes', boardChangesHandler);

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
    const crewByDoId = new Map<string, { driverIds: Array<string | null>; helperIds: Array<string | null>; lorryPlate: string | null }>();
    if (scopeDoIds.length > 0) {
      const { data: crewRows } = await chunkIn<Record<string, unknown>>(scopeDoIds, (batch, from, to) =>
        sb.from('delivery_order_crew')
          .select('do_id, driver_1_id, driver_2_id, helper_1_id, helper_2_id, lorry_plate')
          .in('do_id', batch).order('do_id').range(from, to),
      );
      for (const cr of crewRows) {
        crewByDoId.set(String(cr.do_id ?? cr.doId ?? ''), {
          driverIds: [(cr.driver1Id ?? cr.driver_1_id) as string | null, (cr.driver2Id ?? cr.driver_2_id) as string | null],
          helperIds: [(cr.helper1Id ?? cr.helper_1_id) as string | null, (cr.helper2Id ?? cr.helper_2_id) as string | null],
          lorryPlate: (cr.lorryPlate ?? cr.lorry_plate ?? null) as string | null,
        });
      }
    }
    docNos = docNos.filter((dn) => {
      const latest = latestDoByDoc.get(dn);
      if (!latest) return false;
      const crew = crewByDoId.get(latest.id) ?? { driverIds: [], helperIds: [], lorryPlate: null };
      return scopeMatchesAssignment(scope, {
        driverIds: [...crew.driverIds, latest.driverId],
        helperIds: crew.helperIds,
        lorryPlate: crew.lorryPlate,
      });
    });
  }
  const docNoSet = new Set(docNos);
  const scopedRows = dayRows.filter((r) => docNoSet.has(String(r.docNo ?? r.doc_no ?? '')));

  if (scopedRows.length === 0) {
    return c.json({ date, region: regionParam, configured, points: [], depot: null, depotReason: 'no orders on this day', lorryDepots: {}, ungeocoded: [] });
  }

  const { data: zoneRows } = await paginateAll<ZoneMapRow>((from, to) =>
    scopeToCompany(sb.from('delivery_zone_postcodes').select(ZONE_MAP_COLS), c).order('id').range(from, to),
  );
  const { map: zoneMap } = toPrefixMap(zoneRows ?? []);

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
        scopeToCompany(pgrestIn(sb.from('mfg_products').select('code, category'), 'code', chunk), c).range(from, to),
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
        .select('id, name, code, location, city, state, postcode, latitude, longitude')
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
      const hit = w.latitude != null && w.longitude != null ? { lat: Number(w.latitude), lng: Number(w.longitude) } : whAddr ? await geocodeAddressCached(sb, c.env, whAddr) : null;
      if (hit) {
        depot = { warehouseId: best.id, name: whName, code: (w.code ?? null) as string | null, lat: hit.lat, lng: hit.lng };
      } else {
        depotReason = whName
          ? `depot warehouse "${whName}" could not be geocoded — fill in its address in the Warehouses master`
          : 'depot warehouse could not be geocoded';
      }
    }
  }

  const candidatesByDoc = new Map<string, GeoCandidate[]>();
  const addrByDoc = new Map<string, string>();
  for (const r of scopedRows) {
    const dn = String(r.docNo ?? r.doc_no ?? '');
    if (!dn) continue;
    const addr = composeAddress({
      address1: r.address1,
      address2: r.address2,
      postcode: r.postcode,
      state: r.customerState ?? r.customer_state ?? null,
      country: r.customerCountry ?? r.customer_country ?? null,
    });
    addrByDoc.set(dn, addr);
    candidatesByDoc.set(dn, soCandidates(addr, r.postcode, r.customerState ?? r.customer_state ?? null, r.customerCountry ?? r.customer_country ?? null));
  }
  const located = await locateStops(sb, c.env, candidatesByDoc);

  const points: Array<{
    ref: string; so_doc_no: string; lat: number; lng: number; approximate: boolean;
    zone: string | null; region: Region; state: string | null; country: string | null; postcode: string | null;
    sets: number; revenueSen: number; customer: string | null; address: string;
  }> = [];
  const ungeocoded: Array<{ ref: string; reason: string }> = [];
  for (const r of scopedRows) {
    const dn = String(r.docNo ?? r.doc_no ?? '');
    const loc = located.get(dn);
    if (!loc) continue;
    if (!loc.ok) { ungeocoded.push({ ref: dn, reason: loc.reason }); continue; }
    const zr = zoneForAddress({ postcode: r.postcode, address1: r.address1, address2: r.address2 }, zoneMap);
    const sc = deriveSetCount(setLinesByDoc.get(dn) ?? []);
    points.push({
      ref: dn,
      so_doc_no: dn,
      lat: loc.lat,
      lng: loc.lng,
      approximate: loc.approximate,
      zone: zr.zone,
      region: (regionsByDoc.get(dn) ?? [])[0] ?? FALLBACK_DEFAULT_REGION,
      state: r.customerState ?? r.customer_state ?? null, country: r.customerCountry ?? r.customer_country ?? null,
      postcode: r.postcode ?? null,
      sets: sc.sets,
      revenueSen: Number(r.localTotalSen ?? r.local_total_sen ?? 0) || 0,
      customer: r.debtorName ?? r.debtor_name ?? null,
      address: loc.approximate ? loc.address : (addrByDoc.get(dn) ?? loc.address),
    });
  }

  return c.json({ date, region: regionParam, configured, points, depot, depotReason, ...(await loadLorryDepots(sb, c.env)), ungeocoded });
});

deliveryPlanning.get('/geo/jobs', async (c) => {
  const sb = c.get('supabase');
  const configured = !!c.env.GOOGLE_MAPS_API_KEY;
  const refs = [...new Set((c.req.query('refs') ?? '').split(',').map((r) => r.trim()).filter(Boolean))];
  if (refs.length > 300) return c.json({ error: 'too_many_refs', reason: 'at most 300 refs' }, 400);
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  if (refs.length === 0 || scope.mode !== 'all') return c.json({ configured, points: [], ungeocoded: [] });

  const { stops, error } = await loadJobStops(c, sb, refs);
  if (error) return c.json({ error: 'load_failed', reason: error }, 500);
  const located = await locateStops(sb, c.env, new Map(stops.map((s) => [s.ref, s.candidates])));
  const points: Array<{ ref: string; lat: number; lng: number; approximate: boolean; address: string; customer: string | null; postcode: string | null; state: string | null }> = [];
  const ungeocoded: Array<{ ref: string; reason: string }> = [];
  for (const s of stops) {
    const loc = located.get(s.ref);
    if (!loc) continue;
    if (loc.ok) points.push({ ref: s.ref, lat: loc.lat, lng: loc.lng, approximate: loc.approximate, address: loc.address, customer: s.customer, postcode: s.postcode, state: s.state });
    else ungeocoded.push({ ref: s.ref, reason: loc.reason });
  }
  const found = new Set(stops.map((s) => s.ref));
  for (const r of refs) if (!found.has(r)) ungeocoded.push({ ref: r, reason: 'job not found' });
  return c.json({ configured, points, ungeocoded });
});

deliveryPlanning.get('/:docNo/lines', async (c) => {
  const sb = c.get('supabase');
  const docNo = c.req.param('docNo');
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

deliveryPlanning.get('/do/:doRef/pod', doPodContextHandler);

function matchesRegion(
  o: { regions: Region[] },
  regionParam: string,
  validCodes: Set<Region>,
): boolean {
  if (regionParam === 'ALL' || regionParam === '') return true;
  if (validCodes.has(regionParam)) {
    return o.regions.includes(regionParam);
  }
  return true;
}

function emptyCounts(): Record<'ALL' | DeliveryState, number> {
  return { ALL: 0, PENDING_DELIVERY: 0, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: 0 };
}



deliveryPlanning.patch('/:type/:id/fields', async (c) => {
  const type = c.req.param('type').toLowerCase();
  const id = c.req.param('id');
  if (type !== 'so' && type !== 'do' && type !== 'dp' && type !== 'assr' && type !== 'project') {
    return c.json({ error: 'bad_type', reason: 'type must be so | do | dp | assr | project' }, 400);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = fieldsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data as Record<string, unknown>;

  if (p.deliverySubstatus != null && p.deliverySubstatus !== '' &&
      !(HC_SUBSTATUS_VALUES as readonly string[]).includes(String(p.deliverySubstatus))) {
    return c.json({ error: 'invalid_substatus', reason: `delivery_substatus must be one of: ${HC_SUBSTATUS_VALUES.join(', ')} (or blank).` }, 400);
  }

  if (p.deliveryMessageStatus != null && p.deliveryMessageStatus !== '' &&
      !(HC_MESSAGE_STATUS_VALUES as readonly string[]).includes(String(p.deliveryMessageStatus))) {
    return c.json({ error: 'invalid_message_status', reason: 'delivery_message_status is not one of the allowed workflow values.' }, 400);
  }

  const sb = c.get('supabase');

  if (type === 'dp' || type === 'assr' || type === 'project') {
    const r = await writeNonSoFields(c, sb, type, id, {
      deliveryMessageStatus: p.deliveryMessageStatus as string | null | undefined,
      timeRange: p.timeRange as string | null | undefined,
      remark: p.dpRemark as string | null | undefined,
      amendReason: p.amendReason as string | null | undefined,
      jobKind: p.jobKind as 'customer_pickup' | 'delivery' | 'inspection' | undefined,
    });
    return c.json(r.body, r.status);
  }

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

  let soDocNo: string | null = null;
  let doId: string | null = null;
  /* COMPANY GATE for the whole handler: everything below keys off soDocNo /
     doId, both taken from the caller-supplied :id. Resolve the document ONCE,
     scoped, and refuse before any write.
     ALLOWED companies, not the active one (HC-0180): the board lists every
     granted company's orders (MULTICOMPANY-MODULE-MAP rule 3), so pinning the
     active company 404'd "That item could no longer be found" on a 2990 row
     picked while switched to Houzs. Same widening as GET /:docNo/lines. */
  if (type === 'so') {
    const { data: own, error: ownErr } = await scopeToAllowedCompanies(
      sb.from('mfg_sales_orders').select('doc_no').eq('doc_no', id), c,
    ).maybeSingle();
    if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
    if (!own) return c.json({ error: 'not_found' }, 404);
  } else {
    const { data: own, error: ownErr } = await scopeToAllowedCompanies(
      sb.from('delivery_orders').select('id').eq('id', id), c,
    ).maybeSingle();
    if (ownErr) return c.json({ error: 'lookup_failed', reason: ownErr.message }, 500);
    if (!own) return c.json({ error: 'not_found' }, 404);
  }

  if (type === 'so') {
    soDocNo = id;
    if (Object.keys(doUpdates).length > 0) {
      const { data: doRows, error: doRowsErr } = await scopeToAllowedCompanies(sb.from('delivery_orders')
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
    /* Owner 2026-08-12 — the PO lock (every company) is the same soft lock reached
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

  if (Object.keys(soUpdates).length > 0 && soDocNo) {
    let beforeRow: Record<string, unknown> = {};
    try {
      const { data: beforeData } = await sb.from('mfg_sales_orders')
        .select(`status, ${Object.values(SO_FIELD_COLS).join(', ')}`)
        .eq('doc_no', soDocNo).maybeSingle();
      beforeRow = (beforeData ?? {}) as unknown as Record<string, unknown>;
    } catch { }
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

  if (Object.keys(doUpdates).length > 0) {
    if (doId) {
      doUpdates.updated_at = new Date().toISOString();
      const { error } = await scopeToAllowedCompanies(sb.from('delivery_orders').update(doUpdates).eq('id', doId), c);
      if (error) {
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

const scheduleSchema = z.object({
  scheduleDate: z.string().nullable().optional(),
  deliveryState: z.enum(['PENDING_DELIVERY', 'PENDING_SCHEDULE', 'OVERDUE', 'DELIVERED']).nullable().optional(),
  jobKind: z.enum(ASSR_BOARD_LEGS).nullable().optional(),
  assrLegStatus: z.enum(['delivered', 'cancelled', 'pending']).optional(),
  tripId: z.string().uuid().nullable().optional(),
  lorryId: z.string().uuid().nullable().optional(),
  driverId: z.string().uuid().nullable().optional(),
  helper1Id: z.string().uuid().nullable().optional(),
  helper2Id: z.string().uuid().nullable().optional(),
  tripDate: z.string().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  stopNo: z.number().int().min(1).max(999).optional(),
  etaOffsetS: z.number().int().min(0).nullable().optional(),
  legDistanceM: z.number().int().min(0).nullable().optional(),
  legDurationS: z.number().int().min(0).nullable().optional(),
  threePlCostSen: z.number().int().min(0).nullable().optional(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deriveTripOutsourced(sb: any, lorryId: string | null): Promise<boolean> {
  if (!lorryId) return false;
  const { data } = await sb.from('lorries').select('is_internal').eq('id', lorryId).maybeSingle();
  if (!data) return false;
  return ((data as { isInternal?: boolean | null; is_internal?: boolean | null }).isInternal
    ?? (data as { is_internal?: boolean | null }).is_internal) === false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function nextTripNo(sb: any): Promise<string> {
  const yymm = yymmFor();
  return mintMonthlyDocNo(sb, 'trips', 'trip_no', `TRIP-${yymm}`);
}

deliveryPlanning.patch('/:type/:id/schedule', async (c) => {
  const type = c.req.param('type').toLowerCase();
  const id = c.req.param('id');
  if (type !== 'so' && type !== 'do' && type !== 'assr' && type !== 'dp') {
    return c.json({ error: 'bad_type', reason: 'type must be so | do | assr | dp' }, 400);
  }
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: parsed.error.message }, 400);
  const p = parsed.data;

  if (type === 'assr') {
    const assrWantsTrip = p.tripId != null || p.lorryId != null;
    const assrCrewOnly = !assrWantsTrip && hasSeatPatch(p);
    const wantsStatus = p.assrLegStatus !== undefined;
    if (p.scheduleDate === undefined && !assrWantsTrip && !assrCrewOnly && !wantsStatus) return c.json({ error: 'no_changes' }, 400);
    const caseId = Number(id);
    if (!Number.isFinite(caseId)) return c.json({ error: 'bad_id', reason: 'assr id must be numeric' }, 400);
    const jobKind: 'customer_pickup' | 'delivery' | 'inspection' =
      p.jobKind === 'customer_pickup' ? 'customer_pickup'
      : p.jobKind === 'inspection' ? 'inspection'
      : 'delivery';
    const col = ASSR_CONFIRMED_COL[jobKind];
    const legCase = (await c.env.DB.prepare(assrLegGuardSql(c)).bind(caseId).first()) as Parameters<typeof assrLegOpen>[0] | null;
    if (!legCase) return c.json({ error: 'not_found' }, 404);
    const actor = c.get('user') as { name?: string; email?: string } | null;
    const by = actor?.name ?? actor?.email ?? 'logistics';

    // Leg status dropdown (owner 2026-11-06): Delivered / Cancelled / pending — records
    // the step, never closes the case (logic in the board-writes module, size ceiling).
    if (p.assrLegStatus !== undefined && p.scheduleDate === undefined && !assrWantsTrip && !assrCrewOnly) {
      const r = await writeAssrLegStatus(c, caseId, jobKind, p.assrLegStatus, by);
      return c.json(r.body, r.status);
    }

    if (!assrLegOpen(legCase, jobKind, todayMyt())) return c.json({ error: 'not_found' }, 404);

    if (p.scheduleDate !== undefined) {
      try {
        const res = await c.env.DB.prepare(assrConfirmDateSql(jobKind)).bind(p.scheduleDate, caseId).run();
        if (!res.meta.changes) return c.json({ error: 'not_found' }, 404);
        await logActivity(c.env, caseId, 'leg_date_confirmed', null, p.scheduleDate,
          `${jobKind} delivery date confirmed on the Delivery Planning board by ${by}`, null, 'service');
      } catch (e) {
        return c.json({ error: 'update_failed', reason: String((e as Error).message).slice(0, 200) }, 500);
      }
    }
    const sb = c.get('supabase');
    if (assrCrewOnly) {
      const legTrip = await setAssrLegCrew(sb, caseId, jobKind, p).catch((e: Error) => ({ error: e.message }));
      if (legTrip && typeof legTrip === 'object') return c.json({ error: 'crew_save_failed', reason: legTrip.error }, 500);
      if (!legTrip && p.scheduleDate === undefined) return c.json({ error: 'no_trip', reason: 'Pick a lorry for this job first; the driver rides with the lorry run.' }, 409);
    }
    const wiring: TripWiring = assrWantsTrip
      ? await scheduleAssrOntoTrip(c, sb, caseId, jobKind, p)
      : { state: 'NOT_REQUESTED' };
    if (hasSeatPatch(p) || assrWantsTrip) {
      await logActivity(c.env, caseId, 'leg_crew_assigned', null, null,
        `${jobKind} driver/lorry assigned on the Delivery Planning board by ${by}`, null, 'service')
        .catch((e: Error) => console.warn(`[delivery-planning] ASSR crew activity log skipped: ${e.message.slice(0, 120)}`));
    }
    return c.json({ ok: true, assr: { id: caseId, job_kind: jobKind, [col]: p.scheduleDate ?? null }, ...tripFieldsFor(wiring) });
  }

  if (type === 'dp') {
    const r = await scheduleDpDate(c, c.get('supabase'), id, p.scheduleDate);
    return c.json(r.body, r.status);
  }

  const wantsTrip = p.tripId != null || p.lorryId != null;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.scheduleDate !== undefined && type === 'so') updates.amended_delivery_date = dateOrNull(p.scheduleDate);
  if (p.deliveryState !== undefined) updates.delivery_state = p.deliveryState;
  const coId = type === 'so' && hasSeatPatch(p) ? await soCompanyWithinGrants(c, id) : (activeCompanyId(c) ?? null);
  const crew = type === 'so' && !wantsTrip && hasSeatPatch(p) && coId != null
    ? await assignSoCrew(c.get('supabase'), coId, id, p, (c.get('user') as { id?: string } | null)?.id ?? null).catch((e: Error) => ({ error: e.message })) : undefined;
  if (crew === null) return c.json({ error: 'no_delivery_order', reason: 'Create a delivery order first, then assign the crew.' }, 409);
  if (crew && 'error' in crew) return c.json({ error: 'crew_save_failed', reason: crew.error }, 500);
  if (Object.keys(updates).length === 1 && crew) return c.json({ ok: true, crew });
  if (Object.keys(updates).length === 1 && !wantsTrip) return c.json({ error: 'no_changes' }, 400);

  const sb = c.get('supabase');
  const table = type === 'so' ? 'mfg_sales_orders' : 'delivery_orders';
  const keyCol = type === 'so' ? 'doc_no' : 'id';
  const selectCols = type === 'so'
    ? 'doc_no, customer_delivery_date, amended_delivery_date, amend_date_from_customer, delivery_state, status'
    : 'id, do_number, customer_delivery_date, delivery_state, status';

  let data: Record<string, unknown> | null = null;
  if (Object.keys(updates).length > 1) {
    let scheduleBefore: Record<string, unknown> = {};
    if (type === 'so') {
      try {
        const { data: b } = await sb.from('mfg_sales_orders')
          .select('amended_delivery_date, delivery_state, status').eq('doc_no', id).maybeSingle();
        scheduleBefore = (b ?? {}) as Record<string, unknown>;
      } catch { }
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

  const carry = type === 'so' && !wantsTrip && p.scheduleDate ? await staleRunOfSo(sb, coId, id, p.scheduleDate) : null;
  const wiring: TripWiring = wantsTrip || carry
    ? await scheduleOntoTrip(c, sb, type, id, { ...p, ...carry })
    : { state: 'NOT_REQUESTED' };

  return c.json({ ok: true, [type]: data, ...tripFieldsFor(wiring) });
});

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

const SO_DO_STOP_TYPE = 'DELIVERY';

export type StaleStopSweep =
  | { state: 'SWEEP'; column: 'do_id' | 'so_id'; value: string; stopType: string }
  | { state: 'NO_KEY'; reason: string };

export function staleStopSweepFor(doId: string | null, soId: string | null): StaleStopSweep {
  if (doId) return { state: 'SWEEP', column: 'do_id', value: doId, stopType: SO_DO_STOP_TYPE };
  if (soId) return { state: 'SWEEP', column: 'so_id', value: soId, stopType: SO_DO_STOP_TYPE };
  return {
    state: 'NO_KEY',
    reason: 'the order has no do_id/so_id uuid, so no stop was written for it and none can be stranded',
  };
}

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

    let doId: string | null = null;
    let soId: string | null = null;
    let soDocNo: string | null = null;
    let revenueSen = 0;
    let customerName: string | null = null;
    let address: string | null = null;
    let tripWarehouseId: string | null = p.warehouseId ?? null;
    let orderDate: string | null = null;

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
      const { data: soRow } = await sb.from('mfg_sales_orders')
        .select('local_total_sen, debtor_name, address1, address2, amended_delivery_date, customer_delivery_date').eq('doc_no', id).maybeSingle();
      if (soRow) {
        const r = soRow as Record<string, unknown>;
        soId = null;
        doId = await latestLiveDoIdForSo(sb, (await soCompanyWithinGrants(c, id)) ?? activeCompanyId(c) ?? null, id);
        orderDate = dateOrNull((r.amended_delivery_date ?? r.customer_delivery_date ?? null) as string | null);
        revenueSen = Number((r.localTotalSen ?? r.local_total_sen) ?? 0);
        customerName = (r.debtorName ?? r.debtor_name ?? null) as string | null;
        address = [r.address1, r.address2].filter(Boolean).join(', ') || null;
      }
    }
    revenueSen = Math.max(0, Math.round(revenueSen) || 0);

    const tripDate = dateOrNull(p.tripDate) ?? dateOrNull(p.scheduleDate) ?? orderDate ?? todayMyt();
    let tripId = p.tripId ?? null;
    if (!tripId && p.lorryId) {
      const { data: found } = await sb.from('trips').select('id, trip_no')
        .eq('lorry_id', p.lorryId).eq('trip_date', tripDate).neq('status', 'CANCELLED').limit(1);
      const hit = ((found ?? []) as Array<{ id: string; trip_no?: string; tripNo?: string }>)[0];
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
        helper_1_id:   p.helper1Id ?? null,
        helper_2_id:   p.helper2Id ?? null,
        warehouse_id:  tripWarehouseId,
        trip_type:     'DELIVERY',
        status:        'PLANNED',
        is_outsourced: isOutsourced,
        three_pl_cost_sen: isOutsourced ? (p.threePlCostSen ?? null) : null,
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

    const stopFilter = sb.from('trip_stops').select('id').eq('trip_id', tripIdStr);
    const { data: existingStops } = await (doId
      ? stopFilter.eq('do_id', doId)
      : stopFilter.eq('so_id', soId));
    const already = ((existingStops ?? []) as Array<{ id: string }>)[0];

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
      const nextStopNo = p.stopNo ?? appendStopNo;

      let dpNo: string | null = null;
      let lorryIdForNo = p.lorryId ?? null;
      if (!lorryIdForNo) {
        const { data: tRow } = await sb.from('trips').select('lorry_id').eq('id', tripIdStr).maybeSingle();
        const tr = tRow as { lorry_id?: string | null; lorryId?: string | null } | null;
        lorryIdForNo = (tr?.lorryId ?? tr?.lorry_id ?? null) as string | null;
      }
      dpNo = await mintDpNoForLorry(sb, { tripDate, lorryId: lorryIdForNo });

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
        eta_offset_s:       p.etaOffsetS ?? null,
        leg_distance_m:     p.legDistanceM ?? null,
        leg_duration_s:     p.legDurationS ?? null,
        route_optimised_at: p.stopNo != null && p.etaOffsetS != null ? new Date().toISOString() : null,
      });
    }

    const sweep = staleStopSweepFor(doId, soId);
    if (sweep.state === 'SWEEP') {
      const { error: staleErr } = await sb.from('trip_stops').delete()
        .eq(sweep.column, sweep.value).eq('stop_type', sweep.stopType).neq('trip_id', tripIdStr);
      if (staleErr) {
        return {
          state: 'FAILED',
          reason: `the order was placed on the new trip but the previous one could not be cleared — it may be counted twice: ${String((staleErr as { message?: string }).message ?? staleErr).slice(0, 120)}`,
        };
      }
    }

    await applyScheduleCrew(sb, tripIdStr, p, user?.id ?? null);

    const { data: tNo } = await sb.from('trips').select('id, trip_no').eq('id', tripIdStr).maybeSingle();
    const tr = tNo as { id?: string; trip_no?: string; tripNo?: string } | null;

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
    return {
      state: 'FAILED',
      reason: `trip wiring failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`,
    };
  }
}

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
    const requestedCol = jobKind === 'customer_pickup' ? 'customer_pickup_at'
      : jobKind === 'inspection' ? 'inspection_visit_at'
      : 'do_date';
    const dateCol = `COALESCE(${ASSR_CONFIRMED_COL[jobKind]}, ${requestedCol})`;

    /* Case snapshot (customer / address) + the leg's own date, from public.assr_cases
       via c.env.DB (same path the ASSR board union uses). The leg date is the trip's
       default date so a crew-only edit (no scheduleDate) still lands on the right day.
       company-scope: deliberately UNSCOPED, and safe — reachable only after the
       ASSR branch's assrLegGuardSql has 404'd any case outside the caller's
       granted companies. Same shape as routes/assr.ts (:2672, :1116). */
    const a = (await c.env.DB.prepare(
      `SELECT customer_name AS customer_name, ${dateCol} AS leg_date,
              addr1 AS addr1, addr2 AS addr2, addr3 AS addr3, addr4 AS addr4,
              ca.postcode AS postcode, ca.city AS city, ca.state AS state
         FROM assr_cases LEFT JOIN assr_case_address ca ON ca.assr_id = assr_cases.id WHERE assr_cases.id = ?`,
    ).bind(caseId).first()) as {
      customer_name: string | null; leg_date: string | null;
      addr1: string | null; addr2: string | null; addr3: string | null; addr4: string | null;
      postcode: string | null; city: string | null; state: string | null;
    } | null;
    const customerName = a?.customer_name ?? null;
    const address = a ? formatCaseAddress(a) : null;

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

    const { data: existing } = await sb.from('trip_stops').select('id')
      .eq('trip_id', tripIdStr).eq('assr_case_id', caseId).eq('stop_type', stopType).limit(1);
    const already = ((existing ?? []) as Array<{ id: string }>)[0];
    if (!already) {
      const { data: cntRows } = await sb.from('trip_stops').select('stop_no').eq('trip_id', tripIdStr);
      const nextStopNo = ((cntRows ?? []) as Array<{ stop_no?: number; stopNo?: number }>)
        .reduce((m, r) => Math.max(m, Number(r.stopNo ?? r.stop_no ?? 0)), 0) + 1;

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

    const { error: staleErr } = await sb.from('trip_stops').delete()
      .eq('assr_case_id', caseId).eq('stop_type', stopType).neq('trip_id', tripIdStr);
    if (staleErr) {
      return {
        state: 'FAILED',
        reason: `the leg was placed on the new trip but the previous one could not be cleared — it may be counted twice: ${String((staleErr as { message?: string }).message ?? staleErr).slice(0, 120)}`,
      };
    }

    /* The run the leg moved OFF keeps no crew progress either. Its On-the-way /
       Arrived / Delivered + POD in scm.job_progress were for a trip the leg no
       longer rides, but the Last Mile board keys progress by JOB (not trip) and
       reads completed_at, so a leftover completion showed the leg "Delivered" on
       the new run with no way to clear it (case ASSR/2610-048). Reset it beside
       the stale trip_stop, scoped the SAME way (this leg, trip != the new one),
       and re-point the row at the new trip. Best-effort + logged: the leg is
       already on the new trip, so a failed clear is a stale badge, not a
       capacity error, and must not fail the schedule. company-scope: source_id
       is this already-authorized case id (assrLegGuardSql 404'd out-of-scope). */
    const progReset = staleLegProgressReset('assr', caseId, jobKind, tripIdStr);
    const { error: progErr } = await sb.from('job_progress')
      .update({ ...progReset.set, updated_at: new Date().toISOString() })
      .eq('source_type', progReset.match.source_type)
      .eq('source_id', progReset.match.source_id)
      .eq('leg', progReset.match.leg)
      .neq('trip_id', progReset.excludeTripId);
    if (progErr) console.warn(`[delivery-planning] stale leg progress clear skipped: ${String((progErr as { message?: string }).message ?? progErr).slice(0, 120)}`);

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
