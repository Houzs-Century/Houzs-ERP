import type { Env } from "../../types";
import { registerAgent, type AgentRunContext } from "../agent-scheduler";
import {
  CONFIG_PROPOSAL_RULES,
  activeInstructions,
  createConfigProposal,
  effectiveStage,
} from "../agent-console";
import { autoApproveReorderProposals } from "./procurement-execute";
import { AGENT_BRAIN_MODEL, askAgentBrain, type AgentBrainUsageSink } from "../agent-brain";
import { agentFeature } from "../aiUsage";
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

import "./document-agent";
import "./of-agent";
import "./si-agent";


CONFIG_PROPOSAL_RULES.push(DELIVERY_TRANSIT_RULE);

CONFIG_PROPOSAL_RULES.push(PROCUREMENT_SUPPLIER_BUFFER_RULE);
CONFIG_PROPOSAL_RULES.push(PROCUREMENT_SEASON_BUFFER_RULE);

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
  cadence: { firstRunHour: 7.5, minGapHours: 1, maxRunsPerDay: 4 },
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

    if (ctx.llmKey) {
      const sink: AgentBrainUsageSink = { tokensIn: 0, tokensOut: 0 };
      const ownerInstructions = await activeInstructions(env.DB, "DELIVERY");
      const focus = await askAgentBrain(ctx.llmKey, {
        system: DELIVERY_FOCUS_SYSTEM,
        payload: { brief: compactDeliveryBrief(r.brief), ownerInstructions },
        maxTokens: 400,
        usageSink: sink,
        aiUsage: { env, feature: agentFeature("DELIVERY"), model: AGENT_BRAIN_MODEL, companyId: null, userId: null, waitUntil: null },
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


async function writeLatestAiFocus(env: Env, table: string, focus: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE ${table} SET ai_focus = ?
      WHERE id = (SELECT id FROM ${table} ORDER BY created_at DESC LIMIT 1)`,
  )
    .bind(focus)
    .run();
}

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
    aiUsage: { env, feature: agentFeature(family), model: AGENT_BRAIN_MODEL, companyId: null, userId: null, waitUntil: null },
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
