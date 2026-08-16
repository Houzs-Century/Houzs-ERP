// ---------------------------------------------------------------------------
// delivery-agent.ts — the Houzs Delivery Agent ENGINE (deterministic, pure).
// Ported from HOOKKA src/api/lib/delivery-agent.ts as the design template,
// re-grounded in the Houzs delivery domain: B2C furniture deliveries with an
// OWN fleet (drivers/helpers/lorries, migration 0053 TMS), organised by
// customer-STATE regions on the Delivery Planning board.
//
// The engine only:
//   1. generateDeliveryProposals — writes PENDING rows into
//      delivery_agent_proposals (migration 0092):
//        LOAD_PLAN  — the board's ready-to-deliver pool (planning state
//                     PENDING_SCHEDULE) bucketed by REGION, one customer's
//                     orders grouped together inside the payload.
//        POD_CHASE  — DOs delivered >24h ago with neither a POD photo
//                     (pod_r2_key) nor a signature (signature_data).
//                     Default ON (Houzs has POD capture on the DO).
//   2. collectDeliveryBrief — today's delivery picture (pool by planning
//      state + region, overdue-to-deliver, DO pipeline, POD gaps, trips
//      today/tomorrow with crew) + a snapshot row in delivery_agent_briefs.
//   3. deliveryLearning — per-state ACTUAL dispatch→delivered working days
//      (90d window) vs the configured allowance; drift ≥1 day over ≥5
//      deliveries yields a proposed config change the LEAD wires into the
//      skeleton's config_proposals framework (this module never writes them).
//   4. runDeliveryAgent — orchestrates 1-3 for the scheduler.
//   5. deliveryAgentStatus — cheap counters for the console card.
//
// RED LINES (HOOKKA discipline, enforced structurally):
//   - NEVER creates/edits/dispatches DOs or trips — this module writes ONLY
//     to delivery_agent_proposals + delivery_agent_briefs (public schema).
//   - Deterministic only — no LLM calls, no invented numbers. The AI-focus
//     paragraph is the lead's job (shared brain), stored via ai_focus later.
//   - Every proposal carries a human-readable summary.
//
// DB access, following house patterns:
//   - scm tables → getSupabaseService(env) (PostgREST, schema:'scm',
//     snake_case columns verbatim — no camelCase transform, no dual-read).
//   - public tables (delivery_agent_*, app_settings) → env.DB (d1-compat
//     shim). Rows read off env.DB are dual-keyed r.camelCase ?? r.snake_case
//     defensively, matching services/agent-console.ts.
//
// Board fidelity: the ready pool reuses the board's OWN exports —
// summariseReadiness (scm/lib/so-readiness), soDeliverableRemaining
// (scm/routes/delivery-orders-mfg) and derivePlanningState
// (scm/routes/delivery-planning) — so agent and board can never disagree
// about what "ready to deliver" means.
// ---------------------------------------------------------------------------

import type { Env } from '../../types';
import { getSupabaseService } from '../../db/supabase';
import { paginateAll } from '../../scm/lib/paginate-all';
import { todayMyt, mytDateOf } from '../../scm/lib/my-time';
import { summariseReadiness, type ReadinessLine } from '../../scm/lib/so-readiness';
import { derivePlanningState, type DeliveryState } from '../../scm/routes/delivery-planning';
import { soDeliverableRemaining } from '../../scm/routes/delivery-orders-mfg';
import { readAgentSetting, type ConfigParamRule } from '../agent-console';
import { DO_STATUSES as SHARED_DO_STATUSES } from '../../scm/shared/do-shipped-states';
import {
  loadRegionConfig,
  stateToRegions,
  resolveStateCode,
  type Region,
  type RegionConfig,
} from './delivery-agent-geo';

// ── Config (app_settings['agents.delivery']) ─────────────────────────────────

export const DELIVERY_AGENT_SETTING_KEY = 'agents.delivery';

/** Working-day allowance assumed for a state with no configured value. */
export const DEFAULT_TRANSIT_DAYS = 3;

export interface DeliveryAgentSettings {
  /** Per-state working-day transit allowance, keyed by canonical code (SEL, KL…). */
  transitDaysByState?: Record<string, number>;
  defaultTransitDays?: number;
  /** POD chasing. Default ON — Houzs captures pod_r2_key / signature_data on the DO. */
  podChase?: boolean;
}

async function loadDeliverySettings(db: D1Database): Promise<Required<Pick<DeliveryAgentSettings, 'defaultTransitDays' | 'podChase'>> & { transitDaysByState: Record<string, number> }> {
  const raw = (await readAgentSetting<DeliveryAgentSettings>(db, DELIVERY_AGENT_SETTING_KEY)) ?? {};
  const byState: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.transitDaysByState ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 30) byState[k.toUpperCase()] = Math.floor(n);
  }
  const dflt = Number(raw.defaultTransitDays);
  return {
    transitDaysByState: byState,
    defaultTransitDays: Number.isFinite(dflt) && dflt >= 0 && dflt <= 30 ? Math.floor(dflt) : DEFAULT_TRANSIT_DAYS,
    podChase: raw.podChase !== false, // default ON
  };
}

