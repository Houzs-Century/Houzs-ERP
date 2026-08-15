// ---------------------------------------------------------------------------
// Mail Center — in-ERP shared inbox for the company's email.
//
// Ported from Hookka (src/api/routes/mail-center.ts). Adaptations for Houzs:
//   • SINGLE-TENANT — every org_id / getOrgId / DEFAULT_ORG_ID is DROPPED.
//   • Houzs is snake_case (postgres.js, NO camelCase transform), so the row
//     mappers read PLAIN snake_case columns — the Hookka `r.camelCase ??
//     r.snake_case` dual-reads are removed.
//   • Query API: c.env.DB.prepare().bind().first()/.all()/.run() (d1-compat shim).
//   • Outbound send uses Houzs sendEmail (Resend) — NOT Hookka sendMail/Brevo.
//   • Attachments live in R2 (POD_BUCKET) and stream through an authed route
//     (GET /attachments/:id) — no Supabase Storage, no signed URLs.
//   • Auth: c.get("user") = AuthUser{ id:number, permissions[], ... }; super-admin
//     = permissions.includes("*") || mail_center.manage. Admin endpoints
//     (addresses / access / scope-level) are gated by requirePermission, mounted
//     in index.ts; reads/reply/compose/star/label/trash gate on mailbox SCOPE
//     ownership (a non-owner gets 404), NOT a permission key.
//   • From-default + the inbound mailbox domain read getBranding(env), never a
//     literal.
//   • Schema is a real migration (0039) applied before deploy — there is NO
//     runtime self-apply.
//
// Timestamp columns are TEXT, written via new Date().toISOString() (per mig 0008).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthUser } from "../services/auth";
import { hasPermission } from "../services/permissions";
import { recipientList, sendEmail } from "../services/email";
import { getBranding, getBrandingForCompany } from "../services/branding";
import { validateMailAttachments } from "../lib/mail-attachments";
import { isSalesDirectorUser } from "../services/pmsAccess";
import { activeCompanyId, activeCompanySql } from "../scm/lib/companyScope";
import { toArray, stripHtml, safeIso, base64ToBytes, safeFilename } from "../services/mail-parse";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Multi-company scoping (merge: HOUZS=1, 2990=2). Every PER-COMPANY mail table
// (email_addresses / email_address_access / email_threads / email_messages /
// email_labels) carries a company_id (migration 0107). Authed reads/writes in
// this router filter/stamp the ACTIVE company via activeCompanyId(c) /
// activeCompanySql(c) — both NO-OP when the company is unresolved (pre-migration
// / cold-start), so single-company Houzs never locks out.
//
// The PRE-AUTH inbound path (ingestInboundEmail) has no request context, so it
// resolves the company from the RECIPIENT address instead — see
// companyCodeForRecipient / resolveInboundCompanyId below.
// ---------------------------------------------------------------------------

// Recipient-address -> company CODE mapping for inbound tagging. EXTENSIBLE:
// add a company's inbound address(es) / domain here so their mail is tagged to
// that company. Anything unmatched defaults to HOUZS (the base company).
// Literals are correct HERE (pre-auth path, no request context to resolve a
// company from) — everywhere else the domain comes from Branding.
const RECIPIENT_COMPANY_RULES: Array<{
  match: (addr: string) => boolean;
  code: string;
}> = [
  // HOUZS inbound addresses / domain.
  {
    match: (a) => a.endsWith("@houzscentury.com") || a === "hello@houzscentury.com",
    code: "HOUZS",
  },
  // 2990's inbound domain (hello@2990shome.com et al).
  {
    match: (a) => a.endsWith("@2990shome.com"),
    code: "2990",
  },
];

// Resolve the owning company CODE for one inbound email from its recipients
// (Delivered-To, then To, then Cc). First matching rule wins; unmatched => HOUZS.
function companyCodeForRecipient(recipients: string[]): string {
  for (const r of recipients) {
    const a = (r ?? "").trim().toLowerCase();
    if (!a) continue;
    for (const rule of RECIPIENT_COMPANY_RULES) {
      if (rule.match(a)) return rule.code;
    }
  }
  return "HOUZS";
}

