// ---------------------------------------------------------------------------
// procurement-execute.ts — what an APPROVED reorder proposal actually does.
//
// Split out of routes/agent-console.ts because two callers need it and they
// have nothing else in common:
//   - the console's approve button, acting AS the human who clicked it;
//   - the full-auto path (owner's Stage 2), acting as a staff member he has
//     explicitly nominated.
// Leaving it in the route would have forced the headless caller to fake a Hono
// context, which is exactly the mistake companyDocPrefix's comment records
// ("[object Object]-SO-2607-001").
//
// THE RED LINE, restated because this file is where it looks like it moves:
// procurement-agent.ts (the ENGINE) still never touches scm.purchase_orders. It
// proposes. This module executes a DECISION someone made about a proposal, and
// what it creates is a DRAFT PO that a human must still confirm. Approve, then
// confirm — two gates. Turning the auto-approve gate on removes the FIRST gate,
// never the second: nothing here can put a PO in front of a supplier.
// ---------------------------------------------------------------------------

import type { Env } from '../../types';
import { createDraftPosFromPicks } from '../../scm/routes/mfg-purchase-orders';
import { readAgentSetting } from '../agent-console';
import { PROCUREMENT_AGENT_SETTING_KEY } from './procurement-learning';
import { canSelfApprove } from './governance';
import { familyDataQuality } from './data-quality';
import { isScopeKilled, recordDecision } from './kill-scopes';

/**
 * The Stage-2 self-approval ceiling for a reorder, in UNITS ordered, read from
 * app_settings['agents.procurement'].maxAutoApproveUnits. This is the
 * "Low-value catalogue within limit" cell of the spec's EXTERNAL_PO row
 * (docs/agents/operating-spec.md §6.8): above it, a reorder is a human's call.
 *
 * Default 500. A conservative ceiling, not "no ceiling": the spec forbids
 * auto-approve from meaning "approve everything" (§1.2), so the absence of a
 * configured limit must still BE a limit, never unbounded.
 */
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

