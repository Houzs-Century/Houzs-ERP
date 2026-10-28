import type { Env } from "../types";
import { sendEmail, publicUrl } from "./email";

// ---------------------------------------------------------------------------
// Daily client-error digest -- the "visible within a day" half of the
// self-hosted error reporting (routes/clientErrors.ts is the intake half).
//
// Runs in the existing 0 2 * * * cron slot (index.ts). If ANY client_errors
// row was seen in the last 24h, ONE summary email goes to IT with the top 10
// errors by occurrence count; zero errors sends nothing -- an empty digest
// trains people to delete digests.
//
// Recipient is the shared IT/ops mailbox, deliberately hardcoded rather than
// role-derived: this mail is infrastructure telemetry, not a business
// notification, and must keep arriving even mid permission-model surgery.
// ---------------------------------------------------------------------------

const DIGEST_TO = "hello@houzscentury.com";

// Rows older than this are purged by the same daily run. The dedup collapse
// keeps the table small per day; this bounds it over time. 90 days comfortably
// covers "did this error exist before the last few deploys" archaeology.
const RETENTION_DAYS = 90;

interface DigestRow {
  message: string;
  route: string;
  build_id: string;
  n: number;
  affected_users: number;
  last_seen_at: string;
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function clientErrorDigestHtml(p: {
  rows: DigestRow[];
  totalErrors: number;
  totalOccurrences: number;
  link: string;
}): string {
  const tr = p.rows
    .map(
      (r) =>
        `<tr>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#222;max-width:320px;word-break:break-word">${escapeHtml(r.message)}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#555;font-family:monospace;font-size:12px">${escapeHtml(r.route || "-")}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#222;text-align:right;font-weight:600">${r.n}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#222;text-align:right">${r.affected_users}</td>` +
        `</tr>`,
    )
    .join("");
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 4px">Client errors -- last 24 hours</h2>
      <p style="margin:0 0 16px;color:#777">${p.totalErrors} distinct error(s), ${p.totalOccurrences} occurrence(s). Top ${p.rows.length} by count:</p>
      <table style="border-collapse:collapse;width:100%">
        <thead>
          <tr style="text-align:left;color:#777;font-size:12px;text-transform:uppercase">
            <th style="padding:6px 10px;border-bottom:2px solid #ddd">Message</th>
            <th style="padding:6px 10px;border-bottom:2px solid #ddd">Route</th>
            <th style="padding:6px 10px;border-bottom:2px solid #ddd;text-align:right">Count</th>
            <th style="padding:6px 10px;border-bottom:2px solid #ddd;text-align:right">Users</th>
          </tr>
        </thead>
        <tbody>${tr}</tbody>
      </table>
      <p style="margin:24px 0">
        <a href="${escapeHtml(p.link)}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Open System Health
        </a>
      </p>
      <p style="color:#777;font-size:12px">
        Automated daily digest from the self-hosted client error reporter. Stacks
        and per-user detail are in the client_errors table / System Health page.
      </p>
    </div>`;
}

export async function runClientErrorDigest(
  env: Env,
): Promise<{ sent: number; errors: number; occurrences: number; purged: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const res = await env.DB.prepare(
    `SELECT MAX(message) AS message,
            MAX(route) AS route,
            MAX(build_id) AS build_id,
            SUM(count) AS n,
            COUNT(DISTINCT user_id) AS affected_users,
            MAX(last_seen_at) AS last_seen_at
       FROM client_errors
      WHERE last_seen_at >= ?
      GROUP BY dedup_hash
      ORDER BY n DESC
      LIMIT 10`,
  )
    .bind(cutoff)
    .all<DigestRow & { n: number | string; affected_users: number | string }>();

  const rows: DigestRow[] = (res.results ?? []).map((r) => ({
    message: String(r.message ?? ""),
    route: String(r.route ?? ""),
    build_id: String(r.build_id ?? ""),
    n: Number(r.n),
    affected_users: Number(r.affected_users),
    last_seen_at: String(r.last_seen_at ?? ""),
  }));

  // Retention sweep rides the same daily slot (idempotency-sweep precedent).
  // Best-effort: a purge failure must never block the digest.
  let purged = 0;
  try {
    const keep = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const del = await env.DB.prepare(`DELETE FROM client_errors WHERE last_seen_at < ?`)
      .bind(keep)
      .run();
    purged = Number(del?.meta?.changes ?? 0);
  } catch (e) {
    console.error("[client-errors] retention sweep failed", e);
  }

  // Zero errors = no email. The digest's whole value is that its arrival MEANS
  // something broke.
  if (rows.length === 0) return { sent: 0, errors: 0, occurrences: 0, purged };

  // True window totals -- the table caps at 10, the subject must not.
  let errors = rows.length;
  let occurrences = rows.reduce((s, r) => s + r.n, 0);
  try {
    const tot = await env.DB.prepare(
      `SELECT COUNT(DISTINCT dedup_hash) AS e, SUM(count) AS o
         FROM client_errors WHERE last_seen_at >= ?`,
    )
      .bind(cutoff)
      .first<{ e: number | string; o: number | string }>();
    if (tot) {
      errors = Number(tot.e) || errors;
      occurrences = Number(tot.o) || occurrences;
    }
  } catch {
    // Top-10 sums are a fine floor if the totals query hiccups.
  }

  const subject = `[Houzs ERP] Client errors -- ${errors} distinct, ${occurrences} occurrence(s) in 24h`;
  const html = clientErrorDigestHtml({
    rows,
    totalErrors: errors,
    totalOccurrences: occurrences,
    link: publicUrl(env, "/system-health"),
  });

  const result = await sendEmail(env, {
    to: DIGEST_TO,
    subject,
    html,
    purpose: "client_error_digest",
  });

  return { sent: result.status === "sent" ? 1 : 0, errors, occurrences, purged };
}
