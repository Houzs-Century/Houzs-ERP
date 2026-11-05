import type { Env } from "../types";
import { setChecklistStatus } from "./projects";

// Auto-tick a checklist row DONE the moment its evidence is uploaded, so staff
// no longer tick the bullet by hand (owner's repeated ask, latest 2026-10-29;
// "once an image/file is uploaded, auto-tick — no manual click, mobile and PC").
// Both upload doors call in here so desktop and mobile behave the same, and the
// two routes stay small (file-size ceiling on routes/projects.ts).
//
// Scope, shared by both doors: a PLAIN evidence row only. We never force-done
//   * a gated row (required_perm) — its "done" is the approver's call
//     (completion = review_status='approved', see checklistProgress.ts), nor
//   * a review-document row — Agreement / Quotation, Stock Out/In Transfer
//     Record, Display Floor Plan, 3D/2D Design, Exchange List — which carry the
//     submit/approve/reject loop. The regex is the exact one the frontend uses
//     in vendor/scm/lib/pms-reviewable-titles.ts.
// Only a 'pending' row is touched, so N/A, blocked and already-done rows stand.
const REVIEW_DOC_TITLE_RE =
  /^(agreement|stock\s*(out|in)\s*transfer|display\s*floor\s*plan|3d\s*design|2d\s*design|exchange\s*list)/i;

/** Task-attachment upload (PUT /checklist/:id/attachments). The row is already
 *  loaded by the route, so take its fields rather than re-reading. */
export async function autoTickChecklistOnUpload(
  env: Env,
  item: { title: string | null; required_perm: string | null; status: string | null },
  itemId: number,
  userId: number,
): Promise<void> {
  if (
    !item.required_perm &&
    (item.status ?? "") === "pending" &&
    !REVIEW_DOC_TITLE_RE.test((item.title ?? "").trim())
  ) {
    await setChecklistStatus(env, itemId, "done", userId);
  }
}

/** Crew Setup/Dismantle photo (POST /:id/phase-photos → project_phase_photos).
 *  These land in a different table than task attachments, so the matching
 *  "Setup Image" / "Dismantle Image" row would never tick without this. Ticks
 *  the DRIVER-badged row (the one the desktop merges the photo into); the SALES
 *  PIC "Setup Image" ticks from its own task attachment instead. */
export async function autoTickPhasePhoto(
  env: Env,
  projectId: number,
  phase: "setup" | "dismantle",
  userId: number,
): Promise<void> {
  const wantTitle = phase === "setup" ? "setup image%" : "dismantle image%";
  const row = await env.DB.prepare(
    `SELECT id FROM project_checklist
      WHERE project_id = ?
        AND lower(trim(title)) LIKE ?
        AND (required_perm IS NULL OR required_perm = '')
        AND status = 'pending'
      ORDER BY (CASE WHEN upper(coalesce(role_label, '')) LIKE '%DRIVER%' THEN 0 ELSE 1 END), id
      LIMIT 1`,
  )
    .bind(projectId, wantTitle)
    .first<{ id: number }>();
  if (row) {
    await setChecklistStatus(env, row.id, "done", userId);
  }
}
