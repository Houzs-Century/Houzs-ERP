import type { Env } from "../types";
import { todayMyt } from "../scm/lib/my-time";

/**
 * Outstanding-task reminders feed (owner/admin Reminder view, owner 2026-09-30).
 *
 * Returns every INCOMPLETE checklist item (status NOT IN done/na, the
 * codebase-wide "incomplete" predicate) across all events in the active company,
 * with the organizer / owner / Sales PIC / booth / due-date each row needs so
 * the frontend can group and copy a chase-list without opening projects one by
 * one. The month cut and the incomplete predicate are done here; task / status /
 * group-by slicing is done client-side on this one payload.
 *
 * Access is gated at the route (the BD / Owner / weisiang tier); this service only reads.
 */

export interface OutstandingTaskRow {
  id: number;
  title: string;
  status: string;
  review_status: string | null;
  due_date: string | null;
  overdue_days: number;
  project_id: number;
  code: string;
  name: string;
  brand: string | null;
  organizer: string | null;
  state: string | null;
  venue: string | null;
  booth_no: string | null;
  start_date: string | null;
  end_date: string | null;
  pic_name: string | null;
  owner_name: string | null;
}

interface OutstandingTaskQueryRow extends Omit<OutstandingTaskRow, "overdue_days"> {
  /* overdue_days is derived below, not selected. */
}

export async function listOutstandingTasks(
  env: Env,
  opts: { companyId?: number; month?: string },
): Promise<{ today: string; rows: OutstandingTaskRow[] }> {
  const binds: (string | number)[] = [];
  // company-scope: reads are pinned to the caller's active company on
  // p.company_id; project_checklist rides its parent project via the JOIN, so no
  // separate scope on c is needed. A super-admin with no active company (rare)
  // reads across companies, exactly as the project list does.
  let companySql = "";
  if (opts.companyId != null) {
    companySql = " AND p.company_id = ?";
    binds.push(opts.companyId);
  }
  let monthSql = "";
  if (opts.month) {
    monthSql = " AND substr(p.start_date, 1, 7) = ?";
    binds.push(opts.month);
  }
  const rows = await env.DB.prepare(
    `SELECT c.id, c.title, c.status, c.review_status, c.due_date,
            p.id AS project_id, p.code, p.name, p.brand, p.organizer,
            p.state, p.venue, p.booth_no, p.start_date, p.end_date,
            pic.name AS pic_name, ow.name AS owner_name
       FROM project_checklist c
       JOIN projects p ON p.id = c.project_id
       LEFT JOIN users pic ON pic.id = p.pic_id
       LEFT JOIN users ow  ON ow.id = c.owner_user_id
      WHERE p.archived_at IS NULL
        AND c.status NOT IN ('done', 'na')${companySql}${monthSql}
      ORDER BY p.organizer, p.start_date, c.title`
  )
    .bind(...binds)
    .all<OutstandingTaskQueryRow>();

  const today = todayMyt();
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const outRows = rows.results.map((r): OutstandingTaskRow => {
    const due = r.due_date ? r.due_date.slice(0, 10) : null;
    const overdue_days =
      due && due < today
        ? Math.round((todayMs - Date.parse(`${due}T00:00:00Z`)) / 86_400_000)
        : 0;
    return { ...r, overdue_days };
  });
  return { today, rows: outRows };
}
