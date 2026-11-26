
import type { Env } from '../../types';
import { getSupabaseService } from '../../db/supabase';
import { chunkIn, paginateAll } from '../../scm/lib/paginate-all';
import { tallyStatusRows, type StatusTally } from '../../scm/lib/status-counts';
import { todayMyt, mytDateOf } from '../../scm/lib/my-time';
import { effectiveSoDelivery } from '../../scm/shared';
import { summariseReadiness, type ReadinessLine } from '../../scm/lib/so-readiness';
import { resolveLineCategories } from '../../scm/lib/so-readiness-category';
import { derivePlanningState, type DeliveryState } from '../../scm/routes/delivery-planning';
import { loadAcExemptionExpiryByDoc } from '../../scm/lib/ac-exemption-expiry';
import { soExemptionExpiryOf } from '../../scm/lib/so-exemption-expiry';
import { soDeliverableRemaining } from '../../scm/routes/delivery-orders-mfg';
import { readAgentSetting, type ConfigParamRule } from '../agent-console';
import {
  loadRegionConfig,
  stateToRegions,
  resolveStateCode,
  type Region,
  type RegionConfig,
} from './delivery-agent-geo';
import { fmtSen } from '../../scm/shared/format';


export const DELIVERY_AGENT_SETTING_KEY = 'agents.delivery';

/** Working-day allowance assumed for a state with no configured value. */
export const DEFAULT_TRANSIT_DAYS = 3;

