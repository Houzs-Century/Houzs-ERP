// ---------------------------------------------------------------------------
// si-agent.ts — Sales & Commercial Intelligence Agent (HZS-SI-006).
//
// Owner 2026-07-18: "基本上就是 PMS 的看 PMS，然后还有看我们的 Sales Order."
// So it reads the Sales Orders — including their `venue` dimension, which IS the
// roadshow / PMS view — and turns them into a management scorecard plus an
// anomaly list.
//
// Spec §8.2: sales / margin / conversion analysis; detect unusual cancellation and
// low-margin work. §8.6 EXPLICITLY forbids it setting price, discount, commission
// or credit — so it is READ-ONLY over the business and writes ONLY its own two
// public tables (si_agent_findings / _briefs, mig 0133). A bug here is a wrong
// advisory number, never a wrong order.
//
// It reports REVENUE QUALITY, not just revenue (§8.3: "revenue growth mistaken for
// profit growth"): every rollup carries margin and cancellation next to sales, so
// a big month with thin margin cannot read as a good month.
//
// DB handle = env.DB (the d1-compat shim over postgres.js), schema-qualified SQL.
// ---------------------------------------------------------------------------

import { registerAgent } from '../agent-scheduler';
import type { Env } from '../../types';
import { activeInstructions } from '../agent-console';
import { askAgentBrain, type AgentBrainUsageSink } from '../agent-brain';

export const SI_AGENT_SETTING_KEY = 'agents.si';

/** Look-back for the scorecard. */
const WINDOW_DAYS = 30;
/** A salesperson/venue needs at least this many orders before a cancellation rate
 *  is worth flagging — 1 cancelled out of 2 is noise, not a pattern. */
const MIN_ORDERS_FOR_RATE = 5;
/** Cancellation rate above this is flagged. */
const CANCEL_RATE_WARN = 0.2;

interface SoRow {
  doc_no: string;
  so_date?: string | null;
  status?: string | null;
  agent?: string | null;
  venue?: string | null;
  branding?: string | null;
  customer_state?: string | null;
  local_total_centi?: number | null;
  total_cost_centi?: number | null;
  total_revenue_centi?: number | null;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const key = (v: unknown): string => {
  const t = (v == null ? '' : String(v)).trim();
  return t === '' ? '(unassigned)' : t;
};

interface Roll { sales: number; cost: number; revenue: number; orders: number; cancelled: number }
const emptyRoll = (): Roll => ({ sales: 0, cost: 0, revenue: 0, orders: 0, cancelled: 0 });

export interface SiPatrolResult {
  summary: string;
  brief: unknown;
  opened: number;
  resolved: number;
}

export async function patrolSalesIntelligence(env: Env): Promise<SiPatrolResult> {
  const db = env.DB;
  const nowIso = new Date().toISOString();
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);

  const res = await db
    .prepare(
      `SELECT doc_no, so_date, status, agent, venue, branding, customer_state,
              local_total_centi, total_cost_centi, total_revenue_centi
         FROM scm.mfg_sales_orders
        WHERE status <> 'DRAFT' AND so_date >= ?
        LIMIT 5000`,
    )
    .bind(since)
    .all<SoRow>();
  const rows = res.results ?? [];

  const all = emptyRoll();
  const byAgent = new Map<string, Roll>();
  const byVenue = new Map<string, Roll>();
  const byState = new Map<string, Roll>();
  const bump = (m: Map<string, Roll>, k: string, r: SoRow, cancelled: boolean) => {
    const cur = m.get(k) ?? emptyRoll();
    cur.orders++;
    if (cancelled) cur.cancelled++;
    else {
      cur.sales += n(r.local_total_centi);
      cur.cost += n(r.total_cost_centi);
      cur.revenue += n(r.total_revenue_centi);
    }
    m.set(k, cur);
  };

  interface Desired { kind: string; severity: 'CRIT' | 'WARN'; subjectType: string; metric: string; summary: string; payload: unknown }
  const desired = new Map<string, Desired>(); // key = `${kind}\0${subject}`

