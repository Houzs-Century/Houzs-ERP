import type { Env } from "../types";
import { sendEmail, publicUrl } from "./email";
import { assrOpenStageSql } from "./assrStages";

/**
 * SLA escalation sweep. Marks open cases as "escalated" once they've
 * been past their deadline for more than 24 hours. Three guards:
 *   - only stamps cases that don't already have escalated_at set
 *   - skips CLOSED cases — BOTH terminal stages, via assrOpenStageSql. This used
 *     to be a hand-written predicate naming only `completed`, which let every
 *     VOIDED case keep escalating: the cron stamped escalated_at, wrote an
 *     activity row and emailed the assignee plus every service_cases.manage
 *     holder about a case somebody had closed precisely so it would stop
 *     demanding attention. (The literal is not quoted here on purpose —
 *     `tests/assrOpenStageNoHandCopies.test.ts` bans it from this file.)
 *   - skips ARCHIVED cases. Archiving is the other way a case leaves the
 *     workload, and it was not checked either, so an archived case past its
 *     deadline mailed the same people.
 * Logs each escalation to assr_activity so the timeline shows it.
 *
 * When emails are enabled (RESEND_API_KEY + email.assr_sla_escalation),
 * each escalated case also fires an alert to the assignee (if any)
 * plus everyone holding service_cases.manage.
 *
 * Called daily by the cron scheduler (see src/index.ts).
 */
export async function runSlaEscalation(env: Env): Promise<{ escalated: number }> {
  const candidates = await env.DB.prepare(
    `SELECT c.id, c.assr_no, c.deadline_at, c.customer_name,
            c.complaint_issue, c.stage, c.assigned_to,
            u.email as assignee_email, u.name as assignee_name
       FROM assr_cases c
       LEFT JOIN users u ON u.id = c.assigned_to
      WHERE ${assrOpenStageSql("c")}
        AND c.archived_at IS NULL
        AND c.deadline_at IS NOT NULL
        AND c.escalated_at IS NULL
        AND julianday('now') - julianday(c.deadline_at) >= 1`
  ).all<{
    id: number;
    assr_no: string;
    deadline_at: string;
    customer_name: string | null;
    complaint_issue: string | null;
    stage: string;
    assigned_to: number | null;
    assignee_email: string | null;
    assignee_name: string | null;
  }>();

  const rows = candidates.results ?? [];
  if (rows.length === 0) return { escalated: 0 };

  // Managers (hold service_cases.manage) — addressed once, not once per case.
  const managers = await env.DB.prepare(
    `SELECT DISTINCT u.id, u.email, u.name
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.status = 'active'
        AND u.email IS NOT NULL AND u.email != ''
        AND COALESCE(u.assr_email_muted, 0) = 0
        AND r.permissions LIKE '%"service_cases.manage"%'`
  ).all<{ id: number; email: string; name: string | null }>();
  const managerEmails = (managers.results ?? []).map((m) => m.email).filter(Boolean);

  const now = new Date().toISOString();

  for (const row of rows) {
    await env.DB.prepare(
      `UPDATE assr_cases SET escalated_at = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(now, row.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id)
       VALUES (?, 'escalated', NULL, ?, ?, NULL)`
    )
      .bind(row.id, row.deadline_at, `SLA breached >24h — case auto-escalated`)
      .run();

    // Email alerts — fire-and-forget (sendEmail never throws).
    const subject = `[SLA] ${row.assr_no} — escalated (overdue >24h)`;
    const link = publicUrl(env, `/assr`);
    const html = escalationEmailHtml({
      assrNo: row.assr_no,
      stage: row.stage,
      deadline: row.deadline_at,
      customer: row.customer_name,
      issue: row.complaint_issue,
      assigneeName: row.assignee_name,
      link,
    });
    if (row.assignee_email) {
      await sendEmail(env, {
        to: row.assignee_email,
        subject,
        html,
        purpose: "assr_sla_escalation",
        refType: "assr",
        refId: row.id,
      });
    }
    // Also loop in managers unless they'd get a duplicate from the assignee addr
    for (const m of managerEmails) {
      if (m.toLowerCase() === (row.assignee_email || "").toLowerCase()) continue;
      await sendEmail(env, {
        to: m,
        subject,
        html,
        purpose: "assr_sla_escalation",
        refType: "assr",
        refId: row.id,
      });
    }
  }

  return { escalated: rows.length };
}

function escalationEmailHtml(p: {
  assrNo: string;
  stage: string;
  deadline: string;
  customer: string | null;
  issue: string | null;
  assigneeName: string | null;
  link: string;
}): string {
  const issue = (p.issue || "").slice(0, 200);
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#222">
      <div style="background:#fee;border-left:4px solid #c23;padding:10px 14px;margin-bottom:18px">
        <strong style="color:#a11">SLA breach — escalated</strong>
      </div>
      <h2 style="margin:0 0 6px">${p.assrNo}</h2>
      <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:18px">
        <tr><td style="color:#666;padding:4px 0;width:120px">Current stage</td><td><strong>${p.stage}</strong></td></tr>
        <tr><td style="color:#666;padding:4px 0">Deadline was</td><td>${p.deadline.slice(0, 16).replace("T", " ")}</td></tr>
        <tr><td style="color:#666;padding:4px 0">Customer</td><td>${p.customer || "—"}</td></tr>
        <tr><td style="color:#666;padding:4px 0">Assigned to</td><td>${p.assigneeName || "(unassigned)"}</td></tr>
      </table>
      ${issue ? `<p style="background:#f6f6f6;padding:10px 12px;border-radius:4px;font-size:13px">${issue}${p.issue && p.issue.length > 200 ? "…" : ""}</p>` : ""}
      <p style="margin:22px 0">
        <a href="${p.link}"
           style="display:inline-block;padding:11px 20px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Open in ERP
        </a>
      </p>
      <p style="color:#aaa;font-size:12px;border-top:1px solid #eee;padding-top:14px">
        You're receiving this because you're the assignee or hold service_cases.manage.
        Escalation emails can be disabled in Settings → Email.
      </p>
    </div>`;
}
