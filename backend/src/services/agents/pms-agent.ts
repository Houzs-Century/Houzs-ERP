// ---------------------------------------------------------------------------
// pms-agent.ts — the Houzs PMS (Roadshow / Project) Agent ENGINE (deterministic,
// pure). The owner: "PMS agent 就是 roadshow/project agent." It runs two jobs on
// opposite sides of a hard red line:
//
//   Job A — SALES ANALYTICS BRIEF (READ-ONLY). A daily multi-dimensional cut of
//     the SCM sales-order header — by category, brand, customer-state,
//     salesperson and venue, plus a salesperson-by-state cross that answers the
//     owner's "which salesperson does especially well in which state." It reads
//     ONLY the SO header (no fragile cross-DB join) and writes ONE
//     pms_agent_briefs snapshot per run. It NEVER proposes anything.
//     A PER-DIMENSION DATA-READINESS GATE rides along: salesperson_id / venue_id
//     are sparsely populated on historical SOs, so each of {salesperson, venue,
//     brand, state} carries its fill-rate + a `gated` flag when coverage is
//     below the configured floor. Gated dimensions keep their rows — the console
//     just shows "coverage too low to trust — assign salespeople / venues first."
//
//   Job B — PROJECT-LIFECYCLE CHASE (PROPOSAL-ONLY). A confirmed/active project
//     whose end_date is past but whose stage was never moved to teardown /
//     closed / cancelled becomes a PROJECT_CHASE proposal. This engine never
//     edits a project or contacts anyone — it writes ONLY pms_agent_proposals.
//     The WHOLE job is wrapped in try/catch so any projects-table column drift
//     can never sink Job A.
//
// RED LINES (enforced structurally):
//   - Job A is READ-ONLY (brief snapshot only); Job B is PROPOSAL-ONLY. Neither
//     mutates any scm.* or projects row, and neither contacts a customer.
//   - Deterministic — no LLM calls, no invented numbers. The ai_focus paragraph
//     over the brief is the lead's shared-brain pass, stored later (NULL here).
//   - Money is integer sen end-to-end (scm columns are *_centi = sen; payloads /
//     brief expose them as *Sen).
//
// DB access, following house patterns:
//   - scm tables (mfg_sales_orders, staff, venues) → getSupabaseService(env)
//     (PostgREST, schema:'scm', snake_case columns verbatim — no dual-read).
//   - public tables (projects, pms_agent_*) → env.DB (the d1-compat shim over
//     postgres.js). Rows read off env.DB are dual-keyed r.camelCase ?? r.snake_case
//     defensively, matching the other agent engines.
// ---------------------------------------------------------------------------

import type { Env } from '../../types';
import { getSupabaseService } from '../../db/supabase';
import { paginateAll } from '../../scm/lib/paginate-all';
import { todayMyt } from '../../scm/lib/my-time';
import { readAgentSetting } from '../agent-console';
import { resolveStateCode } from './delivery-agent-geo';

// ── Config (app_settings['agents.pms']) ──────────────────────────────────────

export const PMS_AGENT_SETTING_KEY = 'agents.pms';

/** Analytics look-back window when unset (days). Clamped 30..1095. */
const DEFAULT_ANALYTICS_WINDOW_DAYS = 365;
const MIN_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 1095;

/** A dimension whose fill-rate is below this % is flagged `gated`. Clamped 0..100. */
const DEFAULT_MIN_COVERAGE_PCT = 90;

/** Cap every dimension array so a brief JSON stays bounded. */
const DIM_CAP = 20;
/** Cap the salesperson-by-state cross cells. */
const CROSS_CAP = 15;

interface PmsSettings {
  analyticsWindowDays: number;
  minCoveragePct: number;
}

