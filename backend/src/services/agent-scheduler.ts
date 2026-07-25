// ---------------------------------------------------------------------------
// agent-scheduler.ts — the agents' SELF-scheduling brain + heartbeat runner.
// Ported from HOOKKA (src/api/lib/agent-scheduler.ts + the heartbeat route's
// execution loop; owner OK 2026-07-13).
//
// A dumb heartbeat (the existing `*/30 * * * *` Worker cron) beats; nothing
// about cadence lives in the cron. Each beat, decideAgentRuns() looks at the
// business's own pulse and decides which agents should run right now:
//
//   • how long since the last run, how many runs already today
//   • the agent's own event-driven trigger (new deliveries, new docs, ...)
//
// Every decision — run or skip — carries a human-readable reason that lands
// in the agent_runs summary, so the console always shows WHY the agent chose
// to move. The owner keeps exactly three overrides: per-family Pause, the
// global kill switch, and the HARD_* bounds below (structural, not
// configurable). Thresholds are tunable via app_settings['agents.schedule'].
//
// HOUZS ADAPTATIONS:
//   * Generic REGISTRY instead of HOOKKA's hardcoded delivery/production
//     blocks — the Delivery and Document engines each register ONE entry
//     (registerAgent) and the decision pass + heartbeat pick them up.
//   * Heartbeat = Worker cron (no GH-Actions HTTP trigger; the house has no
//     internal-cron-route pattern — CF cron + the console's Run-now cover it;
//     the DASHBOARD_API_KEY service user can hit Run-now for tooling).
// ---------------------------------------------------------------------------

import type { Env } from "../types";
import {
  type AgentFamily,
  autoApplyConfigProposals,
  isAgentPaused,
  effectiveStage,
  isKillSwitchOn,
  llmKeyIfBudgetAllows,
  mytDate,
  mytDayRangeUtc,
  readAgentSetting,
  reapStaleAgentRuns,
  recordAgentRun,
  AGENT_SCHEDULE_SETTING_KEY,
  MYT_OFFSET_MS,
} from "./agent-console";
import { canSelfTuneConfig } from "./agents/governance";
import { familyDataQuality } from "./agents/data-quality";

// Structural bounds — an agent can never talk itself past these.
const HARD_MAX_RUNS_PER_DAY = 6;
const HARD_MIN_GAP_HOURS = 1;

export interface AgentCadence {
  /** MYT hour (fraction ok) before which the daily first run won't fire. */
  firstRunHour: number;
  minGapHours: number;
  maxRunsPerDay: number;
}

export interface AgentRunContext {
  /** True on the day's first run — the only run that gets an LLM key. */
  firstOfDay: boolean;
  /** Why the scheduler fired this run (lands in the run summary). */
  reason: string;
  /** ANTHROPIC key when firstOfDay + monthly budget has headroom, else undefined. */
  llmKey: string | undefined;
  /** Report Anthropic token usage so the console shows real spend. */
  addTokens: (tokensIn: number, tokensOut: number) => void;
}

export interface RegisteredAgent {
  family: AgentFamily;
  /** agent_runs task id, e.g. "delivery-run" / "document-run". */
  task: string;
  /** Cadence defaults; per-task overrides live in app_settings['agents.schedule'][task]. */
  cadence: AgentCadence;
  /**
   * OPTIONAL event-driven trigger past the day's first run: given the last
   * run time, decide whether business activity justifies an extra run.
   * Pure reads only — the decision pass never writes.
   */
  shouldRunExtra?: (
    db: D1Database,
    sinceIso: string,
  ) => Promise<{ fire: boolean; reason: string }>;
  /** Execute one run. Return the console summary line. */
  run: (env: Env, ctx: AgentRunContext) => Promise<string>;
}

const REGISTRY = new Map<string, RegisteredAgent>();

/**
 * REGISTRATION POINT for the Delivery / Document engines (built next):
 * call once at module load (e.g. from the engine's own service file, imported
 * by routes/agent-console.ts) and the scheduler + console pick the agent up.
 */
export function registerAgent(reg: RegisteredAgent): void {
  REGISTRY.set(reg.task, reg);
}

export function registeredAgents(): RegisteredAgent[] {
  return [...REGISTRY.values()];
}