  for (const r of rows) {
    const cancelled = String(r.status ?? '').toUpperCase() === 'CANCELLED';
    all.orders++;
    if (cancelled) all.cancelled++;
    else {
      all.sales += n(r.local_total_centi);
      all.cost += n(r.total_cost_centi);
      all.revenue += n(r.total_revenue_centi);
    }
    bump(byAgent, key(r.agent), r, cancelled);
    bump(byVenue, key(r.venue), r, cancelled);
    bump(byState, key(r.customer_state), r, cancelled);

    /* NEGATIVE MARGIN — an order whose cost exceeds its revenue. Only when BOTH
       numbers are present and revenue > 0: a zero-revenue row is un-costed data,
       not a loss, and calling it one would be the confident lie this codebase
       keeps recording. */
    if (!cancelled) {
      const rev = n(r.total_revenue_centi);
      const cost = n(r.total_cost_centi);
      if (rev > 0 && cost > rev) {
        const lossRm = ((cost - rev) / 100).toFixed(2);
        desired.set(`NEGATIVE_MARGIN\0${r.doc_no}`, {
          kind: 'NEGATIVE_MARGIN', severity: 'CRIT', subjectType: 'ORDER',
          metric: `-RM ${lossRm}`,
          summary: `${r.doc_no}: cost exceeds revenue by RM ${lossRm} — check pricing / costing before the next one like it.`,
          payload: { docNo: r.doc_no, revenueCenti: rev, costCenti: cost, agent: r.agent ?? null, venue: r.venue ?? null },
        });
      }
    }
  }

  /* HIGH CANCELLATION — by salesperson, only with enough orders to mean anything
     (§8.3: comparing people without sample size is the unfair-ranking trap). */
  for (const [agent, roll] of byAgent) {
    if (agent === '(unassigned)' || roll.orders < MIN_ORDERS_FOR_RATE) continue;
    const rate = roll.cancelled / roll.orders;
    if (rate > CANCEL_RATE_WARN) {
      desired.set(`HIGH_CANCELLATION\0${agent}`, {
        kind: 'HIGH_CANCELLATION', severity: 'WARN', subjectType: 'SALESPERSON',
        metric: `${(rate * 100).toFixed(0)}%`,
        summary: `${agent}: ${roll.cancelled} of ${roll.orders} orders cancelled (${(rate * 100).toFixed(0)}%) in the last ${WINDOW_DAYS} days.`,
        payload: { agent, orders: roll.orders, cancelled: roll.cancelled, rate },
      });
    }
  }

  // ── upsert + auto-resolve (the Document/OF patrol shape) ───────────────────
  const openRes = await db
    .prepare(`SELECT id, kind, subject FROM si_agent_findings WHERE status = 'OPEN'`)
    .all<{ id: string; kind: string; subject: string }>();
  const open = new Map<string, string>();
  for (const o of openRes.results ?? []) open.set(`${o.kind}\0${o.subject}`, o.id);

  let opened = 0;
  let resolved = 0;
  for (const [k, f] of desired) {
    const subject = k.split('\0')[1];
    const exId = open.get(k);
    if (!exId) {
      await db
        .prepare(
          `INSERT INTO si_agent_findings
             (id, kind, severity, subject, subject_type, metric, summary, payload, status, created_at, last_seen_at)
           VALUES (?,?,?,?,?,?,?,?, 'OPEN', ?, ?)
           ON CONFLICT (kind, subject) WHERE status = 'OPEN' DO NOTHING`,
        )
        .bind(crypto.randomUUID(), f.kind, f.severity, subject, f.subjectType, f.metric, f.summary, JSON.stringify(f.payload), nowIso, nowIso)
        .run();
      opened++;
    } else {
      await db
        .prepare(
          `UPDATE si_agent_findings SET severity=?, metric=?, summary=?, payload=?, last_seen_at=? WHERE id=? AND status='OPEN'`,
        )
        .bind(f.severity, f.metric, f.summary, JSON.stringify(f.payload), nowIso, exId)
        .run();
    }
  }
  for (const [k, id] of open) {
    if (desired.has(k)) continue;
    await db
      .prepare(`UPDATE si_agent_findings SET status='RESOLVED', resolved_at=?, last_seen_at=? WHERE id=? AND status='OPEN'`)
      .bind(nowIso, nowIso, id)
      .run();
    resolved++;
  }

