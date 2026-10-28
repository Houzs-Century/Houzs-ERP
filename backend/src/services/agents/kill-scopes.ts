// ---------------------------------------------------------------------------
// kill-scopes.ts — the finer halves of the §10.6 kill switch, and the decision
// packet recorder (§9.4 / §10.6 "immutable decision and action history").
//
// agent_controls already gives the GLOBAL switch and the per-FAMILY pause. With
// two companies on one backend, "stop the agents for 2990 while we sort its data
// out" had no expression short of stopping them for Houzs too. Scopes fix that.
//
// FAIL-SAFE DIRECTION: a scope read that throws is treated as KILLED, not as
// clear. A kill switch that fails open is not a kill switch — it is a comment
// with a database behind it. (The opposite of the family pause, which fails OPEN
// deliberately so a blip cannot silently halt the whole fleet; a targeted scope
// is a deliberate, narrow stop, so its failure mode is the cautious one.)
// ---------------------------------------------------------------------------

import type { DataQuality } from './governance';

export type KillScopeType = 'COMPANY' | 'CLASS' | 'TOOL';

export interface KillScopeRow {
  scopeType: KillScopeType;
  scopeValue: string;
  paused: boolean;
  reason: string | null;
  updatedAt: string | null;
}

/** Is this specific scope killed? Unknown/unreadable → treated as KILLED. */
export async function isScopeKilled(
  db: D1Database,
  scopeType: KillScopeType,
  scopeValue: string | number | null | undefined,
): Promise<{ killed: boolean; reason: string | null }> {
  if (scopeValue == null || String(scopeValue).trim() === '') {
    return { killed: false, reason: null }; // nothing to match — not a kill
  }
  try {
    const row = await db
      .prepare(
        `SELECT paused, reason FROM agent_kill_scopes
          WHERE scope_type = ? AND scope_value = ? LIMIT 1`,
      )
      .bind(scopeType, String(scopeValue))
      .first<{ paused?: number | string | null; reason?: string | null }>();
    if (!row) return { killed: false, reason: null };
    const killed = Number(row.paused) === 1;
    return { killed, reason: killed ? (row.reason ?? `${scopeType} ${scopeValue} is stopped`) : null };
  } catch (e) {
    // Cannot prove it is clear → treat as stopped. See the header.
    return {
      killed: true,
      reason: `could not read the kill scopes (${String((e as Error)?.message ?? e).slice(0, 80)}) — treating ${scopeType} ${scopeValue} as stopped`,
    };
  }
}

export async function listKillScopes(db: D1Database): Promise<KillScopeRow[]> {
  try {
    const res = await db
      .prepare(`SELECT * FROM agent_kill_scopes ORDER BY scope_type, scope_value`)
      .all<Record<string, unknown>>();
    return (res.results ?? []).map((r) => ({
      scopeType: String(r.scopeType ?? r.scope_type) as KillScopeType,
      scopeValue: String(r.scopeValue ?? r.scope_value),
      paused: Number(r.paused) === 1,
      reason: (r.reason as string | null) ?? null,
      updatedAt: (r.updatedAt ?? r.updated_at ?? null) as string | null,
    }));
  } catch {
    return [];
  }
}

export async function setKillScope(
  db: D1Database,
  p: { scopeType: KillScopeType; scopeValue: string; paused: boolean; reason?: string | null; updatedBy?: string | null },
): Promise<void> {
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO agent_kill_scopes (id, scope_type, scope_value, paused, reason, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (scope_type, scope_value) DO UPDATE SET
         paused = excluded.paused, reason = excluded.reason,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(crypto.randomUUID(), p.scopeType, p.scopeValue, p.paused ? 1 : 0, p.reason ?? null, nowIso, p.updatedBy ?? null)
    .run();
}

// ── Decision packets (§9.4) ─────────────────────────────────────────────────

export interface DecisionRecord {
  agent: string;              // spec agent id, e.g. 'HZS-REP-004'
  family?: string | null;     // code family, e.g. 'PROCUREMENT'
  decisionClass: string;
  statement: string;
  reason?: string | null;
  evidence?: unknown[];
  options?: unknown[];
  impact?: string | null;
  policy?: string | null;
  confidence?: number | null;
  dataQuality?: DataQuality | null;
  reversible?: boolean;
  rollback?: string | null;
  verification?: string | null;
  approver?: string | null;       // user id, or 'AGENT_AUTO'
  approvalRequired?: boolean;
  outcome?: string | null;
}

/**
 * Write ONE decision packet. Append-only by intent — there is no update path
 * here, so a decision that turned out wrong is answered with a NEW row rather
 * than by editing the old one.
 *
 * Best-effort: recording the reasoning must never fail the decision it describes
 * (the same rule the audit writer follows). A failure is logged, not thrown.
 */
export async function recordDecision(db: D1Database, d: DecisionRecord): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO agent_decisions
           (id, agent, family, decision_class, statement, reason, evidence, options, impact,
            policy, confidence, data_quality, reversible, rollback, verification,
            approver, approval_required, outcome, created_at)
         VALUES (?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        crypto.randomUUID(), d.agent, d.family ?? null, d.decisionClass, d.statement,
        d.reason ?? null, JSON.stringify(d.evidence ?? []), JSON.stringify(d.options ?? []),
        d.impact ?? null, d.policy ?? null,
        d.confidence == null ? null : d.confidence,
        d.dataQuality ?? null, d.reversible ? 1 : 0, d.rollback ?? null, d.verification ?? null,
        d.approver ?? null, d.approvalRequired === false ? 0 : 1, d.outcome ?? null,
        new Date().toISOString(),
      )
      .run();
  } catch (e) {
    console.warn('[agent-decisions] record failed:', e);
  }
}
