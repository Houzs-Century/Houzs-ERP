import type { Env } from "../types";
import {
  getBrandingForCompany,
  shortCompanyName,
  HOUZS_COMPANY_CODE,
} from "./branding";

// ── Email service (Resend-backed) ─────────────────────────────
//
// Design goals:
//   • No-op safely when secrets or recipients are missing.  send()
//     never throws — it returns a result object that callers can log
//     but don't *need* to check. This keeps notification calls off
//     the critical path of mutations like "close case" or "escalate".
//   • Every attempt (sent / skipped / error) is written to email_log
//     so ops can trace a missing email to a specific reason without
//     digging through worker logs.
//   • Channel toggles in app_settings let admins disable categories
//     (e.g. flip off SLA escalation during a quiet week) without
//     needing a deploy.

export type EmailPurpose =
  | "assr_survey"
  | "assr_sla_escalation"
  // v3.1 per-stage alert events (one toggle each so admins can mute
  // half-time chatter while leaving breach alerts on)
  | "assr_alert_stage_entered"
  | "assr_alert_half_time"
  | "assr_alert_approaching_breach"
  | "assr_alert_breach"
  | "assr_daily_digest"
  | "supplier_invite"
  | "member_invite"
  | "project_due_reminder"
  | "password_reset"
  // Customer-facing document emails (auto-send foundation). All OFF by default
  // (seeded false in mig 098) — high-stakes outbound, flip per-channel when ready.
  | "delivery_order"
  | "invoice"
  | "document_report"
  // Supplier-facing: a Purchase Order sent to its supplier. OFF by default
  // (seeded false in mig 0132), fail-closed — a PO reaches an external supplier
  // only when the owner flips this channel on, and only on a human action.
  | "purchase_order"
  // Internal IT telemetry: the daily client-error digest (services/
  // clientErrors.ts). Internal channel — default ON when the toggle row is
  // missing, like the other digests.
  | "client_error_digest"
  | "generic";

export interface SendOptions {
  /** One address, or several. A list goes out as ONE message with every
   *  recipient on it — never one message each. See `cc` below for why. */
  to: string | string[] | null | undefined;
  /** Carbon copy. Visible to everyone on the message.
   *
   *  ONE SEND, NOT N SENDS. The outbox row is drained with a SINGLE provider
   *  call carrying every recipient, so a delivery either happens or does not.
   *  Looping per recipient would let a mid-loop failure leave the row 'pending'
   *  and the 5-minute cron retry would deliver a SECOND copy to everyone who
   *  already had it. */
  cc?: string | string[] | null;
  /** Blind carbon copy. Not visible to the other recipients. */
  bcc?: string | string[] | null;
  subject: string;
  html: string;
  text?: string;        // plain-text fallback; auto-derived from html if missing
  purpose: EmailPurpose;
  refType?: string | null;
  refId?: number | null;
  replyTo?: string | null;
  // Optional From override. When set, the outbound From is this address (wrapped
  // with the Branding company name as the display name) INSTEAD of the default
  // no-reply@<domain> / EMAIL_FROM. Used by the Mail Center so a reply/compose
  // goes out FROM the chosen mailbox (e.g. hello@houzscentury.com or
  // hello@2990shome.com). The address must be on a Resend-VERIFIED domain to
  // deliver. Bare address (no "<>") — the company display name is added here.
  from?: string | null;
  // Optional attachments forwarded to the provider on the IMMEDIATE send (Mail
  // Center reply/compose). `content` is base64. NOT persisted to the outbox row
  // (email_outbox has no attachment column), so a drained retry sends body-only.
  attachments?: Array<{ filename: string; content: string }>;
  // Whether a FAILED immediate send may be retried by the 5-minute cron drain.
  // Default true (the historical behaviour, and the right one for a body-only
  // message: a durable retry is strictly better than a lost email).
  //
  // Pass FALSE when the message's value depends on an ATTACHMENT. email_outbox
  // has no attachment column (see `attachments` above), so a drained retry
  // re-sends the BODY ALONE — for a document email that means the supplier or
  // customer receives a covering note for a document that isn't there, while the
  // operator, having been told "not sent", sends a second complete copy. The row
  // is still written (so the failure is visible in the outbox and email_log); it
  // is just marked terminal instead of pending.
  outboxRetry?: boolean;
  // Which company's identity the outbound mail carries ('HOUZS' | '2990').
  // Drives the From DISPLAY NAME (the address itself stays the verified Resend
  // sender — see deliverViaResend). Persisted to email_outbox.company_code so
  // a cron-drained retry renders the same identity. Omitted → HOUZS (legacy).
  companyCode?: string | null;
}

export interface SendResult {
  status: "sent" | "skipped" | "error";
  providerId?: string;
  reason?: string;
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
  // No toggle for 'generic' — caller opted in explicitly.
  generic: "email.enabled",
};

