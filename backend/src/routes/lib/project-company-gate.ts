import type { Context } from "hono";
import type { Env } from "../../types";
import { activeCompanySql } from "../../scm/lib/companyScope";


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
  if (!coSql) return null;
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

export const FOREIGN_ATTACHMENT_PREFIXES = [
  "mail-outbox/", "mail/", "hr-punch/", "user/", "memos/", "assr/",
  "announcements/", "fleet/", "branding/", "driver/",
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
