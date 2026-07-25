// ---------------------------------------------------------------------------
// agents/index.ts — engine bootstrap. Importing this module (done once, from
// routes/agent-console.ts, which index.ts mounts at worker init) registers
// every agent engine with the scheduler and the config-proposal whitelist.
//
// Wiring layers stay separate on purpose (AGENTS-BLUEPRINT iron rule 2):
// the engines are pure deterministic calculators; THIS file is where their
// results meet the skeleton — scheduler registration, learning findings →
// config_proposals, and the once-a-day AI focus paragraph over the brief.
// ---------------------------------------------------------------------------
import type { Env } from "../../types";
import { registerAgent, type AgentRunContext } from "../agent-scheduler";
import {
  CONFIG_PROPOSAL_RULES,
  activeInstructions,
  createConfigProposal,
  effectiveStage,
} from "../agent-console";
import { autoApproveReorderProposals } from "./procurement-execute";
import { askAgentBrain, type AgentBrainUsageSink } from "../agent-brain";
import { DELIVERY_TRANSIT_RULE, runDeliveryAgent } from "./delivery-agent";
import type { DeliveryBriefData } from "./delivery-agent";
import { runCollectionAgent } from "./collection-agent";
import { runCsAgent } from "./cs-agent";
import { runProcurementAgent } from "./procurement-agent";
import {
  PROCUREMENT_SUPPLIER_BUFFER_RULE,
  PROCUREMENT_SEASON_BUFFER_RULE,
} from "./procurement-learning";
import { runPmsAgent } from "./pms-agent";

// Document Agent self-registers at module load (family DOCUMENT, 9:00 MYT).
import "./document-agent";
import "./of-agent";
import "./si-agent";

// ── Delivery Agent wiring ────────────────────────────────────────────────────

// Whitelist the learner's only tunable: per-state transit working days.
CONFIG_PROPOSAL_RULES.push(DELIVERY_TRANSIT_RULE);

// Whitelist the Procurement learner's two tunables: how many days earlier we
// must ask a given SUPPLIER to deliver, and how many more in a given MONTH.
// Both are additive buffers ON TOP of the owner's manual per-(warehouse,
// category) lead-time table, which no agent may write. Anything outside these
// two patterns and their 0..30 bounds is rejected at approve time — the
// whitelist is the fuse, not the learner's good manners.
CONFIG_PROPOSAL_RULES.push(PROCUREMENT_SUPPLIER_BUFFER_RULE);
CONFIG_PROPOSAL_RULES.push(PROCUREMENT_SEASON_BUFFER_RULE);

/** Pre-compact the brief for the brain — counts and top rows, never tables. */
function compactDeliveryBrief(b: DeliveryBriefData) {
  return {
    date: b.date,
    pendingPool: {
      total: b.pendingPool.total,
      byPlanningState: b.pendingPool.byPlanningState,
      readyByRegion: b.pendingPool.readyByRegion.slice(0, 8),
      readyByState: b.pendingPool.readyByState.slice(0, 8),
    },
    overdueToDeliver: {
      count: b.overdueToDeliver.count,
      worst: b.overdueToDeliver.rows.slice(0, 5),
    },
    doPipeline: b.doPipeline,
    podGapCount: b.podGaps.count,
    trips: { today: b.trips.today.length, tomorrow: b.trips.tomorrow.length },
    openProposals: b.openProposals,
  };
}

const DELIVERY_FOCUS_SYSTEM = [
  "You are the Delivery Agent of Houzs, a Malaysian B2C furniture retailer",
  "delivering roadshow sales orders to end customers with its own fleet.",
  "You are given today's deterministic delivery brief (all money values are",
  "in sen, RM x100). Write ONE short paragraph (3-5 sentences, plain",
  "English, no markdown, no emoji) telling the owner what matters most",
  "today: where the ready-to-deliver pool is piling up, which overdue",
  "deliveries need a decision, and any POD gaps worth chasing. Judgment and",
  "attribution only — never invent numbers that are not in the payload.",
  "Honour ownerInstructions when present.",
].join(" ");