// Map a company CODE to its numeric id from the companies master. Returns null
// when the master is absent (pre-migration / cold-start) or the code is unknown,
// so the caller degrades to leaving company_id unstamped — the column DEFAULTs
// to HOUZS (migration 0107), never a NOT NULL violation.
async function companyIdForCode(
  db: D1Database,
  code: string,
): Promise<number | null> {
  try {
    const row = await db
      .prepare(`SELECT id FROM companies WHERE code = ? LIMIT 1`)
      .bind(code)
      .first<{ id: number | string }>();
    return row?.id != null ? Number(row.id) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inbound ingestion — called by the pre-auth /inbound route (routes/mail-inbound.ts)
// and by the admin test-inject endpoint below.
// ---------------------------------------------------------------------------
// One inbound attachment as it arrives on the /inbound payload. The sync layer
// base64-encodes the raw bytes so the JSON POST stays credential-free; the ERP
// owns storage (uploads to R2 here). Oversized files are dropped at the sync
// layer, so contentBase64 is always sane to decode in the Worker.
export interface InboundAttachmentPayload {
  filename?: string;
  contentType?: string;
  contentId?: string;
  contentBase64?: string;
}

export interface InboundEmailPayload {
  from?: string;
  fromName?: string;
  to?: string[] | string;
  cc?: string[] | string;
  // The envelope recipient as seen by the receiving server (the Delivered-To /
  // Received-for header). With the FREE-ALIAS model every dept alias
  // (operation@/sales@/marketing@/finance@/hr@) is an alias of the single hello@
  // mailbox, so ALL mail is pulled from ONE IMAP account and `to` may not name
  // the alias that was actually hit (list mail, BCC, forwards). Delivered-To is
  // the authoritative routing key; we prefer it over `to`/`cc` when matching one
  // of our email_addresses. May be a single address or a list.
  deliveredTo?: string[] | string;
  subject?: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[] | string;
  date?: string;
  attachments?: InboundAttachmentPayload[];
}

export type IngestResult =
  | { ok: true; threadId: string; messageId: string; deduped?: boolean }
  | { ok: false; error: string };

/* toArray / stripHtml / safeIso / base64ToBytes / safeFilename moved VERBATIM to
   services/mail-parse.ts (imported above). They are pure — no env, no database,
   no R2 — so lifting them changes nothing here, and this file is over its
   file-size ceiling: the only way to clear that is to take something out.
   They now have tests, which they did not have inline. */

// Persist the attachments for one freshly-stored (or backfilled) message: upload
// each file's bytes to R2 (POD_BUCKET) and INSERT an email_attachments row.
// Best-effort per attachment — a single failed upload/insert is logged and
// skipped so the rest of the email is unaffected. No-op when there is no bucket
// or no attachments. R2 key scheme: mail/{messageId}/{n}-{safeFilename}.
async function storeAttachments(
  db: D1Database,
  env: Env | undefined,
  msgRowId: string,
  attachments: InboundAttachmentPayload[] | undefined,
): Promise<void> {
  if (!attachments || attachments.length === 0) return;
  if (!env?.POD_BUCKET) {
    console.warn(
      "[mail-center] attachments present but POD_BUCKET not configured — skipping",
    );
    return;
  }
  const now = new Date().toISOString();
  let idx = 0;
  for (const att of attachments) {
    idx++;
    const bytes = base64ToBytes(att.contentBase64 ?? "");
    if (!bytes || bytes.length === 0) {
      console.warn(
        `[mail-center] attachment ${idx} on ${msgRowId} had no decodable content — skipping`,
      );
      continue;
    }
    const fname = safeFilename(att.filename);
    const contentType = (att.contentType || "application/octet-stream").slice(0, 200);
    // Prefix each file with its index so two same-named files on one email don't
    // collide on the same R2 key.
    const storagePath = `mail/${msgRowId}/${idx}-${fname}`;
    try {
      await env.POD_BUCKET.put(storagePath, bytes, {
        httpMetadata: { contentType },
      });
      await db
        .prepare(
          `INSERT INTO email_attachments
             (id, message_id, filename, content_type, size_bytes,
              storage_path, content_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          msgRowId,
          att.filename ?? fname,
          contentType,
          bytes.length,
          storagePath,
          att.contentId ?? null,
          now,
        )
        .run();
    } catch (e) {
      console.error(
        `[mail-center] failed to store attachment ${idx} on ${msgRowId}:`,
        e,
      );
    }
  }
}

// The inbound mailbox domain (e.g. "houzscentury.com") comes from the central
// Branding config — never a literal. Falls back to houzscentury.com if Branding
// is unreadable (getBranding never throws).
async function brandingDomain(env: Env | undefined): Promise<string> {
  if (!env) return "houzscentury.com";
  try {
    const branding = await getBranding(env);
    return (branding.email.split("@")[1] || "houzscentury.com").trim().toLowerCase();
  } catch {
    return "houzscentury.com";
  }
}

export async function ingestInboundEmail(
  db: D1Database,
  payload: InboundEmailPayload,
  // Env carries the R2 binding for attachment storage + Branding for the inbound
  // domain. Absent => attachments are skipped, the message itself still stores.
  env?: Env,
): Promise<IngestResult> {
  const from = (payload.from || "").trim();
  if (!from) return { ok: false, error: "missing from address" };

  const to = toArray(payload.to);
  const cc = toArray(payload.cc);
  const deliveredTo = toArray(payload.deliveredTo);

  // Which of OUR addresses did this hit? With the free-alias model the dept
  // alias is in Delivered-To (the envelope recipient), NOT necessarily in To/Cc.
  // Resolve against email_addresses in priority order:
  //   1. Delivered-To  (authoritative envelope recipient — the alias hit)
  //   2. To, then Cc   (header recipients — covers direct sends + back-compat)
  // The FIRST registered address that matches wins, so mail to sales@ lands on
  // the Sales mailbox even though it was pulled from the shared hello@ account.
  let mailbox = "";
  const matchOrder = [...deliveredTo, ...to, ...cc];
  for (const r of matchOrder) {
    const hit = await db
      .prepare(
        `SELECT address FROM email_addresses WHERE lower(address) = lower(?) LIMIT 1`,
      )
      .bind(r)
      .first<{ address: string }>();
    if (hit?.address) {
      mailbox = hit.address;
      break;
    }
  }
  if (!mailbox) {
    // No registered alias matched. Fall back to the first recipient on our
    // branding domain, then any first recipient, then the general hello@ inbox.
    const domain = await brandingDomain(env);
    const recipients = [...deliveredTo, ...to, ...cc];
    mailbox =
      recipients.find((r) => r.toLowerCase().endsWith(`@${domain}`)) ||
      recipients[0] ||
      `hello@${domain}`;
  }

  // Which company owns this inbound mail? Resolved from the recipient address
  // (see companyCodeForRecipient). Unresolved => null, and the INSERTs below omit
  // company_id so it falls to the column DEFAULT (HOUZS) — never a NOT NULL
  // violation, so inbound never breaks.
  const companyId = await companyIdForCode(
    db,
    companyCodeForRecipient([...deliveredTo, ...to, ...cc]),
  );
  const stampCo = companyId != null;

  const now = new Date().toISOString();
  const sentAt = safeIso(payload.date, now);
  const subject = (payload.subject || "(no subject)").slice(0, 500);
  const snippet = (payload.text || stripHtml(payload.html || "") || "")
    .trim()
    .slice(0, 240);

  // Idempotency — the inbound worker may retry. Skip if we already stored this
  // Message-ID. BUT: if the existing message has NO attachments yet and this
  // (re)delivery carries some, backfill them onto the already-ingested message.
  if (payload.messageId) {
    const dup = await db
      .prepare(
        `SELECT id, thread_id FROM email_messages WHERE message_id = ? LIMIT 1`,
      )
      .bind(payload.messageId)
      .first<{ id: string; thread_id?: string }>();
    if (dup?.id) {
      if (payload.attachments && payload.attachments.length > 0) {
        const existing = await db
          .prepare(
            `SELECT COUNT(*) AS n FROM email_attachments WHERE message_id = ?`,
          )
          .bind(dup.id)
          .first<{ n?: number | string }>();
        const have = Number(existing?.n ?? 0);
        if (have === 0) {
          await storeAttachments(db, env, dup.id, payload.attachments);
        }
      }
      return {
        ok: true,
        threadId: dup.thread_id ?? "",
        messageId: dup.id,
        deduped: true,
      };
    }
  }

  // Thread resolution: follow In-Reply-To / References back to an existing
  // message's thread. Otherwise start a new thread.
  let threadId = "";
  const refs = [payload.inReplyTo, ...toArray(payload.references)].filter(
    Boolean,
  ) as string[];
  if (refs.length) {
    const placeholders = refs.map(() => "?").join(", ");
    const ref = await db
      .prepare(
        `SELECT thread_id FROM email_messages WHERE message_id IN (${placeholders}) LIMIT 1`,
      )
      .bind(...refs)
      .first<{ thread_id?: string }>();
    if (ref?.thread_id) threadId = ref.thread_id;
  }

  if (!threadId) {
    threadId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO email_threads
           (id, mailbox_address, subject, counterparty_email,
            counterparty_name, status, last_message_at, last_direction,
            last_snippet, message_count, unread, created_at${stampCo ? ", company_id" : ""})
         VALUES (?, ?, ?, ?, ?, 'open', ?, 'inbound', ?, 1, 1, ?${stampCo ? ", ?" : ""})`,
      )
      .bind(
        threadId,
        mailbox,
        subject,
        from,
        payload.fromName ?? null,
        sentAt,
        snippet,
        now,
        ...(stampCo ? [companyId] : []),
      )
      .run();
  } else {
    // Re-open a closed thread when a new inbound message lands.
    await db
      .prepare(
        `UPDATE email_threads
            SET last_message_at = ?, last_direction = 'inbound',
                last_snippet = ?, message_count = message_count + 1,
                unread = 1,
                status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
          WHERE id = ?`,
      )
      .bind(sentAt, snippet, threadId)
      .run();
  }

  const msgId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO email_messages
         (id, thread_id, direction, message_id, in_reply_to,
          reference_ids, from_address, from_name, to_addresses, cc_addresses,
          subject, text_body, html_body, sent_at, received_at, created_at${stampCo ? ", company_id" : ""})
       VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`,
    )
    .bind(
      msgId,
      threadId,
      payload.messageId ?? null,
      payload.inReplyTo ?? null,
      toArray(payload.references).join(" ") || null,
      from,
      payload.fromName ?? null,
      JSON.stringify(to),
      cc.length ? JSON.stringify(cc) : null,
      subject,
      payload.text ?? null,
      payload.html ?? null,
      sentAt,
      now,
      now,
      ...(stampCo ? [companyId] : []),
    )
    .run();

  // Upload + index any attachments for this newly-stored message. Best-effort.
  await storeAttachments(db, env, msgId, payload.attachments);

  return { ok: true, threadId, messageId: msgId };
}

// ---------------------------------------------------------------------------
// Row -> API shape mappers. Houzs is snake_case (no camelCase transform), so
// these read plain snake columns. The API shape stays camelCase for the FE.
// ---------------------------------------------------------------------------
type ThreadRow = {
  id: string;
  mailbox_address: string | null;
  subject: string | null;
  counterparty_email: string | null;
  counterparty_name: string | null;
  status: string;
  assigned_to_user_id: number | null;
  assigned_to_name: string | null;
  last_message_at: string | null;
  last_direction: string | null;
  last_snippet: string | null;
  message_count: number | string | null;
  unread: number | boolean | null;
  starred: number | boolean | null;
  labels: string | null;
  trashed_at: string | null;
  created_at: string | null;
  // Computed (not a column): EXISTS roll-up of any outbound message, so the
  // frontend's Sent folder is accurate instead of relying on last_direction.
  has_outbound?: number | boolean | null;
};

function rowToThread(r: ThreadRow) {
  return {
    id: r.id,
    mailboxAddress: r.mailbox_address ?? "",
    subject: r.subject ?? "(no subject)",
    counterpartyEmail: r.counterparty_email ?? "",
    counterpartyName: r.counterparty_name ?? "",
    status: r.status,
    assignedToUserId: r.assigned_to_user_id ?? undefined,
    assignedToName: r.assigned_to_name ?? undefined,
    lastMessageAt: r.last_message_at ?? "",
    lastDirection: r.last_direction ?? "inbound",
    lastSnippet: r.last_snippet ?? "",
    messageCount: Number(r.message_count ?? 0),
    unread: Number(r.unread ?? 0) === 1,
    starred: Number(r.starred ?? 0) === 1,
    labels: parseJsonArray(r.labels),
    trashedAt: r.trashed_at ?? null,
    hasOutbound: Number(r.has_outbound ?? 0) === 1,
    createdAt: r.created_at ?? "",
  };
}

type MessageRow = {
  id: string;
  thread_id: string;
  direction: string;
  message_id: string | null;
  in_reply_to: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  sent_at: string | null;
  received_at: string | null;
  sent_by_user_id: number | null;
  sent_by_name: string | null;
  created_at: string | null;
};

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function rowToMessage(r: MessageRow) {
  return {
    id: r.id,
    threadId: r.thread_id,
    direction: r.direction,
    messageId: r.message_id ?? undefined,
    inReplyTo: r.in_reply_to ?? undefined,
    fromAddress: r.from_address ?? "",
    fromName: r.from_name ?? "",
    toAddresses: parseJsonArray(r.to_addresses),
    ccAddresses: parseJsonArray(r.cc_addresses),
    subject: r.subject ?? "",
    textBody: r.text_body ?? "",
    htmlBody: r.html_body ?? "",
    sentAt: r.sent_at ?? "",
    receivedAt: r.received_at ?? "",
    sentByUserId: r.sent_by_user_id ?? undefined,
    sentByName: r.sent_by_name ?? undefined,
    createdAt: r.created_at ?? "",
  };
}

// Attachment row -> API shape served on each message. `url` is the authed
// streaming route (GET /api/mail-center/attachments/:id), NOT a signed URL.
type AttachmentRow = {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | string | null;
  storage_path: string | null;
  content_id: string | null;
  message_id: string | null;
};

function attachmentToApi(r: AttachmentRow) {
  return {
    id: r.id,
    filename: r.filename ?? "file",
    contentType: r.content_type ?? "application/octet-stream",
    sizeBytes: Number(r.size_bytes ?? 0),
    contentId: r.content_id ?? undefined,
    // Authed stream route — the FE swaps this for a blob URL via the client's
    // authed fetch helper. No signed URL.
    url: `/api/mail-center/attachments/${r.id}`,
  };
}

type AddressRow = {
  id: string;
  address: string;
  label: string | null;
  assigned_user_id: number | null;
  assigned_user_name: string | null;
  assigned_dept: string | null;
  assigned_position: string | null;
  active: number | boolean | null;
  created_at: string | null;
};

function rowToAddress(r: AddressRow) {
  return {
    id: r.id,
    address: r.address,
    label: r.label ?? "",
    assignedUserId: r.assigned_user_id ?? undefined,
    assignedUserName: r.assigned_user_name ?? undefined,
    assignedDept: r.assigned_dept ?? undefined,
    assignedPosition: r.assigned_position ?? undefined,
    active: Number(r.active ?? 0) === 1,
    createdAt: r.created_at ?? "",
  };
}

type LabelRow = {
  id: string;
  name: string;
  color: string | null;
  created_at: string | null;
};

function rowToLabel(r: LabelRow) {
  return {
    id: r.id,
    name: r.name,
    color: r.color ?? "",
    createdAt: r.created_at ?? "",
  };
}

// ---------------------------------------------------------------------------
// Hierarchical mailbox visibility. Super-admin (permissions "*" or
// mail_center.manage) always sees every thread/address. Every other user has a
// VISIBILITY LEVEL in mail_user_scope (default 'personal'):
//   • 'personal'   — own assigned alias(es) + shared mailboxes granted via
//                    email_address_access.
//   • 'department' — the personal set PLUS every active mailbox whose
//                    assigned_dept matches the caller's own dept.
//   • 'company'    — every active mailbox.
// Inherently scoped to the caller — no broad RBAC grant required.
// ---------------------------------------------------------------------------
const MAIL_SCOPE_LEVELS = ["personal", "department", "company"] as const;
type MailScopeLevel = (typeof MAIL_SCOPE_LEVELS)[number];

// A user is a Mail Center admin (sees all) if they hold the "*" wildcard or the
// mail_center.manage permission.
function isMailAdmin(user: AuthUser | undefined): boolean {
  if (!user) return false;
  const granted = user.permissions_set ?? user.permissions;
  return (
    hasPermission(granted, "*") || hasPermission(granted, "mail_center.manage")
  );
}

async function getMailScope(c: Context<{ Bindings: Env }>): Promise<{
  isAdmin: boolean;
  userId: number | null;
  addresses: string[];
  level: string;
}> {
  const userId = c.get("userId") ?? null;
  // Company scope (merge): limit every mailbox lookup to the ACTIVE company so a
  // user only ever resolves addresses — and therefore threads — from the company
  // they're currently in. NO-OP (empty string) when the company is unresolved.
  const coSql = activeCompanySql(c);
  // Visibility follows mail_user_scope.level for EVERYONE, admins included — a
  // mail admin keeps MANAGEMENT rights (isMailAdmin: create/assign mailboxes,
  // set scope) but no longer auto-sees every mailbox, which would defeat the
  // per-user isolation the owner wants. An admin who needs the all-view is given
  // an explicit 'company' scope level.
  if (!userId)
    return { isAdmin: false, userId: null, addresses: [], level: "personal" };

  const levelRow = await c.env.DB.prepare(
    `SELECT level FROM mail_user_scope WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<{ level: string | null }>();
  let level: MailScopeLevel = (MAIL_SCOPE_LEVELS as readonly string[]).includes(
    levelRow?.level ?? "",
  )
    ? (levelRow!.level as MailScopeLevel)
    : "personal";

  // Sales Director → own-department mailbox tier (owner 2026-07, rule 5): the
  // personal set PLUS every active mailbox whose assigned_dept matches the
  // director's ORG department (Sales). This ADDS the Sales mailboxes on top of
  // 'personal' WITHOUT granting the all-mailbox 'company' view — non-Sales
  // mailboxes stay hidden. Keyed off the STABLE ORG FIELD department_name, not
  // the mailbox-owner's assigned_dept (a director may not own a dept mailbox),
  // so it's distinct from the generic 'department' tier below. Never DOWNGRADES
  // an explicitly-set 'company' scope. isMailAdmin (mail_center.manage / `*`)
  // is handled by the caller and is unaffected.
  const user = c.get("user");
  const salesDirDept = isSalesDirectorUser(user)
    ? (user?.department_name ?? "").trim() || "Sales"
    : null;
  if (salesDirDept && level !== "company") {
    const own = await c.env.DB.prepare(
      `SELECT address FROM email_addresses
         WHERE active = 1${coSql} AND (
           assigned_user_id = ?
           OR id IN (SELECT address_id FROM email_address_access WHERE user_id = ?)
         )`,
    )
      .bind(userId, userId)
      .all<{ address: string }>();
    /* Go-live review #12 — the bidirectional substring LIKE over-matched: a
       "Sales" director captured "Presales" / "Wholesales" mailboxes (either
       direction of the LIKE). Tighten to a NORMALIZED equality (case-insensitive,
       trimmed) on the department name so a Sales director sees exactly the Sales
       department's mailboxes and nothing whose name merely contains "sales". */
    const deptRows = await c.env.DB.prepare(
      `SELECT address FROM email_addresses
         WHERE active = 1${coSql}
           AND assigned_dept IS NOT NULL AND trim(assigned_dept) <> ''
           AND lower(trim(assigned_dept)) = lower(trim(?))`,
    )
      .bind(salesDirDept)
      .all<{ address: string }>();
    const addrs = [
      ...(own.results ?? []).map((r) => r.address),
      ...(deptRows.results ?? []).map((r) => r.address),
    ];
    return {
      isAdmin: false,
      userId,
      addresses: dedupeLower(addrs),
      level: "department",
    };
  }

  // 'company' — every active mailbox.
  if (level === "company") {
    const all = await c.env.DB.prepare(
      `SELECT address FROM email_addresses WHERE active = 1${coSql}`,
    ).all<{ address: string }>();
    return {
      isAdmin: false,
      userId,
      addresses: dedupeLower((all.results ?? []).map((r) => r.address)),
      level,
    };
  }

  // 'personal' base set: own assigned alias(es) + granted shared mailboxes.
  const own = await c.env.DB.prepare(
    `SELECT address FROM email_addresses
       WHERE active = 1${coSql} AND (
         assigned_user_id = ?
         OR id IN (SELECT address_id FROM email_address_access WHERE user_id = ?)
       )`,
  )
    .bind(userId, userId)
    .all<{ address: string }>();
  const addresses = (own.results ?? []).map((r) => r.address);

  // 'department' — additionally every active mailbox in the caller's own dept.
  if (level === "department") {
    /* Go-live review #12 — the caller's department is the caller's OWN org
       department_name, not whatever dept happens to be stamped on a mailbox they
       were granted access to. Deriving it from an owned mailbox row let a member
       whose only assigned mailbox carries an unrelated assigned_dept scope to the
       WRONG department. Prefer the caller's org department_name; fall back to the
       mailbox-derived dept only when the org field is absent (legacy rows). */
    let dept = (user?.department_name ?? "").trim();
    if (!dept) {
      const deptRow = await c.env.DB.prepare(
        `SELECT assigned_dept FROM email_addresses
           WHERE assigned_user_id = ?${coSql}
             AND assigned_dept IS NOT NULL AND assigned_dept <> '' LIMIT 1`,
      )
        .bind(userId)
        .first<{ assigned_dept?: string | null }>();
      dept = (deptRow?.assigned_dept ?? "").trim();
    }
    if (dept) {
      const deptRows = await c.env.DB.prepare(
        `SELECT address FROM email_addresses
           WHERE active = 1${coSql}
             AND lower(trim(assigned_dept)) = lower(trim(?))`,
      )
        .bind(dept)
        .all<{ address: string }>();
      addresses.push(...(deptRows.results ?? []).map((r) => r.address));
    } else {
      level = "personal";
    }
  }

  return { isAdmin: false, userId, addresses: dedupeLower(addresses), level };
}

// The caller's OWN outward alias (users.email_alias), lowercased — their personal
// sending identity under the free-alias model. A member may send FROM this even
// when it isn't a shared/dept mailbox in their getMailScope set. "" when none.
async function ownAliasFor(
  c: Context<{ Bindings: Env }>,
): Promise<string> {
  const user = c.get("user");
  const alias = (user?.email_alias ?? "").trim().toLowerCase();
  if (alias) return alias;
  // Fallback for callers whose cached AuthUser predates the email_alias field:
  // read it straight from users by id.
  const userId = c.get("userId") ?? null;
  if (userId == null) return "";
  try {
    const row = await c.env.DB.prepare(
      `SELECT email_alias FROM users WHERE id = ? LIMIT 1`,
    )
      .bind(userId)
      .first<{ email_alias?: string | null }>();
    return (row?.email_alias ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

// Whether `fromAddress` is an allowed sender for this caller: admins may send
// from any; everyone else from a mailbox in their scope OR their own alias.
async function canSendFrom(
  c: Context<{ Bindings: Env }>,
  scope: { isAdmin: boolean; addresses: string[] },
  fromAddress: string,
): Promise<boolean> {
  if (scope.isAdmin) return true;
  const lc = fromAddress.trim().toLowerCase();
  if (!lc) return false;
  if (scope.addresses.includes(lc)) return true;
  const alias = await ownAliasFor(c);
  return !!alias && alias === lc;
}

// Lowercase + de-duplicate an address list (order-preserving).
function dedupeLower(addrs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const lc = (a ?? "").toLowerCase();
    if (!lc || seen.has(lc)) continue;
    seen.add(lc);
    out.push(lc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authenticated read endpoints (mounted at /api/mail-center, AFTER auth).
// Per-user scoped via getMailScope — every logged-in user reads THEIR OWN
// mailbox; admins read all.
// ---------------------------------------------------------------------------

// GET /api/mail-center/threads?mailbox=&status=&q=&starred=&sent=&label=&mailboxes=
// Opt-in pagination: pass page (1-based) + pageSize to get
//   { threads, total, hasMore, page, pageSize }
// instead of the bare array. With NO page/pageSize the response is UNCHANGED
// (bare array, newest 300) so existing callers (the Trash badge fetch, the
// mobile client) are unaffected. Every narrowing the desktop list used to do
// client-side over that truncated 300 — starred / sent / label / q, plus a
// department's mailbox set — is now applied here in SQL, so pagination reaches
// the whole mailbox and a match on thread #900 is no longer invisible.
app.get("/threads", async (c) => {
  const scope = await getMailScope(c);
  const pageParam = c.req.query("page");
  const pageSizeParam = c.req.query("pageSize");
  const paginated = pageParam != null || pageSizeParam != null;
  if (!scope.isAdmin && scope.addresses.length === 0) {
    return c.json(
      paginated
        ? { threads: [], total: 0, hasMore: false, page: 1, pageSize: 0 }
        : [],
    );
  }

  const mailbox = c.req.query("mailbox");
  const status = c.req.query("status");
  const q = c.req.query("q");
  const starredOnly = c.req.query("starred") === "1";
  const sentOnly = c.req.query("sent") === "1";
  const label = c.req.query("label");
  const mailboxesCsv = c.req.query("mailboxes");

  const where: string[] = [];
  const binds: (string | number)[] = [];
  // Company scope (merge): only the active company's threads. Guarded — no-op
  // when unresolved. Belt-and-braces with the address filter below (scope.addresses
  // is already company-scoped via getMailScope).
  const companyId = activeCompanyId(c);
  if (companyId != null) {
    where.push("company_id = ?");
    binds.push(companyId);
  }
  if (!scope.isAdmin) {
    const ph = scope.addresses.map(() => "?").join(", ");
    where.push(`LOWER(mailbox_address) IN (${ph})`);
    binds.push(...scope.addresses);
  }
  if (mailbox) {
    where.push("mailbox_address = ?");
    binds.push(mailbox);
  }
  // Department filter: restrict to an explicit set of mailbox addresses (the
  // dept's mailboxes, sent as a comma list). An empty set — the client sends a
  // "__none__"-style sentinel for a dept with no mailboxes — matches nothing,
  // never everything.
  if (mailboxesCsv != null) {
    const list = mailboxesCsv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (list.length) {
      const ph = list.map(() => "?").join(", ");
      where.push(`LOWER(mailbox_address) IN (${ph})`);
      binds.push(...list);
    } else {
      where.push("1 = 0");
    }
  }
  // Trash is its own folder: status=trashed returns ONLY soft-deleted rows;
  // every other view EXCLUDES them.
  if (status === "trashed") {
    where.push("trashed_at IS NOT NULL");
  } else {
    where.push("trashed_at IS NULL");
    if (status) {
      where.push("status = ?");
      binds.push(status);
    }
  }
  if (starredOnly) {
    where.push("starred = 1");
  }
  // Sent folder: the thread has at least one outbound message (mirrors the
  // has_outbound flag below, but as a WHERE filter).
  if (sentOnly) {
    where.push(
      "EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND m.direction = 'outbound')",
    );
  }
  // Label filter: labels are a JSON string array (e.g. ["Urgent","VIP"]). Match
  // the quoted, lower-cased token so "VIP" doesn't also match "VIProom". Strip
  // quote/LIKE-wildcard chars from the needle to keep the pattern well-formed.
  if (label && label.trim()) {
    const token = label.trim().toLowerCase().replace(/["%_]/g, "");
    where.push("LOWER(labels) LIKE ?");
    binds.push(`%"${token}"%`);
  }
  if (q) {
    where.push(
      "(LOWER(subject) LIKE ? OR LOWER(counterparty_email) LIKE ? OR LOWER(counterparty_name) LIKE ? OR LOWER(last_snippet) LIKE ?)",
    );
    const like = `%${q.toLowerCase()}%`;
    binds.push(like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const selectSql = `SELECT t.*,
       EXISTS (
         SELECT 1 FROM email_messages m
          WHERE m.thread_id = t.id AND m.direction = 'outbound'
       ) AS has_outbound
       FROM email_threads t ${whereSql}`;
  const orderSql = " ORDER BY t.last_message_at DESC NULLS LAST";

  if (paginated) {
    let pageSize = Number(pageSizeParam ?? 50);
    if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 50;
    pageSize = Math.min(pageSize, 200);
    let page = Number(pageParam ?? 1);
    if (!Number.isFinite(page) || page < 1) page = 1;
    const offset = (page - 1) * pageSize;

    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_threads t ${whereSql}`,
    )
      .bind(...binds)
      .first<{ n: number }>();
    const total = Number(countRow?.n ?? 0);

    const res = await c.env.DB.prepare(
      selectSql + orderSql + " LIMIT ? OFFSET ?",
    )
      .bind(...binds, pageSize, offset)
      .all<ThreadRow>();
    const threadsPage = (res.results ?? []).map(rowToThread);
    return c.json({
      threads: threadsPage,
      total,
      hasMore: offset + threadsPage.length < total,
      page,
      pageSize,
    });
  }

  const res = await c.env.DB.prepare(selectSql + orderSql + " LIMIT 300")
    .bind(...binds)
    .all<ThreadRow>();
  return c.json((res.results ?? []).map(rowToThread));
});

// GET /api/mail-center/threads/:id — thread + its messages (marks read).
app.get("/threads/:id", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  const thread = await c.env.DB.prepare(
    `SELECT * FROM email_threads WHERE id = ?${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(id)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((thread.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const msgs = await c.env.DB.prepare(
    `SELECT * FROM email_messages WHERE thread_id = ? ORDER BY created_at ASC`,
  )
    .bind(id)
    .all<MessageRow>();
  const mappedMsgs = (msgs.results ?? []).map(rowToMessage);

  // Attachments — load every attachment for THIS thread's messages and group
  // them under their message. Each carries an authed stream URL (no signed URL).
  const attByMsg = new Map<string, ReturnType<typeof attachmentToApi>[]>();
  try {
    const msgIds = mappedMsgs.map((m) => m.id);
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => "?").join(", ");
      const attRows = await c.env.DB.prepare(
        `SELECT * FROM email_attachments
           WHERE message_id IN (${ph})
           ORDER BY created_at ASC`,
      )
        .bind(...msgIds)
        .all<AttachmentRow>();
      for (const r of attRows.results ?? []) {
        const msgKey = r.message_id ?? "";
        if (!msgKey) continue;
        const item = attachmentToApi(r);
        const list = attByMsg.get(msgKey) ?? [];
        list.push(item);
        attByMsg.set(msgKey, list);
      }
    }
  } catch (e) {
    console.error("[mail-center] loading attachments failed:", e);
  }

  // Clear the unread flag on open.
  try {
    await c.env.DB.prepare(`UPDATE email_threads SET unread = 0 WHERE id = ?`)
      .bind(id)
      .run();
  } catch {
    /* read view must not fail if the mark-read write blips */
  }

  return c.json({
    thread: rowToThread(thread),
    messages: mappedMsgs.map((m) => ({
      ...m,
      attachments: attByMsg.get(m.id) ?? [],
    })),
  });
});

// GET /api/mail-center/attachments/:id — authed R2 stream (replaces signed URLs).
// Scoped: a non-admin may only fetch an attachment whose thread mailbox is in
// their scope. The bytes never leave through a public URL.
app.get("/attachments/:id", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  // Join the attachment -> its message -> its thread so we can scope on the
  // thread's mailbox (the same gate as reading the thread).
  const row = await c.env.DB.prepare(
    `SELECT a.filename, a.content_type, a.storage_path, t.mailbox_address
       FROM email_attachments a
       JOIN email_messages m ON m.id = a.message_id
       JOIN email_threads t ON t.id = m.thread_id
      WHERE a.id = ? LIMIT 1`,
  )
    .bind(id)
    .first<{
      filename: string | null;
      content_type: string | null;
      storage_path: string | null;
      mailbox_address: string | null;
    }>();
  if (!row || !row.storage_path) return c.json({ error: "Not found" }, 404);
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((row.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Not found" }, 404);
  }

  const obj = await c.env.POD_BUCKET.get(row.storage_path);
  if (!obj) return c.json({ error: "Not found" }, 404);
  const filename = safeFilename(row.filename ?? "file");
  // Inbound email attachments carry a sender-controlled content-type. Serving an
  // attacker-shaped text/html or image/svg+xml INLINE would execute script in the
  // ERP origin (token theft). Preview only the known-safe raster/PDF types inline;
  // force every other type to download as octet-stream. nosniff blocks MIME-sniffing
  // of the octet-stream fallback back into html/svg.
  const INLINE_SAFE = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
  ]);
  const storedType = (row.content_type ?? "").toLowerCase().split(";")[0].trim();
  const inlineSafe = INLINE_SAFE.has(storedType);
  return new Response(obj.body as ReadableStream, {
    headers: {
      "Content-Type": inlineSafe ? storedType : "application/octet-stream",
      "Content-Disposition": `${inlineSafe ? "inline" : "attachment"}; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=600",
    },
  });
});

// GET /api/mail-center/addresses — our addresses / aliases, scoped to match the
// thread scope at every visibility level.
app.get("/addresses", async (c) => {
  c.header("Cache-Control", "no-store");
  const scope = await getMailScope(c);
  // ?manage=1 is the management view (MailboxesTab): a mail admin lists EVERY
  // mailbox to assign them to people. The default (sidebar + Compose from-picker)
  // is scope-bound so each user only sees their own + granted mailboxes.
  if (c.req.query("manage") === "1" && isMailAdmin(c.get("user"))) {
    // Management view is still company-scoped: a mail admin manages only the
    // ACTIVE company's mailboxes. Guarded — no-op when unresolved.
    const res = await c.env.DB.prepare(
      `SELECT * FROM email_addresses WHERE 1=1${activeCompanySql(c)} ORDER BY address ASC`,
    ).all<AddressRow>();
    return c.json((res.results ?? []).map(rowToAddress));
  }
  if (scope.addresses.length === 0) return c.json([]);
  const ph = scope.addresses.map(() => "?").join(", ");
  const res = await c.env.DB.prepare(
    `SELECT * FROM email_addresses
       WHERE LOWER(address) IN (${ph})
       ORDER BY address ASC`,
  )
    .bind(...scope.addresses)
    .all<AddressRow>();
  return c.json((res.results ?? []).map(rowToAddress));
});

// ---------------------------------------------------------------------------
// Auto-sent log (the "Auto-sent" folder). The system fires customer notices
// (DO / invoice / document report / member+supplier invites) from no-reply@ via
// the email outbox; there is no human "Sent" copy to look at — owner 2026-06-24
// "因為是 noreply 所以看不到". These two read endpoints expose that durable log,
// read-only, visible to a mail admin OR any user with a mailbox in scope (same
// bar as the inbox). Ported from Hookka. Houzs `email_outbox` columns are
// snake_case (read them snake here, like rowToThread/rowToAddress); statuses are
// stored lowercase (pending/sent/failed) and surfaced UPPERCASE for the UI.
// ---------------------------------------------------------------------------
type OutboxRow = {
  id: string;
  to_address: string | null;
  subject: string | null;
  status: string | null;
  attempts: number | string | null;
  last_error: string | null;
  sent_at: string | null;
  created_at: string | null;
  body_text: string | null;
  body_html: string | null;
};

function outboxSnippet(text: string | null, html: string | null): string {
  const t = (text && text.trim()) || (html ? html.replace(/<[^>]+>/g, " ") : "");
  return t.replace(/\s+/g, " ").trim().slice(0, 200);
}

const OUTBOX_STATUSES = ["pending", "sent", "failed"];

// GET /api/mail-center/outbox?status=&q=&limit=&offset= — the auto-sent log
// (newest first) + a status roll-up for the panel header.
app.get("/outbox", async (c) => {
  const scope = await getMailScope(c);
  const empty = { rows: [], counts: { sent: 0, failed: 0, pending: 0 }, hasMore: false };
  if (!isMailAdmin(c.get("user")) && scope.addresses.length === 0) return c.json(empty);
  c.header("Cache-Control", "no-store");

  const status = (c.req.query("status") || "").trim().toLowerCase();
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "60", 10) || 60, 1), 200);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);

  try {
    const where: string[] = [];
    const binds: (string | number)[] = [];
    if (status && OUTBOX_STATUSES.includes(status)) {
      where.push("status = ?");
      binds.push(status);
    }
    if (q) {
      where.push("(LOWER(to_address) LIKE ? OR LOWER(subject) LIKE ?)");
      const like = `%${q}%`;
      binds.push(like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const res = await c.env.DB.prepare(
      `SELECT id, to_address, subject, status, attempts, last_error,
              sent_at, created_at, body_text, body_html
         FROM email_outbox ${whereSql}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<OutboxRow>();

    const rows = (res.results ?? []).map((r) => ({
      id: r.id,
      toAddress: r.to_address ?? "",
      subject: r.subject ?? "(no subject)",
      status: (r.status ?? "pending").toUpperCase(),
      attempts: Number(r.attempts ?? 0),
      lastError: r.last_error ?? null,
      sentAt: r.sent_at ?? null,
      createdAt: r.created_at ?? "",
      snippet: outboxSnippet(r.body_text, r.body_html),
      attachmentNames: [] as string[],
    }));

    // Status roll-up over the WHOLE log so the header can flag failures.
    const counts = { sent: 0, failed: 0, pending: 0 };
    const countRes = await c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status`,
    ).all<{ status: string; n: number | string }>();
    for (const row of countRes.results ?? []) {
      const s = String(row.status || "").toLowerCase();
      const n = Number(row.n ?? 0);
      if (s === "sent") counts.sent += n;
      else if (s === "failed") counts.failed += n;
      else counts.pending += n;
    }

    return c.json({ rows, counts, hasMore: rows.length === limit });
  } catch (e) {
    // email_outbox may be absent on a very old deploy — degrade to empty.
    console.error("[mail-center] outbox read failed:", e);
    return c.json(empty);
  }
});

// GET /api/mail-center/outbox/:id — one auto-sent email incl. the full body.
app.get("/outbox/:id", async (c) => {
  const scope = await getMailScope(c);
  if (!isMailAdmin(c.get("user")) && scope.addresses.length === 0) {
    return c.json({ error: "not found" }, 404);
  }
  const id = c.req.param("id");
  try {
    const r = await c.env.DB.prepare(
      `SELECT id, to_address, subject, status, attempts, last_error,
              sent_at, created_at, body_text, body_html
         FROM email_outbox WHERE id = ? LIMIT 1`,
    )
      .bind(id)
      .first<OutboxRow>();
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({
      id: r.id,
      toAddress: r.to_address ?? "",
      subject: r.subject ?? "(no subject)",
      status: (r.status ?? "pending").toUpperCase(),
      attempts: Number(r.attempts ?? 0),
      lastError: r.last_error ?? null,
      sentAt: r.sent_at ?? null,
      createdAt: r.created_at ?? "",
      bodyText: r.body_text ?? "",
      bodyHtml: r.body_html ?? "",
      attachmentNames: [] as string[],
    });
  } catch (e) {
    console.error("[mail-center] outbox detail read failed:", e);
    return c.json({ error: "not found" }, 404);
  }
});

// ---------------------------------------------------------------------------
// Label catalogue. Reads are open to any authenticated mailbox user (the
// sidebar needs colours); create/edit/delete require a mailbox in scope — the
// SAME gate as labelling a thread, NOT a permission key.
// ---------------------------------------------------------------------------
const LABEL_COLORS = [
  "#6B5C32",
  "#B45309",
  "#15803D",
  "#0E7490",
  "#1D4ED8",
  "#6D28D9",
  "#BE185D",
  "#B91C1C",
  "#475569",
] as const;
const DEFAULT_LABEL_COLOR = LABEL_COLORS[0];

function normalizeColor(input: string | undefined | null): string {
  const v = (input ?? "").trim();
  if (!v) return DEFAULT_LABEL_COLOR;
  const up = v.toUpperCase();
  const hit = (LABEL_COLORS as readonly string[]).find(
    (c2) => c2.toUpperCase() === up,
  );
  return hit ?? DEFAULT_LABEL_COLOR;
}

// Whether the caller may manage the label catalogue: admin, or any user with at
// least one mailbox in scope (same bar as labelling a thread).
async function canManageLabels(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const scope = await getMailScope(c);
  return scope.isAdmin || scope.addresses.length > 0;
}

// GET /api/mail-center/labels — the catalogue (name + colour).
app.get("/labels", async (c) => {
  c.header("Cache-Control", "no-store");
  // Scope the catalogue to the active company. Guarded — no-op when unresolved.
  const res = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE 1=1${activeCompanySql(c)} ORDER BY name ASC`,
  ).all<LabelRow>();
  return c.json((res.results ?? []).map(rowToLabel));
});

// POST /api/mail-center/labels {name,color} — create a catalogue label.
app.post("/labels", async (c) => {
  if (!(await canManageLabels(c))) {
    return c.json({ error: "no mailbox in scope" }, 403);
  }
  const body = await c.req
    .json<{ name?: string; color?: string }>()
    .catch(() => ({}) as { name?: string; color?: string });
  const name = (body.name ?? "").trim().slice(0, 60);
  if (!name) return c.json({ error: "name is required" }, 400);
  const color = normalizeColor(body.color);

  const existing = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE lower(name) = lower(?)${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(name)
    .first<LabelRow>();
  if (existing) return c.json(rowToLabel(existing));

  const id = crypto.randomUUID();
  const userId = c.get("userId") ?? null;
  // Stamp the active company on the new label. Guarded — omitted when unresolved,
  // so the column DEFAULT (HOUZS) applies.
  const companyId = activeCompanyId(c);
  const stampCo = companyId != null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO email_labels (id, name, color, created_at, created_by${stampCo ? ", company_id" : ""})
       VALUES (?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`,
    )
      .bind(
        id,
        name,
        color,
        new Date().toISOString(),
        userId,
        ...(stampCo ? [companyId] : []),
      )
      .run();
  } catch {
    const row = await c.env.DB.prepare(
      `SELECT * FROM email_labels WHERE lower(name) = lower(?)${activeCompanySql(c)} LIMIT 1`,
    )
      .bind(name)
      .first<LabelRow>();
    return c.json(row ? rowToLabel(row) : { id, name, color });
  }
  const row = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE id = ?${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(id)
    .first<LabelRow>();
  return c.json(row ? rowToLabel(row) : { id, name, color }, 201);
});

// PATCH /api/mail-center/labels/:id {name?,color?} — rename / recolour. A rename
// cascades to every thread carrying the OLD name.
app.patch("/labels/:id", async (c) => {
  if (!(await canManageLabels(c))) {
    return c.json({ error: "no mailbox in scope" }, 403);
  }
  const id = c.req.param("id");
  const body = await c.req
    .json<{ name?: string; color?: string }>()
    .catch(() => ({}) as { name?: string; color?: string });

  const current = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE id = ?${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(id)
    .first<LabelRow>();
  if (!current) return c.json({ error: "label not found" }, 404);

  const sets: string[] = [];
  const binds: (string | null)[] = [];
  let renameFrom = "";
  let renameTo = "";
  if (body.name !== undefined) {
    const name = body.name.trim().slice(0, 60);
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    if (name.toLowerCase() !== current.name.toLowerCase()) {
      const clash = await c.env.DB.prepare(
        `SELECT id FROM email_labels WHERE lower(name) = lower(?) AND id <> ?${activeCompanySql(c)} LIMIT 1`,
      )
        .bind(name, id)
        .first<{ id: string }>();
      if (clash) return c.json({ error: "a label with that name exists" }, 409);
      renameFrom = current.name;
      renameTo = name;
    }
    sets.push("name = ?");
    binds.push(name);
  }
  if (body.color !== undefined) {
    sets.push("color = ?");
    binds.push(normalizeColor(body.color));
  }
  if (sets.length === 0) return c.json({ error: "no fields to update" }, 400);

  await c.env.DB.prepare(
    `UPDATE email_labels SET ${sets.join(", ")} WHERE id = ?${activeCompanySql(c)}`,
  )
    .bind(...binds, id)
    .run();

  if (renameFrom && renameTo) {
    await renameThreadLabel(c, renameFrom, renameTo);
  }

  const row = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE id = ?${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(id)
    .first<LabelRow>();
  return c.json(row ? rowToLabel(row) : { id });
});

// DELETE /api/mail-center/labels/:id — remove a catalogue label and strip it
// from every thread that carried it.
app.delete("/labels/:id", async (c) => {
  if (!(await canManageLabels(c))) {
    return c.json({ error: "no mailbox in scope" }, 403);
  }
  const id = c.req.param("id");
  const current = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE id = ?${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(id)
    .first<LabelRow>();
  if (!current) return c.json({ error: "label not found" }, 404);

  await c.env.DB.prepare(`DELETE FROM email_labels WHERE id = ?${activeCompanySql(c)}`)
    .bind(id)
    .run();
  await renameThreadLabel(c, current.name, "");
  return c.json({ ok: true });
});

// Rewrite one label name across every thread's JSON label array. renameTo=""
// REMOVES the label; otherwise rename in place, de-duped case-insensitively.
async function renameThreadLabel(
  c: Context<{ Bindings: Env }>,
  from: string,
  to: string,
): Promise<void> {
  const like = `%${from}%`;
  // Scope to the active company so a label rename/delete only rewrites THIS
  // company's threads. Guarded — no-op when unresolved.
  const rows = await c.env.DB.prepare(
    `SELECT id, labels FROM email_threads
       WHERE labels IS NOT NULL AND labels LIKE ?${activeCompanySql(c)}`,
  )
    .bind(like)
    .all<{ id: string; labels: string | null }>();
  for (const r of rows.results ?? []) {
    const arr = parseJsonArray(r.labels);
    if (!arr.some((l) => l.toLowerCase() === from.toLowerCase())) continue;
    const next: string[] = [];
    for (const l of arr) {
      if (l.toLowerCase() === from.toLowerCase()) {
        if (to && !next.some((n) => n.toLowerCase() === to.toLowerCase())) {
          next.push(to);
        }
      } else if (!next.some((n) => n.toLowerCase() === l.toLowerCase())) {
        next.push(l);
      }
    }
    await c.env.DB.prepare(`UPDATE email_threads SET labels = ? WHERE id = ?`)
      .bind(JSON.stringify(next), r.id)
      .run();
  }
}

// POST /api/mail-center/test-inject — admin-only: seed ONE sample inbound email
// so the owner can verify the inbox + reply UI BEFORE switching MX (zero infra).
// Gated by requirePermission("mail_center.manage") in index.ts is NOT applied to
// this sub-path (the router is mounted whole), so gate inline on isMailAdmin.
app.post("/test-inject", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
  // Land it on a real configured address if one exists, else <branding domain>.
  const addr = await c.env.DB.prepare(
    `SELECT address FROM email_addresses WHERE active = 1${activeCompanySql(c)} ORDER BY created_at ASC LIMIT 1`,
  ).first<{ address: string }>();
  const domain = await brandingDomain(c.env);
  const mailbox = addr?.address || `support@${domain}`;
  const result = await ingestInboundEmail(
    c.env.DB,
    {
      from: "customer@example.com",
      fromName: "Test Customer",
      to: [mailbox],
      subject: "Test: can you make a 5ft bed frame?",
      text: "Hi, I'd like to order a 5ft bed frame. Could you let me know the price and lead time?\n\n(This is a test email — feel free to delete it.)\n\nThanks,\nTest Customer",
      messageId: `test-${crypto.randomUUID()}@example.com`,
      date: new Date().toISOString(),
    },
    c.env,
  );
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Address admin endpoints. Creating / managing an alias is an account-level
// action, gated on mail_center.manage (owner passes via "*"). The route-level
// requirePermission mount in index.ts protects the router as a whole only for
// the admin sub-paths — but since the whole router is mounted after a single
// permission check would over-gate the reads, these admin handlers each verify
// isMailAdmin inline. (Reads above intentionally stay scope-gated, not perm-gated.)
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/mail-center/addresses — create an alias for a user.
app.post("/addresses", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }

  type CreateBody = {
    address?: string;
    label?: string;
    assignedUserId?: number | null;
    assignedUserName?: string;
    assignedDept?: string;
    assignedPosition?: string;
  };
  const body: CreateBody = await c.req
    .json<CreateBody>()
    .catch(() => ({}) as CreateBody);

  const address = (body.address ?? "").trim().toLowerCase();
  if (!address || !EMAIL_RE.test(address)) {
    return c.json({ error: "invalid email address" }, 400);
  }
  // Enforce the ACTIVE company's domain from its Branding (not a literal, and
  // not the HOUZS row — a 2990 mailbox must be on 2990's own domain). The
  // frontend picker (MailboxesTab) validates against the same company-aware
  // /api/branding, so both surfaces agree.
  const branding = await getBrandingForCompany(c.env, activeCompanyId(c));
  const domain = (branding.email.split("@")[1] || "").trim().toLowerCase();
  if (!domain) {
    return c.json(
      { error: "Set this company's email in Settings -> Branding first; it defines the mailbox domain." },
      400,
    );
  }
  if (!address.endsWith(`@${domain}`)) {
    return c.json({ error: `address must end with @${domain}` }, 400);
  }

  const userId = c.get("userId") ?? null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Stamp the active company on the new mailbox. Guarded — omitted when
  // unresolved, so the column DEFAULT (HOUZS) applies.
  const companyId = activeCompanyId(c);
  const stampCo = companyId != null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO email_addresses
         (id, address, label, assigned_user_id, assigned_user_name,
          assigned_dept, assigned_position, active, created_at, created_by${stampCo ? ", company_id" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?${stampCo ? ", ?" : ""})`,
    )
      .bind(
        id,
        address,
        body.label?.trim() || null,
        body.assignedUserId ?? null,
        body.assignedUserName ?? null,
        body.assignedDept ?? null,
        body.assignedPosition?.trim() || null,
        now,
        userId,
        ...(stampCo ? [companyId] : []),
      )
      .run();
  } catch (e) {
    const existing = await c.env.DB.prepare(
      `SELECT * FROM email_addresses WHERE lower(address) = ? LIMIT 1`,
    )
      .bind(address)
      .first<AddressRow>();
    if (existing) {
      return c.json({ error: "address already exists" }, 409);
    }
    console.error("[mail-center] address insert failed:", e);
    return c.json({ error: "failed to create address" }, 500);
  }

  const row = await c.env.DB.prepare(
    `SELECT * FROM email_addresses WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<AddressRow>();
  return c.json(row ? rowToAddress(row) : { id, address }, 201);
});

// PATCH /api/mail-center/addresses/:id — toggle active / relabel / reassign.
app.patch("/addresses/:id", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
  const id = c.req.param("id");

  type PatchBody = {
    label?: string;
    assignedUserId?: number | null;
    assignedUserName?: string | null;
    assignedDept?: string | null;
    assignedPosition?: string | null;
    active?: boolean;
  };
  const body: PatchBody = await c.req
    .json<PatchBody>()
    .catch(() => ({}) as PatchBody);

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.label !== undefined) {
    sets.push("label = ?");
    binds.push(body.label?.trim() || null);
  }
  if (body.assignedUserId !== undefined) {
    sets.push("assigned_user_id = ?");
    binds.push(body.assignedUserId ?? null);
  }
  if (body.assignedUserName !== undefined) {
    sets.push("assigned_user_name = ?");
    binds.push(body.assignedUserName ?? null);
  }
  if (body.assignedDept !== undefined) {
    sets.push("assigned_dept = ?");
    binds.push(body.assignedDept?.trim() || null);
  }
  if (body.assignedPosition !== undefined) {
    sets.push("assigned_position = ?");
    binds.push(body.assignedPosition?.trim() || null);
  }
  if (body.active !== undefined) {
    sets.push("active = ?");
    binds.push(body.active ? 1 : 0);
  }
  if (sets.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  // Scope the mutation to the active company so an admin can't edit another
  // company's mailbox. Guarded — no-op when unresolved.
  const coSql = activeCompanySql(c);
  const res = await c.env.DB.prepare(
    `UPDATE email_addresses SET ${sets.join(", ")} WHERE id = ?${coSql}`,
  )
    .bind(...binds, id)
    .run();
  if (!res.meta?.changes) {
    return c.json({ error: "address not found" }, 404);
  }

  const row = await c.env.DB.prepare(
    `SELECT * FROM email_addresses WHERE id = ?${coSql} LIMIT 1`,
  )
    .bind(id)
    .first<AddressRow>();
  return c.json(row ? rowToAddress(row) : { id });
});

// ---------------------------------------------------------------------------
// Mailbox access matrix. A user always has their own assigned alias; these
// grants ADDITIONALLY let them open a SHARED mailbox. Admin-only.
// ---------------------------------------------------------------------------

// GET /api/mail-center/access — every (addressId,userId) grant.
app.get("/access", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
  // Scope grants to the active company. Guarded — no-op when unresolved.
  const res = await c.env.DB.prepare(
    `SELECT address_id, user_id FROM email_address_access WHERE 1=1${activeCompanySql(c)}`,
  ).all<{ address_id: string; user_id: number }>();
  c.header("Cache-Control", "no-store");
  return c.json(
    (res.results ?? []).map((r) => ({
      addressId: r.address_id,
      userId: r.user_id,
    })),
  );
});

// POST /api/mail-center/access {addressId,userId} — grant access. Idempotent.
app.post("/access", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
  const body = await c.req
    .json<{ addressId?: string; userId?: number }>()
    .catch(() => ({}) as { addressId?: string; userId?: number });
  const addressId = (body.addressId ?? "").toString().trim();
  const userId = body.userId;
  if (!addressId || userId == null) {
    return c.json({ error: "addressId and userId are required" }, 400);
  }
  const grantedBy = c.get("userId") ?? null;
  // Stamp the active company on the grant. Guarded — omitted when unresolved,
  // so the column DEFAULT (HOUZS) applies.
  const companyId = activeCompanyId(c);
  const stampCo = companyId != null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO email_address_access
         (id, address_id, user_id, created_at, created_by${stampCo ? ", company_id" : ""})
       VALUES (?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`,
    )
      .bind(
        crypto.randomUUID(),
        addressId,
        userId,
        new Date().toISOString(),
        grantedBy,
        ...(stampCo ? [companyId] : []),
      )
      .run();
  } catch {
    // Unique (address_id,user_id) collision → the grant already exists.
  }
  return c.json({ ok: true, addressId, userId }, 201);
});

// DELETE /api/mail-center/access {addressId,userId} — revoke a grant.
app.delete("/access", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
  const body = await c.req
    .json<{ addressId?: string; userId?: number }>()
    .catch(() => ({}) as { addressId?: string; userId?: number });
  const addressId = (body.addressId ?? c.req.query("addressId") ?? "")
    .toString()
    .trim();
  const userIdRaw = body.userId ?? c.req.query("userId");
  const userId = userIdRaw == null ? null : Number(userIdRaw);
  if (!addressId || userId == null || Number.isNaN(userId)) {
    return c.json({ error: "addressId and userId are required" }, 400);
  }
  await c.env.DB.prepare(
    `DELETE FROM email_address_access WHERE address_id = ? AND user_id = ?${activeCompanySql(c)}`,
  )
    .bind(addressId, userId)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Hierarchical mail-visibility levels. Admin sets a per-user level in
// mail_user_scope: 'personal' | 'department' | 'company'. Absent row = personal.
// ---------------------------------------------------------------------------

// GET /api/mail-center/scope-levels — every per-user level row.
app.get("/scope-levels", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
  const res = await c.env.DB.prepare(
    `SELECT user_id, level FROM mail_user_scope`,
  ).all<{ user_id: number; level: string }>();
  c.header("Cache-Control", "no-store");
  return c.json(
    (res.results ?? []).map((r) => ({
      userId: r.user_id,
      level: r.level,
    })),
  );
});

// PUT /api/mail-center/scope-level {userId,level} — upsert a user's level.
app.put("/scope-level", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
  const body = await c.req
    .json<{ userId?: number; level?: string }>()
    .catch(() => ({}) as { userId?: number; level?: string });
  const userId = body.userId;
  const level = (body.level ?? "").trim().toLowerCase();
  if (userId == null) {
    return c.json({ error: "userId is required" }, 400);
  }
  if (!(MAIL_SCOPE_LEVELS as readonly string[]).includes(level)) {
    return c.json(
      { error: "level must be 'personal', 'department', or 'company'" },
      400,
    );
  }
  await c.env.DB.prepare(
    `INSERT INTO mail_user_scope (user_id, level, created_at)
       VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET level = excluded.level`,
  )
    .bind(userId, level, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Reply + compose (mounted at /api/mail-center, AFTER auth). Outbound send uses
// Houzs sendEmail (Resend); from-default + company come from Branding.
// ---------------------------------------------------------------------------

// Resolve a sender display name for the outbound message row. Houzs users.name
// (not Hookka displayName); fall back to email, else the numeric id as a string.
async function senderName(db: D1Database, userId: number | null): Promise<string> {
  if (userId == null) return "";
  try {
    const row = await db
      .prepare("SELECT name, email FROM users WHERE id = ? LIMIT 1")
      .bind(userId)
      .first<{ name: string | null; email: string | null }>();
    return row?.name?.trim() || row?.email || String(userId);
  } catch {
    return String(userId);
  }
}

// Minimal HTML escape for wrapping a plain-text reply into an HTML body.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// POST /api/mail-center/threads/:id/reply — send an outbound reply via Houzs
// sendEmail (Resend), then record it. The From identity (domain/company) tracks
// Branding inside deliverViaResend; the operator's chosen mailbox is honoured
// only when it's in their scope.
//
// NOTE: sendEmail has no custom In-Reply-To / References header support, so this
// reply is NOT RFC-threaded on the recipient's side for v1 — local threading is
// still correct. Attachments ARE now forwarded to Resend on the immediate send
// (contentBase64 -> base64 content); they are not persisted to the outbox row,
// so a drained retry would send body-only.
app.post("/threads/:id/reply", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  type ReplyBody = {
    text?: string;
    html?: string;
    fromAddress?: string;
    /* Reply-all and manual recipients. Both optional: omit them and this route
       behaves exactly as it did — a plain reply to the thread's counterparty. */
    replyAll?: boolean;
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    attachments?: Array<{ filename: string; contentBase64: string }>;
  };
  const body: ReplyBody = await c.req
    .json<ReplyBody>()
    .catch(() => ({}) as ReplyBody);

  const text = (body.text ?? "").trim();
  const html = body.html?.trim() || "";
  if (!text && !html) {
    return c.json({ error: "reply body is empty" }, 400);
  }

  const attachments = body.attachments ?? [];
  const attachCheck = validateMailAttachments(attachments);
  if (!attachCheck.ok) {
    return c.json({ error: attachCheck.error || "Invalid attachments." }, 400);
  }

  const thread = await c.env.DB.prepare(
    `SELECT * FROM email_threads WHERE id = ?${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(id)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((thread.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const mailbox = (thread.mailbox_address ?? "").trim();

  /* WHO THE REPLY GOES TO.
  
     Until now this was one address — thread.counterparty_email — and there was
     no way to add anyone. An email that CC'd three people was answered to
     exactly one of them, silently: the other three never saw the answer and
     nothing on screen said so. Owner, 2026-08-03: "然后那些人回复我的话，我要怎么
     回复他? 怎么在上面回复他们?"
  
     The addresses were never missing. email_messages has stored to_addresses and
     cc_addresses since mig 0039 — inbound Cc has been captured all along and
     simply never read back.
  
     Precedence: an explicit `to` from the caller wins; else reply-all builds the
     list from the newest INBOUND message; else the counterparty, as before. */
  const explicitTo = recipientList(body.to);
  let toList = explicitTo;
  let ccList = recipientList(body.cc);

  if (toList.length === 0 || (body.replyAll && recipientList(body.cc).length === 0)) {
    const lastInbound = await c.env.DB.prepare(
      `SELECT from_address, to_addresses, cc_addresses FROM email_messages
        WHERE thread_id = ? AND direction = 'inbound'
        ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1`,
    )
      .bind(id)
      .first<{ from_address: string | null; to_addresses: string | null; cc_addresses: string | null }>();

    if (toList.length === 0) {
      toList = recipientList(lastInbound?.from_address ?? thread.counterparty_email ?? "");
    }
    if (body.replyAll && ccList.length === 0 && lastInbound) {
      /* Everyone else who was on it, MINUS our own mailbox and minus whoever is
         already on To — replying to ourselves loops mail back into the thread it
         came from, and a duplicate across fields makes the provider deliver
         twice. Bcc is not reconstructed: it was blind, and guessing at it would
         expose a recipient the sender chose to hide. */
      const onTo = new Set(toList.map((a) => a.toLowerCase()));
      const mine = new Set([mailbox.toLowerCase(), ...scope.addresses.map((a) => a.toLowerCase())]);
      ccList = [
        ...recipientList(parseJsonArray(lastInbound.to_addresses)),
        ...recipientList(parseJsonArray(lastInbound.cc_addresses)),
      ].filter((a) => !onTo.has(a.toLowerCase()) && !mine.has(a.toLowerCase()));
    }
  }

  const bccList = recipientList(body.bcc);
  const to = toList.join(", ");
  if (!to) {
    return c.json({ error: "thread has no counterparty email to reply to" }, 400);
  }
  const badReplyAddress = [...toList, ...ccList, ...bccList].find((a) => !EMAIL_RE.test(a));
  if (badReplyAddress) {
    return c.json({ error: `not a valid email address: ${badReplyAddress}` }, 400);
  }

  // Resolve the From: an explicit fromAddress is honoured only when the caller
  // may send from it (admin = any; non-admin = a mailbox in scope OR their own
  // alias). Otherwise fall back to the thread's mailbox (ownership-checked above).
  const requestedFrom = (body.fromAddress ?? "").trim();
  let fromAddress = mailbox;
  if (requestedFrom && (await canSendFrom(c, scope, requestedFrom))) {
    fromAddress = requestedFrom;
  }

  const baseSubject = thread.subject ?? "(no subject)";
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;

  const htmlBody = html || `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;

  // Send via Houzs sendEmail. purpose:"generic" (caller opted in). The From is
  // the operator's chosen mailbox (owner ask: replies come FROM the mailbox, not
  // no-reply@) — sendEmail wraps it with the Branding company display name.
  // replyTo is the same mailbox so the customer's reply lands back on it.
  // companyCode follows the SENDING mailbox's domain (not the session's active
  // company) so a hello@2990shome.com reply reads "2990's Home", and a
  // cron-drained retry renders the same identity.
  const result = await sendEmail(c.env, {
    to,
    cc: ccList.join(", ") || null,
    bcc: bccList.join(", ") || null,
    subject,
    html: htmlBody,
    text: text || undefined,
    purpose: "generic",
    from: fromAddress || undefined,
    replyTo: fromAddress || undefined,
    companyCode: companyCodeForRecipient([fromAddress]),
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: a.contentBase64.replace(/^data:[^;]+;base64,/, ""),
    })),
  });
  if (result.status !== "sent") {
    return c.json(
      { error: result.reason || "failed to send reply" },
      result.status === "skipped" ? 400 : 502,
    );
  }

  const userId = c.get("userId") ?? null;
  const fromName = await senderName(c.env.DB, userId);

  const now = new Date().toISOString();
  const snippet = (text || stripHtml(htmlBody)).slice(0, 240);
  const messageId = crypto.randomUUID();
  // Stamp the active company (the thread was verified in it above). Guarded —
  // omitted when unresolved, so the column DEFAULT (HOUZS) applies.
  const companyId = activeCompanyId(c);
  const stampCo = companyId != null;
  await c.env.DB.prepare(
    `INSERT INTO email_messages
       (id, thread_id, direction, from_address, from_name,
        to_addresses, cc_addresses, subject, text_body, html_body, sent_at, received_at,
        sent_by_user_id, sent_by_name, provider_message_id, created_at${stampCo ? ", company_id" : ""})
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`,
  )
    .bind(
      messageId,
      id,
      fromAddress || null,
      fromName || null,
      /* The full lists, so the thread shows who actually received this and the
         NEXT reply-all reads them back. Bcc is not stored: it was blind, and a
         thread anyone on the mailbox can open is the wrong place to record it. */
      JSON.stringify(toList),
      JSON.stringify(ccList),
      subject,
      text || null,
      htmlBody,
      now,
      now,
      userId,
      fromName || null,
      result.providerId ?? null,
      now,
      ...(stampCo ? [companyId] : []),
    )
    .run();

  await c.env.DB.prepare(
    `UPDATE email_threads
        SET last_message_at = ?, last_direction = 'outbound',
            last_snippet = ?, message_count = message_count + 1, unread = 0
      WHERE id = ?`,
  )
    .bind(now, snippet, id)
    .run();

  return c.json({ ok: true, messageId });
});

// POST /api/mail-center/compose — start a NEW outbound conversation. Sends via
// Houzs sendEmail (Resend), then records a fresh thread + outbound message.
//
// Per-user scope: a non-admin may only send FROM an address that is
// assigned/granted to them (getMailScope). Admins may send from any.
app.post("/compose", async (c) => {
  const scope = await getMailScope(c);

  type ComposeBody = {
    fromAddress?: string;
    /* string | string[] — the single string every caller sent before this still
       works, and a comma/semicolon list is what a human pastes. */
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject?: string;
    text?: string;
    attachments?: Array<{ filename: string; contentBase64: string }>;
  };
  const body: ComposeBody = await c.req
    .json<ComposeBody>()
    .catch(() => ({}) as ComposeBody);

  const fromAddress = (body.fromAddress ?? "").trim();
  const toList = recipientList(body.to);
  const ccList = recipientList(body.cc);
  const bccList = recipientList(body.bcc);
  const to = toList.join(", ");
  const subject = (body.subject ?? "").trim();
  const text = (body.text ?? "").trim();
  const attachments = body.attachments ?? [];

  if (!fromAddress) {
    return c.json({ error: "fromAddress is required" }, 400);
  }
  /* Validate EVERY address, and name the bad one. The old check ran the
     single-address regex over the whole field, so a list failed with "a valid
     recipient is required" and no clue which entry was wrong. */
  if (toList.length === 0) {
    return c.json({ error: "a valid recipient (to) is required" }, 400);
  }
  const badAddress = [...toList, ...ccList, ...bccList].find((a) => !EMAIL_RE.test(a));
  if (badAddress) {
    return c.json({ error: `not a valid email address: ${badAddress}` }, 400);
  }
  if (!subject) {
    return c.json({ error: "subject is required" }, 400);
  }
  if (!text) {
    return c.json({ error: "message body is required" }, 400);
  }

  const attachCheck = validateMailAttachments(attachments);
  if (!attachCheck.ok) {
    return c.json({ error: attachCheck.error || "Invalid attachments." }, 400);
  }

  // Authorize the From: non-admins may only send from a mailbox they own or have
  // been granted, OR their own outward alias (users.email_alias). addresses are
  // already lowercased in getMailScope.
  if (!(await canSendFrom(c, scope, fromAddress))) {
    return c.json({ error: "not allowed to send from " + fromAddress }, 403);
  }

  const htmlBody = `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;

  // From = the operator's chosen mailbox (owner ask), not no-reply@. replyTo is
  // the same so the recipient's reply lands back on it. companyCode follows the
  // mailbox's domain so the display name matches the sending company.
  const result = await sendEmail(c.env, {
    to,
    /* Compose validated and STORED cc/bcc but never passed them to the
       provider, so copied recipients silently never received the mail while
       the thread rendered them (found 2026-08-12, code-read sweep). Same
       shape as the reply path above. */
    cc: ccList.join(", ") || null,
    bcc: bccList.join(", ") || null,
    subject,
    html: htmlBody,
    text,
    purpose: "generic",
    from: fromAddress || undefined,
    replyTo: fromAddress || undefined,
    companyCode: companyCodeForRecipient([fromAddress]),
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: a.contentBase64.replace(/^data:[^;]+;base64,/, ""),
    })),
  });
  if (result.status !== "sent") {
    return c.json(
      { error: result.reason || "send failed" },
      result.status === "skipped" ? 400 : 502,
    );
  }

  const userId = c.get("userId") ?? null;
  const fromName = await senderName(c.env.DB, userId);

  const now = new Date().toISOString();
  const snippet = text.slice(0, 200);
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  // Stamp the active company on the new thread + message. Guarded — omitted when
  // unresolved, so the column DEFAULT (HOUZS) applies.
  const companyId = activeCompanyId(c);
  const stampCo = companyId != null;

  await c.env.DB.prepare(
    `INSERT INTO email_threads
       (id, mailbox_address, subject, counterparty_email,
        counterparty_name, status, last_message_at, last_direction,
        last_snippet, message_count, unread, created_at${stampCo ? ", company_id" : ""})
     VALUES (?, ?, ?, ?, '', 'open', ?, 'outbound', ?, 1, 0, ?${stampCo ? ", ?" : ""})`,
  )
    .bind(
      threadId,
      fromAddress,
      subject,
      to,
      now,
      snippet,
      now,
      ...(stampCo ? [companyId] : []),
    )
    .run();

  await c.env.DB.prepare(
    `INSERT INTO email_messages
       (id, thread_id, direction, from_address, from_name,
        to_addresses, cc_addresses, subject, text_body, html_body, sent_at,
        sent_by_user_id, sent_by_name, provider_message_id, created_at${stampCo ? ", company_id" : ""})
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${stampCo ? ", ?" : ""})`,
  )
    .bind(
      messageId,
      threadId,
      fromAddress,
      fromName || null,
      /* The FULL recipient lists, not just the first address. This row is what
         the thread view renders and what a reply-all reads back — a message
         stored as one recipient makes everyone else invisible in the history
         and drops them from every later reply. Bcc is deliberately NOT stored:
         it is blind, and a thread anyone on the mailbox can open is the wrong
         place to record who was quietly copied. */
      JSON.stringify(toList),
      JSON.stringify(ccList),
      subject,
      text,
      htmlBody,
      now,
      userId,
      fromName || null,
      result.providerId ?? null,
      now,
      ...(stampCo ? [companyId] : []),
    )
    .run();

  return c.json({ ok: true, threadId, messageId }, 201);
});

// PATCH /api/mail-center/threads/:id — mutate a thread: assign / resolve /
// reopen, plus star / labels / mark-unread / trash. Gate matches the READS
// (getMailScope ownership): a mailbox OWNER may mutate THEIR OWN threads;
// admin keeps all. The UPDATE is built dynamically from the body fields.
app.patch("/threads/:id", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  type PatchBody = {
    status?: "open" | "closed";
    assignedToUserId?: number | null;
    assignedToName?: string | null;
    starred?: boolean;
    labels?: string[];
    unread?: boolean;
    trashed?: boolean;
  };
  const body: PatchBody = await c.req
    .json<PatchBody>()
    .catch(() => ({}) as PatchBody);

  const owned = await c.env.DB.prepare(
    `SELECT mailbox_address FROM email_threads WHERE id = ?${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(id)
    .first<{ mailbox_address?: string | null }>();
  if (!owned) return c.json({ error: "Thread not found" }, 404);
  if (
    !scope.isAdmin &&
    !scope.addresses.includes((owned.mailbox_address ?? "").toLowerCase())
  ) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "closed") {
      return c.json({ error: "status must be 'open' or 'closed'" }, 400);
    }
    sets.push("status = ?");
    binds.push(body.status);
  }
  if (body.assignedToUserId !== undefined) {
    sets.push("assigned_to_user_id = ?");
    binds.push(body.assignedToUserId ?? null);
  }
  if (body.assignedToName !== undefined) {
    sets.push("assigned_to_name = ?");
    binds.push(body.assignedToName ?? null);
  }
  if (body.starred !== undefined) {
    sets.push("starred = ?");
    binds.push(body.starred ? 1 : 0);
  }
  if (body.labels !== undefined) {
    const clean = Array.isArray(body.labels)
      ? body.labels.map((l) => String(l).trim()).filter(Boolean)
      : [];
    sets.push("labels = ?");
    binds.push(JSON.stringify(clean));
  }
  if (body.unread !== undefined) {
    sets.push("unread = ?");
    binds.push(body.unread ? 1 : 0);
  }
  if (body.trashed !== undefined) {
    sets.push("trashed_at = ?");
    binds.push(body.trashed ? new Date().toISOString() : null);
  }
  if (sets.length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE email_threads SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...binds, id)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT * FROM email_threads WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<ThreadRow>();
  return c.json(row ? rowToThread(row) : { id });
});

export default app;