export interface DeliveryAgentSettings {
  transitDaysByState?: Record<string, number>;
  defaultTransitDays?: number;
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
    podChase: raw.podChase !== false,
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


function s(v: unknown): string {
  return v == null ? '' : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function rm(centi: number): string {
  return `${fmtSen(centi)}`;
}

function daysSince(fromIso: string, todayYmd: string): number {
  if (!fromIso) return 0;
  const from = new Date(fromIso.slice(0, 10) + 'T00:00:00Z').getTime();
  const today = new Date(todayYmd + 'T00:00:00Z').getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((today - from) / 86_400_000));
}

function daysUntil(todayYmd: string, targetIso: string | null | undefined): number | null {
  if (!targetIso) return null;
  const a = new Date(`${todayYmd}T00:00:00Z`).getTime();
  const b = new Date(`${String(targetIso).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function isoAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

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


export interface PoolSo {
  docNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  status: string;
  planningState: DeliveryState;
  stateCode: string;
  customerState: string | null;
  region: Region;
  regions: Region[];
  effectiveDeliveryDate: string | null;
  daysLeft: number | null;
  localTotalSen: number;
}

interface DeliverySnapshot {
  today: string;
  regionCfg: RegionConfig;
  pool: PoolSo[];
}

type SoHeaderRow = {
  doc_no: string | null; debtor_code: string | null; debtor_name: string | null;
  status: string | null; delivery_state: string | null;
  customer_state: string | null; customer_country: string | null;
  customer_delivery_date: string | null; amended_delivery_date: string | null;
  processing_date: string | null; sales_exemption_expiry: string | null; linked_ac_docno: string | null;
  local_total_sen: number | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadDeliverySnapshot(sb: any): Promise<DeliverySnapshot> {
  const today = todayMyt();
  const regionCfg = await loadRegionConfig(sb);

  const { data: soRowsRaw, error: soErr } = await paginateAll<SoHeaderRow>((from, to) =>
    sb.from('mfg_sales_orders')
      .select('doc_no, debtor_code, debtor_name, status, delivery_state, customer_state, customer_country, customer_delivery_date, amended_delivery_date, processing_date, sales_exemption_expiry, linked_ac_docno, local_total_sen')
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

  const { data: itemRowsRaw } = await chunkIn<{
    doc_no: string; item_group: string | null; item_code: string | null;
    stock_status: string | null; cancelled: boolean | null;
  }>(docNos, (batch, from, to) =>
    sb.from('mfg_sales_order_items')
      .select('doc_no, item_group, item_code, stock_status, cancelled')
      .in('doc_no', batch)
      .eq('cancelled', false)
      .order('doc_no')
      .range(from, to),
  );
  const linesByDoc = new Map<string, ReadinessLine[]>();
  for (const it of itemRowsRaw) {
    if (!it.doc_no) continue;
    const arr = linesByDoc.get(it.doc_no) ?? [];
    arr.push({
      item_group: it.item_group,
      item_code: it.item_code,
      stock_status: (it.stock_status ?? 'PENDING') as ReadinessLine['stock_status'],
      cancelled: it.cancelled,
    });
    linesByDoc.set(it.doc_no, arr);
  }
  const { error: catErr } = await resolveLineCategories(sb, linesByDoc.values());
  if (catErr) throw new Error(`delivery-agent product category load failed: ${catErr.message}`);

  const deliveredByDoc = new Map<string, number>();
  const remainingByDoc = new Map<string, number>();
  const deliverableMap = await soDeliverableRemaining(sb, docNos);
  for (const line of deliverableMap.values()) {
    deliveredByDoc.set(line.docNo, (deliveredByDoc.get(line.docNo) ?? 0) + line.delivered);
    remainingByDoc.set(line.docNo, (remainingByDoc.get(line.docNo) ?? 0) + line.remaining);
  }

  const acExpiryByDoc = await loadAcExemptionExpiryByDoc(sb, { get: () => undefined }, soRows);

  const pool: PoolSo[] = soRows.map((r) => {
    const docNo = s(r.doc_no);
    const readiness = summariseReadiness(linesByDoc.get(docNo) ?? []);
    const effectiveDD = effectiveSoDelivery(r);
    const planningState = derivePlanningState({
      storedOverride: r.delivery_state,
      status: r.status,
      readiness,
      delivered: deliveredByDoc.get(docNo) ?? 0,
      remaining: remainingByDoc.get(docNo) ?? 0,
      effectiveDD,
      amendedDD: r.amended_delivery_date ?? null,
      salesExemptionExpiry: soExemptionExpiryOf({
        sales_exemption_expiry: r.sales_exemption_expiry, ac_sales_exemption_expiry: acExpiryByDoc.get(docNo) ?? null, customer_delivery_date: r.customer_delivery_date,
      }),
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
      localTotalSen: Math.round(n(r.local_total_sen)),
    };
  });

  return { today, regionCfg, pool };
}


export interface PodGapRow {
  doId: string;
  doNumber: string;
  soDocNo: string | null;
  debtorName: string | null;
  stateCode: string;
  deliveredAt: string;
  daysSinceDelivered: number;
}

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


export type DeliveryProposalKind = 'LOAD_PLAN' | 'POD_CHASE';

interface ProposalInsert {
  kind: DeliveryProposalKind;
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
       VALUES (?, ?, ?, 'PENDING', ?::text::jsonb, ?, ?)`,
    )
    .bind(crypto.randomUUID(), p.kind, p.key, JSON.stringify(p.payload), p.summary, nowIso)
    .run();
}


export interface GenerateDeliveryProposalsResult {
  created: number;
  loadPlans: number;
  podChases: number;
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
        valueSen: group.reduce((sum, x) => sum + x.localTotalSen, 0),
        sos: group.map((x) => ({
          docNo: x.docNo,
          effectiveDeliveryDate: x.effectiveDeliveryDate,
          daysLeft: x.daysLeft,
          valueSen: x.localTotalSen,
        })),
      }))
      .sort((a, b) => {
        const da = Math.min(...a.sos.map((x) => x.daysLeft ?? 9999));
        const db2 = Math.min(...b.sos.map((x) => x.daysLeft ?? 9999));
        return da - db2;
      });
    const valueSen = sos.reduce((sum, x) => sum + x.localTotalSen, 0);
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
        valueSen,
        customers,
      },
      summary:
        `Load plan ${regionLabel.get(region) ?? region}: ${sos.length} ready-to-deliver SO(s) across ` +
        `${customers.length} customer(s), worth ${rm(valueSen)}` +
        (multi > 0 ? ` (${multi} customer(s) with multiple orders — keep each customer's orders on one trip)` : '') +
        `. Proposal only — schedule the trip(s) on the Delivery Planning board.`,
    });
  }

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
  date: string;
  generatedAt: string;
  pendingPool: {
    total: number;
    byPlanningState: Record<DeliveryState, number>;
    readyByRegion: Array<{ region: string; label: string; count: number; customers: number; valueSen: number }>;
    readyByState: Array<{ stateCode: string; count: number; valueSen: number }>;
  };
  overdueToDeliver: {
    count: number;
    rows: Array<{
      docNo: string; debtorName: string | null; region: string;
      effectiveDeliveryDate: string | null; daysLeft: number | null; valueSen: number;
    }>;
  };
  doPipeline: { byStatus: Record<string, number>; unavailableReason: string | null };
  podGaps: { count: number; rows: PodGapRow[] };
  trips: { today: TripBriefRow[]; tomorrow: TripBriefRow[] };
  openProposals: { total: number; byKind: Record<string, number> };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function collectDoStatusCounts(sb: any): Promise<StatusTally> {
  try {
    return tallyStatusRows(
      await paginateAll<{ status: string | null }>((from, to) =>
        sb.from('delivery_orders').select('status').range(from, to)),
      () => 1,
    );
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
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
  } catch { }
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

  const [doCounts, podGaps, tripsByDate, openProposals] = await Promise.all([
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
  if (!doCounts.ok) console.error('[delivery-agent] DO pipeline counts failed:', doCounts.reason);

  const byPlanningState: Record<DeliveryState, number> = {
    PENDING_DELIVERY: 0, PENDING_SCHEDULE: 0, OVERDUE: 0, DELIVERED: 0,
  };
  for (const so of snapshot.pool) byPlanningState[so.planningState] += 1;

  const regionLabel = new Map(
    snapshot.regionCfg.regions.map((r) => [r.key, r.label] as [string, string]),
  );
  const regionAgg = new Map<string, { count: number; valueSen: number; customers: Set<string> }>();
  for (const so of snapshot.pool) {
    if (so.planningState !== 'PENDING_SCHEDULE') continue;
    const agg = regionAgg.get(so.region) ?? { count: 0, valueSen: 0, customers: new Set<string>() };
    agg.count += 1;
    agg.valueSen += so.localTotalSen;
    agg.customers.add(s(so.debtorCode) || s(so.debtorName) || so.docNo);
    regionAgg.set(so.region, agg);
  }
  const readyByRegion = [...regionAgg.entries()]
    .map(([region, a]) => ({
      region,
      label: regionLabel.get(region) ?? region,
      count: a.count,
      customers: a.customers.size,
      valueSen: a.valueSen,
    }))
    .sort((a, b) => b.valueSen - a.valueSen);

  const stateAgg = new Map<string, { count: number; valueSen: number }>();
  for (const so of snapshot.pool) {
    if (so.planningState !== 'PENDING_SCHEDULE') continue;
    const agg = stateAgg.get(so.stateCode) ?? { count: 0, valueSen: 0 };
    agg.count += 1;
    agg.valueSen += so.localTotalSen;
    stateAgg.set(so.stateCode, agg);
  }
  const readyByState = [...stateAgg.entries()]
    .map(([stateCode, a]) => ({ stateCode, count: a.count, valueSen: a.valueSen }))
    .sort((a, b) => b.valueSen - a.valueSen);

  const overdueRows = snapshot.pool
    .filter((so) => so.planningState === 'OVERDUE')
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
    .map((so) => ({
      docNo: so.docNo,
      debtorName: so.debtorName,
      region: so.region,
      effectiveDeliveryDate: so.effectiveDeliveryDate,
      daysLeft: so.daysLeft,
      valueSen: so.localTotalSen,
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
    doPipeline: doCounts.ok
      ? { byStatus: doCounts.byStatus, unavailableReason: null }
      : { byStatus: {}, unavailableReason: doCounts.reason },
    podGaps: { count: podGaps.length, rows: podGaps.slice(0, 20) },
    trips: {
      today: tripsByDate.get(today) ?? [],
      tomorrow: tripsByDate.get(tomorrow) ?? [],
    },
    openProposals,
  };

  try {
    await db
      .prepare(
        'INSERT INTO delivery_agent_briefs (id, brief, ai_focus, created_at) VALUES (?, ?::text::jsonb, NULL, ?)',
      )
      .bind(crypto.randomUUID(), JSON.stringify(brief), brief.generatedAt)
      .run();
  } catch (e) {
    console.warn('[delivery-agent] brief snapshot insert failed:', e);
  }

  return brief;
}


export interface TransitConfigProposal {
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
    if (agg.samples < LEARNING_MIN_SAMPLES) continue;
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


export interface RunDeliveryAgentResult {
  summary: string;
  brief: DeliveryBriefData;
  proposalsCreated: number;
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


export interface DeliveryAgentStatus {
  openProposals: number;
  openByKind: Record<string, number>;
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
  } catch { }
  return { openProposals: total, openByKind: byKind, lastBriefAt };
}