  // ── the scorecard brief ────────────────────────────────────────────────────
  const top = (m: Map<string, Roll>, limit = 5) =>
    [...m.entries()]
      .filter(([k2]) => k2 !== '(unassigned)')
      .sort((a, b) => b[1].sales - a[1].sales)
      .slice(0, limit)
      .map(([name, r]) => ({
        name,
        salesCenti: r.sales,
        marginCenti: r.revenue - r.cost,
        orders: r.orders,
        cancelled: r.cancelled,
      }));

  const brief = {
    generatedAt: nowIso,
    windowDays: WINDOW_DAYS,
    orders: all.orders,
    cancelled: all.cancelled,
    cancellationRate: all.orders ? all.cancelled / all.orders : 0,
    salesCenti: all.sales,
    // Margin sits NEXT TO sales everywhere — revenue growth must never read as
    // profit growth (§8.3).
    marginCenti: all.revenue - all.cost,
    topSalespeople: top(byAgent),
    topVenues: top(byVenue),   // the roadshow / PMS view
    topStates: top(byState),
    openAnomalies: desired.size,
  };
  await db
    .prepare(`INSERT INTO si_agent_briefs (id, generated_at, brief) VALUES (?,?,?)`)
    .bind(crypto.randomUUID(), nowIso, JSON.stringify(brief))
    .run();

  const salesRm = (all.sales / 100).toFixed(0);
  const marginRm = ((all.revenue - all.cost) / 100).toFixed(0);
  return {
    summary: `Sales intelligence: ${all.orders} orders / RM ${salesRm} sales / RM ${marginRm} margin in ${WINDOW_DAYS}d · ${desired.size} anomal${desired.size === 1 ? 'y' : 'ies'} (${opened} new, ${resolved} resolved)`,
    brief, opened, resolved,
  };
}

const SI_FOCUS_SYSTEM = [
  'You are the Sales & Commercial Intelligence Agent of Houzs, a Malaysian B2C',
  'furniture retailer selling through showrooms and roadshows. You are given a',
  '30-day scorecard (money in sen, RM x100). Write ONE short paragraph (3-5',
  'sentences, plain English, no markdown, no emoji) on what the numbers actually',
  'say: where sales AND margin moved together, where they did not, and which',
  'anomaly is worth acting on. Never present revenue growth as profit growth, and',
  'never rank a salesperson or venue without noting the sample size. Invent',
  'nothing that is not in the payload. Honour ownerInstructions when present.',
].join(' ');

async function writeSiAiFocus(env: Env, focus: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE si_agent_briefs SET ai_focus = ?
      WHERE id = (SELECT id FROM si_agent_briefs ORDER BY generated_at DESC LIMIT 1)`,
  ).bind(focus).run();
}

registerAgent({
  family: 'SI',
  task: 'si-run',
  cadence: { firstRunHour: 7, minGapHours: 12, maxRunsPerDay: 1 },
  run: async (env, ctx) => {
    const r = await patrolSalesIntelligence(env);
    if (ctx.llmKey) {
      const sink: AgentBrainUsageSink = { tokensIn: 0, tokensOut: 0 };
      const ownerInstructions = await activeInstructions(env.DB, 'SI');
      const focus = await askAgentBrain(ctx.llmKey, {
        system: SI_FOCUS_SYSTEM,
        payload: { brief: r.brief, ownerInstructions },
        maxTokens: 400,
        usageSink: sink,
      });
      ctx.addTokens(sink.tokensIn, sink.tokensOut);
      if (focus) {
        await writeSiAiFocus(env, focus).catch((e) =>
          console.warn('[si-agent] ai_focus write failed:', e));
      }
    }
    return r.summary;
  },
});
