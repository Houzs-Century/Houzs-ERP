/**
 * ASSR/QMS v3.1 alert engine — proposal §9.
 *
 * Scans every open stage_history row, computes elapsed_pct against the
 * snapshotted target_days, and fires one of:
 *
 *   stage_entered      — emitted at history insert (already covered)
 *   half_time          — elapsed_pct >= 50%
 *   approaching_breach — elapsed_pct >= 80%
 *   breach             — elapsed_pct >= 100%
 *
 * Idempotency: `assr_stage_history.alerts_fired` is a bit-mask
 * (1=entered, 2=half, 4=approaching, 8=breach). Each pass OR-s in the
 * bits it just fired, so re-running this on the same row only sends
 * what hasn't been sent.
 *
 * `stage_entered` is a special case — fired inline by `transitionStage`
 * in services/assr.ts (we want it the moment the case enters the
 * stage, not on the next 30-min cron tick). The bit is also flipped
 * there so the scanner skips it.
 *
 * Snooze handling: `assr_alert_acks(snoozed_until)` suppresses alerts
 * for a (case, stage, event) until that time. Max 2 snoozes per stage
 * enforced at the route layer.
 *
 * Channels: email always (reuses sendEmail). WhatsApp / Telegram stubs
 * documented but unwired — proposal §9.2 calls them out as opt-in.
 */
import type { Env } from "../types";
import { sendEmail, publicUrl } from "./email";

const FLAG_ENTERED = 1;
const FLAG_HALF = 2;
const FLAG_APPROACHING = 4;
const FLAG_BREACH = 8;

type Event = "stage_entered" | "half_time" | "approaching_breach" | "breach";

const EVENT_FLAG: Record<Event, number> = {
  stage_entered: FLAG_ENTERED,
  half_time: FLAG_HALF,
  approaching_breach: FLAG_APPROACHING,
  breach: FLAG_BREACH,
};

const EVENT_LABEL: Record<Event, string> = {
  stage_entered: "Stage entered",
  half_time: "Half-time reminder",
  approaching_breach: "Approaching breach",
  breach: "SLA breach",
};

/**
 * Runs the alert scanner. Wired on the 30-minute cron slot in
 * src/index.ts. Returns counts so the cron log shows progress.
 */