async function loadPmsSettings(db: D1Database): Promise<PmsSettings> {
  const raw = (await readAgentSetting<Record<string, unknown>>(db, PMS_AGENT_SETTING_KEY)) ?? {};
  const w = Number(raw.analyticsWindowDays);
  const c = Number(raw.minCoveragePct);
  return {
    analyticsWindowDays: Number.isFinite(w)
      ? Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.floor(w)))
      : DEFAULT_ANALYTICS_WINDOW_DAYS,
    minCoveragePct: Number.isFinite(c)
      ? Math.min(100, Math.max(0, Math.floor(c)))
      : DEFAULT_MIN_COVERAGE_PCT,
  };
}

// ── Small helpers ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function s(v: unknown): string {
  return v == null ? '' : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function col(r: Row, camel: string, snake: string): unknown {
  return r[camel] ?? r[snake];
}
function rm(sen: number): string {
  return `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** marginSen / revenueSen * 100, one decimal place, divide-by-zero guarded. */
function marginPctOf(revenueSen: number, marginSen: number): number {
  if (revenueSen === 0) return 0;
  return Math.round((marginSen / revenueSen) * 1000) / 10;
}
/** Whole days from a YMD/ISO date to todayYmd (>= 0). */
function daysSinceYmd(fromIso: string, todayYmd: string): number {
  if (!fromIso) return 0;
  const from = new Date(`${fromIso.slice(0, 10)}T00:00:00Z`).getTime();
  const today = new Date(`${todayYmd}T00:00:00Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(today)) return 0;
  return Math.max(0, Math.floor((today - from) / 86_400_000));
}

// ── Public shapes (the integrator consumes these) ────────────────────────────

export type DimRow = {
  label: string;
  soCount: number;
  revenueSen: number;
  costSen: number;
  marginSen: number;
  marginPct: number;
};

export type GatedDim = {
  /** % of in-window SOs that have this dimension populated. */
  fillRatePct: number;
  /** true when fillRatePct < minCoveragePct — surface but don't trust. */
  gated: boolean;
  rows: DimRow[];
};

export interface PmsBriefData {
  generatedAt: string;
  windowDays: number;
  soCount: number;
  totals: { revenueSen: number; costSen: number; marginSen: number; marginPct: number };
  byCategory: DimRow[];
  byBrand: GatedDim;
  byState: GatedDim;
  bySalesperson: GatedDim;
  byVenue: GatedDim;
  salespersonByState: Array<{
    salesperson: string;
    stateCode: string;
    soCount: number;
    revenueSen: number;
    marginSen: number;
  }>;
  openProposals: { total: number };
}

// ── Job A source: the SO header (one query, no cross-DB join) ─────────────────

type SoHeader = {
  doc_no: string | null;
  status: string | null;
  so_date: string | null;
  branding: string | null;
  customer_state: string | null;
  customer_country: string | null;
  salesperson_id: string | null;
  venue: string | null;
  venue_id: string | null;
  total_revenue_centi: number | null;
  total_cost_centi: number | null;
  total_margin_centi: number | null;
  local_total_centi: number | null;
  mattress_sofa_centi: number | null;
  bedframe_centi: number | null;
  accessories_centi: number | null;
  others_centi: number | null;
  service_centi: number | null;
  mattress_sofa_cost_centi: number | null;
  bedframe_cost_centi: number | null;
  accessories_cost_centi: number | null;
  others_cost_centi: number | null;
  service_cost_centi: number | null;
};

/** One SO reduced to its dimensions + headline money (all sen). */
interface SoFact {
  revenueSen: number;
  costSen: number;
  marginSen: number;
  brandLabel: string;
  stateCode: string;
  salespersonLabel: string;
  venueLabel: string;
  brandFilled: boolean;
  stateFilled: boolean;
  salespersonFilled: boolean;
  venueFilled: boolean;
  cat: { mattressSofa: [number, number]; bedframe: [number, number]; accessories: [number, number]; others: [number, number]; service: [number, number] };
}