// Customer-facing channels FAIL CLOSED: a missing toggle row (fresh/restored
// DB, dropped seed) must never auto-email a real customer. Legacy internal
// channels keep their historical default-ON (their rows were never all seeded).
const FAIL_CLOSED_PURPOSES: ReadonlySet<EmailPurpose> = new Set([
  "delivery_order",
  "invoice",
  "document_report",
  "purchase_order",
]);

// Exported so a caller that takes a SIDE EFFECT alongside the send (the DO
// email claims delivery_orders.do_email_sent_at before sending) can check the
// gate BEFORE it writes anything. sendEmail re-checks independently, so this is
// an early-out, never the only gate.
export async function isChannelEnabled(env: Env, purpose: EmailPurpose): Promise<boolean> {
  // Master kill-switch first.
  const master = await readSetting<{ value: boolean }>(env, "email.enabled");
  if (master && master.value === false) return false;
  // Per-channel check.
  const k = PURPOSE_TOGGLE_KEYS[purpose];
  if (k === "email.enabled") return true;
  const s = await readSetting<{ value: boolean }>(env, k);
  // Customer-facing: ON only when explicitly true (missing row = OFF).
  if (FAIL_CLOSED_PURPOSES.has(purpose)) return s?.value === true;
  // Internal channels: default ON if the row is missing.
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
    // Logging failures are non-fatal — the request already succeeded.
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

// Low-level Resend POST. No logging / no outbox — shared by sendEmail and the
// outbox drain. Returns 'sent' | 'error' (caller pre-checks channel + key).
async function deliverViaResend(
  env: Env,
  m: { to: string; cc?: string | null; bcc?: string | null; subject: string; html: string; text?: string | null; replyTo?: string | null; from?: string | null; attachments?: Array<{ filename: string; content: string }> | null; companyCode?: string | null },
): Promise<SendResult> {
  // From-name + fallback sender address come from the central Branding config
  // (per-company: m.companyCode, default HOUZS) so the outbound identity tracks
  // Settings, not a hardcode. EMAIL_FROM (when set) still supplies the ADDRESS
  // — it's the verified Resend sender; a 2990 sender domain is an ops task
  // (Resend domain verification), so only the DISPLAY NAME follows the company
  // for now. The no-EMAIL_FROM fallback keeps the local-part
  // no-reply@<branding.email's domain> so the address stays deliverable on the
  // verified domain.
  //
  // EXCEPTION: an explicit per-message `from` (Mail Center reply/compose) wins
  // over both — the operator's chosen mailbox becomes the visible sender. We
  // wrap the bare address with the company's Branding display name. The address
  // must be on a Resend-VERIFIED domain (houzscentury.com; 2990shome.com once
  // the owner verifies it) to deliver.
  let from: string | undefined;
  const explicitFrom = (m.from ?? "").trim();
  if (explicitFrom) {
    // Already a "Name <addr>" form? Use as-is; otherwise add the company name.
    if (explicitFrom.includes("<")) {
      from = explicitFrom;
    } else {
      const branding = await getBrandingForCompany(env, m.companyCode);
      from = `${branding.companyName} <${explicitFrom}>`;
    }
  } else if (env.EMAIL_FROM) {
    const configured = env.EMAIL_FROM.trim();
    if (configured.includes("<")) {
      // Operator configured a full "Name <addr>" identity — respect it as-is
      // (it can't be re-branded per company without corrupting the address).
      from = configured;
    } else {
      // Bare verified address — wrap it with the sending company's display
      // name so 2990 documents arrive as "2990's Home <no-reply@…>" while the
      // address stays on the verified Resend domain.
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
        /* ARRAYS, and one call. Resend delivers a single message addressed to
           everyone listed; sending per recipient would turn a mid-loop failure
           into a duplicate on the cron retry. */
        to: recipientList(m.to),
        ...(recipientList(m.cc).length ? { cc: recipientList(m.cc) } : {}),
        ...(recipientList(m.bcc).length ? { bcc: recipientList(m.bcc) } : {}),
        subject: m.subject,
        html: m.html,
        text: m.text || stripHtml(m.html),
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments } : {}),
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
  /* Cc/Bcc minus anyone already on To — see recipientList: a duplicate across
     fields makes the provider deliver the same message twice. */
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

  // Durable: enqueue first (so a failed send is never silently lost), then try
  // to deliver immediately. On failure the row stays 'pending' for the */5 cron
  // drain (drainEmailOutbox) to retry. email_log remains the per-attempt audit.
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO email_outbox
         (id, to_address, cc_address, bcc_address, subject, body_html, body_text, purpose, ref_type, ref_id, reply_to, company_code, status, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)`,
    )
      /* Stored as the joined lists so a cron retry sends to exactly the same
         people the immediate attempt did — a retry that quietly dropped the Cc
         would be worse than the failure it is recovering from. */
      .bind(id, to, ccList.join(", ") || null, bccList.join(", ") || null, opts.subject, opts.html, opts.text ?? null, opts.purpose, opts.refType ?? null, opts.refId ?? null, opts.replyTo ?? null, opts.companyCode ?? null)
      .run();
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
    companyCode: opts.companyCode,
  });
  try {
    if (result.status === "sent") {
      await env.DB.prepare(`UPDATE email_outbox SET status='sent', sent_at=datetime('now') WHERE id=?`).bind(id).run();
    } else if (opts.outboxRetry === false) {
      // Attachment-bearing message: mark terminal so the cron never re-delivers
      // it body-only (see SendOptions.outboxRetry). The row and the reason stay
      // for the ops trace — this suppresses the RETRY, not the record.
      await env.DB.prepare(`UPDATE email_outbox SET status='failed', last_error=? WHERE id=?`)
        .bind(`${result.reason ?? "send failed"} [not retried: message carried an attachment the outbox cannot store]`, id)
        .run();
    } else {
      await env.DB.prepare(`UPDATE email_outbox SET last_error=? WHERE id=?`).bind(result.reason ?? null, id).run();
    }
  } catch {
    /* outbox bookkeeping is best-effort */
  }
  await logEmail(env, opts, result);
  return result;
}

// Cron drain (called from the every-5-min scheduled handler): retry pending
// outbox rows — the immediate-send failures. Up to 3 attempts total, then
// 'failed'. No-op when RESEND_API_KEY is unset. Each attempt mirrors to email_log.
export async function drainEmailOutbox(
  env: Env,
  limit = 25,
): Promise<{ processed: number; sent: number; failed: number }> {
  if (!env.RESEND_API_KEY) return { processed: 0, sent: 0, failed: 0 };
  const rows = await env.DB.prepare(
    `SELECT id, to_address, cc_address, bcc_address, subject, body_html, body_text, purpose, ref_type, ref_id, reply_to, company_code, attempts
       FROM email_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      to_address: string;
      /* Re-sent to exactly the people the first attempt addressed. A retry that
         quietly dropped the Cc would be worse than the failure it recovers. */
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
      attempts: number;
    }>();

  let sent = 0;
  let failed = 0;
  const list = rows.results ?? [];
  for (const r of list) {
    // Respect the LIVE channel toggle at retry time: an admin may have turned
    // the channel (or master switch) OFF after this row was enqueued. Don't
    // deliver it then — mark it terminal so the drain stops re-trying.
    if (!(await isChannelEnabled(env, r.purpose))) {
      await env.DB.prepare(
        `UPDATE email_outbox SET status='failed', last_error='channel disabled at drain' WHERE id=?`,
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
    const result = await deliverViaResend(env, {
      to: r.to_address,
      cc: r.cc_address,
      bcc: r.bcc_address,
      subject: r.subject,
      html: r.body_html ?? "",
      text: r.body_text,
      replyTo: r.reply_to,
      companyCode: r.company_code,
    });
    const attempts = (r.attempts ?? 0) + 1;
    if (result.status === "sent") {
      await env.DB.prepare(`UPDATE email_outbox SET status='sent', sent_at=datetime('now'), attempts=? WHERE id=?`).bind(attempts, r.id).run();
      sent++;
    } else {
      const status = attempts >= 3 ? "failed" : "pending";
      await env.DB.prepare(`UPDATE email_outbox SET status=?, attempts=?, last_error=? WHERE id=?`).bind(status, attempts, result.reason ?? null, r.id).run();
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
  return { processed: list.length, sent, failed };
}

// ── Convenience: build a public URL for email links ──────────
// Used by callers to build survey / portal / invite / reset URLs.
// Falls back to the canonical user-facing domain if PUBLIC_APP_URL is unset.
//
// Per-company: links in a 2990-identity email should land on 2990's hostname
// (companyContext's hostname default then resolves 2990 as the login default).
// Callers pass the company code where they know it; omitted → the historical
// PUBLIC_APP_URL / houzscentury.com behaviour, so untouched callers (cron
// reminders, escalations) are unchanged.

const COMPANY_PUBLIC_URLS: Record<string, string> = {
  "2990": "https://erp.2990shome.com",
};

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

// ── Shared transactional templates ───────────────────────────
// Kept here (not in route files) so invite + reset mail share one
// look and both invite paths (issue + resend) render identically.

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
  /** Company-branded product name (erpProductName). Default keeps the
   *  historical copy for untouched callers. */
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

// HTML-escape interpolated values. Document emails embed customer-controlled
// free text (names, addresses, driver/lorry fields); without escaping a value
// containing < > & " would corrupt or inject markup into the outbound email.
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
  docTypeLabel: string; // "Delivery Order" | "Invoice" | "Report"
  docNo: string;
  recipientName: string;
  rows: Array<{ label: string; value: string }>; // summary key/values
  viewLink?: string | null; // tokenized public view/print URL, optional
  note?: string | null;
  // Company name for the header + footer — pass branding.companyName from the
  // central Branding config. Falls back to the historical literal so existing
  // callers (and any pre-migration call) render unchanged.
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
  /** Company-branded product name (erpProductName). Default keeps the
   *  historical copy for untouched callers. */
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

// ── Settings helpers exposed to routes ────────────────────────

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