/**
 * The Delivery Agent's config-proposal whitelist entry. The LEAD registers
 * this in CONFIG_PROPOSAL_RULES (services/agent-console.ts) with one line:
 *
 *   import { DELIVERY_TRANSIT_RULE } from "./agents/delivery-agent";
 *   CONFIG_PROPOSAL_RULES.push(DELIVERY_TRANSIT_RULE);
 *
 * Approval then writes app_settings['agents.delivery'].transitDaysByState.<STATE>.
 */
export const DELIVERY_TRANSIT_RULE: ConfigParamRule = {
  pattern: /^delivery\.transitDays\.([A-Z]{2,3})$/,
  min: 0,
  max: 10,
  settingKey: DELIVERY_AGENT_SETTING_KEY,
  path: (m) => ['transitDaysByState', m[1]],
};

// ── Shared helpers ───────────────────────────────────────────────────────────

function s(v: unknown): string {
  return v == null ? '' : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function rm(centi: number): string {
  return `RM ${(centi / 100).toFixed(2)}`;
}

/** Whole days from a YMD/ISO to todayYmd (>= 0). */
function daysSince(fromIso: string, todayYmd: string): number {
  if (!fromIso) return 0;
  const from = new Date(fromIso.slice(0, 10) + 'T00:00:00Z').getTime();
  const today = new Date(todayYmd + 'T00:00:00Z').getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((today - from) / 86_400_000));
}