const UNASSIGNED = '(unassigned)';
const NO_BRAND = '(no brand)';
const NO_VENUE = '(no venue)';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSoFacts(sb: any, windowDays: number): Promise<SoFact[]> {
  const windowStart = todayMyt(-windowDays); // YYYY-MM-DD, MYT
  const { data: rowsRaw, error } = await paginateAll<SoHeader>((from, to) =>
    sb.from('mfg_sales_orders')
      .select(
        'doc_no, status, so_date, branding, customer_state, customer_country, salesperson_id, venue, venue_id, ' +
        'total_revenue_centi, total_cost_centi, total_margin_centi, local_total_centi, ' +
        'mattress_sofa_centi, bedframe_centi, accessories_centi, others_centi, service_centi, ' +
        'mattress_sofa_cost_centi, bedframe_cost_centi, accessories_cost_centi, others_cost_centi, service_cost_centi',
      )
      .neq('status', 'DRAFT')
      .neq('status', 'CANCELLED')
      .gte('so_date', windowStart)
      .order('so_date', { ascending: false })
      .range(from, to),
  );
  if (error) throw new Error(`pms-agent SO header load failed: ${error.message}`);
  const rows = rowsRaw ?? [];

  // Resolve salesperson + venue names in batch (dedupe ids).
  const spIds = [...new Set(rows.map((r) => s(r.salesperson_id)).filter(Boolean))];
  const venueIds = [...new Set(rows.map((r) => s(r.venue_id)).filter(Boolean))];
  const spName = new Map<string, string>();
  const venueName = new Map<string, string>();
  await Promise.all([
    (async () => {
      if (spIds.length === 0) return;
      try {
        const { data } = await sb.from('staff').select('id, name').in('id', spIds);
        for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
          if (r.id) spName.set(s(r.id), s(r.name));
        }
      } catch { /* names optional — fall back to id */ }
    })(),
    (async () => {
      if (venueIds.length === 0) return;
      try {
        const { data } = await sb.from('venues').select('id, name').in('id', venueIds);
        for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
          if (r.id) venueName.set(s(r.id), s(r.name));
        }
      } catch { /* names optional — fall back to free-text venue */ }
    })(),
  ]);

  return rows.map((r): SoFact => {
    const revenueSen = Math.round(n(r.total_revenue_centi));
    const costSen = Math.round(n(r.total_cost_centi));
    const marginSen = r.total_margin_centi != null ? Math.round(n(r.total_margin_centi)) : revenueSen - costSen;

    const brandRaw = s(r.branding).trim();
    const stateCode = resolveStateCode(r.customer_state) ?? resolveStateCode(r.customer_country) ?? 'UNKNOWN';
    const spId = s(r.salesperson_id).trim();
    const vId = s(r.venue_id).trim();
    const vText = s(r.venue).trim();

    return {
      revenueSen,
      costSen,
      marginSen,
      brandLabel: brandRaw || NO_BRAND,
      stateCode,
      salespersonLabel: spId ? (spName.get(spId) || `#${spId}`) : UNASSIGNED,
      venueLabel: vId ? (venueName.get(vId) || vText || `#${vId}`) : (vText || NO_VENUE),
      brandFilled: brandRaw.length > 0,
      stateFilled: stateCode !== 'UNKNOWN',
      salespersonFilled: spId.length > 0,
      venueFilled: vId.length > 0 || vText.length > 0,
      cat: {
        mattressSofa: [Math.round(n(r.mattress_sofa_centi)), Math.round(n(r.mattress_sofa_cost_centi))],
        bedframe: [Math.round(n(r.bedframe_centi)), Math.round(n(r.bedframe_cost_centi))],
        accessories: [Math.round(n(r.accessories_centi)), Math.round(n(r.accessories_cost_centi))],
        others: [Math.round(n(r.others_centi)), Math.round(n(r.others_cost_centi))],
        service: [Math.round(n(r.service_centi)), Math.round(n(r.service_cost_centi))],
      },
    };
  });
}

