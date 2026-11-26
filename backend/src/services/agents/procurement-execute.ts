
import type { Env } from '../../types';
import { createDraftPosFromPicks } from '../../scm/routes/mfg-purchase-orders';
import { readAgentSetting } from '../agent-console';
import { PROCUREMENT_AGENT_SETTING_KEY } from './procurement-learning';
import { canSelfApprove } from './governance';
import { familyDataQuality } from './data-quality';
import { isScopeKilled, recordDecision } from './kill-scopes';

const DEFAULT_MAX_AUTO_APPROVE_UNITS = 500;
async function maxAutoApproveUnits(db: D1Database): Promise<number> {
  const cfg = await readAgentSetting<Record<string, unknown>>(db, PROCUREMENT_AGENT_SETTING_KEY);
  const n = Number(cfg?.maxAutoApproveUnits);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_AUTO_APPROVE_UNITS;
}

/** Sum of a REORDER proposal's pick quantities — the size proxy the Stage-2
 *  ceiling is measured against. Reads the payload the same way
 *  executeReorderProposal does. */
export function reorderUnits(payloadRaw: unknown): number {
  const payload = (typeof payloadRaw === 'string' ? safeParse(payloadRaw) : payloadRaw) as
    | { picks?: unknown }
    | null;
  const picks = Array.isArray(payload?.picks) ? payload.picks : [];
  return picks.reduce((sum, p) => {
    const q = Number((p as { qty?: unknown })?.qty);
    return sum + (Number.isFinite(q) && q > 0 ? q : 0);
  }, 0);
}

export type ApproveEffect =
  | { ok: true; note?: string }
  | { ok: false; error: string; reversible: boolean };

export interface ReorderProposalRow {
  kind?: string;
  payload?: unknown;
}

/**
 * WHO THE AGENT IS when it approves its own work.
 *
 * There is no default and there must not be one. A purchase order carries a
 * created_by, that column is an accountability record, and an agent inventing
 * an identity for itself — a system row, the first staff member it finds, the
 * owner because he is probably fine with it — is the agent deciding who is
 * answerable for an order. That is the owner's call, expressed by naming a
 * staff member in app_settings['agents.procurement'].actorStaffId.
 *
 * Unset → the full-auto path does nothing and says why. The gate being on is
 * not consent to be attributed to someone who never agreed to it.
 */
export async function resolveAgentActorStaffId(db: D1Database): Promise<string | null> {
  const cfg = await readAgentSetting<Record<string, unknown>>(db, PROCUREMENT_AGENT_SETTING_KEY);
  const raw = cfg?.actorStaffId;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const id = raw.trim();
  const hit = await db
    .prepare(`SELECT id FROM scm.staff WHERE id = ? AND active = true`)
    .bind(id)
    .first<{ id: string }>();
  return hit?.id ?? null;
}

/** public.users id → scm.staff UUID. /api/agents authenticates with the public
 *  bigint (its own header says so); PO.created_by is an scm.staff UUID. Mapped
 *  the way pos.ts does. No fallback — stamping a PO to the wrong identity, or to
 *  a system row, is worse than refusing to raise it. */
export async function staffIdForUser(db: D1Database, userId: unknown): Promise<string | null> {
  if (userId == null) return null;
  const hit = await db
    .prepare(`SELECT id FROM scm.staff WHERE user_id = ?`)
    .bind(userId)
    .first<{ id: string }>();
  return hit?.id ?? null;
}

/**
 * Raise the DRAFT POs an approved REORDER proposal describes.
 *
 * `actorStaffId` is stamped as created_by and is REQUIRED — both callers resolve
 * their own, because "who did this" has a different answer for a click than for
 * a heartbeat and neither should guess the other's.
 */