export async function runAssrAlerts(
  env: Env
): Promise<{ half: number; approaching: number; breach: number; cases_scanned: number }> {
  // All open stage_history rows (exited_at IS NULL) with a positive
  // target — completed stage rows have target_days = 0 and don't fire
  // alerts.
  const rows = await env.DB.prepare(
    `SELECT h.id          AS history_id,
            h.assr_id     AS assr_id,
            h.stage       AS stage,
            h.entered_at  AS entered_at,
            h.target_days AS target_days,
            h.alerts_fired AS alerts_fired,
            c.assr_no     AS assr_no,
            c.customer_name AS customer_name,
            c.complaint_issue AS complaint_issue,
            c.assigned_to AS assigned_to,
            u.email       AS assignee_email,
            u.name        AS assignee_name
       FROM assr_stage_history h
       JOIN assr_cases c ON c.id = h.assr_id
       LEFT JOIN users u ON u.id = c.assigned_to
      WHERE h.exited_at IS NULL
        AND c.archived_at IS NULL
        AND h.target_days > 0`
  ).all<{
    history_id: number;
    assr_id: number;
    stage: string;
    entered_at: string;
    target_days: number;
    alerts_fired: number;
    assr_no: string;
    customer_name: string | null;
    complaint_issue: string | null;
    assigned_to: number | null;
    assignee_email: string | null;
    assignee_name: string | null;
  }>();

  const open = rows.results ?? [];
  if (open.length === 0) {
    return { half: 0, approaching: 0, breach: 0, cases_scanned: 0 };
  }

  // Managers — emailed on approaching + breach events. One DB lookup
  // up-front; ASSR managers don't churn within a 30-min cron window.
  const managers = await env.DB.prepare(
    `SELECT DISTINCT u.email
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.status = 'active'
        AND u.email IS NOT NULL AND u.email != ''
        AND COALESCE(u.assr_email_muted, 0) = 0
        AND r.permissions LIKE '%"service_cases.manage"%'`
  ).all<{ email: string }>();
  const managerEmails = (managers.results ?? []).map((m) => m.email);

  const counts = { half: 0, approaching: 0, breach: 0, cases_scanned: open.length };
  const nowMs = Date.now();

  for (const r of open) {
    const enteredMs = new Date(r.entered_at.endsWith("Z") ? r.entered_at : r.entered_at + "Z").getTime();
    const elapsedDays = (nowMs - enteredMs) / (1000 * 60 * 60 * 24);
    if (!isFinite(elapsedDays) || elapsedDays < 0) continue;
    const elapsedPct = elapsedDays / r.target_days;

    const toFire: Event[] = [];
    if (elapsedPct >= 0.5 && !(r.alerts_fired & FLAG_HALF)) toFire.push("half_time");
    if (elapsedPct >= 0.8 && !(r.alerts_fired & FLAG_APPROACHING)) toFire.push("approaching_breach");
    if (elapsedPct >= 1.0 && !(r.alerts_fired & FLAG_BREACH)) toFire.push("breach");

    if (toFire.length === 0) continue;

    // Per-(case, stage, event) snooze suppression — most-recent ack
    // wins, snoozed_until in the future suppresses.
    const acked = await env.DB.prepare(
      `SELECT event, MAX(snoozed_until) AS snoozed_until
         FROM assr_alert_acks
        WHERE assr_id = ? AND stage = ?
          AND snoozed_until IS NOT NULL AND snoozed_until > datetime('now')
        GROUP BY event`
    )
      .bind(r.assr_id, r.stage)
      .all<{ event: string; snoozed_until: string }>();
    const snoozedEvents = new Set((acked.results ?? []).map((a) => a.event));

    let firedMask = r.alerts_fired;
    for (const ev of toFire) {
      if (snoozedEvents.has(ev)) continue;
      const subject = `[ASSR] ${r.assr_no} — ${EVENT_LABEL[ev]} on ${prettyStage(r.stage)}`;
      const html = alertEmailHtml({
        assrNo: r.assr_no,
        event: ev,
        stage: r.stage,
        elapsedDays,
        targetDays: r.target_days,
        customer: r.customer_name,
        issue: r.complaint_issue,
        link: publicUrl(env, `/assr`),
      });
      // Owner first, manager loop-in on approaching + breach.
      const recipients = new Set<string>();
      if (r.assignee_email) recipients.add(r.assignee_email);
      if (ev === "approaching_breach" || ev === "breach") {
        for (const m of managerEmails) recipients.add(m);
      }
      for (const to of recipients) {
        await sendEmail(env, {
          to,
          subject,
          html,
          purpose: `assr_alert_${ev}` as const,
          refType: "assr",
          refId: r.assr_id,
        });
      }
      // Audit row — record only the actual SLA breach. The half-time and
      // approaching-breach reminders still email the owner/managers, but
      // they are timer noise on the timeline, so they are NOT recorded
      // (owner 2026-07-21).
      if (ev === "breach") {
        await env.DB.prepare(
          `INSERT INTO assr_activity (assr_id, action, from_value, to_value, note, user_id, category)
           VALUES (?, 'alert', ?, ?, ?, NULL, 'system')`
        )
          .bind(r.assr_id, r.stage, ev, `${EVENT_LABEL[ev]} — ${elapsedDays.toFixed(1)}/${r.target_days}d`)
          .run();
      }

      firedMask |= EVENT_FLAG[ev];
      counts[(ev === "half_time" ? "half" : ev === "approaching_breach" ? "approaching" : "breach") as keyof typeof counts]++;
    }

    if (firedMask !== r.alerts_fired) {
      await env.DB.prepare(
        `UPDATE assr_stage_history SET alerts_fired = ? WHERE id = ?`
      )
        .bind(firedMask, r.history_id)
        .run();
    }
  }

  return counts;
}

/**
 * Daily digest at 08:00 MYT (= 00:00 UTC). One email per manager
 * summarising every breached + approaching case. Cheap — single
 * query, single email per recipient.
 */
