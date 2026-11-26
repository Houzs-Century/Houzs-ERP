
import type { Env } from '../../types';
import { computeMrp, type MrpResult } from '../../scm/routes/mrp';
import { loadLeadBuffers } from './procurement-learning';
import { resolveAgentCompany, scopeFor } from './agent-company';
import { getSupabaseService } from '../../db/supabase';
import { resolveStateCode } from './delivery-agent-geo';
import { readAgentSetting } from '../agent-console';
import { todayMyt } from '../../scm/lib/my-time';
import { effectiveSoDelivery } from '../../scm/shared';
import { paginateAll } from '../../scm/lib/paginate-all';


/** app_settings key for the CS Agent's own tunables (warn window). */
export const CS_AGENT_SETTING_KEY = 'agents.cs';

const DELIVERY_AGENT_SETTING_KEY = 'agents.delivery';

const DEFAULT_TRANSIT_DAYS = 3;

const DEFAULT_ASSR_WARN_HOURS = 24;


function s(v: unknown): string {
  return v == null ? '' : String(v);
}
function num(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function addWorkingDays(fromYmd: string, days: number): string {
  const d = new Date(`${fromYmd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return fromYmd;
  const target = Math.max(0, Math.min(30, Math.floor(days)));
  let added = 0;
  let guard = 0;
  while (added < target && guard < 400) {
    d.setUTCDate(d.getUTCDate() + 1);
    guard++;
    if (d.getUTCDay() !== 0) added++;
  }
  return d.toISOString().slice(0, 10);
}

function isEarlier(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.slice(0, 10) < b.slice(0, 10);
}

async function loadTransitDays(db: D1Database): Promise<Record<string, number>> {
  const raw = (await readAgentSetting<{ transitDaysByState?: Record<string, unknown> }>(
    db,
    DELIVERY_AGENT_SETTING_KEY,
  )) ?? {};
  const byState: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.transitDaysByState ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 30) byState[k.toUpperCase()] = Math.floor(n);
  }
  return byState;
}

async function assrWarnHours(db: D1Database): Promise<number> {
  const cfg = await readAgentSetting<Record<string, unknown>>(db, CS_AGENT_SETTING_KEY);
  const n = Number(cfg?.assrWarnHours);
  if (!Number.isFinite(n) || n < 1 || n > 168) return DEFAULT_ASSR_WARN_HOURS;
  return Math.floor(n);
}


export type CsProposalKind = 'PROMISE_DATE' | 'ASSR_SLA';

interface ProposalInsert {
  kind: CsProposalKind;
  key: string;
  payload: unknown;
  summary: string;
}

async function openProposalKeys(db: D1Database): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const res = await db
      .prepare("SELECT kind, key FROM cs_agent_proposals WHERE status = 'PENDING'")
      .all<{ kind: string; key: string }>();
    for (const r of res.results ?? []) keys.add(`${s(r.kind)}\0${s(r.key)}`);
  } catch (e) {
    console.warn('[cs-agent] open-proposal key read failed:', e);
  }
  return keys;
}

async function openProposalCounts(db: D1Database): Promise<{ total: number; byKind: Record<string, number> }> {
  const byKind: Record<string, number> = {};
  let total = 0;
  try {
    const res = await db
      .prepare("SELECT kind, COUNT(*) AS n FROM cs_agent_proposals WHERE status = 'PENDING' GROUP BY kind")
      .all<{ kind: string; n: number | string }>();
    for (const r of res.results ?? []) {
      const c = num(r.n);
      byKind[s(r.kind) || 'UNKNOWN'] = c;
      total += c;
    }
  } catch { }
  return { total, byKind };
}

async function insertProposal(db: D1Database, p: ProposalInsert, nowIso: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cs_agent_proposals (id, kind, key, status, payload, summary, created_at)
       VALUES (?, ?, ?, 'PENDING', ?::text::jsonb, ?, ?)`,
    )
    .bind(crypto.randomUUID(), p.kind, p.key, JSON.stringify(p.payload), p.summary, nowIso)
    .run();
}


interface SupplyItem {
  itemCode: string | null;
  source: 'stock' | 'po' | 'shortage';
  poEta: string | null;
  shortageQty: number;
}

interface SoHeader {
  docNo: string;
  debtorName: string | null;
  status: string;
  customerState: string | null;
  stateCode: string;
  currentPromised: string | null;
}

const DELIVERED_STATUSES = new Set(['DELIVERED', 'INVOICED', 'CLOSED']);

interface PromiseProposalRow {
  soDocNo: string;
  debtorName: string | null;
  computedPromiseDate: string;
  stateCode: string;
}

interface PromiseResult {
  proposals: ProposalInsert[];
  promisable: number;
  cannotPromise: number;
  upcoming: PromiseProposalRow[];
}

type SoHeaderRow = {
  doc_no: string | null;
  debtor_name: string | null;
  status: string | null;
  customer_state: string | null;
  customer_country: string | null;
  customer_delivery_date: string | null;
  amended_delivery_date: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSoHeaders(sb: any, companyId: number | undefined): Promise<Map<string, SoHeader>> {
  const { data: rows, error } = await paginateAll<SoHeaderRow>((from, to) => {
    let q = sb.from('mfg_sales_orders')
      .select('doc_no, debtor_name, status, customer_state, customer_country, customer_delivery_date, amended_delivery_date')
      .neq('status', 'DRAFT')
      .neq('status', 'CANCELLED');
    if (companyId != null) q = q.eq('company_id', companyId);
    return q.range(from, to);
  });
  if (error) throw new Error(`cs-agent SO header load failed: ${error.message}`);
  const map = new Map<string, SoHeader>();
  for (const r of rows ?? []) {
    const docNo = s(r.doc_no);
    if (!docNo) continue;
    map.set(docNo, {
      docNo,
      debtorName: r.debtor_name ?? null,
      status: s(r.status).toUpperCase(),
      customerState: r.customer_state ?? null,
      stateCode:
        resolveStateCode(r.customer_state) ?? resolveStateCode(r.customer_country) ?? 'UNKNOWN',
      currentPromised: effectiveSoDelivery(r),
    });
  }
  return map;
}

function groupSupplyBySo(mrp: MrpResult): Map<string, SupplyItem[]> {
  const bySo = new Map<string, SupplyItem[]>();
  const push = (docNo: string, item: SupplyItem) => {
    const arr = bySo.get(docNo) ?? [];
    arr.push(item);
    bySo.set(docNo, arr);
  };
  for (const sku of mrp.skus) {
    for (const line of sku.lines) {
      const docNo = s(line.soDocNo);
      if (!docNo) continue;
      push(docNo, {
        itemCode: sku.itemCode ?? null,
        source: line.source,
        poEta: line.poEta ?? null,
        shortageQty: num(line.shortageQty),
      });
    }
  }
  for (const set of mrp.sofaSets) {
    const docNo = s(set.soDocNo);
    if (!docNo) continue;
    const short = num(set.shortageQty) > 0 && !set.poEta;
    push(docNo, {
      itemCode: set.itemCode ?? null,
      source: short ? 'shortage' : set.poEta ? 'po' : 'stock',
      poEta: set.poEta ?? null,
      shortageQty: num(set.shortageQty),
    });
  }
  return bySo;
}

function buildPromiseProposals(
  headers: Map<string, SoHeader>,
  supplyBySo: Map<string, SupplyItem[]>,
  transitByState: Record<string, number>,
  today: string,
): PromiseResult {
  const proposals: ProposalInsert[] = [];
  const upcoming: PromiseProposalRow[] = [];
  let promisable = 0;
  let cannotPromise = 0;

  for (const [docNo, items] of supplyBySo) {
    const header = headers.get(docNo);
    if (!header) continue;
    if (DELIVERED_STATUSES.has(header.status)) continue;

    const hasUncovered = items.some(
      (it) => it.source === 'shortage' && it.shortageQty > 0 && !it.poEta,
    );
    if (hasUncovered) {
      cannotPromise++;
      continue;
    }
    promisable++;

    const etas = items.map((it) => it.poEta).filter((e): e is string => !!e);
    const basis: 'stock' | 'po' = etas.length > 0 ? 'po' : 'stock';
    const stockReadyDate =
      etas.length > 0 ? etas.reduce((a, b) => (b.slice(0, 10) > a.slice(0, 10) ? b : a)).slice(0, 10) : today;

    const transitDays = Math.max(
      0,
      Math.min(30, transitByState[header.stateCode] ?? DEFAULT_TRANSIT_DAYS),
    );
    const computedPromiseDate = addWorkingDays(stockReadyDate, transitDays);

    const needsProposal =
      header.currentPromised == null || isEarlier(header.currentPromised, computedPromiseDate);
    if (!needsProposal) continue;

    const shortLines = items
      .filter((it) => !!it.poEta)
      .map((it) => ({ itemCode: it.itemCode ?? undefined, poEta: it.poEta, shortageQty: it.shortageQty }));

    proposals.push({
      kind: 'PROMISE_DATE',
      key: `PROMISE_DATE:${docNo}`,
      payload: {
        soDocNo: docNo,
        debtorName: header.debtorName,
        status: header.status,
        stateCode: header.stateCode,
        customerState: header.customerState,
        basis,
        stockReadyDate,
        transitDays,
        computedPromiseDate,
        currentPromisedDate: header.currentPromised,
        shortLines,
      },
      summary:
        `SO ${docNo}${header.debtorName ? ` (${header.debtorName})` : ''} can realistically be promised ` +
        `${computedPromiseDate} (stock ready ${stockReadyDate} + ${transitDays} transit day(s) to ` +
        `${header.stateCode}); customer currently shows ${header.currentPromised ?? 'no date'}. ` +
        `Confirm the date with the customer.`,
    });
    upcoming.push({
      soDocNo: docNo,
      debtorName: header.debtorName,
      computedPromiseDate,
      stateCode: header.stateCode,
    });
  }

  upcoming.sort((a, b) => (a.computedPromiseDate < b.computedPromiseDate ? -1 : a.computedPromiseDate > b.computedPromiseDate ? 1 : 0));
  return { proposals, promisable, cannotPromise, upcoming };
}


interface AssrFinding {
  proposal: ProposalInsert;
  breached: boolean;
}

interface AssrResult {
  proposals: ProposalInsert[];
  openCases: number;
  breached: number;
  atRisk: number;
  byPriority: Record<string, number>;
}

async function collectAssrFindings(db: D1Database, warnHours: number, nowMs: number): Promise<AssrResult> {
  const res = await db
    .prepare(
      `SELECT assr_no, doc_no, status, stage, priority, sla_hours, deadline_at,
              escalated_at, customer_name, phone, sales_agent
         FROM assr_cases
        WHERE stage NOT IN ('completed', 'voided')
          AND status NOT IN ('Closed')
          AND deadline_at IS NOT NULL`,
    )
    .all<{
      assr_no: string | null; doc_no: string | null; status: string | null; stage: string | null;
      priority: string | null; sla_hours: number | string | null; deadline_at: string | null;
      escalated_at: string | null; customer_name: string | null; phone: string | null;
      sales_agent: string | null;
    }>();

  const warnMs = warnHours * 3_600_000;
  const byPriority: Record<string, number> = {};
  const findings: AssrFinding[] = [];
  let openCases = 0;
  let breachedCount = 0;
  let atRiskCount = 0;

  for (const r of res.results ?? []) {
    openCases++;
    const priority = s(r.priority) || 'normal';
    byPriority[priority] = (byPriority[priority] ?? 0) + 1;

    const deadlineMs = new Date(s(r.deadline_at)).getTime();
    if (!Number.isFinite(deadlineMs)) continue;

    const breached = deadlineMs < nowMs;
    const withinWarn = !breached && deadlineMs <= nowMs + warnMs;
    if (!breached && !withinWarn) continue;
    if (breached) breachedCount++;
    else atRiskCount++;

    const hoursOverdue = Math.round((nowMs - deadlineMs) / 3_600_000);
    const assrNo = s(r.assr_no) || s(r.doc_no) || '(unknown ASSR)';
    const customer = s(r.customer_name);
    const stage = s(r.stage) || 'unknown';

    const summary = breached
      ? `ASSR ${assrNo}${customer ? ` (${customer})` : ''} is ${hoursOverdue}h past its ${priority} SLA ` +
        `at stage ${stage}. Chase the service team.`
      : `ASSR ${assrNo}${customer ? ` (${customer})` : ''} is due in ${-hoursOverdue}h on its ${priority} SLA ` +
        `at stage ${stage}. Chase the service team.`;

    findings.push({
      breached,
      proposal: {
        kind: 'ASSR_SLA',
        key: `ASSR_SLA:${assrNo}`,
        payload: {
          assrNo,
          docNo: r.doc_no ?? null,
          stage,
          priority,
          deadlineAt: r.deadline_at ?? null,
          hoursOverdue,
          customerName: r.customer_name ?? null,
          salesAgent: r.sales_agent ?? null,
        },
        summary,
      },
    });
  }

  return {
    proposals: findings.map((f) => f.proposal),
    openCases,
    breached: breachedCount,
    atRisk: atRiskCount,
    byPriority,
  };
}


export interface CsBriefData {
  generatedAt: string;
  promise: {
    promisable: number;
    cannotPromise: number;
    proposalsOpen: number;
    upcoming: Array<{ soDocNo: string; debtorName: string | null; computedPromiseDate: string; stateCode: string }>;
  };
  assr: {
    openCases: number;
    breached: number;
    atRisk: number;
    byPriority: Record<string, number>;
  };
  openProposals: { total: number; byKind: Record<string, number> };
}


export async function runCsAgent(
  env: Env,
): Promise<{ summary: string; brief: CsBriefData; proposalsCreated: number }> {
  const db = env.DB;
  const sb = getSupabaseService(env);
  const today = todayMyt();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  const company = scopeFor(await resolveAgentCompany(db, CS_AGENT_SETTING_KEY));
  if (company.refuse) {
    throw new Error(`cs_company_unresolved: ${company.refuse}`);
  }

  const [mrp, headers, transitByState] = await Promise.all([
    computeMrp(sb, {
      catFilter: null,
      whFilter: null,
      includeUndated: false,
      companyId: company.companyId ?? null,
      leadBuffers: await loadLeadBuffers(env.DB),
    }),
    loadSoHeaders(sb, company.companyId),
    loadTransitDays(db),
  ]);
  const supplyBySo = groupSupplyBySo(mrp);
  const promise = buildPromiseProposals(headers, supplyBySo, transitByState, today);

  const warnHours = await assrWarnHours(db);
  let assr: AssrResult = { proposals: [], openCases: 0, breached: 0, atRisk: 0, byPriority: {} };
  try {
    assr = await collectAssrFindings(db, warnHours, nowMs);
  } catch (e) {
    console.warn('[cs-agent] ASSR SLA watch skipped (Job A unaffected):', e);
  }

  const openKeys = await openProposalKeys(db);
  let proposalsCreated = 0;
  for (const p of [...promise.proposals, ...assr.proposals]) {
    const dedupe = `${p.kind}\0${p.key}`;
    if (openKeys.has(dedupe)) continue;
    await insertProposal(db, p, nowIso);
    openKeys.add(dedupe);
    proposalsCreated++;
  }

  const openProposals = await openProposalCounts(db);

  const brief: CsBriefData = {
    generatedAt: nowIso,
    promise: {
      promisable: promise.promisable,
      cannotPromise: promise.cannotPromise,
      proposalsOpen: openProposals.byKind.PROMISE_DATE ?? 0,
      upcoming: promise.upcoming.slice(0, 20),
    },
    assr: {
      openCases: assr.openCases,
      breached: assr.breached,
      atRisk: assr.atRisk,
      byPriority: assr.byPriority,
    },
    openProposals,
  };

  try {
    await db
      .prepare('INSERT INTO cs_agent_briefs (id, brief, ai_focus, created_at) VALUES (?, ?::text::jsonb, NULL, ?)')
      .bind(crypto.randomUUID(), JSON.stringify(brief), nowIso)
      .run();
  } catch (e) {
    console.warn('[cs-agent] brief snapshot insert failed:', e);
  }

  const summary =
    `CS: ${promise.promisable} promisable SO(s) (${promise.cannotPromise} cannot be promised — ` +
    `uncovered shortage), created ${proposalsCreated} proposal(s); ` +
    `ASSR ${assr.openCases} open (${assr.breached} breached, ${assr.atRisk} at risk).`;

  return { summary, brief, proposalsCreated };
}


export async function csAgentStatus(
  env: Env,
): Promise<{ openProposals: number; openByKind: Record<string, number>; lastBriefAt: string | null }> {
  const db = env.DB;
  const { total, byKind } = await openProposalCounts(db);
  let lastBriefAt: string | null = null;
  try {
    const r = await db
      .prepare('SELECT MAX(created_at) AS last FROM cs_agent_briefs')
      .first<{ last?: string | null }>();
    lastBriefAt = r?.last ?? null;
  } catch { }
  return { openProposals: total, openByKind: byKind, lastBriefAt };
}