async function writeDeliveryAiFocus(env: Env, focus: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE delivery_agent_briefs SET ai_focus = ?
      WHERE id = (SELECT id FROM delivery_agent_briefs ORDER BY created_at DESC LIMIT 1)`,
  )
    .bind(focus)
    .run();
}

registerAgent({
  family: "DELIVERY",
  task: "delivery-run",
  // HOOKKA's delivery cadence: first sweep after 7:30 MYT, then event-driven.
  cadence: { firstRunHour: 7.5, minGapHours: 1, maxRunsPerDay: 4 },
  // Extra sweeps only when the yard actually moved: >=3 dispatch/delivery
  // events since the last run (HOOKKA threshold). Pure read.
  shouldRunExtra: async (db, sinceIso) => {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM scm.delivery_orders
          WHERE status <> 'CANCELLED'
            AND (dispatched_at > ? OR delivered_at > ?)`,
      )
      .bind(sinceIso, sinceIso)
      .first<{ n?: number | string | null }>();
    const n = Number(r?.n) || 0;
    return n >= 3
      ? { fire: true, reason: `${n} dispatch/delivery events since last run` }
      : { fire: false, reason: `only ${n} dispatch/delivery event(s) since last run (<3)` };
  },
  run: async (env, ctx) => {
    const r = await runDeliveryAgent(env);

    // Learning findings → PENDING config proposals (dedupes per param key;
    // approval — manual or AGENT_AUTO — goes through the whitelist gateway).
    let proposed = 0;
    for (const l of r.learning) {
      const created = await createConfigProposal(env.DB, {
        paramKey: l.key,
        currentValue: String(l.current),
        proposedValue: String(l.proposed),
        reason: l.reason,
      }).catch(() => false);
      if (created) proposed++;
    }

    // AI focus — first run of the day only (ctx.llmKey is budget-gated and
    // undefined otherwise). Best-effort: a brain failure changes nothing.
    if (ctx.llmKey) {
      const sink: AgentBrainUsageSink = { tokensIn: 0, tokensOut: 0 };
      const ownerInstructions = await activeInstructions(env.DB, "DELIVERY");
      const focus = await askAgentBrain(ctx.llmKey, {
        system: DELIVERY_FOCUS_SYSTEM,
        payload: { brief: compactDeliveryBrief(r.brief), ownerInstructions },
        maxTokens: 400,
        usageSink: sink,
      });
      ctx.addTokens(sink.tokensIn, sink.tokensOut);
      if (focus) {
        await writeDeliveryAiFocus(env, focus).catch((e) =>
          console.warn("[delivery-agent] ai_focus write failed:", e),
        );
      }
    }

    return proposed > 0 ? `${r.summary} · ${proposed} transit proposal(s)` : r.summary;
  },
});

// ── Phase-2 engines: Collection / CS / Procurement / PMS ─────────────────────
// Each engine ships a bounded, already-compact brief (top-N rows, not tables),
// so the whole brief is handed to the shared brain (Delivery pre-compacts only
// because its brief is larger). The AI-focus pass is best-effort and budget-
// gated: no key / over budget / brain failure leaves ai_focus NULL and every
// deterministic number still ships. The brief tables (migrations 0094-0097)
// are all created_at-ordered.

/** Write the brain paragraph onto the newest snapshot of a created_at-ordered
 *  brief table. Table name is a module constant (never user input). */
