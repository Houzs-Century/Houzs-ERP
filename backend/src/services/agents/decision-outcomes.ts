
export type OutcomeKind = 'EXECUTED' | 'FAILED' | 'VERIFIED' | 'CONTRADICTED' | 'SKIPPED';

export interface OutcomeRow {
  decisionId: string;
  agent: string;
  kind: OutcomeKind;
  detail?: string | null;
  recoveryRef?: string | null;
  observedAt: string;
  observedBy?: string | null;
}

/** Write ONE observation. Best-effort, like recordDecision: failing to record an
 *  observation must never fail the operation being observed. */
export async function recordOutcome(
  db: D1Database,
  o: Omit<OutcomeRow, 'observedAt'> & { observedAt?: string },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO agent_decision_outcomes
           (id, decision_id, agent, kind, detail, recovery_ref, observed_at, observed_by)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(
        crypto.randomUUID(), o.decisionId, o.agent, o.kind,
        o.detail ?? null, o.recoveryRef ?? null,
        o.observedAt ?? new Date().toISOString(), o.observedBy ?? null,
      )
      .run();
  } catch (e) {
    console.warn('[agent-decision-outcomes] record failed:', e);
  }
}

export interface PromotionEvidence {
  decisionsObserved: number;
  executed: number;
  failed: number;
  verified: number;
  contradicted: number;
  skipped: number;
  executedButUnverified: number;
  unrecovered: number;
  autoPromote: false;
  concerns: string[];
}

/**
 * Fold observations into evidence, per decision (not per row) so an agent that
 * logs three observations for one action does not look three times as busy.
 *
 * A decision's kind is resolved by PRECEDENCE, not by recency: CONTRADICTED beats
 * VERIFIED beats FAILED beats EXECUTED beats SKIPPED. A later "verified" must not
 * erase an earlier contradiction — the bad news is the part worth keeping.
 */
export function summarisePromotionEvidence(rows: readonly OutcomeRow[]): PromotionEvidence {
  const byDecision = new Map<string, OutcomeRow[]>();
  for (const r of rows) {
    const list = byDecision.get(r.decisionId) ?? [];
    list.push(r);
    byDecision.set(r.decisionId, list);
  }

  const ev: PromotionEvidence = {
    decisionsObserved: byDecision.size,
    executed: 0, failed: 0, verified: 0, contradicted: 0, skipped: 0,
    executedButUnverified: 0, unrecovered: 0,
    autoPromote: false, concerns: [],
  };

  for (const list of byDecision.values()) {
    const kinds = new Set(list.map((r) => r.kind));
    if (kinds.has('CONTRADICTED')) ev.contradicted += 1;
    else if (kinds.has('VERIFIED')) ev.verified += 1;
    else if (kinds.has('FAILED')) ev.failed += 1;
    else if (kinds.has('EXECUTED')) ev.executed += 1;
    else if (kinds.has('SKIPPED')) ev.skipped += 1;

    if (kinds.has('EXECUTED') && !kinds.has('VERIFIED') && !kinds.has('CONTRADICTED')) {
      ev.executedButUnverified += 1;
    }
    const bad = list.filter((r) => r.kind === 'FAILED' || r.kind === 'CONTRADICTED');
    if (bad.length > 0 && !bad.some((r) => (r.recoveryRef ?? '').trim() !== '')) {
      ev.unrecovered += 1;
    }
  }

  if (ev.decisionsObserved === 0) {
    ev.concerns.push('no observed decisions — there is no track record to promote on');
  }
  if (ev.contradicted > 0) {
    ev.concerns.push(`${ev.contradicted} decision(s) produced a result that contradicted the prediction`);
  }
  if (ev.unrecovered > 0) {
    ev.concerns.push(`${ev.unrecovered} failed/contradicted decision(s) have no recovery task`);
  }
  if (ev.executedButUnverified > 0) {
    ev.concerns.push(
      `${ev.executedButUnverified} decision(s) were executed but never verified — a clean record of unchecked actions is not a clean record`,
    );
  }
  return ev;
}
