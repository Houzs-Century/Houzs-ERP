import type { Env } from "../types";

/**
 * Cross-project Defect List feed (owner 2026-11-20).
 *
 * Every OPEN defect photo across the active company in one query, so the
 * service team reviews defects without opening each project. A defect photo is
 * an attachment on a checklist item titled "Defect List…" / "Defect Item…"
 * (the same title match the My-Pending defect arms in services/projects.ts
 * use). "Open" = the attachment's LATEST action-timeline entry is not `done`
 * (a fresh upload, a legacy `ongoing`, or an escalated `replace`/Exchange).
 *
 * Read only; company scope is pinned on p.company_id by the route. Acting on a
 * defect stays gated on POST /checklist/attachments/:id/actions.
 */

export interface DefectListRow {
  attachment_id: number;
  r2_key: string;
  file_name: string;
  content_type: string | null;
  caption: string | null;
  uploaded_at: string | null;
  uploader_name: string | null;
  item_id: number;
  item_title: string;
  item_status: string;
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
  latest_status: string | null;
  latest_remark: string | null;
  latest_at: string | null;
  latest_user_name: string | null;
}

export async function listOpenDefects(
  env: Env,
  opts: { companyId?: number; includeResolved?: boolean },
): Promise<{ rows: DefectListRow[] }> {
  const binds: (string | number)[] = [];
  let companySql = "";
  if (opts.companyId != null) {
    companySql = " AND p.company_id = ?";
    binds.push(opts.companyId);
  }
  // Open-only is the default (the service team's actionable queue); `all` drops
  // the filter so a resolved photo stays listed with its Done stamp. A defect is
  // settled in the project EITHER way, so both drop off Open here too:
  //  1. the photo's latest action is resolved — `done` OR `done_clean` (the
  //     reviewer's "Done Clean" settles without escalating); the SAME set as
  //     defectReviewer.ts RESOLVED_STATUSES, and
  //  2. the defect checklist ITEM is ticked `done`/`na` — the project's own
  //     "finished" test (services/projects.ts My-Pending: once ticked done/na the
  //     defect leaves every open lane, regardless of the photo's last action).
  const openSql = opts.includeResolved
    ? ""
    : ` AND LOWER(COALESCE(la.status, '')) NOT IN ('done', 'done_clean')
        AND LOWER(COALESCE(dl.status, '')) NOT IN ('done', 'na')`;
  const rows = await env.DB.prepare(
    `SELECT
        a.id AS attachment_id, a.r2_key, a.file_name, a.content_type, a.caption, a.uploaded_at,
        up.name AS uploader_name,
        dl.id AS item_id, dl.title AS item_title, dl.status AS item_status,
        p.id AS project_id, p.code, p.name, p.brand, p.organizer, p.state, p.venue, p.booth_no,
        p.start_date, p.end_date,
        la.status AS latest_status, la.remark AS latest_remark, la.created_at AS latest_at,
        lau.name AS latest_user_name
       FROM project_checklist_attachments a
       JOIN project_checklist dl ON dl.id = a.item_id
       JOIN projects p ON p.id = dl.project_id
       LEFT JOIN users up ON up.id = a.uploaded_by
       LEFT JOIN project_checklist_attachment_actions la
         ON la.id = (SELECT act.id
                       FROM project_checklist_attachment_actions act
                      WHERE act.attachment_id = a.id
                      ORDER BY act.id DESC LIMIT 1)
       LEFT JOIN users lau ON lau.id = la.user_id
      WHERE a.archived_at IS NULL
        AND p.archived_at IS NULL
        AND (dl.title LIKE 'Defect List%' OR dl.title LIKE 'Defect Item%')${companySql}${openSql}
      ORDER BY substr(COALESCE(p.end_date, p.start_date), 1, 10) DESC, p.id DESC, a.id DESC`,
  )
    .bind(...binds)
    .all<DefectListRow>();
  return { rows: rows.results ?? [] };
}
