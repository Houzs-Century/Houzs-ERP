import type { Env } from "../types";
import {
  getBrandingForCompany,
  shortCompanyName,
  HOUZS_COMPANY_CODE,
} from "./branding";


export type EmailPurpose =
  | "assr_survey"
  | "assr_sla_escalation"
  | "assr_alert_stage_entered"
  | "assr_alert_half_time"
  | "assr_alert_approaching_breach"
  | "assr_alert_breach"
  | "assr_daily_digest"
  | "supplier_invite"
  | "member_invite"
  | "project_due_reminder"
  | "password_reset"
  | "delivery_order"
  | "invoice"
  | "document_report"
  | "purchase_order"
  | "client_error_digest"
  | "meeting"
  | "generic";

export interface SendOptions {
  to: string | string[] | null | undefined;
  cc?: string | string[] | null;
  bcc?: string | string[] | null;
  subject: string;
  html: string;
  text?: string;
  purpose: EmailPurpose;
  refType?: string | null;
  refId?: number | null;
  replyTo?: string | null;
  from?: string | null;
  attachments?: Array<{ filename: string; content: string }>;
  headers?: Record<string, string> | null;
  outboxRetry?: boolean;
  companyCode?: string | null;
}

export interface SendResult {
  status: "sent" | "skipped" | "error";
  providerId?: string;
  reason?: string;
  outboxId?: string;
  retrying?: boolean;
}

const PURPOSE_TOGGLE_KEYS: Record<EmailPurpose, string> = {
  assr_survey: "email.assr_survey",
  assr_sla_escalation: "email.assr_sla_escalation",
  assr_alert_stage_entered: "email.assr_alert_stage_entered",
  assr_alert_half_time: "email.assr_alert_half_time",
  assr_alert_approaching_breach: "email.assr_alert_approaching_breach",
  assr_alert_breach: "email.assr_alert_breach",
  assr_daily_digest: "email.assr_daily_digest",
  supplier_invite: "email.supplier_invite",
  member_invite: "email.member_invite",
  project_due_reminder: "email.project_due_reminder",
  password_reset: "email.password_reset",
  delivery_order: "email.delivery_order",
  invoice: "email.invoice",
  document_report: "email.document_report",
  purchase_order: "email.purchase_order",
  client_error_digest: "email.client_error_digest",
  meeting: "email.meeting",
  generic: "email.enabled",
};

const FAIL_CLOSED_PURPOSES: ReadonlySet<EmailPurpose> = new Set([
  "delivery_order",
  "invoice",
  "document_report",
  "purchase_order",
]);

export async function isChannelEnabled(env: Env, purpose: EmailPurpose): Promise<boolean> {
  const master = await readSetting<{ value: boolean }>(env, "email.enabled");
  if (master && master.value === false) return false;
  const k = PURPOSE_TOGGLE_KEYS[purpose];
  if (k === "email.enabled") return true;
  const s = await readSetting<{ value: boolean }>(env, k);
  if (FAIL_CLOSED_PURPOSES.has(purpose)) return s?.value === true;
  return s?.value !== false;
}