export async function runAssrDailyDigest(
  env: Env
): Promise<{ recipients: number; cases: number }> {
  const overdue = await env.DB.prepare(
    `SELECT c.id, c.assr_no, c.customer_name, c.stage, c.complaint_issue,
            h.entered_at, h.target_days,
            CAST((julianday('now') - julianday(h.entered_at)) AS REAL) AS elapsed_days
       FROM assr_stage_history h
       JOIN assr_cases c ON c.id = h.assr_id
      WHERE h.exited_at IS NULL
        AND c.archived_at IS NULL
        AND h.target_days > 0
        AND (julianday('now') - julianday(h.entered_at)) / h.target_days >= 0.8
      ORDER BY (julianday('now') - julianday(h.entered_at)) / h.target_days DESC`
  ).all<{
    id: number;
    assr_no: string;
    customer_name: string | null;
    stage: string;
    complaint_issue: string | null;
    entered_at: string;
    target_days: number;
    elapsed_days: number;
  }>();

  const cases = overdue.results ?? [];
  if (cases.length === 0) return { recipients: 0, cases: 0 };

  const managers = await env.DB.prepare(
    `SELECT DISTINCT u.email
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.status = 'active'
        AND u.email IS NOT NULL AND u.email != ''
        AND COALESCE(u.assr_email_muted, 0) = 0
        AND r.permissions LIKE '%"service_cases.manage"%'`
  ).all<{ email: string }>();
  const managerEmails = (managers.results ?? []).map((m) => m.email).filter(Boolean);

  if (managerEmails.length === 0) return { recipients: 0, cases: cases.length };

  const html = digestEmailHtml({
    cases,
    link: publicUrl(env, `/assr`),
  });
  const subject = `[ASSR] Daily SLA digest — ${cases.length} case(s) at risk`;

  for (const to of managerEmails) {
    await sendEmail(env, {
      to,
      subject,
      html,
      purpose: "assr_daily_digest",
    });
  }
  return { recipients: managerEmails.length, cases: cases.length };
}

// ── Email templates ─────────────────────────────────────────────────

function prettyStage(stage: string): string {
  return stage
    .split("_")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join(" ");
}

function alertEmailHtml(p: {
  assrNo: string;
  event: Event;
  stage: string;
  elapsedDays: number;
  targetDays: number;
  customer: string | null;
  issue: string | null;
  link: string;
}): string {
  const pct = Math.round((p.elapsedDays / p.targetDays) * 100);
  const accent =
    p.event === "breach"
      ? "#dc2626"
      : p.event === "approaching_breach"
      ? "#d97706"
      : "#0369a1";
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <div style="border-left:4px solid ${accent};padding-left:12px;margin-bottom:16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#666;font-weight:600">${EVENT_LABEL[p.event]}</div>
        <div style="font-size:18px;font-weight:600;margin-top:2px">${p.assrNo}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
        <tr><td style="padding:4px 0;color:#666;width:120px">Stage</td><td>${prettyStage(p.stage)}</td></tr>
        <tr><td style="padding:4px 0;color:#666">Elapsed</td><td><b>${p.elapsedDays.toFixed(1)}d</b> / ${p.targetDays}d (${pct}%)</td></tr>
        ${p.customer ? `<tr><td style="padding:4px 0;color:#666">Customer</td><td>${escHtml(p.customer)}</td></tr>` : ""}
        ${p.issue ? `<tr><td style="padding:4px 0;color:#666">Issue</td><td>${escHtml(p.issue)}</td></tr>` : ""}
      </table>
      <a href="${p.link}" style="display:inline-block;padding:8px 14px;background:${accent};color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">Open case</a>
    </div>`;
}

function digestEmailHtml(p: {
  cases: {
    assr_no: string;
    customer_name: string | null;
    stage: string;
    elapsed_days: number;
    target_days: number;
  }[];
  link: string;
}): string {
  const rows = p.cases
    .map((c) => {
      const pct = Math.round((c.elapsed_days / c.target_days) * 100);
      const tone = pct >= 100 ? "#dc2626" : "#d97706";
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee"><b>${c.assr_no}</b></td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${prettyStage(c.stage)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#666">${c.customer_name ? escHtml(c.customer_name) : "—"}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;color:${tone};font-weight:600">${pct}%</td>
      </tr>`;
    })
    .join("");
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#222">
      <div style="font-size:18px;font-weight:600;margin-bottom:4px">ASSR Daily SLA Digest</div>
      <div style="font-size:13px;color:#666;margin-bottom:16px">${p.cases.length} case(s) at 80%+ of stage target.</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:#f5f5f5;color:#444">
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #ddd">ASSR</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #ddd">Stage</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #ddd">Customer</th>
          <th style="padding:6px 8px;text-align:right;border-bottom:1px solid #ddd">% elapsed</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:16px"><a href="${p.link}" style="color:#0369a1">Open ASSR module →</a></div>
    </div>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