/** Whole-day difference (target − today); null when target is blank/invalid. */
function daysUntil(todayYmd: string, targetIso: string | null | undefined): number | null {
  if (!targetIso) return null;
  const a = new Date(`${todayYmd}T00:00:00Z`).getTime();
  const b = new Date(`${String(targetIso).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** ISO instant N days before now (for timestamptz comparisons). */
function isoAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Working-day steps fromYmd → toYmd (Sundays skipped, cap 30) — HOOKKA parity. */
function transitWorkingDays(fromYmd: string, toYmd: string): number | null {
  if (!fromYmd || !toYmd || toYmd < fromYmd) return null;
  const d = new Date(`${fromYmd}T00:00:00`);
  const end = new Date(`${toYmd}T00:00:00`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime())) return null;
  let steps = 0;
  while (d < end && steps < 30) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) steps++;
  }
  return steps;
}

// ── The planning pool (board-faithful snapshot) ──────────────────────────────

export interface PoolSo {
  docNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  status: string;
  planningState: DeliveryState;
  /** Canonical state code (SEL/KL/…), or 'UNKNOWN' when unresolvable. */
  stateCode: string;
  customerState: string | null;
  /** Primary region tab (first mapped bucket) — proposals bucket on THIS. */
  region: Region;
  regions: Region[];
  /** amended_delivery_date ?? customer_delivery_date (the board's effective date). */
  effectiveDeliveryDate: string | null;
  daysLeft: number | null;
  localTotalCenti: number;
}

interface DeliverySnapshot {
  today: string; // MYT YYYY-MM-DD
  regionCfg: RegionConfig;
  /** Every live SO on the board (all four planning states). */
  pool: PoolSo[];
}

type SoHeaderRow = {
  doc_no: string | null; debtor_code: string | null; debtor_name: string | null;
  status: string | null; delivery_state: string | null;
  customer_state: string | null; customer_country: string | null;
  customer_delivery_date: string | null; amended_delivery_date: string | null;
  processing_date: string | null;
  local_total_centi: number | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadDeliverySnapshot(sb: any): Promise<DeliverySnapshot> {
  const today = todayMyt();
  const regionCfg = await loadRegionConfig(sb);

  /* Live SO headers needing delivery — the board's pool definition verbatim:
     NOT DRAFT/CANCELLED + a delivery-date signal. BASE table only (view-trap:
     delivery_state / amended_delivery_date are NOT in the payment-totals view). */
  const { data: soRowsRaw, error: soErr } = await paginateAll<SoHeaderRow>((from, to) =>
    sb.from('mfg_sales_orders')
      .select('doc_no, debtor_code, debtor_name, status, delivery_state, customer_state, customer_country, customer_delivery_date, amended_delivery_date, processing_date, local_total_centi')
      .neq('status', 'DRAFT')
      .neq('status', 'CANCELLED')
      .order('customer_delivery_date', { ascending: true, nullsFirst: false })
      .range(from, to),
  );
  if (soErr) throw new Error(`delivery-agent pool load failed: ${soErr.message}`);
  const soRows = (soRowsRaw ?? []).filter(
    (r) => r.customer_delivery_date != null || r.processing_date != null,
  );
  const docNos = soRows.map((r) => s(r.doc_no)).filter(Boolean);
  if (docNos.length === 0) return { today, regionCfg, pool: [] };

  /* Per-line readiness (same select shape as the board's step 3). */
  const { data: itemRowsRaw } = await paginateAll<{
    doc_no: string; item_group: string | null; item_code: string | null;
    stock_status: string | null; cancelled: boolean | null;
  }>((from, to) =>
    sb.from('mfg_sales_order_items')
      .select('doc_no, item_group, item_code, stock_status, cancelled')
      .in('doc_no', docNos)
      .eq('cancelled', false)
      .range(from, to),
  );
  /* Catalog category by item_code — isServiceLine's strongest signal, which the
     board also feeds it (see delivery-planning step 3). Bounded .in chunks over
     the codes actually in view, never the whole table. Agent and board must
     classify the same line the same way or their "ready to deliver" pools
     diverge, which is the one thing this module promises they cannot do. */
  const productCategory = new Map<string, string>();
  {
    const codes = [...new Set((itemRowsRaw ?? []).map((it) => it.item_code).filter((x): x is string => !!x))];
    for (let i = 0; i < codes.length; i += 300) {
      const chunk = codes.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: prodRows, error: prodErr } = await paginateAll<{ code: string; category: string | null }>((from, to) =>
        sb.from('mfg_products').select('code, category').in('code', chunk).range(from, to),
      );
      /* Loud, like the pool load above. A discarded failure here reads as "none
         of these codes is a SERVICE", which silently turns delivery fees back
         into short accessories and shrinks the ready pool — a wrong answer that
         looks exactly like a correct one. */
      if (prodErr) throw new Error(`delivery-agent product category load failed: ${prodErr.message}`);
      for (const p of (prodRows ?? [])) {
        if (p.category) productCategory.set(p.code, p.category);
      }
    }
  }
  const linesByDoc = new Map<string, ReadinessLine[]>();
  for (const it of (itemRowsRaw ?? [])) {
    if (!it.doc_no) continue;
    const arr = linesByDoc.get(it.doc_no) ?? [];
    arr.push({
      item_group: it.item_group,
      item_code: it.item_code,
      category: it.item_code ? (productCategory.get(it.item_code) ?? null) : null,
      stock_status: (it.stock_status ?? 'PENDING') as ReadinessLine['stock_status'],
      cancelled: it.cancelled,
    });
    linesByDoc.set(it.doc_no, arr);
  }

  /* Delivery progress per SO (board step 4) — DELIVERED detection. */
  const deliveredByDoc = new Map<string, number>();
  const remainingByDoc = new Map<string, number>();
  const deliverableMap = await soDeliverableRemaining(sb, docNos);
  for (const line of deliverableMap.values()) {
    deliveredByDoc.set(line.docNo, (deliveredByDoc.get(line.docNo) ?? 0) + line.delivered);
    remainingByDoc.set(line.docNo, (remainingByDoc.get(line.docNo) ?? 0) + line.remaining);
  }

  const pool: PoolSo[] = soRows.map((r) => {
    const docNo = s(r.doc_no);
    const readiness = summariseReadiness(linesByDoc.get(docNo) ?? []);
    const effectiveDD = r.amended_delivery_date ?? r.customer_delivery_date;
    const planningState = derivePlanningState({
      storedOverride: r.delivery_state,
      status: r.status,
      readiness,
      delivered: deliveredByDoc.get(docNo) ?? 0,
      remaining: remainingByDoc.get(docNo) ?? 0,
      effectiveDD,
      today,
    });
    const regions = stateToRegions(regionCfg, r.customer_state, r.customer_country);
    return {
      docNo,
      debtorCode: r.debtor_code ?? null,
      debtorName: r.debtor_name ?? null,
      status: s(r.status).toUpperCase(),
      planningState,
      stateCode: resolveStateCode(r.customer_state) ?? resolveStateCode(r.customer_country) ?? 'UNKNOWN',
      customerState: r.customer_state ?? null,
      region: regions[0]!,
      regions,
      effectiveDeliveryDate: effectiveDD ?? null,
      daysLeft: daysUntil(today, effectiveDD),
      localTotalCenti: Math.round(n(r.local_total_centi)),
    };
  });

  return { today, regionCfg, pool };
}

// ── POD gaps ─────────────────────────────────────────────────────────────────

export interface PodGapRow {
  doId: string;
  doNumber: string;
  soDocNo: string | null;
  debtorName: string | null;
  stateCode: string;
  deliveredAt: string;
  daysSinceDelivered: number;
}

/** Chase window: delivered between 90 days and 24 hours ago (bounded so day
 *  one never manufactures an ancient backlog — HOOKKA's 253-row lesson). */
const POD_CHASE_WINDOW_DAYS = 90;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPodGaps(sb: any, today: string): Promise<PodGapRow[]> {
  const { data: rows } = await paginateAll<{
    id: string; do_number: string | null; so_doc_no: string | null;
    debtor_name: string | null; customer_state: string | null;
    delivered_at: string | null; pod_r2_key: string | null; signature_data: string | null;
  }>((from, to) =>
    sb.from('delivery_orders')
      .select('id, do_number, so_doc_no, debtor_name, customer_state, delivered_at, pod_r2_key, signature_data')
      .in('status', ['DELIVERED', 'INVOICED'])
      .not('delivered_at', 'is', null)
      .gte('delivered_at', isoAgo(POD_CHASE_WINDOW_DAYS))
      .lt('delivered_at', isoAgo(1))
      .order('delivered_at', { ascending: true })
      .range(from, to),
  );
  return (rows ?? [])
    .filter((r) => !s(r.pod_r2_key).trim() && !s(r.signature_data).trim())
    .map((r) => {
      const deliveredAt = mytDateOf(s(r.delivered_at));
      return {
        doId: s(r.id),
        doNumber: s(r.do_number),
        soDocNo: r.so_doc_no ?? null,
        debtorName: r.debtor_name ?? null,
        stateCode: resolveStateCode(r.customer_state) ?? 'UNKNOWN',
        deliveredAt,
        daysSinceDelivered: daysSince(deliveredAt, today),
      };
    });
}

// ── Proposal persistence (delivery_agent_proposals, public schema) ───────────

export type DeliveryProposalKind = 'LOAD_PLAN' | 'POD_CHASE';

interface ProposalInsert {
  kind: DeliveryProposalKind;
  /** Dedupe key — an OPEN (PENDING) proposal with the same kind+key blocks re-creation. */
  key: string;
  payload: unknown;
  summary: string;
}

async function openProposalKeys(db: D1Database): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const res = await db
      .prepare("SELECT kind, key FROM delivery_agent_proposals WHERE status = 'PENDING'")
      .all<{ kind: string; key: string }>();
    for (const r of res.results ?? []) keys.add(`${s(r.kind)}\0${s(r.key)}`);
  } catch (e) {
    console.warn('[delivery-agent] open-proposal key read failed:', e);
  }
  return keys;
}

async function insertProposal(db: D1Database, p: ProposalInsert, nowIso: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO delivery_agent_proposals (id, kind, key, status, payload, summary, created_at)
       VALUES (?, ?, ?, 'PENDING', ?::jsonb, ?, ?)`,
    )
    .bind(crypto.randomUUID(), p.kind, p.key, JSON.stringify(p.payload), p.summary, nowIso)
    .run();
}

