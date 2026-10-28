// Reopen a completed/voided service case for a DIFFERENT complaint (owner
// 2026-09-22: "第一次结束后再有问题倒回来，会有不一样的投诉内容"). The case keeps
// its number; the NEW complaint overwrites complaint_issue and the OLD one is
// written to the activity timeline so it is never lost. The case reactivates
// (closed_at / completion_date cleared, status In Progress) and moves back to a
// re-assessment stage the operator picks. Any supplier returns from the first
// problem stay on the case as history. Kept out of services/assr.ts, which is at
// its size ceiling; imports transitionStage + logActivity from there.
import type { Context } from "hono";
import type { Env } from "../types";
import { transitionStage, logActivity, type Stage } from "./assr";

// The stages a reopen may land on — assessment stages before the supplier leg.
export const REOPEN_STAGES: readonly Stage[] = [
  "pending_review",
  "pending_solution",
  "under_verification",
];

export async function reopenCaseWithComplaint(
  env: Env,
  assrId: number,
  userId: number,
  complaint: string,
  stage: Stage,
): Promise<boolean> {
  const before = await env.DB.prepare(
    `SELECT complaint_issue, closed_at FROM assr_cases WHERE id = ?`
  )
    .bind(assrId)
    .first<{ complaint_issue: string | null; closed_at: string | null }>();
  if (!before) return false;

  // Record the previous complaint on the timeline BEFORE it is overwritten, so
  // the first problem's text survives even though the field now holds the new one.
  await logActivity(
    env, assrId, "case_reopened",
    before.complaint_issue ?? null, complaint,
    "Reopened for a new complaint",
    userId, { category: "service" },
  );

  // New complaint + reactivate. transitionStage stamps closed_at only on ENTERING
  // a terminal stage and never clears it, so a reopen must clear it here.
  await env.DB.prepare(
    `UPDATE assr_cases
        SET complaint_issue = ?, closed_at = NULL, completion_date = NULL,
            status = 'In Progress', updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(complaint, assrId)
    .run();

  // Move onto the chosen re-assessment stage (records stage_history).
  await transitionStage(env, assrId, stage, userId, "reopened for a new complaint", "app");
  return true;
}

type Ctx = Context<{ Bindings: Env }>;
const uid = (c: Ctx): number => (c as unknown as { get?: (k: string) => number }).get?.("userId") ?? 0;

export async function reopenCaseRoute(c: Ctx) {
  const id = parseInt(c.req.param("id") ?? "", 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const body = await c.req.json<{ complaint?: string; stage?: string }>().catch(() => ({}) as { complaint?: string; stage?: string });
  const complaint = (body.complaint ?? "").trim();
  if (!complaint) return c.json({ error: "A new complaint is required to reopen" }, 400);
  const stage: Stage = REOPEN_STAGES.includes(body.stage as Stage)
    ? (body.stage as Stage)
    : "under_verification";
  const ok = await reopenCaseWithComplaint(c.env, id, uid(c), complaint, stage);
  return ok ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
}