async function readSetting<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare(
    `SELECT value FROM app_settings WHERE key = ?`
  )
    .bind(key)
    .first<{ value: string }>();
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function logEmail(
  env: Env,
  opts: SendOptions,
  result: SendResult,
  error?: string | null
) {
  try {
    await env.DB.prepare(
      `INSERT INTO email_log
         (purpose, ref_type, ref_id, to_addr, subject, status, provider_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        opts.purpose,
        opts.refType ?? null,
        opts.refId ?? null,
        opts.to ?? "",
        opts.subject,
        result.status,
        result.providerId ?? null,
        error ?? result.reason ?? null
      )
      .run();
  } catch (e) {
    console.error("[email_log] insert failed", e);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function deliverViaResend(
  env: Env,
  m: { to: string; cc?: string | null; bcc?: string | null; subject: string; html: string; text?: string | null; replyTo?: string | null; from?: string | null; attachments?: Array<{ filename: string; content: string }> | null; headers?: Record<string, string> | null; companyCode?: string | null },
): Promise<SendResult> {
  let from: string | undefined;
  const explicitFrom = (m.from ?? "").trim();
  if (explicitFrom) {
    if (explicitFrom.includes("<")) {
      from = explicitFrom;
    } else {
      const branding = await getBrandingForCompany(env, m.companyCode);
      from = `${branding.companyName} <${explicitFrom}>`;
    }
  } else if (env.EMAIL_FROM) {
    const configured = env.EMAIL_FROM.trim();
    if (configured.includes("<")) {
      from = configured;
    } else {
      const branding = await getBrandingForCompany(env, m.companyCode);
      from = `${branding.companyName} <${configured}>`;
    }
  }
  if (!from) {
    const branding = await getBrandingForCompany(env, m.companyCode);
    const domain = (branding.email.split("@")[1] || "houzscentury.com").trim();
    from = `${branding.companyName} <no-reply@${domain}>`;
  }
  const replyTo = m.replyTo ?? env.EMAIL_REPLY_TO ?? null;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: recipientList(m.to),
        ...(recipientList(m.cc).length ? { cc: recipientList(m.cc) } : {}),
        ...(recipientList(m.bcc).length ? { bcc: recipientList(m.bcc) } : {}),
        subject: m.subject,
        html: m.html,
        text: m.text || stripHtml(m.html),
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments } : {}),
        ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { status: "error", reason: `resend ${resp.status}: ${body.slice(0, 300)}` };
    }
    const data = (await resp.json().catch(() => ({}))) as { id?: string };
    return { status: "sent", providerId: data.id };
  } catch (e: any) {
    return { status: "error", reason: e?.message || String(e) };
  }
}

/** A recipient field -> a clean, de-duplicated list. Accepts the single string
 *  every caller used before this, an array, or a comma/semicolon-separated
 *  string (what the outbox column holds, and what a human pastes).
 *
 *  De-duplication is case-insensitive and load-bearing: the same address in To
 *  and Cc would otherwise make the provider deliver twice, and a reply-all that
 *  includes our own mailbox would loop mail back into the thread it came from. */
export function recipientList(v: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(v) ? v : String(v ?? "").split(/[,;]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const addr = String(item ?? "").trim();
    if (!addr || !addr.includes("@")) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

export async function sendEmail(env: Env, opts: SendOptions): Promise<SendResult> {
  const toList = recipientList(opts.to);
  const onTo = new Set(toList.map((a) => a.toLowerCase()));
  const ccList = recipientList(opts.cc).filter((a) => !onTo.has(a.toLowerCase()));
  const onToCc = new Set([...onTo, ...ccList.map((a) => a.toLowerCase())]);
  const bccList = recipientList(opts.bcc).filter((a) => !onToCc.has(a.toLowerCase()));
  const to = toList.join(", ");
  if (!to || !to.includes("@")) {
    const result: SendResult = { status: "skipped", reason: "missing or invalid recipient" };
    await logEmail(env, opts, result);
    return result;
  }

  if (!(await isChannelEnabled(env, opts.purpose))) {
    const result: SendResult = { status: "skipped", reason: "channel disabled" };
    await logEmail(env, opts, result);
    return result;
  }

  if (!env.RESEND_API_KEY) {
    const result: SendResult = { status: "skipped", reason: "RESEND_API_KEY not configured" };
    await logEmail(env, opts, result);
    return result;
  }

  const id = crypto.randomUUID();
  let enqueued = false;
  try {
    await env.DB.prepare(
      `INSERT INTO email_outbox
         (id, to_address, cc_address, bcc_address, subject, body_html, body_text, purpose, ref_type, ref_id, reply_to, company_code, from_address, headers, status, attempts, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?)`,
    )
      .bind(id, to, ccList.join(", ") || null, bccList.join(", ") || null, opts.subject, opts.html, opts.text ?? null, opts.purpose, opts.refType ?? null, opts.refId ?? null, opts.replyTo ?? null, opts.companyCode ?? null, opts.from ?? null, opts.headers ? JSON.stringify(opts.headers) : null, new Date().toISOString())
      .run();
    enqueued = true;
  } catch (e) {
    console.warn("[email] outbox enqueue failed; sending inline only:", e);
  }

  const result = await deliverViaResend(env, {
    to,
    cc: ccList.join(", ") || null,
    bcc: bccList.join(", ") || null,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    replyTo: opts.replyTo,
    from: opts.from,
    attachments: opts.attachments,
    headers: opts.headers,
    companyCode: opts.companyCode,
  });
  let retrying = false;
  try {
    if (result.status === "sent") {
      await env.DB.prepare(`UPDATE email_outbox SET status='sent', sent_at=datetime('now'), provider_id=?, claimed_at=NULL WHERE id=?`).bind(result.providerId ?? null, id).run();
    } else if (opts.outboxRetry === false) {
      await env.DB.prepare(`UPDATE email_outbox SET status='failed', last_error=?, claimed_at=NULL WHERE id=?`)
        .bind(`${result.reason ?? "send failed"} [not retried: the caller reports the failure instead]`, id)
        .run();
    } else if (opts.attachments?.length) {
      const stashed = await stashOutboxAttachments(env, id, opts.attachments);
      if (stashed) {
        await env.DB.prepare(`UPDATE email_outbox SET attachments=?, last_error=?, claimed_at=NULL WHERE id=?`).bind(stashed, result.reason ?? null, id).run();
        retrying = enqueued;
      } else {
        await env.DB.prepare(`UPDATE email_outbox SET status='failed', last_error=?, claimed_at=NULL WHERE id=?`)
          .bind(`${result.reason ?? "send failed"} [not retried: attachments could not be stored for the retry]`, id)
          .run();
      }
    } else {
      await env.DB.prepare(`UPDATE email_outbox SET last_error=?, claimed_at=NULL WHERE id=?`).bind(result.reason ?? null, id).run();
      retrying = enqueued;
    }
  } catch {
  }
  await logEmail(env, opts, result);
  if (!enqueued) return result;
  return result.status === "error" ? { ...result, outboxId: id, retrying } : { ...result, outboxId: id };
}

async function stashOutboxAttachments(
  env: Env,
  outboxId: string,
  attachments: Array<{ filename: string; content: string }>,
): Promise<string | null> {
  try {
    const list: Array<{ filename: string; key: string }> = [];
    for (const [i, a] of attachments.entries()) {
      const key = `mail-outbox/${outboxId}/${i + 1}`;
      await env.POD_BUCKET.put(key, a.content);
      list.push({ filename: a.filename, key });
    }
    return JSON.stringify(list);
  } catch (e) {
    console.warn("[email] could not store attachments for retry:", e);
    return null;
  }
}

async function loadOutboxAttachments(
  env: Env,
  json: string,
): Promise<Array<{ filename: string; content: string }> | null> {
  try {
    const list = JSON.parse(json) as Array<{ filename: string; key: string }>;
    const out: Array<{ filename: string; content: string }> = [];
    for (const a of list) {
      const obj = await env.POD_BUCKET.get(a.key);
      if (!obj) return null;
      out.push({ filename: a.filename, content: await obj.text() });
    }
    return out;
  } catch {
    return null;
  }
}

function parseHeaders(json: string | null): Record<string, string> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/** How long a sender holds an outbox row (email_outbox.claimed_at). A claim
 *  older than this is treated as abandoned (a Worker killed mid-send) and the
 *  row may be taken again. Longer than any Resend call and than the 5-minute
 *  cron period, so a slow but live send is never taken over. */
export const EMAIL_CLAIM_LEASE_MS = 10 * 60_000;

/** Take one pending row for sending: a compare-and-set that only one caller
 *  can win, so two drains running at once never send the same row twice.
 *  Returns the row's attempts as it stands at the claim (null = not ours): the
 *  drain's earlier SELECT can be stale if another drain already tried the row. */
export async function claimOutboxRow(env: Env, id: string, nowMs: number): Promise<{ attempts: number } | null> {
  const row = await env.DB.prepare(
    `UPDATE email_outbox SET claimed_at=? WHERE id=? AND status='pending' AND (claimed_at IS NULL OR claimed_at < ?) RETURNING attempts`,
  )
    .bind(new Date(nowMs).toISOString(), id, new Date(nowMs - EMAIL_CLAIM_LEASE_MS).toISOString())
    .first<{ attempts: number | null }>();
  return row ? { attempts: Number(row.attempts ?? 0) } : null;
}

export async function drainEmailOutbox(
  env: Env,
  limit = 25,
): Promise<{ processed: number; sent: number; failed: number }> {
  if (!env.RESEND_API_KEY) return { processed: 0, sent: 0, failed: 0 };
  const nowMs = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id, to_address, cc_address, bcc_address, subject, body_html, body_text, purpose, ref_type, ref_id, reply_to, company_code, from_address, headers, attachments, attempts
       FROM email_outbox WHERE status = 'pending' AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY created_at LIMIT ?`,
  )
    .bind(new Date(nowMs - EMAIL_CLAIM_LEASE_MS).toISOString(), limit)
    .all<{
      id: string;
      to_address: string;
      cc_address: string | null;
      bcc_address: string | null;
      subject: string;
      body_html: string | null;
      body_text: string | null;
      purpose: EmailPurpose;
      ref_type: string | null;
      ref_id: number | null;
      reply_to: string | null;
      company_code: string | null;
      from_address: string | null;
      headers: string | null;
      attachments: string | null;
      attempts: number;
    }>();

  let sent = 0;
  let failed = 0;
  const list = rows.results ?? [];
  let processed = 0;
  for (const r of list) {
    const claim = await claimOutboxRow(env, r.id, nowMs);
    if (!claim) continue;
    processed++;
    if (!(await isChannelEnabled(env, r.purpose))) {
      await env.DB.prepare(
        `UPDATE email_outbox SET status='failed', last_error='channel disabled at drain', claimed_at=NULL WHERE id=?`,
      )
        .bind(r.id)
        .run();
      await logEmail(
        env,
        {
          to: r.to_address,
          subject: r.subject,
          html: r.body_html ?? "",
          purpose: r.purpose,
          refType: r.ref_type ?? undefined,
          refId: r.ref_id ?? undefined,
        },
        { status: "skipped", reason: "channel disabled at drain" },
      );
      continue;
    }
    const attachments = r.attachments ? await loadOutboxAttachments(env, r.attachments) : null;
    if (r.attachments && !attachments) {
      await env.DB.prepare(
        `UPDATE email_outbox SET status='failed', last_error='attachment missing at drain', claimed_at=NULL WHERE id=?`,
      )
        .bind(r.id)
        .run();
      failed++;
      continue;
    }
    const result = await deliverViaResend(env, {
      to: r.to_address,
      cc: r.cc_address,
      bcc: r.bcc_address,
      subject: r.subject,
      html: r.body_html ?? "",
      text: r.body_text,
      replyTo: r.reply_to,
      from: r.from_address,
      headers: parseHeaders(r.headers),
      attachments,
      companyCode: r.company_code,
    });
    const attempts = claim.attempts + 1;
    if (result.status === "sent") {
      await env.DB.prepare(`UPDATE email_outbox SET status='sent', sent_at=datetime('now'), attempts=?, provider_id=?, claimed_at=NULL WHERE id=?`).bind(attempts, result.providerId ?? null, r.id).run();
      sent++;
    } else {
      const status = attempts >= 3 ? "failed" : "pending";
      await env.DB.prepare(`UPDATE email_outbox SET status=?, attempts=?, last_error=?, claimed_at=NULL WHERE id=?`).bind(status, attempts, result.reason ?? null, r.id).run();
      if (status === "failed") failed++;
    }
    await logEmail(
      env,
      {
        to: r.to_address,
        subject: r.subject,
        html: r.body_html ?? "",
        purpose: r.purpose,
        refType: r.ref_type ?? undefined,
        refId: r.ref_id ?? undefined,
      },
      result,
    );
  }
  return { processed, sent, failed };
}

const COMPANY_PUBLIC_URLS: Record<string, string> = {};

export function publicUrl(env: Env, path: string, companyCode?: string | null): string {
  const code = (companyCode ?? "").trim().toUpperCase();
  const base = (
    (code && code !== HOUZS_COMPANY_CODE && COMPANY_PUBLIC_URLS[code]) ||
    env.PUBLIC_APP_URL ||
    "https://erp.houzscentury.com"
  ).replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}


/** Product name for template copy ("You're invited to <X> ERP"). Derives from
 *  the company's Branding so 2990 invites read "2990's Home ERP". Callers pass
 *  the branding they already fetched; no branding → the historical literal. */
export function erpProductName(branding?: { companyName: string } | null): string {
  if (!branding?.companyName?.trim()) return "Houzs ERP";
  return `${shortCompanyName(branding.companyName)} ERP`;
}

export function inviteEmailHtml(p: {
  link: string;
  roleName: string;
  inviterName: string;
  expiresIn: string;
  productName?: string;
}): string {
  const product = p.productName?.trim() || "Houzs ERP";
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 10px">You're invited to ${product}</h2>
      <p>${escapeHtml(p.inviterName)} has invited you to join the ${product} workspace as <strong>${escapeHtml(p.roleName)}</strong>.</p>
      <p style="margin:24px 0">
        <a href="${escapeHtml(p.link)}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Accept invitation
        </a>
      </p>
      <p style="color:#777;font-size:12px">
        You'll be asked to set your own password. If the button doesn't work,
        paste this link into your browser:
      </p>
      <p style="color:#555;font-size:11px;word-break:break-all">${escapeHtml(p.link)}</p>
      <p style="color:#777;font-size:12px">
        This invitation expires in ${p.expiresIn}. If you weren't expecting it,
        you can ignore this email.
      </p>
    </div>`;
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Shared customer-facing document email (Delivery Order, Invoice, Report all
// reuse this — only the label + summary rows differ). HTML-only: it inlines the
// document summary and optionally links to a view/print page, rather than
// attaching a PDF.
//
// WHY no PDF — and note the ORIGINAL reason has half expired, so read this
// before "fixing" it: Cloudflare Workers has no headless-browser PDF path, and
// Houzs's only PDF generator is frontend jsPDF (frontend/src/vendor/scm/lib/
// pdf-common.ts), which lazily embeds a Noto Sans SC subset and verifies the
// font's own cmap covers every codepoint (:196-245), throwing rather than
// emitting corruption. Writing a BACKEND generator to attach one would mean a
// SECOND engine that cannot do that — HOOKKA has exactly that and its backend
// PDF crashes on any Chinese character, smart quote or em-dash. Owner's
// direction (2026-07-17): Houzs does not build engine two. backend/package.json
// has no pdf dependency; keep it that way.
//
// The part that IS now stale: this comment used to also say "deliverViaResend
// has no attachment param". It has one — the Mail Center added it (SendOptions
// .attachments → the provider payload, :233). So attaching a PDF the BROWSER
// rendered and stored is open, and the owner expects to want it
// ("之後可能也會要附件"). One catch to design around when that lands:
// email_outbox has no attachment column (see SendOptions.attachments), so a
// cron-drained RETRY of a failed send delivers the body WITHOUT the attachment.
//
// Every interpolated value is escaped (escapeHtml) since it can be customer text.
export function documentEmailHtml(p: {
  docTypeLabel: string;
  docNo: string;
  recipientName: string;
  rows: Array<{ label: string; value: string }>;
  viewLink?: string | null;
  note?: string | null;
  companyName?: string;
}): string {
  const label = escapeHtml(p.docTypeLabel);
  const company = escapeHtml(p.companyName?.trim() || "Houzs Century");
  const summary = p.rows
    .map(
      (r) =>
        `<tr><td style="padding:4px 14px 4px 0;color:#777;white-space:nowrap">${escapeHtml(r.label)}</td>` +
        `<td style="padding:4px 0;color:#222;font-weight:600">${escapeHtml(r.value)}</td></tr>`,
    )
    .join("");
  const button = p.viewLink
    ? `<p style="margin:24px 0"><a href="${escapeHtml(p.viewLink)}"
         style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">View ${label}</a></p>`
    : "";
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 4px">${company}</h2>
      <p style="margin:0 0 16px;color:#777">${label} ${escapeHtml(p.docNo)}</p>
      <p>Dear ${escapeHtml(p.recipientName)},</p>
      <p>Please find your ${escapeHtml(p.docTypeLabel.toLowerCase())} details below.</p>
      <table style="border-collapse:collapse;margin:12px 0">${summary}</table>
      ${p.note ? `<p style="color:#555">${escapeHtml(p.note)}</p>` : ""}
      ${button}
      <p style="color:#777;font-size:12px;margin-top:24px">
        This is an automated message from ${company}. Reply to this email if
        you have any questions about your order.
      </p>
    </div>`;
}

export function resetEmailHtml(p: {
  name: string;
  link: string;
  expiresIn: string;
  requestedBy: string | null;
  productName?: string;
}): string {
  const product = p.productName?.trim() || "Houzs ERP";
  const intro = p.requestedBy
    ? `${escapeHtml(p.requestedBy)} has initiated a password reset for your ${product} account.`
    : `We received a request to reset the password for your ${product} account. If this was you, set a new password below.`;
  return `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
      <h2 style="margin:0 0 10px">Hi ${escapeHtml(p.name)},</h2>
      <p>${intro}</p>
      <p style="margin:24px 0">
        <a href="${escapeHtml(p.link)}"
           style="display:inline-block;padding:12px 22px;background:#a16a2e;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Set new password
        </a>
      </p>
      <p style="color:#777;font-size:12px">
        This link expires in ${p.expiresIn}. If you didn't expect this email,
        you can ignore it — but if you notice repeated resets on your
        account, flag it with your admin.
      </p>
    </div>`;
}


export async function getAllEmailSettings(env: Env): Promise<Record<string, any>> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM app_settings WHERE key LIKE 'email.%'`
  ).all<{ key: string; value: string }>();
  const out: Record<string, any> = {};
  for (const r of rows.results ?? []) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = null;
    }
  }
  return out;
}

export async function setSetting(
  env: Env,
  key: string,
  value: any,
  userId: number | null
) {
  const json = JSON.stringify(value);
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`
  )
    .bind(key, json, userId ?? null)
    .run();
}
