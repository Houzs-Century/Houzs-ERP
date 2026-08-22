// ---------------------------------------------------------------------------
// of-agent.ts — the Order Fulfilment Agent (HZS-OF-001) engine.
//
// docs/agents/operating-spec.md §3. The readiness CORE (order-fulfilment.ts,
// #729) computes a per-SO readiness score + blocker list; this makes it RUN: a
// patrol over the fulfilment pipeline that writes one OPEN finding per blocked
// order, naming the precise blocker, its owner and the next action.
//
// READ-ONLY over business documents — like the Document agent, the ONLY thing it
// writes is its own two public-schema tables (of_agent_findings / _briefs,
// mig 0130). So a bug here produces a wrong ADVISORY finding, never a wrong
// order: the blast radius is the console, not the ledger.
//
// DB handle = env.DB (the d1-compat shim over postgres.js), which reads scm.*
// with schema-qualified SQL, exactly as document-agent.ts does.
// ---------------------------------------------------------------------------

import { registerAgent } from '../agent-scheduler';
import type { Env } from '../../types';
import { activeInstructions } from '../agent-console';
import { askAgentBrain, type AgentBrainUsageSink } from '../agent-brain';
import { summariseReadiness, type ReadinessLine } from '../../scm/lib/so-readiness';
import { computeReleaseGate } from './release-gate';
import { assessFulfilment, type FulfilmentInput } from './order-fulfilment';

export const OF_AGENT_SETTING_KEY = 'agents.of';

// The orders being fulfilled — not drafts, not terminal states. An SO leaving
// this set (delivered / invoiced / cancelled) auto-resolves its finding.
const PIPELINE = "('CONFIRMED','IN_PRODUCTION','READY_TO_SHIP')";

interface SoRow {
  doc_no: string; status: string;
  /** Migration 0324 — the hold MARKER. A held order keeps its real status, so
   *  the PIPELINE status filter below can no longer exclude one by itself. */
  on_hold?: boolean | null;
  debtor_name?: string | null; email?: string | null; address1?: string | null;
  postcode?: string | null; customer_delivery_date?: string | null;
  local_total_sen?: number | null; paid_sen?: number | null;
}
interface ItemRow {
  doc_no: string; item_group: string; item_code: string;
  /** mfg_products.category, resolved by the scalar subquery below. */
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
              customer_delivery_date, local_total_sen, paid_sen
         FROM scm.mfg_sales_orders WHERE status IN ${PIPELINE} LIMIT 1000`,
    )
    .all<SoRow>();
  const sos = soRes.results ?? [];

  // All items for pipeline SOs in one join — no per-order query, no dynamic IN.
  // The catalog category rides as a SCALAR SUBQUERY, not a join: mfg_products is
  // per-company and `code` collides across companies, so joining it would fan a
  // line out into two rows and double-count the readiness tally. LIMIT 1 cannot
  // fan out, and the only consumer is isServiceLine's "is this SERVICE?" test —
  // a code that is SERVICE in one company is SERVICE in the other.
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
    if (r.ready) continue; // only blocked orders become findings
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
           VALUES (?, 'NOT_READY', ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
           ON CONFLICT (so_doc_no) WHERE status = 'OPEN' DO NOTHING`,
        )
        .bind(crypto.randomUUID(), f.severity, doc, f.readiness, f.topBlocker, f.owner, f.summary, JSON.stringify(f.payload), nowIso, nowIso)
        .run();
      opened++;
    } else {
      await db
        .prepare(
          `UPDATE of_agent_findings
              SET severity = ?, readiness = ?, top_blocker = ?, owner = ?, summary = ?, payload = ?, last_seen_at = ?
            WHERE id = ? AND status = 'OPEN'`,
        )
        .bind(f.severity, f.readiness, f.topBlocker, f.owner, f.summary, JSON.stringify(f.payload), nowIso, exId)
        .run();
    }
  }
  // Auto-resolve: an order that is no longer blocked (or left the pipeline) loses
  // its finding. Safe to mass-resolve here — this is a single-detector patrol, so
  // "absent from desired" is a real recovery, not a failed query (a thrown query
  // aborts the whole run before this point).
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
    .prepare(`INSERT INTO of_agent_briefs (id, generated_at, brief) VALUES (?, ?, ?)`)
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
    /* AI focus — first run of the day only (ctx.llmKey is budget-gated and
       undefined otherwise). Best-effort: a brain failure leaves ai_focus NULL and
       every deterministic finding still ships. */
    if (ctx.llmKey) {
      const sink: AgentBrainUsageSink = { tokensIn: 0, tokensOut: 0 };
      const ownerInstructions = await activeInstructions(env.DB, 'OF');
      const focus = await askAgentBrain(ctx.llmKey, {
        system: OF_FOCUS_SYSTEM,
        payload: { brief: r.brief, ownerInstructions },
        maxTokens: 400,
        usageSink: sink,
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