export async function executeReorderProposal(
  env: Env,
  row: ReorderProposalRow,
  actorStaffId: string,
): Promise<ApproveEffect> {
  if (String(row.kind ?? '').toUpperCase() !== 'REORDER') {
    return { ok: true };
  }

  const payload = (typeof row.payload === 'string'
    ? safeParse(row.payload)
    : row.payload) as { picks?: unknown; companyId?: unknown; companyCode?: unknown } | null;

  const picks = (Array.isArray(payload?.picks) ? payload.picks : [])
    .map((p) => p as { soItemId?: unknown; qty?: unknown })
    .filter((p) => typeof p.soItemId === 'string' && p.soItemId !== '' && Number(p.qty) > 0)
    .map((p) => ({ soItemId: String(p.soItemId), qty: Number(p.qty) }));
  if (picks.length === 0) {
    return {
      ok: false,
      error: 'This proposal has nothing to order. Please raise the purchase order from the MRP page.',
      reversible: true,
    };
  }

  const planCompanyId = Number(payload?.companyId);
  const hasCompany = Number.isInteger(planCompanyId) && planCompanyId > 0;
  if (payload?.companyId != null && !hasCompany) {
    return {
      ok: false,
      error: `proposal carries an unusable companyId (${String(payload.companyId)})`,
      reversible: true,
    };
  }

  const out = await createDraftPosFromPicks(env, {
    userId: actorStaffId,
    companyId: hasCompany ? planCompanyId : null,
    allowedCompanyIds: hasCompany ? [planCompanyId] : undefined,
    companyCode: typeof payload?.companyCode === 'string' ? payload.companyCode : null,
    picks,
  });

  const body = out.body as {
    created?: Array<{ poNumber?: string }>;
    dropped?: Array<{ reason?: string }>;
    error?: string;
  };
  const created = Array.isArray(body.created) ? body.created : [];
  if (out.status >= 400 || created.length === 0) {
    return {
      ok: false,
      error: body.error ?? `converter created no PO (status ${out.status})`,
      reversible: true,
    };
  }

  const numbers = created.map((p) => p.poNumber).filter(Boolean).join(', ');
  if (body.dropped?.length) {
    return {
      ok: false,
      error:
        `raised ${created.length} draft PO(s) (${numbers}) but ${body.dropped.length} bucket(s) failed: ` +
        `${body.dropped.map((d) => d.reason ?? 'unknown').join('; ')} — the rest must be raised by hand`,
      reversible: false,
    };
  }
  return { ok: true, note: `raised ${created.length} draft PO(s): ${numbers}` };
}

/**
 * FULL AUTO (owner's Stage 2: "自动 Submit 和 Approve").
 *
 * Approves the agent's own PENDING reorders and raises their DRAFT POs, exactly
 * as the console's approve button does — same executor, same claim, same
 * evidence-based reversibility. The mirror of autoApplyConfigProposals, which
 * does this for the learner's parameters.
 *
 * WHAT THIS GATE DOES AND DOES NOT REMOVE. It removes the human from
 * PROPOSAL → APPROVED. It does not touch PO DRAFT → SUBMITTED, which is still a
 * person confirming. So the owner stops reviewing proposals and starts reviewing
 * draft POs — one gate, not two, and the remaining one is the one that faces a
 * supplier. Stage 3 (auto-confirm + auto-send) is a separate decision and is not
 * enabled by this.
 *
 * Returns a count and the notes/errors for the run summary. Never throws: a
 * failed auto-approve must not sink the sweep that produced the proposals, and
 * the proposals survive as PENDING for a human either way.
 */