// ── Aggregation ──────────────────────────────────────────────────────────────

function dimRow(label: string, soCount: number, revenueSen: number, costSen: number, marginSen: number): DimRow {
  return { label, soCount, revenueSen, costSen, marginSen, marginPct: marginPctOf(revenueSen, marginSen) };
}

/** Group SOs by a label, sum money, sort by revenue desc, cap to DIM_CAP. */
function aggregateDim(facts: SoFact[], labelOf: (f: SoFact) => string): DimRow[] {
  const m = new Map<string, { count: number; rev: number; cost: number; margin: number }>();
  for (const f of facts) {
    const label = labelOf(f);
    const a = m.get(label) ?? { count: 0, rev: 0, cost: 0, margin: 0 };
    a.count += 1;
    a.rev += f.revenueSen;
    a.cost += f.costSen;
    a.margin += f.marginSen;
    m.set(label, a);
  }
  return [...m.entries()]
    .map(([label, a]) => dimRow(label, a.count, a.rev, a.cost, a.margin))
    .sort((x, y) => y.revenueSen - x.revenueSen)
    .slice(0, DIM_CAP);
}

/** A dimension + its fill-rate readiness gate. */
function gatedDim(
  facts: SoFact[],
  labelOf: (f: SoFact) => string,
  filledOf: (f: SoFact) => boolean,
  minCoveragePct: number,
): GatedDim {
  const total = facts.length;
  const filled = facts.reduce((c, f) => c + (filledOf(f) ? 1 : 0), 0);
  const fillRatePct = total === 0 ? 0 : Math.round((filled / total) * 1000) / 10;
  return { fillRatePct, gated: fillRatePct < minCoveragePct, rows: aggregateDim(facts, labelOf) };
}

/** The 5 header category buckets (revenue/cost read from distinct columns). */
function categoryRows(facts: SoFact[]): DimRow[] {
  const defs: Array<{ label: string; pick: (f: SoFact) => [number, number] }> = [
    { label: 'Mattress/Sofa', pick: (f) => f.cat.mattressSofa },
    { label: 'Bedframe', pick: (f) => f.cat.bedframe },
    { label: 'Accessories', pick: (f) => f.cat.accessories },
    { label: 'Others', pick: (f) => f.cat.others },
    { label: 'Service', pick: (f) => f.cat.service },
  ];
  return defs
    .map((d) => {
      let rev = 0;
      let cost = 0;
      let count = 0;
      for (const f of facts) {
        const [r, c] = d.pick(f);
        rev += r;
        cost += c;
        if (r !== 0 || c !== 0) count += 1;
      }
      return dimRow(d.label, count, rev, cost, rev - cost);
    })
    .sort((x, y) => y.revenueSen - x.revenueSen);
}

/** salespersonByState cross cells — only SOs with a resolved salesperson,
 *  top CROSS_CAP by revenue (answers "who does especially well where"). */
function salespersonByState(facts: SoFact[]): PmsBriefData['salespersonByState'] {
  const m = new Map<string, { salesperson: string; stateCode: string; soCount: number; revenueSen: number; marginSen: number }>();
  for (const f of facts) {
    if (!f.salespersonFilled) continue;
    const key = `${f.salespersonLabel} ${f.stateCode}`;
    const a = m.get(key) ?? { salesperson: f.salespersonLabel, stateCode: f.stateCode, soCount: 0, revenueSen: 0, marginSen: 0 };
    a.soCount += 1;
    a.revenueSen += f.revenueSen;
    a.marginSen += f.marginSen;
    m.set(key, a);
  }
  return [...m.values()].sort((x, y) => y.revenueSen - x.revenueSen).slice(0, CROSS_CAP);
}

// ── Proposal persistence (pms_agent_proposals, public schema) ────────────────