// ── 1. generateDeliveryProposals ─────────────────────────────────────────────

export interface GenerateDeliveryProposalsResult {
  /** Rows actually inserted. */
  created: number;
  loadPlans: number;
  podChases: number;
  /** Candidates skipped because a PENDING proposal with the same key exists. */
  skippedOpen: number;
}

export async function generateDeliveryProposals(env: Env): Promise<GenerateDeliveryProposalsResult> {
  const sb = getSupabaseService(env);
  const snapshot = await loadDeliverySnapshot(sb);
  return generateDeliveryProposalsCore(env, sb, snapshot);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateDeliveryProposalsCore(
  env: Env,
  sb: any,
  snapshot: DeliverySnapshot,
): Promise<GenerateDeliveryProposalsResult> {
  const db = env.DB;
  const nowIso = new Date().toISOString();
  const settings = await loadDeliverySettings(db);
  const openKeys = await openProposalKeys(db);

  const proposals: ProposalInsert[] = [];

  /* -- LOAD_PLAN: the ready-to-deliver pool (PENDING_SCHEDULE) bucketed by the
        SO's PRIMARY region, one customer's orders grouped together. Proposals
        only — trips get created by the office on the Delivery Planning board. */
  const ready = snapshot.pool.filter((so) => so.planningState === 'PENDING_SCHEDULE');
  const byRegion = new Map<Region, PoolSo[]>();
  for (const so of ready) {
    const arr = byRegion.get(so.region) ?? [];
    arr.push(so);
    byRegion.set(so.region, arr);
  }
  const regionLabel = new Map(
    snapshot.regionCfg.regions.map((r) => [r.key, r.label] as [string, string]),
  );
  for (const [region, sos] of byRegion) {
    const byCustomer = new Map<string, PoolSo[]>();
    for (const so of sos) {
      const custKey = s(so.debtorCode) || s(so.debtorName) || so.docNo;
      const arr = byCustomer.get(custKey) ?? [];
      arr.push(so);
      byCustomer.set(custKey, arr);
    }
    const customers = [...byCustomer.values()]
      .map((group) => ({
        debtorCode: group[0]!.debtorCode,
        debtorName: group[0]!.debtorName,
        state: group[0]!.customerState,
        soCount: group.length,
        valueCenti: group.reduce((sum, x) => sum + x.localTotalCenti, 0),
        sos: group.map((x) => ({
          docNo: x.docNo,
          effectiveDeliveryDate: x.effectiveDeliveryDate,
          daysLeft: x.daysLeft,
          valueCenti: x.localTotalCenti,
        })),
      }))
      // Most date-pressed customer first (dateless customers last). 9999
      // (not Infinity) so two dateless customers compare 0, never NaN.
      .sort((a, b) => {
        const da = Math.min(...a.sos.map((x) => x.daysLeft ?? 9999));
        const db2 = Math.min(...b.sos.map((x) => x.daysLeft ?? 9999));
        return da - db2;
      });
    const valueCenti = sos.reduce((sum, x) => sum + x.localTotalCenti, 0);
    const multi = customers.filter((cu) => cu.soCount > 1).length;
    proposals.push({
      kind: 'LOAD_PLAN',
      key: `LOAD_PLAN:${region}`,
      payload: {
        region,
        regionLabel: regionLabel.get(region) ?? region,
        date: snapshot.today,
        soCount: sos.length,
        customerCount: customers.length,
        valueCenti,
        customers,
      },
      summary:
        `Load plan ${regionLabel.get(region) ?? region}: ${sos.length} ready-to-deliver SO(s) across ` +
        `${customers.length} customer(s), worth ${rm(valueCenti)}` +
        (multi > 0 ? ` (${multi} customer(s) with multiple orders — keep each customer's orders on one trip)` : '') +
        `. Proposal only — schedule the trip(s) on the Delivery Planning board.`,
    });
  }

  /* -- POD_CHASE: delivered >24h with neither POD photo nor signature. */
  if (settings.podChase) {
    const gaps = await loadPodGaps(sb, snapshot.today);
    for (const g of gaps) {
      proposals.push({
        kind: 'POD_CHASE',
        key: `POD_CHASE:${g.doNumber || g.doId}`,
        payload: { ...g },
        summary:
          `${g.doNumber || g.doId}${g.debtorName ? ` (${g.debtorName})` : ''} was marked delivered ` +
          `${g.deliveredAt} but has no POD photo or signature after ${g.daysSinceDelivered} day(s). ` +
          `Chase the delivery crew for the POD.`,
      });
    }
  }

  /* Insert with dedupe: an OPEN (PENDING) proposal with the same kind+key is
     never re-created — decided (APPROVED/REJECTED/EXPIRED) rows don't block. */
  let created = 0;
  let loadPlans = 0;
  let podChases = 0;
  let skippedOpen = 0;
  for (const p of proposals) {
    if (openKeys.has(`${p.kind}\0${p.key}`)) {
      skippedOpen++;
      continue;
    }
    await insertProposal(db, p, nowIso);
    openKeys.add(`${p.kind}\0${p.key}`);
    created++;
    if (p.kind === 'LOAD_PLAN') loadPlans++;
    else podChases++;
  }

  return { created, loadPlans, podChases, skippedOpen };
}

// ── 2. collectDeliveryBrief ──────────────────────────────────────────────────

export interface TripBriefRow {
  tripNo: string;
  tripDate: string;
  tripType: string;
  status: string;
  driver: string | null;
  helpers: string[];
  lorryPlate: string | null;
  isOutsourced: boolean;
  stopCount: number;
}

export interface DeliveryBriefData {
  date: string; // MYT
  generatedAt: string; // ISO
  pendingPool: {
    total: number;
    byPlanningState: Record<DeliveryState, number>;
    /** Ready-to-deliver (PENDING_SCHEDULE) buckets, largest value first. */
    readyByRegion: Array<{ region: string; label: string; count: number; customers: number; valueCenti: number }>;
    /** Ready-to-deliver by canonical customer-state code (SEL/KL/…/UNKNOWN). */
    readyByState: Array<{ stateCode: string; count: number; valueCenti: number }>;
  };
  overdueToDeliver: {
    count: number;
    rows: Array<{
      docNo: string; debtorName: string | null; region: string;
      effectiveDeliveryDate: string | null; daysLeft: number | null; valueCenti: number;
    }>;
  };
  doPipeline: { byStatus: Record<string, number> };
  podGaps: { count: number; rows: PodGapRow[] };
  trips: { today: TripBriefRow[]; tomorrow: TripBriefRow[] };
  openProposals: { total: number; byKind: Record<string, number> };
}

/* The DO lifecycle — pipeline buckets. IMPORTED from the state machine's own
   declaration (scm/shared/do-shipped-states.ts, which delivery-orders-mfg.ts
   reads for its PATCH status guard), because the copy that used to sit here had
   quietly lost COMPLETED: the pipeline counted eight of the nine legal statuses
   and reported the missing bucket as absent rather than as uncounted. */
const DO_STATUSES: readonly string[] = SHARED_DO_STATUSES;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collectDoStatusCounts(sb: any): Promise<Record<string, number>> {
  const byStatus: Record<string, number> = {};
  await Promise.all(
    DO_STATUSES.map(async (st) => {
      try {
        const { count } = await sb
          .from('delivery_orders')
          .select('id', { head: true, count: 'exact' })
          .eq('status', st);
        if ((count ?? 0) > 0) byStatus[st] = count ?? 0;
      } catch { /* best-effort section */ }
    }),
  );
  return byStatus;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadTripsFor(sb: any, dates: string[]): Promise<Map<string, TripBriefRow[]>> {
  const out = new Map<string, TripBriefRow[]>();
  for (const d of dates) out.set(d, []);
  const { data: trips } = await paginateAll<{
    id: string; trip_no: string | null; trip_date: string | null;
    trip_type: string | null; status: string | null; is_outsourced: boolean | null;
    driver_id: string | null; helper_1_id: string | null; helper_2_id: string | null;
    lorry_id: string | null;
  }>((from, to) =>
    sb.from('trips')
      .select('id, trip_no, trip_date, trip_type, status, is_outsourced, driver_id, helper_1_id, helper_2_id, lorry_id')
      .in('trip_date', dates)
      .neq('status', 'CANCELLED')
      .order('trip_date', { ascending: true })
      .range(from, to),
  );
  const rows = trips ?? [];
  if (rows.length === 0) return out;

  const driverIds = [...new Set(rows.map((t) => s(t.driver_id)).filter(Boolean))];
  const helperIds = [...new Set(rows.flatMap((t) => [s(t.helper_1_id), s(t.helper_2_id)]).filter(Boolean))];
  const lorryIds = [...new Set(rows.map((t) => s(t.lorry_id)).filter(Boolean))];
  const tripIds = rows.map((t) => t.id);

  const driverName = new Map<string, string>();
  const helperName = new Map<string, string>();
  const lorryPlate = new Map<string, string>();
  const stopCount = new Map<string, number>();
  await Promise.all([
    (async () => {
      if (driverIds.length === 0) return;
      const { data } = await sb.from('drivers').select('id, name').in('id', driverIds);
      for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) driverName.set(r.id, s(r.name));
    })(),
    (async () => {
      if (helperIds.length === 0) return;
      const { data } = await sb.from('helpers').select('id, name').in('id', helperIds);
      for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) helperName.set(r.id, s(r.name));
    })(),
    (async () => {
      if (lorryIds.length === 0) return;
      const { data } = await sb.from('lorries').select('id, plate').in('id', lorryIds);
      for (const r of (data ?? []) as Array<{ id: string; plate: string | null }>) lorryPlate.set(r.id, s(r.plate));
    })(),
    (async () => {
      const { data } = await paginateAll<{ trip_id: string }>((from, to) =>
        sb.from('trip_stops').select('trip_id').in('trip_id', tripIds).range(from, to),
      );
      for (const r of (data ?? [])) stopCount.set(r.trip_id, (stopCount.get(r.trip_id) ?? 0) + 1);
    })(),
  ]);

  for (const t of rows) {
    const date = s(t.trip_date).slice(0, 10);
    const arr = out.get(date);
    if (!arr) continue;
    arr.push({
      tripNo: s(t.trip_no),
      tripDate: date,
      tripType: s(t.trip_type) || 'DELIVERY',
      status: s(t.status) || 'PLANNED',
      driver: t.driver_id ? (driverName.get(s(t.driver_id)) || null) : null,
      helpers: [t.helper_1_id, t.helper_2_id]
        .map((h) => (h ? helperName.get(s(h)) : undefined))
        .filter((x): x is string => Boolean(x)),
      lorryPlate: t.lorry_id ? (lorryPlate.get(s(t.lorry_id)) || null) : null,
      isOutsourced: t.is_outsourced === true,
      stopCount: stopCount.get(t.id) ?? 0,
    });
  }
  return out;
}

