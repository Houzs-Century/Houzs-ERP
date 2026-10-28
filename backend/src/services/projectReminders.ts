import type { Env } from "../types";
import { sendEmail, publicUrl } from "./email";
import { todayMyt } from "../scm/lib/my-time";

/**
 * Daily job that emails project owners when their checklist items are
 * due soon or overdue.
 *
 * Rules:
 *   • Consider items with status='pending' and a due_date set
 *   • "Overdue"     = due_date < today
 *   • "Due soon"    = today ≤ due_date ≤ today + 3 days
 *   • Skip items on archived projects
 *   • Each owner gets ONE grouped email listing all their items across
 *     projects, so nobody receives a dozen separate reminders
 *   • Items with no owner go to everyone holding `projects.manage`
 *
 * Runs in fire-and-forget mode — individual email failures don't stop
 * the batch. sendEmail() handles the "email disabled" case silently.
 */
export async function runProjectDueReminders(env: Env): Promise<{
  items: number;
  recipients: number;
  sent: number;
}> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.project_id, c.title, c.due_date, c.owner_user_id,
            c.status,
            p.code as project_code, p.name as project_name, p.brand,
            u.email as owner_email, u.name as owner_name
       FROM project_checklist c
       JOIN projects p ON p.id = c.project_id
       LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE p.archived_at IS NULL
        AND c.status = 'pending'
        AND c.due_date IS NOT NULL
        AND substr(c.due_date, 1, 10) <= date('now', '+3 days')`
  ).all<{
    id: number;
    project_id: number;
    title: string;
    due_date: string;
    owner_user_id: number | null;
    status: string;
    project_code: string;
    project_name: string;
    brand: string | null;
    owner_email: string | null;
    owner_name: string | null;
  }>();
  const items = rows.results ?? [];
  if (!items.length) return { items: 0, recipients: 0, sent: 0 };

  // Bucket by owner email (fall back to the "unassigned" bucket).
  const UNASSIGNED = "__unassigned__";
  const byRecipient = new Map<string, typeof items>();
  for (const it of items) {
    const key = it.owner_email?.trim() || UNASSIGNED;
    const arr = byRecipient.get(key) ?? [];
    arr.push(it);
    byRecipient.set(key, arr);
  }

  // Managers — used for the unassigned bucket. Computed lazily.
  let managerEmails: string[] | null = null;
  async function managers(): Promise<string[]> {
    if (managerEmails != null) return managerEmails;
    const r = await env.DB.prepare(
      `SELECT DISTINCT u.email
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.status = 'active'
          AND u.email IS NOT NULL AND u.email != ''
          AND (r.permissions LIKE '%"*"%' OR r.permissions LIKE '%"projects.manage"%')`
    ).all<{ email: string }>();
    managerEmails = (r.results ?? []).map((x) => x.email).filter(Boolean);
    return managerEmails;
  }

  // Overdue/upcoming boundary is a Malaysia calendar day, not UTC. Workers run
  // in UTC, so before 08:00 MYT `toISOString()` is still yesterday and an item
  // due "today" would be mislabelled overdue an entire morning.
  const today = todayMyt();
  let sent = 0;
  let recipients = 0;

  for (const [key, bucket] of byRecipient) {
    const recipientList: string[] =
      key === UNASSIGNED ? await managers() : [key];
    if (!recipientList.length) continue;

    // Partition into overdue vs upcoming for the email copy.
    const overdue = bucket.filter((b) => b.due_date.slice(0, 10) < today);
    const upcoming = bucket.filter((b) => b.due_date.slice(0, 10) >= today);

    const subject =
      overdue.length > 0
        ? `[${overdue.length} overdue] Project checklist items need attention`
        : `[${upcoming.length} due soon] Project checklist reminder`;

    const html = buildReminderHtml({
      ownerName:
        key === UNASSIGNED
          ? "Team"
          : bucket[0].owner_name || key.split("@")[0],
      overdue,
      upcoming,
      link: publicUrl(env, "/projects"),
      unassigned: key === UNASSIGNED,
    });

    for (const to of recipientList) {
      const result = await sendEmail(env, {
        to,
        subject,
        html,
        purpose: "project_due_reminder",
        refType: "project_checklist_batch",
        refId: null,
      });
      if (result.status === "sent") sent++;
      recipients++;
    }
  }

  return { items: items.length, recipients, sent };
}

function buildReminderHtml(p: {
  ownerName: string;
  overdue: Array<{
    project_code: string;
    project_name: string;
    title: string;
    due_date: string;
    brand: string | null;
  }>;
  upcoming: Array<{
    project_code: string;
    project_name: string;
    title: string;
    due_date: string;
    brand: string | null;
  }>;
  link: string;
  unassigned: boolean;
}): string {
  function rowList(
    title: string,
    color: string,
    rows: typeof p.overdue
  ): string {
    if (!rows.length) return "";
    const lines = rows
      .map(
        (r) => `
          <tr>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;color:#999">${r.project_code}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee"><strong>${r.title}</strong><div style="color:#999;font-size:11px">${r.project_name}${r.brand ? ` · ${r.brand}` : ""}</div></td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${r.due_date.slice(0, 10)}</td>
          </tr>`
      )
      .join("");
    return `
      <h3 style="color:${color};margin:22px 0 6px;font-size:14px">${title} (${rows.length})</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">${lines}</table>`;
  }

  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 8px">Hi ${p.ownerName},</h2>
      <p>${p.unassigned ? "The following unassigned project checklist items need an owner." : "Checklist items on your projects are coming due."}</p>

      ${rowList("Overdue", "#c23", p.overdue)}
      ${rowList("Due within 3 days", "#a16a2e", p.upcoming)}

      <p style="margin:28px 0 4px">
        <a href="${p.link}"
           style="display:inline-block;padding:11px 20px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Open Projects
        </a>
      </p>
      <p style="color:#aaa;font-size:12px;border-top:1px solid #eee;padding-top:14px;margin-top:28px">
        You can disable these reminders in Settings → Email → Project due reminders.
      </p>
    </div>`;
}
