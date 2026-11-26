
import { registerAgent } from '../agent-scheduler';
import type { Env } from '../../types';
import { activeInstructions } from '../agent-console';
import { AGENT_BRAIN_MODEL, askAgentBrain, type AgentBrainUsageSink } from '../agent-brain';
import { agentFeature } from '../aiUsage';
import { summariseReadiness, type ReadinessLine } from '../../scm/lib/so-readiness';
import { computeReleaseGate } from './release-gate';
import { assessFulfilment, type FulfilmentInput } from './order-fulfilment';

export const OF_AGENT_SETTING_KEY = 'agents.of';

const PIPELINE = "('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP')";

interface SoRow {
  doc_no: string; status: string;
  on_hold?: boolean | null;
  debtor_name?: string | null; email?: string | null; address1?: string | null;
  postcode?: string | null; customer_delivery_date?: string | null;
  local_total_sen?: number | null; paid_sen?: number | null;
}
interface ItemRow {
  doc_no: string; item_group: string; item_code: string;
  category?: string | null;
  stock_status: string; cancelled?: boolean | null;
}

const has = (v: unknown): boolean => (v == null ? false : String(v).trim() !== '');

export interface OfPatrolResult {
  summary: string;
  brief: unknown;
  opened: number;
  resolved: number;
  blocked: number;
  pipeline: number;
}

export async function patrolOrderFulfilment(env: Env): Promise<OfPatrolResult> {
  const db = env.DB;
  const nowIso = new Date().toISOString();

  const soRes = await db
    .prepare(
      `SELECT doc_no, status, on_hold, debtor_name, email, address1, postcode,
              customer_delivery_date, local_total_sen, paid_total_sen AS paid_sen
         FROM scm.mfg_sales_orders_with_payment_totals WHERE status IN ${PIPELINE} LIMIT 1000`,
    )
    .all<SoRow>();
  const sos = soRes.results ?? [];

  const itemRes = await db
    .prepare(
      `SELECT i.doc_no, i.item_group, i.item_code, i.stock_status, i.cancelled,
              (SELECT p.category FROM scm.mfg_products p
                WHERE p.code = i.item_code LIMIT 1) AS category
         FROM scm.mfg_sales_order_items i
         JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
        WHERE o.status IN ${PIPELINE}`,
    )
    .all<ItemRow>();
  const itemsByDoc = new Map<string, ReadinessLine[]>();
  for (const it of itemRes.results ?? []) {
    const arr = itemsByDoc.get(it.doc_no) ?? [];
    arr.push({ item_group: it.item_group, item_code: it.item_code, category: it.category ?? null, stock_status: it.stock_status, cancelled: !!it.cancelled });
    itemsByDoc.set(it.doc_no, arr);
  }

  interface Desired {
    severity: 'CRIT' | 'WARN'; readiness: number;
    topBlocker: string | null; owner: string | null; summary: string; payload: unknown;
  }
  const desired = new Map<string, Desired>();
  for (const so of sos) {
    const readiness = summariseReadiness(itemsByDoc.get(so.doc_no) ?? []);
    const gate = computeReleaseGate({
      totalSen: Number(so.local_total_sen ?? 0),
      paidSen: Number(so.paid_sen ?? 0),
    });
    const input: FulfilmentInput = {
      status: so.status,
      onHold: so.on_hold ?? null,
      isMainReady: readiness.isMainReady,
      isFullyReady: readiness.isFullyReady,
      releaseDecision: gate.decision,
      hasCustomerName: has(so.debtor_name),
      hasEmail: has(so.email),
      hasAddress: has(so.address1),
      hasPostcode: has(so.postcode),
      hasDeliveryDate: has(so.customer_delivery_date),
    };
    const r = assessFulfilment(input);
    if (r.ready) continue;
    const blockCount = r.blockers.filter((b) => b.severity === 'BLOCK').length;
    const top = r.blockers[0] ?? null;
    desired.set(so.doc_no, {
      severity: blockCount >= 2 ? 'CRIT' : 'WARN',
      readiness: r.score,
      topBlocker: top?.code ?? null,
      owner: top?.owner ?? null,
      summary: `${so.doc_no}: ${top?.message ?? 'not ready'}${r.nextAction ? ` — ${r.nextAction}` : ''}`.slice(0, 240),
      payload: { score: r.score, ready: r.ready, blockers: r.blockers },
    });
  }

  const openRes = await db
    .prepare(`SELECT id, so_doc_no FROM of_agent_findings WHERE status = 'OPEN'`)
    .all<{ id: string; so_doc_no: string }>();
  const open = new Map<string, string>();
  for (const o of openRes.results ?? []) open.set(o.so_doc_no, o.id);

  let opened = 0;
  let resolved = 0;
  for (const [doc, f] of desired) {
    const exId = open.get(doc);
    if (!exId) {
      await db
        .prepare(
          `INSERT INTO of_agent_findings
             (id, kind, severity, so_doc_no, readiness, top_blocker, owner, summary, payload, status, created_at, last_seen_at)
           VALUES (?, 'NOT_READY', ?, ?, ?, ?, ?, ?, ?::text::jsonb, 'OPEN', ?, ?)
           ON CONFLICT (so_doc_no) WHERE status = 'OPEN' DO NOTHING`,
        )
        .bind(crypto.randomUUID(), f.severity, doc, f.readiness, f.topBlocker, f.owner, f.summary, JSON.stringify(f.payload), nowIso, nowIso)
        .run();
      opened++;
    } else {
      await db
        .prepare(
          `UPDATE of_agent_findings
              SET severity = ?, readiness = ?, top_blocker = ?, owner = ?, summary = ?, payload = ?::text::jsonb, last_seen_at = ?
            WHERE id = ? AND status = 'OPEN'`,
        )
        .bind(f.severity, f.readiness, f.topBlocker, f.owner, f.summary, JSON.stringify(f.payload), nowIso, exId)
        .run();
    }
  }
  for (const [doc, id] of open) {
    if (desired.has(doc)) continue;
    await db
      .prepare(`UPDATE of_agent_findings SET status = 'RESOLVED', resolved_at = ?, last_seen_at = ? WHERE id = ? AND status = 'OPEN'`)
      .bind(nowIso, nowIso, id)
      .run();
    resolved++;
  }

  const bySeverity = { CRIT: 0, WARN: 0 };
  const byOwner: Record<string, number> = {};
  for (const f of desired.values()) {
    bySeverity[f.severity]++;
    if (f.owner) byOwner[f.owner] = (byOwner[f.owner] ?? 0) + 1;
  }
  const brief = {
    generatedAt: nowIso,
    pipeline: sos.length,
    blocked: desired.size,
    bySeverity,
    byOwner,
  };
  await db
    .prepare(`INSERT INTO of_agent_briefs (id, generated_at, brief) VALUES (?, ?, ?::text::jsonb)`)
    .bind(crypto.randomUUID(), nowIso, JSON.stringify(brief))
    .run();

  return {
    summary: `Order fulfilment: ${sos.length} in pipeline, ${desired.size} blocked (${opened} new, ${resolved} resolved)`,
    brief, opened, resolved, blocked: desired.size, pipeline: sos.length,
  };
}

