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

/* ── THE ATTACHMENT-KEY GATE (GET /api/projects/attachments/:key) ──────────
   That route streams a POD_BUCKET object by its key, and POD_BUCKET is shared:
   outbound email attachments (mail-outbox/<outboxId>/<n>, every part of it a
   counter), inbound mail, HR punch selfies, service-case photos, memos, staff
   files, fleet papers. Before this gate any signed-in user of either company
   could read any of them by naming the key, past the ownership rule the
   service-case route enforces on its own copy (assr.ts /attachments). Same bug
   class Conts fixed in #166 ("any signed-in account could download any stored
   file by its id").

   A key another module writes is refused outright. A key that names its
   project (or its checklist item) must be in the caller's company. Any other
   key is served as before, because project rows written by older code may carry
   a layout this file has never seen, and refusing those would hide a project's
   own files. */
export const FOREIGN_ATTACHMENT_PREFIXES = [
  "mail-outbox/", "mail/", "hr-punch/", "user/", "memos/", "assr/",
  "announcements/", "fleet/", "branding/",
] as const;

export type AttachmentKeyClass =
  | { kind: "foreign" }
  | { kind: "project"; projectId: number }
  | { kind: "checklist"; itemId: number }
  | { kind: "other" };

export function classifyAttachmentKey(key: string): AttachmentKeyClass {
  if (key.includes("..") || FOREIGN_ATTACHMENT_PREFIXES.some((p) => key.startsWith(p))) return { kind: "foreign" };
  const project = /^(?:projects|project-phase-photos)\/(\d+)\//.exec(key);
  if (project) return { kind: "project", projectId: Number(project[1]) };
  const task = /^task-attach\/(\d+)\//.exec(key);
  if (task) return { kind: "checklist", itemId: Number(task[1]) };
  return { kind: "other" };
}

/** 404 Response when the key is another module's object or another company's project file; null to serve it. */
export async function refuseForeignAttachmentKey(
  c: { env: Env; get(key: string): unknown; json: Context["json"] },
  key: string,
): Promise<Response | null> {
  const k = classifyAttachmentKey(key);
  if (k.kind === "foreign") return c.json({ error: "Not found" }, 404);
  if (k.kind === "project") return refuseForeignProject(c, k.projectId);
  if (k.kind === "checklist") return refuseForeignChild(c, "project_checklist", k.itemId);
  return null;
}