async function openProposalCounts(db: D1Database): Promise<{ total: number; byKind: Record<string, number> }> {
  const byKind: Record<string, number> = {};
  let total = 0;
  try {
    const res = await db
      .prepare(
        "SELECT kind, COUNT(*) AS n FROM delivery_agent_proposals WHERE status = 'PENDING' GROUP BY kind",
      )
      .all<{ kind: string; n: number | string }>();
    for (const r of res.results ?? []) {
      const c = n(r.n);
      byKind[s(r.kind) || 'UNKNOWN'] = c;
      total += c;
    }
  } catch { /* table empty / pre-migration — zeros */ }
  return { total, byKind };
}

export async function collectDeliveryBrief(env: Env): Promise<DeliveryBriefData> {
  const sb = getSupabaseService(env);
  const snapshot = await loadDeliverySnapshot(sb);
  return collectDeliveryBriefCore(env, sb, snapshot);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collectDeliveryBriefCore(
  env: Env,
  sb: any,
  snapshot: DeliverySnapshot,
): Promise<DeliveryBriefData> {
  const db = env.DB;
  const today = snapshot.today;
  const tomorrow = todayMyt(1);

  const [byStatus, podGaps, tripsByDate, openProposals] = await Promise.all([
    collectDoStatusCounts(sb),
    loadPodGaps(sb, today).catch((e) => {
      console.error('[delivery-agent] podGaps failed:', e);
      return [] as PodGapRow[];
    }),
    loadTripsFor(sb, [today, tomorrow]).catch((e) => {
      console.error('[delivery-agent] trips failed:', e);
      return new Map<string, TripBriefRow[]>();
    }),
    openProposalCounts(db),
  ]);

  const byPlanningState: Record<DeliveryState, number> = {
    PENDING_DELIVERY: 0, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: 0,
  };
  for (const so of snapshot.pool) byPlanningState[so.planningState] += 1;

  /* Ready pool by region — largest value first. */
  const regionLabel = new Map(
    snapshot.regionCfg.regions.map((r) => [r.key, r.label] as [string, string]),
  );
  const regionAgg = new Map<string, { count: number; valueCenti: number; customers: Set<string> }>();
  for (const so of snapshot.pool) {
    if (so.planningState !== 'PENDING_SCHEDULE') continue;
    const agg = regionAgg.get(so.region) ?? { count: 0, valueCenti: 0, customers: new Set<string>() };
    agg.count += 1;
    agg.valueCenti += so.localTotalCenti;
    agg.customers.add(s(so.debtorCode) || s(so.debtorName) || so.docNo);
    regionAgg.set(so.region, agg);
  }
  const readyByRegion = [...regionAgg.entries()]
    .map(([region, a]) => ({
      region,
      label: regionLabel.get(region) ?? region,
      count: a.count,
      customers: a.customers.size,
      valueCenti: a.valueCenti,
    }))
    .sort((a, b) => b.valueCenti - a.valueCenti);

  const stateAgg = new Map<string, { count: number; valueCenti: number }>();
  for (const so of snapshot.pool) {
    if (so.planningState !== 'PENDING_SCHEDULE') continue;
    const agg = stateAgg.get(so.stateCode) ?? { count: 0, valueCenti: 0 };
    agg.count += 1;
    agg.valueCenti += so.localTotalCenti;
    stateAgg.set(so.stateCode, agg);
  }
  const readyByState = [...stateAgg.entries()]
    .map(([stateCode, a]) => ({ stateCode, count: a.count, valueCenti: a.valueCenti }))
    .sort((a, b) => b.valueCenti - a.valueCenti);

  /* Overdue-to-deliver: the board's OVERDUE bucket (not ready + inside the
     3-day window / past the effective date), most negative days-left first. */
  const overdueRows = snapshot.pool
    .filter((so) => so.planningState === 'OVERDUE')
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
    .map((so) => ({
      docNo: so.docNo,
      debtorName: so.debtorName,
      region: so.region,
      effectiveDeliveryDate: so.effectiveDeliveryDate,
      daysLeft: so.daysLeft,
      valueCenti: so.localTotalCenti,
    }));

  const brief: DeliveryBriefData = {
    date: today,
    generatedAt: new Date().toISOString(),
    pendingPool: {
      total: snapshot.pool.length,
      byPlanningState,
      readyByRegion,
      readyByState,
    },
    overdueToDeliver: { count: overdueRows.length, rows: overdueRows.slice(0, 20) },
    doPipeline: { byStatus },
    podGaps: { count: podGaps.length, rows: podGaps.slice(0, 20) },
    trips: {
      today: tripsByDate.get(today) ?? [],
      tomorrow: tripsByDate.get(tomorrow) ?? [],
    },
    openProposals,
  };

  /* Snapshot row — ai_focus stays NULL here; the lead's brain call fills it. */
  try {
    await db
      .prepare(
        'INSERT INTO delivery_agent_briefs (id, brief, ai_focus, created_at) VALUES (?, ?::jsonb, NULL, ?)',
      )
      .bind(crypto.randomUUID(), JSON.stringify(brief), brief.generatedAt)
      .run();
  } catch (e) {
    console.warn('[delivery-agent] brief snapshot insert failed:', e);
  }

  return brief;
}

// ── 3. deliveryLearning (per-state transit drift) ────────────────────────────

export interface TransitConfigProposal {
  /** Config-proposal key, e.g. 'delivery.transitDays.SEL' (matches DELIVERY_TRANSIT_RULE). */
  key: string;
  current: number;
  proposed: number;
  reason: string;
}

export interface TransitLearningFinding {
  stateCode: string;
  samples: number;
  configuredDays: number;
  actualAvgDays: number;
  driftDays: number;
  flagged: boolean;
  /** Set only when flagged — the lead feeds these into config_proposals. */
  proposal: TransitConfigProposal | null;
}

const LEARNING_WINDOW_DAYS = 90;
const LEARNING_MIN_SAMPLES = 5;

/**
 * Per-state ACTUAL dispatch→delivered working days over the last 90 days vs
 * the configured allowance (app_settings['agents.delivery'].transitDaysByState,
 * default 3). Drift ≥1 working day over ≥5 deliveries flags the state and
 * carries a proposed config change. PURE: reads only, never writes — the
 * lead wires flagged proposals into the skeleton's config_proposals.
 */
export async function deliveryLearning(env: Env): Promise<TransitLearningFinding[]> {
  const sb = getSupabaseService(env);
  const settings = await loadDeliverySettings(env.DB);

  const { data: rows } = await paginateAll<{
    customer_state: string | null; dispatched_at: string | null; delivered_at: string | null;
  }>((from, to) =>
    sb.from('delivery_orders')
      .select('customer_state, dispatched_at, delivered_at')
      .in('status', ['DELIVERED', 'INVOICED'])
      .not('dispatched_at', 'is', null)
      .not('delivered_at', 'is', null)
      .gte('delivered_at', isoAgo(LEARNING_WINDOW_DAYS))
      .range(from, to),
  );

  const byState = new Map<string, { total: number; samples: number }>();
  for (const r of (rows ?? [])) {
    const stateCode = resolveStateCode(r.customer_state);
    if (!stateCode) continue;
    const days = transitWorkingDays(mytDateOf(s(r.dispatched_at)), mytDateOf(s(r.delivered_at)));
    if (days == null) continue;
    const agg = byState.get(stateCode) ?? { total: 0, samples: 0 };
    agg.total += days;
    agg.samples += 1;
    byState.set(stateCode, agg);
  }

  const findings: TransitLearningFinding[] = [];
  for (const [stateCode, agg] of byState) {
    if (agg.samples < LEARNING_MIN_SAMPLES) continue; // too thin to learn from
    const actualAvg = Math.round((agg.total / agg.samples) * 10) / 10;
    const configured = settings.transitDaysByState[stateCode] ?? settings.defaultTransitDays;
    const drift = Math.round(actualAvg) - configured;
    const flagged = Math.abs(drift) >= 1;
    const proposed = Math.max(0, Math.min(10, Math.round(actualAvg)));
    findings.push({
      stateCode,
      samples: agg.samples,
      configuredDays: configured,
      actualAvgDays: actualAvg,
      driftDays: drift,
      flagged,
      proposal: flagged
        ? {
            key: `delivery.transitDays.${stateCode}`,
            current: configured,
            proposed,
            reason:
              `${stateCode}: actual dispatch->delivered avg ${actualAvg} working days over ` +
              `${agg.samples} deliveries (last ${LEARNING_WINDOW_DAYS}d) vs configured ${configured} — ` +
              `drift ${drift > 0 ? '+' : ''}${drift}d`,
          }
        : null,
    });
  }
  findings.sort((a, b) => Math.abs(b.driftDays) - Math.abs(a.driftDays));
  return findings;
}

// ── 4. runDeliveryAgent (orchestrator) ───────────────────────────────────────

export interface RunDeliveryAgentResult {
  /** One-line human-readable result for the run summary. */
  summary: string;
  brief: DeliveryBriefData;
  proposalsCreated: number;
  /** Flagged transit-drift config changes — the lead wires these into config_proposals. */
  learning: TransitConfigProposal[];
}

export async function runDeliveryAgent(env: Env): Promise<RunDeliveryAgentResult> {
  const sb = getSupabaseService(env);
  const snapshot = await loadDeliverySnapshot(sb);

  const gen = await generateDeliveryProposalsCore(env, sb, snapshot);
  const brief = await collectDeliveryBriefCore(env, sb, snapshot);
  const findings = await deliveryLearning(env).catch((e) => {
    console.error('[delivery-agent] learning failed:', e);
    return [] as TransitLearningFinding[];
  });
  const learning = findings
    .map((f) => f.proposal)
    .filter((p): p is TransitConfigProposal => p != null);

  const summary =
    `Delivery: pool ${brief.pendingPool.total} SO(s) ` +
    `(${brief.pendingPool.byPlanningState.PENDING_SCHEDULE} ready, ` +
    `${brief.pendingPool.byPlanningState.OVERDUE} overdue), ` +
    `created ${gen.created} proposal(s) (${gen.loadPlans} load plan, ${gen.podChases} POD chase` +
    (gen.skippedOpen > 0 ? `, ${gen.skippedOpen} already open` : '') +
    `), ${brief.podGaps.count} POD gap(s), ` +
    `${brief.trips.today.length} trip(s) today, ${learning.length} transit-drift finding(s)`;

  return { summary, brief, proposalsCreated: gen.created, learning };
}

// ── 5. deliveryAgentStatus (console card counters) ───────────────────────────

export interface DeliveryAgentStatus {
  openProposals: number;
  openByKind: Record<string, number>;
  /** created_at of the newest brief snapshot, or null before the first run. */
  lastBriefAt: string | null;
}

export async function deliveryAgentStatus(env: Env): Promise<DeliveryAgentStatus> {
  const db = env.DB;
  const { total, byKind } = await openProposalCounts(db);
  let lastBriefAt: string | null = null;
  try {
    const r = await db
      .prepare('SELECT MAX(created_at) AS last FROM delivery_agent_briefs')
      .first<{ last?: string | null }>();
    lastBriefAt = r?.last ?? null;
  } catch { /* pre-migration — null */ }
  return { openProposals: total, openByKind: byKind, lastBriefAt };
}
