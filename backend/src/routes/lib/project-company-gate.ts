// ─────────────────────────────────────────────────────────────────────────
// project-company-gate.ts — the company boundary for routes/projects.ts.
//
// Lives in its own module rather than inside the router for two reasons: the
// router is over its file-size ceiling, and a boundary rule with its own file
// is one the next reader can find. Both exports are listed in
// check-company-scope.mjs's DELEGATION_GUARDS, which is that script's promise
// that each was opened and read — see the salesDocOutOfScope note there for
// what an unread entry on that list costs.
// ─────────────────────────────────────────────────────────────────────────
import type { Context } from "hono";
import type { Env } from "../../types";
import { activeCompanySql } from "../../scm/lib/companyScope";

/* ── THE CHILD-ROW OWNERSHIP GATE ──────────────────────────────────────────
   One place, because the alternative is thirty hand-written predicates and this
   file already proved what that produces. Two shapes only, decided by whether
   the child table got a company_id:

   · OWN — project_checklist, project_checklist_sections,
     project_checklist_attachments, project_checklist_comments (mig 0093) and
     project_finance_lines (mig 0170) carry company_id, so the row's own column
     is the predicate. 0170 deliberately declined a column DEFAULT for exactly
     this reason ("a default to Houzs would silently re-open the leak").
   · VIA PARENT — project_stock_transfers, project_defects,
     project_sales_reports, project_team, project_attachments,
     project_checklist_attachment_actions have no company_id anywhere in
     migrations-pg, so the boundary is the parent project, via the same EXISTS
     form DELETE /phase-photos/:photoId already uses.

   Deliberately NOT covered, and left alone on purpose: project_event_types and
   project_organizers are SHARED masters with no company_id at all (mig 0292:72
   says so of event types in as many words). Scoping them would break both
   companies' pickers, and they carry no customer data.

   DEGRADES, does not fail closed: when activeCompanySql yields "" the companies
   master is unresolved (pre-migration / D1 test mirror / cold-start) and the
   install is single-company, so the gate is skipped entirely rather than
   turning every child row into a 404. Same first branch as every helper in
   scm/lib/companyScope.ts. */

/** Child tables reachable by their own id, and how each proves its company. */
const CHILD_COMPANY_SHAPE = {
  project_finance_lines: "own",
  project_checklist: "own",
  project_checklist_sections: "own",
  project_checklist_attachments: "own",
  project_checklist_comments: "own",
  project_stock_transfers: "parent",
  project_defects: "parent",
  project_sales_reports: "parent",
  project_team: "parent",
  project_attachments: "parent",
} as const;
type ChildTable = keyof typeof CHILD_COMPANY_SHAPE;

/**
 * Refuse when `childId` names a row of `table` that is not in the caller's
 * active company. Returns a 404 Response to return as-is, or null to proceed.
 *
 * 404, not 403, and the same body as a genuinely missing row: confirming that
 * someone else's id exists is itself a leak (the NOT_THIS_COMPANY rule in
 * scm/lib/companyScope.ts). Call it BEFORE any other probe in the handler, so a
 * foreign id cannot be used to ask what state that row is in either.
 */
export async function refuseForeignChild(
  c: { env: Env; get(key: string): unknown; json: Context["json"] },
  table: ChildTable,
  childId: number | string,
): Promise<Response | null> {
  const coSql = activeCompanySql(c);
  if (!coSql) return null; // unresolved / single-company → degrade, as everywhere
  const sql =
    CHILD_COMPANY_SHAPE[table] === "own"
      ? `SELECT 1 AS ok FROM ${table} WHERE id = ?${coSql}`
      : `SELECT 1 AS ok FROM ${table} t WHERE t.id = ? AND EXISTS (` +
        `SELECT 1 FROM projects p WHERE p.id = t.project_id${activeCompanySql(c, "p.company_id")})`;
  const row = await c.env.DB.prepare(sql).bind(childId).first<{ ok: number }>();
  return row ? null : c.json({ error: "Not found" }, 404);
}

/**
 * The PARENT half of the same rule, for the `/:id/<child>` CREATE routes. They
 * bind `:id` as project_id on the INSERT and never asked whether that project is
 * ours, so a row could be filed under the other company's event — where the
 * scoped read never shows it again, which is the worst kind of write to lose.
 * Same 404-not-403 reasoning as above; same degrade.
 */
export async function refuseForeignProject(
  c: { env: Env; get(key: string): unknown; json: Context["json"] },
  projectId: number | string,
): Promise<Response | null> {
  const coSql = activeCompanySql(c);
  if (!coSql) return null;
  const row = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM projects WHERE id = ?${coSql}`,
  )
    .bind(projectId)
    .first<{ ok: number }>();
  return row ? null : c.json({ error: "Not found" }, 404);
}