/* Returning ok=false with reversible=true means NOTHING was created and the
   proposal is safe to hand back to PENDING. reversible=false means something
   WAS created and it must stay decided, because replaying it would do that part
   twice. The distinction is evidence, not optimism — see the created.length
   check below. */
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
  // Verify it is a real, active staff row rather than trusting the setting: a
  // stale id would stamp POs to a person who has left.
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
    return { ok: true }; // nothing to execute for other kinds
  }

  const payload = (typeof row.payload === 'string'
    ? safeParse(row.payload)
    : row.payload) as { picks?: unknown; companyId?: unknown; companyCode?: unknown } | null;

  const picks = (Array.isArray(payload?.picks) ? payload.picks : [])
    .map((p) => p as { soItemId?: unknown; qty?: unknown })
    .filter((p) => typeof p.soItemId === 'string' && p.soItemId !== '' && Number(p.qty) > 0)
    .map((p) => ({ soItemId: String(p.soItemId), qty: Number(p.qty) }));
  if (picks.length === 0) {
    /* Raised before proposals carried picks, or every short line was already
       drafted. Either way there is nothing to convert — say so rather than
       report a successful approval that created nothing. */
    return {
      ok: false,
      error: 'This proposal has nothing to order. Please raise the purchase order from the MRP page.',
      reversible: true,
    };
  }

  /* WHOSE BOOK — the PROPOSAL's company, never the caller's active one. The
     agent planned one company's demand against that company's stock and
     bindings; whatever company the approver happens to have selected in the top
     bar is a different question, and answering it here would file one company's
     SO lines under another's PO. */
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
    /* Absent = the companies master was unresolved at plan time (the
       single-company case). Pass undefined so stamping no-ops per the sentinel's
       UNRESOLVED rule — do NOT substitute anyone else's company to fill it. */
    companyId: hasCompany ? planCompanyId : undefined,
    allowedCompanyIds: hasCompany ? [planCompanyId] : undefined,
    /* The CODE string. companyDocPrefix stringifies whatever it gets. */
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
      // Reversible ONLY because created is empty. That is measured, not assumed.
      reversible: true,
    };
  }

  const numbers = created.map((p) => p.poNumber).filter(Boolean).join(', ');
  if (body.dropped?.length) {
    /* Some buckets became real POs and others failed. This must NOT go back to
       PENDING: replaying it would re-raise the picks that already landed. Loud,
       and decided. */
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
  // The stored autonomy stage (clamped upstream to PROCUREMENT's ceiling of 2).
  // Threaded into canSelfApprove instead of a hardcoded 2 so the dial governs it.
  reqStage = 2,
): Promise<{ approved: number; notes: string[]; errors: string[] }> {
  const db = env.DB;
  const out = { approved: 0, notes: [] as string[], errors: [] as string[] };

  const actorStaffId = await resolveAgentActorStaffId(db);
  if (!actorStaffId) {
    /* The gate is on but nobody has said who the agent acts as. Do nothing and
       say so — an agent that picks its own created_by has decided who is
       answerable for a purchase order, and that is not its decision. */
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
  /* The REAL data-quality signal (was asserted GREEN). If procurement's own last
     run errored or is stale, its reorder proposals rest on numbers we cannot
     stand behind — §10.2 says stop, and now it actually can. */
  const dq = await familyDataQuality(db, 'procurement-run', 6);
  if (dq.status !== 'GREEN') {
    out.errors.push(`auto-approve held — data-quality ${dq.status}: ${dq.reason}`);
    return out;
  }
  const nowIso = new Date().toISOString();
  for (const row of res.results ?? []) {
    /* THE STAGE-2 POLICY GATE (docs/agents/operating-spec.md §1.2, §6.8).
       The `auto_approve` flag being on is NOT "approve every reorder" — the spec
       is explicit that autonomy is per decision class, "never a blanket
       permission to approve everything". So each reorder passes through the
       shared authority matrix before it is claimed. A reorder over the unit
       ceiling is held for a human; the flag only ever loosens the low-value case.

       Data-quality is asserted GREEN here rather than measured: the domain gates
       downstream (executeReorderProposal refuses on missing picks / unusable
       company; the converter enforces qty-remaining) cover the RED cases today,
       and wiring a real Green/Amber/Red signal into this loop is a later step,
       named in the PR. `counterpartyKnown` is left undefined ON PURPOSE — the
       proposal deliberately does not carry a supplierId (the converter resolves
       the supplier at execution), so the new-supplier stop cannot be evaluated
       here and must not be faked as "known". */
    const gate = canSelfApprove({
      agent: 'HZS-REP-004',
      decisionClass: 'EXTERNAL_PO',
      stage: reqStage as 1 | 2 | 3,
      dataQuality: dq.status,
      valueProxy: reorderUnits(row.payload),
      limit: unitLimit,
    });
    if (!gate.ok) {
      // Leave it PENDING for a human; do not claim it. Naming it keeps the run
      // summary honest about what auto-approve did and did not do.
      out.notes.push(`held for human — ${row.id}: ${gate.reason}`);
      continue;
    }

    /* PER-COMPANY KILL (§10.6). The global switch and the family pause both stop
       everything; with two companies on one backend, stopping the agents for ONE
       book had no expression until now. The proposal carries the book it planned,
       so this is the place that can honour it. */
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

    /* CLAIM FIRST, execute second — the same order the console uses, for the
       same reason: the UPDATE is the atomic step, so a heartbeat racing a human
       clicking approve cannot both raise POs for one proposal. */
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
      // It got far enough to do anything at all, so the claim stands and a human
      // reads the error. Guessing "nothing happened" is what would double-order.
      effect = { ok: false, error: e instanceof Error ? e.message : String(e), reversible: false };
    }

    if (effect.ok) {
      out.approved++;
      if (effect.note) out.notes.push(effect.note);
      /* The decision packet (§9.4) — what was decided, on what evidence, under
         which policy, and how to undo it. Append-only; best-effort, because
         recording the reasoning must never fail the decision it describes. */
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
        // A DRAFT PO is undone by cancelling it — nothing has reached a supplier.
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
    // Nothing was created — hand it back rather than leave an APPROVED row with
    // no PO behind it, which would tell the owner the job is done.
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