export function getRegisteredAgent(task: string): RegisteredAgent | undefined {
  return REGISTRY.get(task);
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** Effective cadence = registered defaults + clamped app_settings overrides. */
export async function loadCadence(
  db: D1Database,
  reg: RegisteredAgent,
): Promise<AgentCadence> {
  const sched = await readAgentSetting<Record<string, Record<string, unknown>>>(
    db,
    AGENT_SCHEDULE_SETTING_KEY,
  );
  const o = sched?.[reg.task] ?? {};
  return {
    firstRunHour: clampNum(o.firstRunHour, 6, 12, reg.cadence.firstRunHour),
    minGapHours: clampNum(o.minGapHours, HARD_MIN_GAP_HOURS, 12, reg.cadence.minGapHours),
    maxRunsPerDay: clampNum(o.maxRunsPerDay, 1, HARD_MAX_RUNS_PER_DAY, reg.cadence.maxRunsPerDay),
  };
}

export interface AgentRunDecision {
  task: string;
  reason: string;
  /** True on the first run of the day — the only run that spends LLM tokens. */
  firstOfDay: boolean;
}

export interface HeartbeatDecisions {
  decisions: AgentRunDecision[];
  skipped: Array<{ task: string; reason: string }>;
}

interface TaskStats {
  lastRunIso: string | null;
  runsToday: number;
}

/**
 * Last run + runs-so-far-today for one task.
 *
 * `today` is bucketed by the UTC instant range the MYT day covers, NOT by
 * substr(started_at, 1, 10): started_at is UTC, todayMyt is the Malaysian date,
 * and the two disagree from 16:00 UTC onward. PMS (07:00 MYT) and DELIVERY
 * (07:30 MYT) fire inside that gap, so their runs were stamped with the
 * previous UTC date and counted as zero — and since decideAgentRuns treats
 * runsToday === 0 as "first run of the day" without ever reaching the min-gap
 * check, they re-fired every beat until 08:00 MYT, each one burning an LLM key.
 *
 * status <> 'error' stays: a live 'running' row is the de-facto mutex that
 * stops two overlapping heartbeats firing one agent twice. It must keep
 * counting; only the reaper retires it (see reapStaleAgentRuns).
 */
async function taskStats(
  db: D1Database,
  task: string,
  todayMyt: string,
): Promise<TaskStats> {
  const { startIso, endIso } = mytDayRangeUtc(todayMyt);
  try {
    const row = await db
      .prepare(
        `SELECT MAX(started_at) AS last,
                SUM(CASE WHEN started_at >= ? AND started_at < ? THEN 1 ELSE 0 END) AS today
           FROM agent_runs WHERE agent = ? AND status <> 'error'`,
      )
      .bind(startIso, endIso, task)
      .first<{ last?: string | null; today?: number | string | null }>();
    return {
      lastRunIso: row?.last ?? null,
      runsToday: Number(row?.today) || 0,
    };
  } catch {
    return { lastRunIso: null, runsToday: 0 };
  }
}

function gapHours(lastRunIso: string | null, nowMs: number): number {
  if (!lastRunIso) return Infinity;
  const t = new Date(lastRunIso).getTime();
  return Number.isNaN(t) ? Infinity : (nowMs - t) / 36e5;
}

/**
 * The decision pass — pure reads, no writes, no LLM. `now` is injectable for
 * tests; defaults to the real clock. MYT (UTC+8) drives "today" and the
 * first-run-of-day rule.
 */
export async function decideAgentRuns(
  db: D1Database,
  now: Date = new Date(),
): Promise<HeartbeatDecisions> {
  const nowMs = now.getTime();
  const myt = new Date(nowMs + MYT_OFFSET_MS);
  const todayMyt = mytDate(now);
  const hourMyt = myt.getUTCHours() + myt.getUTCMinutes() / 60;

  const decisions: AgentRunDecision[] = [];
  const skipped: Array<{ task: string; reason: string }> = [];

  for (const reg of REGISTRY.values()) {
    if (await isAgentPaused(db, reg.family)) {
      skipped.push({ task: reg.task, reason: "paused (console)" });
      continue;
    }
    const cfg = await loadCadence(db, reg);
    const st = await taskStats(db, reg.task, todayMyt);
    if (st.runsToday === 0) {
      if (hourMyt >= cfg.firstRunHour) {
        decisions.push({
          task: reg.task,
          reason: "first run of the day (self-scheduled)",
          firstOfDay: true,
        });
      } else {
        skipped.push({
          task: reg.task,
          reason: `before first-run hour (${cfg.firstRunHour}:00 MYT)`,
        });
      }
      continue;
    }
    if (st.runsToday >= cfg.maxRunsPerDay) {
      skipped.push({
        task: reg.task,
        reason: `daily cap reached (${st.runsToday}/${cfg.maxRunsPerDay})`,
      });
      continue;
    }
    if (gapHours(st.lastRunIso, nowMs) < cfg.minGapHours) {
      skipped.push({
        task: reg.task,
        reason: `ran ${Math.round(gapHours(st.lastRunIso, nowMs) * 10) / 10}h ago (< ${cfg.minGapHours}h gap)`,
      });
      continue;
    }
    if (!reg.shouldRunExtra) {
      skipped.push({
        task: reg.task,
        reason: "already ran today (no event-driven trigger registered)",
      });
      continue;
    }
    const since = st.lastRunIso ?? `${todayMyt}T00:00:00Z`;
    try {
      const extra = await reg.shouldRunExtra(db, since);
      if (extra.fire) {
        decisions.push({ task: reg.task, reason: extra.reason, firstOfDay: false });
      } else {
        skipped.push({ task: reg.task, reason: extra.reason });
      }
    } catch (e) {
      console.warn(`[agent-scheduler] ${reg.task} extra-trigger failed:`, e);
      skipped.push({ task: reg.task, reason: "extra-trigger errored (skipping)" });
    }
  }

  return { decisions, skipped };
}

export interface HeartbeatResult {
  ran: Array<{ task: string; reason: string; summary?: string }>;
  skipped: Array<{ task: string; reason: string }>;
}

/**
 * Execute ONE registered task inside recordAgentRun (console visibility +
 * token accounting), with the decision's REASON in the run summary. Shared by
 * the heartbeat and the console's Run-now. After a successful run, a family
 * with the auto-approve gate ON self-tunes its whitelisted parameters
 * (bounded + logged — see autoApplyConfigProposals).
 */
export async function executeAgentTask(
  env: Env,
  reg: RegisteredAgent,
  d: { reason: string; firstOfDay: boolean },
): Promise<string> {
  const db = env.DB;
  return recordAgentRun(db, reg.task, async (run) => {
    const llmKey = d.firstOfDay
      ? await llmKeyIfBudgetAllows(db, env.ANTHROPIC_API_KEY, reg.family)
      : undefined;
    let summary = await reg.run(env, {
      firstOfDay: d.firstOfDay,
      reason: d.reason,
      llmKey,
      addTokens: (i, o) => run.addTokens(i, o),
    });
    const cfgStage = await effectiveStage(db, reg.family);
    if (cfgStage >= 2) {
      /* Owner decision "B" (2026-07-18): every family's config self-approval goes
         through governance. auto_approve on = Stage 2; data-quality is asserted
         GREEN here (a real G/A/R signal per family is a later step, as on the
         procurement path). canSelfTuneConfig refuses at Stage 1 / on RED, so the
         flag is no longer an ungoverned blanket — behaviour-preserving for the
         normal green case. */
      /* The REAL data-quality signal now (was hard-coded GREEN, which made the
         §10.2 gate inert). Computed from this family's own run history. */
      const dq = await familyDataQuality(db, reg.task, reg.cadence.minGapHours);
      const gate = canSelfTuneConfig({ stage: cfgStage, dataQuality: dq.status });
      if (gate.ok) {
        const params = await autoApplyConfigProposals(db, reg.family, "AGENT_AUTO").catch(
          () => 0,
        );
        if (params > 0) summary += ` · self-tuned ${params} param(s)`;
      } else {
        summary += ` · config self-tune held (${gate.reason}: ${dq.reason})`;
      }
    }
    summary = `${summary} (${d.reason})`;
    run.setSummary(summary);
    return summary;
  });
}

/**
 * One heartbeat: reap, honour the kill switch, decide, execute. One agent's
 * failure never blocks another's beat (the error row is already in agent_runs
 * via recordAgentRun). Safe to call every 30 min — the scheduler's own >=1h
 * min-gap makes it an effective hourly heartbeat.
 *
 * The reap runs FIRST and ahead of every guard: decideAgentRuns counts open
 * runs against the daily cap, so a killed run must be closed before taskStats
 * reads it or it holds a slot until midnight. It precedes the kill switch and
 * the registry check because closing a dead row is bookkeeping, not running an
 * agent — the console should stop showing a run that never ends even while the
 * fleet is stopped, and the quota is then already clean when it restarts.
 */
export async function runAgentHeartbeat(env: Env): Promise<HeartbeatResult> {
  const db = env.DB;
  await reapStaleAgentRuns(db);
  if (REGISTRY.size === 0) {
    return { ran: [], skipped: [{ task: "ALL", reason: "no agents registered" }] };
  }
  if (await isKillSwitchOn(db)) {
    return { ran: [], skipped: [{ task: "ALL", reason: "kill switch" }] };
  }
  const { decisions, skipped } = await decideAgentRuns(db);
  const ran: HeartbeatResult["ran"] = [];
  for (const d of decisions) {
    const reg = REGISTRY.get(d.task);
    if (!reg) continue;
    try {
      const summary = await executeAgentTask(env, reg, d);
      ran.push({ task: d.task, reason: d.reason, summary });
    } catch (err) {
      console.error(`[agent-heartbeat] ${d.task} failed:`, err);
      skipped.push({ task: d.task, reason: "run errored (see agent_runs)" });
    }
  }
  return { ran, skipped };
}