const OF_FOCUS_SYSTEM = [
  'You are the Order Fulfilment Agent of Houzs, a Malaysian B2C furniture retailer.',
  "You are given today's deterministic readiness brief. Write ONE short paragraph",
  '(3-5 sentences, plain English, no markdown, no emoji) telling the owner which',
  'blocked orders matter most today and WHO needs to act — Sales, Finance,',
  'Procurement, the Warehouse or the Office. Judgment and prioritisation only:',
  'never invent an order, a number or a blocker that is not in the payload.',
  'Honour ownerInstructions when present.',
].join(' ');

async function writeOfAiFocus(env: Env, focus: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE of_agent_briefs SET ai_focus = ?
      WHERE id = (SELECT id FROM of_agent_briefs ORDER BY generated_at DESC LIMIT 1)`,
  ).bind(focus).run();
}

registerAgent({
  family: 'OF',
  task: 'of-run',
  cadence: { firstRunHour: 8, minGapHours: 6, maxRunsPerDay: 2 },
  run: async (env, ctx) => {
    const r = await patrolOrderFulfilment(env);
    if (ctx.llmKey) {
      const sink: AgentBrainUsageSink = { tokensIn: 0, tokensOut: 0 };
      const ownerInstructions = await activeInstructions(env.DB, 'OF');
      const focus = await askAgentBrain(ctx.llmKey, {
        system: OF_FOCUS_SYSTEM,
        payload: { brief: r.brief, ownerInstructions },
        maxTokens: 400,
        usageSink: sink,
        aiUsage: { env, feature: agentFeature('OF'), model: AGENT_BRAIN_MODEL, companyId: null, userId: null, waitUntil: null },
      });
      ctx.addTokens(sink.tokensIn, sink.tokensOut);
      if (focus) {
        await writeOfAiFocus(env, focus).catch((e) =>
          console.warn('[of-agent] ai_focus write failed:', e));
      }
    }
    return r.summary;
  },
});