async function writeLatestAiFocus(env: Env, table: string, focus: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE ${table} SET ai_focus = ?
      WHERE id = (SELECT id FROM ${table} ORDER BY created_at DESC LIMIT 1)`,
  )
    .bind(focus)
    .run();
}

/** First-run-of-day AI focus over an engine's brief (shared by the four
 *  Phase-2 engines). Honours the owner-feedback notebook; never sinks the run. */
async function maybeAiFocus(
  env: Env,
  ctx: AgentRunContext,
  family: string,
  system: string,
  briefTable: string,
  brief: unknown,
): Promise<void> {
  if (!ctx.llmKey) return;
  const sink: AgentBrainUsageSink = { tokensIn: 0, tokensOut: 0 };
  const ownerInstructions = await activeInstructions(env.DB, family);
  const focus = await askAgentBrain(ctx.llmKey, {
    system,
    payload: { brief, ownerInstructions },
    maxTokens: 400,
    usageSink: sink,
  });
  ctx.addTokens(sink.tokensIn, sink.tokensOut);
  if (focus) {
    await writeLatestAiFocus(env, briefTable, focus).catch((e) =>
      console.warn(`[${family.toLowerCase()}-agent] ai_focus write failed:`, e),
    );
  }
}

const COLLECTION_FOCUS_SYSTEM = [
  "You are the Collection Agent of Houzs, a Malaysian B2C furniture retailer.",
  "You are given today's deterministic accounts-receivable brief (all money in",
  "sen, RM x100). Write ONE short paragraph (3-5 sentences, plain English, no",
  "markdown, no emoji) telling the owner which debtors to chase first and why:",
  "the biggest and oldest balances, anything tipping into the 90+ bucket.",
  "Judgment and prioritisation only — never invent numbers not in the payload.",
  "Honour ownerInstructions when present.",
].join(" ");

registerAgent({
  family: "COLLECTION",
  task: "collection-run",
  cadence: { firstRunHour: 9.5, minGapHours: 6, maxRunsPerDay: 2 },
  run: async (env, ctx) => {
    const r = await runCollectionAgent(env);
    await maybeAiFocus(
      env,
      ctx,
      "COLLECTION",
      COLLECTION_FOCUS_SYSTEM,
      "collection_agent_briefs",
      r.brief,
    );
    return r.summary;
  },
});

const CS_FOCUS_SYSTEM = [
  "You are the Customer Service Agent of Houzs, a Malaysian B2C furniture",
  "retailer selling at roadshows and delivering with its own fleet. You are",
  "given today's deterministic CS brief: honest delivery-promise readiness (how",
  "many orders can be given a realistic date vs cannot yet) and after-sales SLA",
  "breaches. Write ONE short paragraph (3-5 sentences, plain English, no",
  "markdown, no emoji) on what needs a customer-facing decision today — orders",
  "whose promised date the supply chain cannot hit, and service cases past SLA.",
  "Never invent a delivery date; only speak to what the payload already computed.",
  "Honour ownerInstructions when present.",
].join(" ");

registerAgent({
  family: "CS",
  task: "cs-run",
  cadence: { firstRunHour: 8.5, minGapHours: 4, maxRunsPerDay: 3 },
  run: async (env, ctx) => {
    const r = await runCsAgent(env);
    await maybeAiFocus(env, ctx, "CS", CS_FOCUS_SYSTEM, "cs_agent_briefs", r.brief);
    return r.summary;
  },
});

const PROCUREMENT_FOCUS_SYSTEM = [
  "You are the Procurement Agent of Houzs, a Malaysian B2C furniture retailer",
  "that buys finished goods from suppliers to cover roadshow sales orders. You",
  "are given today's deterministic MRP brief (all money in sen, RM x100),",
  "including a supplier-coverage readiness gate. Write ONE short paragraph (3-5",
  "sentences, plain English, no markdown, no emoji): if the gate is closed, say",
  "so and point at the SKUs missing a supplier binding; otherwise call out the",
  "most urgent reorders by order-by date. Never invent costs or quantities not",
  "in the payload. Honour ownerInstructions when present.",
].join(" ");

registerAgent({
  family: "PROCUREMENT",
  task: "procurement-run",
  cadence: { firstRunHour: 8, minGapHours: 6, maxRunsPerDay: 2 },
  run: async (env, ctx) => {
    const r = await runProcurementAgent(env);

    /* Lead-time learning findings → PENDING config proposals (same path as the
       Delivery Agent's transit days: dedupes per param key, and approval —
       manual or AGENT_AUTO — goes through the whitelist gateway above).

       The agent proposes only the two axes it can measure, supplier punctuality
       and season. The owner's own (warehouse, category) table is never touched:
       these land as separate ADDITIVE buffers, so his number always survives and
       any buffer can be zeroed without disturbing another. */
    let proposed = 0;
    for (const l of r.learning) {
      const created = await createConfigProposal(env.DB, {
        paramKey: l.paramKey,
        currentValue: String(l.currentDays),
        proposedValue: String(l.proposedDays),
        reason: l.reason,
      }).catch(() => false);
      if (created) proposed++;
    }

    await maybeAiFocus(
      env,
      ctx,
      "PROCUREMENT",
      PROCUREMENT_FOCUS_SYSTEM,
      "procurement_agent_briefs",
      r.brief,
    );
    /* FULL AUTO (owner's Stage 2) — behind the gate that already exists, and
       OFF until he turns it on. It removes the human from PROPOSAL → APPROVED
       only: the PO still lands as a DRAFT someone must confirm, so the gate
       that faces a supplier is untouched. He reviews draft POs instead of
       proposals.

       Runs AFTER the sweep above, so this beat's own proposals are eligible in
       the same beat — matching the config path, which self-tunes immediately
       after its run. Never throws: a failed auto-approve must not sink the
       sweep that produced the proposals, and they survive as PENDING for a
       human either way. */
    let autoNote = '';
    const procStage = await effectiveStage(env.DB, "PROCUREMENT");
    if (procStage >= 2) {
      const auto = await autoApproveReorderProposals(env, "AGENT_AUTO", procStage).catch(
        (e): { approved: number; notes: string[]; errors: string[] } => ({
          approved: 0,
          notes: [],
          errors: [e instanceof Error ? e.message : String(e)],
        }),
      );
      if (auto.approved > 0) autoNote += ` · auto-approved ${auto.approved} reorder(s)`;
      if (auto.notes.length) autoNote += ` (${auto.notes.join('; ')})`;
      /* Loud in the run summary, not just a log line: an auto-approve that
         failed is the owner believing a PO exists when it does not. */
      if (auto.errors.length) autoNote += ` · ${auto.errors.length} auto-approve FAILED: ${auto.errors.join('; ')}`;
    }

    return (proposed > 0 ? `${r.summary} · ${proposed} lead-time proposal(s)` : r.summary) + autoNote;
  },
});

const PMS_FOCUS_SYSTEM = [
  "You are the Roadshow/Project (PMS) Agent of Houzs, a Malaysian B2C furniture",
  "retailer selling at exhibitions. You are given today's deterministic sales",
  "analytics brief (all money in sen, RM x100), broken down by category, brand,",
  "state, salesperson and venue, plus a per-dimension data-readiness gate. Write",
  "ONE short paragraph (3-5 sentences, plain English, no markdown, no emoji)",
  "surfacing the real signal — which category/brand/state leads on margin, which",
  "salesperson does especially well in which state — but explicitly discount any",
  "dimension whose readiness gate is closed (coverage too low to trust). Never",
  "invent numbers not in the payload. Honour ownerInstructions when present.",
].join(" ");

registerAgent({
  family: "PMS",
  task: "pms-run",
  cadence: { firstRunHour: 7, minGapHours: 12, maxRunsPerDay: 1 },
  run: async (env, ctx) => {
    const r = await runPmsAgent(env);
    await maybeAiFocus(env, ctx, "PMS", PMS_FOCUS_SYSTEM, "pms_agent_briefs", r.brief);
    return r.summary;
  },
});