async function openProposalKeys(db: D1Database): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const res = await db
      .prepare("SELECT kind, key FROM pms_agent_proposals WHERE status = 'PENDING'")
      .all<{ kind: string; key: string }>();
    for (const r of res.results ?? []) keys.add(`${s(r.kind)} ${s(r.key)}`);
  } catch (e) {
    console.warn('[pms-agent] open-proposal key read failed:', e);
  }
  return keys;
}

async function openProposalTotal(db: D1Database): Promise<number> {
  try {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM pms_agent_proposals WHERE status = 'PENDING'")
      .first<{ n: number | string }>();
    return n(r?.n);
  } catch {
    return 0;
  }
}

// ── Job B: project-lifecycle chase (PROPOSAL-ONLY, fully guarded) ─────────────

type ProjectChase = {
  code: string | null;
  name: string | null;
  stage: string;
  status: string;
  endDate: string | null;
  daysOverdue: number;
  venue: string | null;
  state: string | null;
};

/** Confirmed/active projects whose end_date is past but stage was never closed. */
async function detectProjectChases(db: D1Database, today: string): Promise<ProjectChase[]> {
  const res = await db
    .prepare(
      `SELECT code, name, stage, status, start_date, end_date, venue, state, brand
         FROM projects
        WHERE end_date IS NOT NULL
          AND end_date::date < ?::date
          AND COALESCE(stage, '') NOT IN ('teardown', 'closed', 'cancelled')
          AND COALESCE(status, '') <> 'cancelled'
        ORDER BY end_date ASC`,
    )
    .bind(today)
    .all<Row>();
  return (res.results ?? []).map((r): ProjectChase => {
    const endDateRaw = col(r, 'endDate', 'end_date');
    const endDate = endDateRaw == null ? null : s(endDateRaw).slice(0, 10);
    return {
      code: (s(col(r, 'code', 'code')) || null),
      name: (s(col(r, 'name', 'name')) || null),
      stage: s(col(r, 'stage', 'stage')),
      status: s(col(r, 'status', 'status')),
      endDate,
      daysOverdue: daysSinceYmd(endDate ?? '', today),
      venue: (s(col(r, 'venue', 'venue')) || null),
      state: (s(col(r, 'state', 'state')) || null),
    };
  });
}

async function runProjectChase(env: Env, today: string): Promise<number> {
  const db = env.DB;
  let chases: ProjectChase[];
  try {
    chases = await detectProjectChases(db, today);
  } catch (e) {
    // Any projects-table column drift stays isolated — Job A is untouched.
    console.warn('[pms-agent] project-chase detector skipped (query failed):', e);
    return 0;
  }

  const nowIso = new Date().toISOString();
  const openKeys = await openProposalKeys(db);
  let created = 0;
  for (const chase of chases) {
    const handle = chase.code || chase.name || '(unnamed project)';
    const key = `PROJECT_CHASE:${handle}`;
    if (openKeys.has(`PROJECT_CHASE ${key}`)) continue;
    const name = chase.name || handle;
    const codePart = chase.code ? ` (${chase.code})` : '';
    const summary =
      `Project ${name}${codePart} ended ${chase.endDate ?? '(no date)'} ` +
      `(${chase.daysOverdue} day(s) ago) but is still at stage ${chase.stage || '(none)'}. ` +
      `Chase teardown / closeout.`;
    try {
      await db
        .prepare(
          `INSERT INTO pms_agent_proposals (id, kind, key, status, payload, summary, created_at)
           VALUES (?, 'PROJECT_CHASE', ?, 'PENDING', ?::jsonb, ?, ?)`,
        )
        .bind(crypto.randomUUID(), key, JSON.stringify(chase), summary, nowIso)
        .run();
      openKeys.add(`PROJECT_CHASE ${key}`);
      created++;
    } catch (e) {
      console.warn('[pms-agent] project-chase insert failed:', e);
    }
  }
  return created;
}

// ── Job A: build + persist the analytics brief ───────────────────────────────