export async function autoApproveReorderProposals(
  env: Env,
  decidedBy: string,
  reqStage = 2,
): Promise<{ approved: number; notes: string[]; errors: string[] }> {
  const db = env.DB;
  const out = { approved: 0, notes: [] as string[], errors: [] as string[] };

  const actorStaffId = await resolveAgentActorStaffId(db);
  if (!actorStaffId) {
    out.errors.push(
      'auto-approve is on but agents.procurement.actorStaffId names no active staff member — no PO raised',
    );
    return out;
  }

  const res = await db
    .prepare(
      `SELECT * FROM procurement_agent_proposals
        WHERE status = 'PENDING' AND kind = 'REORDER'
        ORDER BY created_at ASC LIMIT 100`,
    )
    .all<{ id: string; kind?: string; payload?: unknown }>();

  const unitLimit = await maxAutoApproveUnits(db);
  const dq = await familyDataQuality(db, 'procurement-run', 6);
  if (dq.status !== 'GREEN') {
    out.errors.push(`auto-approve held — data-quality ${dq.status}: ${dq.reason}`);
    return out;
  }
  const nowIso = new Date().toISOString();
  for (const row of res.results ?? []) {
    const gate = canSelfApprove({
      agent: 'HZS-REP-004',
      decisionClass: 'EXTERNAL_PO',
      stage: reqStage as 1 | 2 | 3,
      dataQuality: dq.status,
      valueProxy: reorderUnits(row.payload),
      limit: unitLimit,
    });
    if (!gate.ok) {
      out.notes.push(`held for human — ${row.id}: ${gate.reason}`);
      continue;
    }

    const planCompany = (() => {
      const pl = (typeof row.payload === 'string' ? safeParse(row.payload) : row.payload) as { companyId?: unknown } | null;
      const n = Number(pl?.companyId);
      return Number.isInteger(n) && n > 0 ? n : null;
    })();
    const companyKill = await isScopeKilled(db, 'COMPANY', planCompany);
    if (companyKill.killed) {
      out.notes.push(`held — ${row.id}: ${companyKill.reason}`);
      continue;
    }

    const claim = await db
      .prepare(
        `UPDATE procurement_agent_proposals
            SET status = 'APPROVED', decided_at = ?, decided_by = ?
          WHERE id = ? AND status = 'PENDING'`,
      )
      .bind(nowIso, decidedBy, row.id)
      .run();
    if (!(Number(claim.meta?.changes ?? claim.meta?.rows_written ?? 0) > 0)) continue;

    let effect: ApproveEffect;
    try {
      effect = await executeReorderProposal(env, row, actorStaffId);
    } catch (e) {
      effect = { ok: false, error: e instanceof Error ? e.message : String(e), reversible: false };
    }

    if (effect.ok) {
      out.approved++;
      if (effect.note) out.notes.push(effect.note);
      await recordDecision(db, {
        agent: 'HZS-REP-004',
        family: 'PROCUREMENT',
        decisionClass: 'EXTERNAL_PO',
        statement: `Self-approved reorder ${row.id} and raised the DRAFT purchase order(s) it describes.`,
        reason: 'Stage-2 auto-approve is on and the reorder passed every gate.',
        evidence: [{ ref: `procurement_agent_proposals/${row.id}`, at: nowIso, freshness: dq.status }],
        options: [
          { label: 'Raise the DRAFT PO now (taken)' },
          { label: 'Leave it pending for a human', isDoNothing: true },
        ],
        impact: `${reorderUnits(row.payload)} unit(s) committed to a DRAFT purchase order awaiting human confirmation.`,
        policy: `governance.canSelfApprove(HZS-REP-004, EXTERNAL_PO) at Stage 2, unit ceiling ${unitLimit}`,
        confidence: 1,
        dataQuality: dq.status,
        reversible: true,
        rollback: 'Cancel the DRAFT purchase order; no supplier has been contacted.',
        verification: 'The PO exists in DRAFT and a human must still confirm it before it is live.',
        approver: 'AGENT_AUTO',
        approvalRequired: false,
        outcome: effect.note ?? 'DRAFT PO raised',
      });
      continue;
    }
    out.errors.push(`${row.id}: ${effect.error}`);
    if (!effect.reversible) continue;
    await db
      .prepare(
        `UPDATE procurement_agent_proposals
            SET status = 'PENDING', decided_at = NULL, decided_by = NULL
          WHERE id = ? AND status = 'APPROVED'`,
      )
      .bind(row.id)
      .run();
  }
  return out;
}

function safeParse(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