async function buildBrief(env: Env, facts: SoFact[], settings: PmsSettings): Promise<PmsBriefData> {
  const db = env.DB;
  const generatedAt = new Date().toISOString();

  const totalRevenue = facts.reduce((sum, f) => sum + f.revenueSen, 0);
  const totalCost = facts.reduce((sum, f) => sum + f.costSen, 0);
  const totalMargin = facts.reduce((sum, f) => sum + f.marginSen, 0);

  const brief: PmsBriefData = {
    generatedAt,
    windowDays: settings.analyticsWindowDays,
    soCount: facts.length,
    totals: {
      revenueSen: totalRevenue,
      costSen: totalCost,
      marginSen: totalMargin,
      marginPct: marginPctOf(totalRevenue, totalMargin),
    },
    byCategory: categoryRows(facts),
    byBrand: gatedDim(facts, (f) => f.brandLabel, (f) => f.brandFilled, settings.minCoveragePct),
    byState: gatedDim(facts, (f) => f.stateCode, (f) => f.stateFilled, settings.minCoveragePct),
    bySalesperson: gatedDim(facts, (f) => f.salespersonLabel, (f) => f.salespersonFilled, settings.minCoveragePct),
    byVenue: gatedDim(facts, (f) => f.venueLabel, (f) => f.venueFilled, settings.minCoveragePct),
    salespersonByState: salespersonByState(facts),
    openProposals: { total: await openProposalTotal(db) },
  };

  // Snapshot row — ai_focus stays NULL here; the lead's brain call fills it.
  try {
    await db
      .prepare('INSERT INTO pms_agent_briefs (id, brief, ai_focus, created_at) VALUES (?, ?::jsonb, NULL, ?)')
      .bind(crypto.randomUUID(), JSON.stringify(brief), generatedAt)
      .run();
  } catch (e) {
    console.warn('[pms-agent] brief snapshot insert failed:', e);
  }
  return brief;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function runPmsAgent(env: Env): Promise<{ summary: string; brief: PmsBriefData; proposalsCreated: number }> {
  const sb = getSupabaseService(env);
  const settings = await loadPmsSettings(env.DB);
  const today = todayMyt();

  // Job A — analytics (read-only). Must succeed for a useful run.
  const facts = await loadSoFacts(sb, settings.analyticsWindowDays);
  const brief = await buildBrief(env, facts, settings);

  // Job B — project chase (proposal-only). Isolated so it can never sink Job A.
  const proposalsCreated = await runProjectChase(env, today).catch((e) => {
    console.warn('[pms-agent] project-chase job failed:', e);
    return 0;
  });

  const topCat = brief.byCategory[0];
  const gatedDims = (['byBrand', 'byState', 'bySalesperson', 'byVenue'] as const)
    .filter((k) => brief[k].gated)
    .map((k) => k.replace(/^by/, '').toLowerCase());

  const summary =
    `PMS: ${rm(brief.totals.revenueSen)} revenue across ${brief.soCount} SO(s) ` +
    `(${settings.analyticsWindowDays}d window)` +
    (topCat ? `, top category ${topCat.label} (${rm(topCat.revenueSen)})` : '') +
    (gatedDims.length > 0 ? `; ${gatedDims.join('/')} coverage too low to trust` : '') +
    `; created ${proposalsCreated} project chase(s).`;

  return { summary, brief, proposalsCreated };
}

// ── Console card counters (must not throw pre-migration) ──────────────────────

export async function pmsAgentStatus(env: Env): Promise<{ openProposals: number; lastBriefAt: string | null }> {
  const db = env.DB;
  const openProposals = await openProposalTotal(db);
  let lastBriefAt: string | null = null;
  try {
    const r = await db
      .prepare('SELECT MAX(created_at) AS last FROM pms_agent_briefs')
      .first<{ last?: string | null }>();
    lastBriefAt = r?.last ?? null;
  } catch {
    /* pre-migration — null */
  }
  return { openProposals, lastBriefAt };
}
