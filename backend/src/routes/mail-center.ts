import { afterReplySent, replyConflict, replyingOn } from "./mail-reply-guard";
import { afterGrantChange, departmentIdsOf, extraScopeDepartments, departmentMailboxes, isInManagement, LEVEL_NAME, recordAccessChange } from "../lib/mail-access";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthUser } from "../services/auth";
import { hasPermission } from "../services/permissions";
import { recipientList, sendEmail } from "../services/email";
import { senderFrom } from "../lib/mail-sender";
import { getBranding, getBrandingForCompany } from "../services/branding";
import { toStoredMailAttachments, validateMailAttachments } from "../lib/mail-attachments";
import { withThreadAttachments } from "../lib/mail-thread-attachments";
import { isSalesDirectorUser } from "../services/pmsAccess";
import { activeCompanyCodePred, activeCompanyId, activeCompanySql } from "../scm/lib/companyScope";
import { toArray, stripHtml, safeIso, base64ToBytes, safeFilename } from "../services/mail-parse";
import {
  backfillOutboundMessageIds,
  recordOutboundMessage,
  threadForReferences,
  threadingHeaders,
  threadMessageIds,
} from "../lib/mail-threading";
import { deliveryStatus } from "../lib/mail-delivery";
import { MY_READ_JOIN, MY_UNREAD_SQL, isThreadUnreadFor, setThreadRead, threadReaders } from "../lib/mail-reads";
import { maskLoginLinks } from "./lib/mail-outbox-mask";
import { acksForMessages, myOwedOnThread, requestAcks, staffRecipients } from "../lib/mail-acks";

const app = new Hono<{ Bindings: Env }>();
const NO_STAFF_TO_ACK = "None of the To / Cc recipients is a staff member, so nobody can acknowledge it.";


const RECIPIENT_COMPANY_RULES: Array<{
  match: (addr: string) => boolean;
  code: string;
}> = [
  {
    match: (a) => a.endsWith("@houzscentury.com") || a === "hello@houzscentury.com",
    code: "HOUZS",
  },
  {
    match: (a) => a.endsWith("@2990shome.com"),
    code: "2990",
  },
];

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
  env?: Env,
): Promise<IngestResult> {
  const from = (payload.from || "").trim();
  if (!from) return { ok: false, error: "missing from address" };

  const to = toArray(payload.to);
  const cc = toArray(payload.cc);
  const deliveredTo = toArray(payload.deliveredTo);

  let mailbox = "";
  const matchOrder = [...deliveredTo, ...to, ...cc];
  for (const r of matchOrder) {
    // company-scope: INBOUND (no session). The address is the routing key and is unique across companies; the owning company is resolved from it just below.
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
    const domain = await brandingDomain(env);
    const recipients = [...deliveredTo, ...to, ...cc];
    mailbox =
      recipients.find((r) => r.toLowerCase().endsWith(`@${domain}`)) ||
      recipients[0] ||
      `hello@${domain}`;
  }

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

  if (payload.messageId) {
    const dup = await db
      .prepare(
        `SELECT id, thread_id FROM email_messages WHERE message_id = ?${stampCo ? " AND company_id = ?" : ""} LIMIT 1`,
      )
      .bind(payload.messageId, ...(stampCo ? [companyId] : []))
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

  const refs = [payload.inReplyTo, ...toArray(payload.references)].filter(
    Boolean,
  ) as string[];
  const co = stampCo ? companyId : null;
  let threadId = (await threadForReferences(db, refs, co)) ?? "";
  if (!threadId && refs.length && env && (await backfillOutboundMessageIds(db, env, co, 10)) > 0) {
    threadId = (await threadForReferences(db, refs, co)) ?? "";
  }

  if (!threadId) {
    threadId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO email_threads
           (id, mailbox_address, subject, counterparty_email,
            counterparty_name, status, last_message_at, last_direction,
            last_snippet, message_count, unread, last_inbound_at, created_at${stampCo ? ", company_id" : ""})
         VALUES (?, ?, ?, ?, ?, 'open', ?, 'inbound', ?, 1, 1, ?, ?${stampCo ? ", ?" : ""})`,
      )
      .bind(threadId, mailbox, subject, from, payload.fromName ?? null, sentAt, snippet, now, now, ...(stampCo ? [companyId] : []))
      .run();
  } else {
    // Re-open a closed thread when a new inbound message lands. last_inbound_at
    // is the ERP's receipt time, which each person's read_at is compared with.
    // company-scope: threadId came from threadForReferences(db, refs, co), which is already limited to this mail's company.
    await db
      .prepare(
        `UPDATE email_threads
            SET last_message_at = ?, last_direction = 'inbound',
                last_snippet = ?, message_count = message_count + 1,
                unread = 1, last_inbound_at = ?,
                status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
          WHERE id = ?`,
      )
      .bind(sentAt, snippet, now, threadId)
      .run();
  }
  await db.prepare(`UPDATE email_addresses SET mail_host_status = 'live', mail_host_confirmed_at = ? WHERE lower(address) = ? AND mail_host_status = 'pending'`).bind(now, mailbox.toLowerCase()).run();

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

  await storeAttachments(db, env, msgId, payload.attachments);

  return { ok: true, threadId, messageId: msgId };
}

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
  has_outbound?: number | boolean | null;
  my_unread?: number | string | null;
  last_inbound_at?: string | null;
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
    unread: Number(r.my_unread ?? r.unread ?? 0) === 1,
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
  outbox_status?: string | null;
  delivery_status?: string | null;
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
    deliveryStatus: deliveryStatus(r.outbox_status ?? null, r.delivery_status ?? null),
  };
}

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
  department_id: number | null;
  owner_department_id?: number | null; owner_department_name?: string | null;
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
    departmentId: r.department_id ?? null,
    assignedPosition: r.assigned_position ?? undefined,
    ownerDepartmentId: r.owner_department_id ?? null, ownerDepartmentName: r.owner_department_name ?? null,
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
// Hierarchical mailbox visibility. Every user has a VISIBILITY LEVEL in
// mail_user_scope; no row = 'department' (HC-0157: Mail Center follows the
// Org Chart):
//   • 'personal'   — own assigned alias(es) + shared mailboxes granted via
//                    email_address_access.
//   • 'department' — L1 · Personal: the same as 'personal'. A department mailbox
//                    is opened only by an admin's tick (a grant), never by the
//                    department alone (owner 2026-11-23). A Sales Director still
//                    gets their department's mailboxes.
//   • 'department_all' — 'department' PLUS everyone's own mailbox in those and the ticked (mail_scope_departments) departments.
//   • 'company'    — every active mailbox. A member of the Management
//                    department always gets it (lib/mail-access.ts).
// Departments are the primary one plus every user_departments row.
// Inherently scoped to the caller — no broad RBAC grant required.
// ---------------------------------------------------------------------------
const MAIL_SCOPE_LEVELS = ["personal", "department", "department_all", "company"] as const;
type MailScopeLevel = (typeof MAIL_SCOPE_LEVELS)[number];
export const DEFAULT_MAIL_SCOPE_LEVEL: MailScopeLevel = "department";

export function isMailAdmin(user: AuthUser | undefined): boolean {
  if (!user) return false;
  const granted = user.permissions_set ?? user.permissions;
  return (
    hasPermission(granted, "*") || hasPermission(granted, "mail_center.manage")
  );
}

export async function getMailScope(c: Context<{ Bindings: Env }>): Promise<{
  isAdmin: boolean;
  userId: number | null;
  addresses: string[];
  level: string;
}> {
  const userId = c.get("userId") ?? null;
  const coSql = activeCompanySql(c);
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
    : DEFAULT_MAIL_SCOPE_LEVEL;

  const user = c.get("user");
  const departmentIds = await departmentIdsOf(c.env.DB, userId, user?.department_id ?? null);
  if (await isInManagement(c.env.DB, departmentIds)) level = "company";

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

  if (level === "department_all") {
    const whole = await extraScopeDepartments(c.env.DB, userId, departmentIds);
    addresses.push(...(await departmentMailboxes(c.env.DB, whole, true, coSql)));
  } else if (isSalesDirectorUser(user) && departmentIds.length > 0) {
    addresses.push(...(await departmentMailboxes(c.env.DB, departmentIds, false, coSql)));
  }
  if (level === "department" && departmentIds.length === 0) level = "personal";

  return { isAdmin: false, userId, addresses: dedupeLower(addresses), level };
}

export async function ownAliasFor(
  c: Context<{ Bindings: Env }>,
): Promise<string> {
  const user = c.get("user");
  const alias = (user?.email_alias ?? "").trim().toLowerCase();
  if (alias) return alias;
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
  const sentByMe = c.req.query("sentBy") === "me";
  const label = c.req.query("label");
  const mailboxesCsv = c.req.query("mailboxes");

  const where: string[] = [];
  const binds: (string | number)[] = [];
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
  if (sentByMe) {
    where.push("EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND m.direction = 'outbound' AND m.sent_by_user_id = ?)");
    binds.push(scope.userId ?? 0);
  }
  if (sentOnly) {
    where.push(
      "EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id AND m.direction = 'outbound')",
    );
  }
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
       ) AS has_outbound, ${MY_UNREAD_SQL} AS my_unread
       FROM email_threads t ${MY_READ_JOIN} ${whereSql}`;
  const selectBinds = [scope.userId ?? 0, ...binds];
  const orderSql = " ORDER BY t.last_message_at DESC NULLS LAST";

  if (paginated) {
    let pageSize = Number(pageSizeParam ?? 50);
    if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 50;
    pageSize = Math.min(pageSize, 200);
    let page = Number(pageParam ?? 1);
    if (!Number.isFinite(page) || page < 1) page = 1;
    const offset = (page - 1) * pageSize;

    // company-scope: whereSql carries "company_id = ?" (the active company), pushed where the filters are built.
    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_threads t ${whereSql}`,
    )
      .bind(...binds)
      .first<{ n: number }>();
    const total = Number(countRow?.n ?? 0);

    // company-scope: selectSql ends in the same whereSql (company_id = ? for the active company).
    const res = await c.env.DB.prepare(
      selectSql + orderSql + " LIMIT ? OFFSET ?",
    )
      .bind(...selectBinds, pageSize, offset)
      .all<ThreadRow>();
    const threadsPage = await withThreadAttachments(c.env.DB, (res.results ?? []).map(rowToThread), activeCompanySql(c, "m.company_id"));
    return c.json({
      threads: threadsPage,
      total,
      hasMore: offset + threadsPage.length < total,
      page,
      pageSize,
    });
  }

  const res = await c.env.DB.prepare(selectSql + orderSql + " LIMIT 300")
    .bind(...selectBinds)
    .all<ThreadRow>();
  return c.json(await withThreadAttachments(c.env.DB, (res.results ?? []).map(rowToThread), activeCompanySql(c, "m.company_id")));
});

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
    `SELECT m.*, o.status AS outbox_status FROM email_messages m
       LEFT JOIN email_outbox o ON o.id = m.outbox_id
      WHERE m.thread_id = ?${activeCompanySql(c, "m.company_id")} ORDER BY m.created_at ASC`,
  )
    .bind(id)
    .all<MessageRow>();
  const mappedMsgs = (msgs.results ?? []).map(rowToMessage);

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

  const me = scope.userId;
  if (me != null) await setThreadRead(c.env.DB, id, me, true).catch((e) => console.error("[mail-center] mark read:", e));
  const acks = await acksForMessages(c.env.DB, mappedMsgs.map((m) => m.id));
  const owed = me != null ? await myOwedOnThread(c.env.DB, me, mappedMsgs) : new Map<string, string>();

  return c.json({
    thread: { ...rowToThread(thread), unread: false },
    readers: await threadReaders(c.env.DB, thread, activeCompanyId(c) ?? null),
    replying: await replyingOn(c.env.DB, id, me),
    messages: mappedMsgs.map((m) => ({
      ...m,
      attachments: attByMsg.get(m.id) ?? [],
      acks: acks.get(m.id) ?? [],
      ackRequestId: owed.get(m.id) ?? null,
    })),
  });
});

app.get("/attachments/:id", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  const row = await c.env.DB.prepare(
    `SELECT a.filename, a.content_type, a.storage_path, t.mailbox_address
       FROM email_attachments a
       JOIN email_messages m ON m.id = a.message_id
       JOIN email_threads t ON t.id = m.thread_id
      WHERE a.id = ?${activeCompanySql(c, "t.company_id")} LIMIT 1`,
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

app.get("/addresses", async (c) => {
  c.header("Cache-Control", "no-store");
  const scope = await getMailScope(c);
  if (c.req.query("manage") === "1" && isMailAdmin(c.get("user"))) {
    const res = await c.env.DB.prepare(
      `SELECT * FROM email_addresses WHERE 1=1${activeCompanySql(c)} ORDER BY address ASC`,
    ).all<AddressRow>();
    return c.json((res.results ?? []).map(rowToAddress));
  }
  if (scope.addresses.length === 0) return c.json([]);
  const ph = scope.addresses.map(() => "?").join(", ");
  const res = await c.env.DB.prepare(
    `SELECT e.*, u.department_id AS owner_department_id, d.name AS owner_department_name FROM email_addresses e
       LEFT JOIN users u ON u.id = e.assigned_user_id LEFT JOIN departments d ON d.id = u.department_id
       WHERE LOWER(e.address) IN (${ph}) ORDER BY e.address ASC`,
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
// read-only, visible to a mail admin OR any user with a mailbox in scope (sign-in links masked for non-admins).
// Ported from Hookka. Columns are snake_case; statuses stored lowercase, surfaced UPPERCASE.
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

const OUTBOX_COLS = "id, to_address, subject, status, attempts, last_error, sent_at, created_at, body_text, body_html";
const OUTBOX_STATUSES = ["pending", "sent", "failed"];

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
    const outboxCo = activeCompanyCodePred(c);
    if (outboxCo.sql) { where.push(outboxCo.sql.replace(/^ AND /, "")); binds.push(...outboxCo.binds); }
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
      `SELECT ${OUTBOX_COLS} FROM email_outbox ${whereSql}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<OutboxRow>();

    const admin = isMailAdmin(c.get("user"));
    const rows = (res.results ?? []).map((r) => ({
      id: r.id,
      toAddress: r.to_address ?? "",
      subject: r.subject ?? "(no subject)",
      status: (r.status ?? "pending").toUpperCase(),
      attempts: Number(r.attempts ?? 0),
      lastError: r.last_error ?? null,
      sentAt: r.sent_at ?? null,
      createdAt: r.created_at ?? "",
      snippet: admin ? outboxSnippet(r.body_text, r.body_html) : maskLoginLinks(outboxSnippet(r.body_text, r.body_html)),
      attachmentNames: [] as string[],
    }));

    const counts = { sent: 0, failed: 0, pending: 0 };
    const countRes = await c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM email_outbox WHERE 1=1${outboxCo.sql} GROUP BY status`,
    ).bind(...outboxCo.binds).all<{ status: string; n: number | string }>();
    for (const row of countRes.results ?? []) {
      const s = String(row.status || "").toLowerCase();
      const n = Number(row.n ?? 0);
      if (s === "sent") counts.sent += n;
      else if (s === "failed") counts.failed += n;
      else counts.pending += n;
    }

    return c.json({ rows, counts, hasMore: rows.length === limit });
  } catch (e) {
    console.error("[mail-center] outbox read failed:", e);
    return c.json(empty);
  }
});

app.get("/outbox/:id", async (c) => {
  const scope = await getMailScope(c);
  if (!isMailAdmin(c.get("user")) && scope.addresses.length === 0) {
    return c.json({ error: "not found" }, 404);
  }
  const id = c.req.param("id");
  try {
    const outboxCo = activeCompanyCodePred(c);
    const r = await c.env.DB.prepare(
      `SELECT ${OUTBOX_COLS} FROM email_outbox WHERE id = ?${outboxCo.sql} LIMIT 1`,
    )
      .bind(id, ...outboxCo.binds)
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
      bodyText: isMailAdmin(c.get("user")) ? r.body_text ?? "" : maskLoginLinks(r.body_text),
      bodyHtml: isMailAdmin(c.get("user")) ? r.body_html ?? "" : maskLoginLinks(r.body_html),
      attachmentNames: [] as string[],
    });
  } catch (e) {
    console.error("[mail-center] outbox detail read failed:", e);
    return c.json({ error: "not found" }, 404);
  }
});

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

async function canManageLabels(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const scope = await getMailScope(c);
  return scope.isAdmin || scope.addresses.length > 0;
}

app.get("/labels", async (c) => {
  c.header("Cache-Control", "no-store");
  const res = await c.env.DB.prepare(
    `SELECT * FROM email_labels WHERE 1=1${activeCompanySql(c)} ORDER BY name ASC`,
  ).all<LabelRow>();
  return c.json((res.results ?? []).map(rowToLabel));
});

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

async function renameThreadLabel(
  c: Context<{ Bindings: Env }>,
  from: string,
  to: string,
): Promise<void> {
  const like = `%${from}%`;
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
    await c.env.DB.prepare(`UPDATE email_threads SET labels = ? WHERE id = ?${activeCompanySql(c)}`)
      .bind(JSON.stringify(next), r.id)
      .run();
  }
}

app.post("/test-inject", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// HC-0157: a department mailbox links to its Org Chart department by id; the
// name stays in assigned_dept for the Inbox's department grouping. A caller
// that sends only a name ("Sales") is linked to the one department whose name
// contains it, or to none when that is ambiguous.
async function resolveMailboxDepartment(
  db: D1Database,
  departmentId: number | null | undefined,
  assignedDept: string | null | undefined,
): Promise<{ departmentId: number | null; assignedDept: string | null } | "unknown" | undefined> {
  const name = assignedDept === undefined ? undefined : assignedDept?.trim() || null;
  if (departmentId !== undefined) {
    if (departmentId === null) return { departmentId: null, assignedDept: name ?? null };
    const dept = await db
      .prepare(`SELECT id, name FROM departments WHERE id = ? LIMIT 1`)
      .bind(Number(departmentId))
      .first<{ id: number; name: string }>();
    if (!dept) return "unknown";
    return { departmentId: Number(dept.id), assignedDept: name ?? dept.name };
  }
  if (name === undefined) return undefined;
  if (name === null) return { departmentId: null, assignedDept: null };
  const matches = await db
    .prepare(`SELECT id FROM departments WHERE lower(name) LIKE '%' || lower(?) || '%' LIMIT 2`)
    .bind(name)
    .all<{ id: number }>();
  const rows = matches.results ?? [];
  return { departmentId: rows.length === 1 ? Number(rows[0].id) : null, assignedDept: name };
}

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
    departmentId?: number | null;
    assignedPosition?: string;
  };
  const body: CreateBody = await c.req
    .json<CreateBody>()
    .catch(() => ({}) as CreateBody);

  const address = (body.address ?? "").trim().toLowerCase();
  if (!address || !EMAIL_RE.test(address)) {
    return c.json({ error: "invalid email address" }, 400);
  }
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

  const owned = body.assignedUserId != null;
  const dept = owned ? undefined : await resolveMailboxDepartment(c.env.DB, body.departmentId, body.assignedDept);
  if (dept === "unknown") return c.json({ error: "That department no longer exists." }, 400);

  const userId = c.get("userId") ?? null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const companyId = activeCompanyId(c);
  const stampCo = companyId != null;
  try {
    await c.env.DB.prepare(
      `INSERT INTO email_addresses
         (id, address, label, assigned_user_id, assigned_user_name,
          assigned_dept, department_id, assigned_position, active, created_at, created_by${stampCo ? ", company_id" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?${stampCo ? ", ?" : ""})`,
    )
      .bind(
        id,
        address,
        body.label?.trim() || null,
        body.assignedUserId ?? null,
        body.assignedUserName ?? null,
        dept?.assignedDept ?? null,
        dept?.departmentId ?? null,
        body.assignedPosition?.trim() || null,
        now,
        userId,
        ...(stampCo ? [companyId] : []),
      )
      .run();
  } catch (e) {
    // company-scope: the address is UNIQUE across companies (it is the inbound routing key), so "already exists" must look at every company.
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
    `SELECT * FROM email_addresses WHERE id = ?${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(id)
    .first<AddressRow>();
  return c.json(row ? rowToAddress(row) : { id, address }, 201);
});

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
    departmentId?: number | null;
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
  if (body.assignedUserId != null) {
    sets.push("department_id = NULL");
  } else {
    const dept = await resolveMailboxDepartment(c.env.DB, body.departmentId, body.assignedDept);
    if (dept === "unknown") return c.json({ error: "That department no longer exists." }, 400);
    if (dept) {
      sets.push("assigned_dept = ?", "department_id = ?");
      binds.push(dept.assignedDept, dept.departmentId);
    }
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


app.get("/access", async (c) => {
  if (!isMailAdmin(c.get("user"))) {
    return c.json({ error: "You do not have permission to manage the Mail Center." }, 403);
  }
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
    return c.json({ ok: true, addressId, userId }, 201);
  }
  await afterGrantChange(c, addressId, userId, "shared");
  return c.json({ ok: true, addressId, userId }, 201);
});

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
  await afterGrantChange(c, addressId, userId, "stopped sharing");
  return c.json({ ok: true });
});


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
      { error: "level must be 'personal', 'department', 'department_all' or 'company'" },
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
  await recordAccessChange(c.env.DB, {
    companyId: activeCompanyId(c) ?? null,
    byUserId: c.get("userId") ?? null,
    userId,
    change: `set level to ${LEVEL_NAME[level] ?? level}`,
  });
  return c.json({ ok: true });
});


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

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

app.post("/threads/:id/reply", async (c) => {
  const id = c.req.param("id");
  const scope = await getMailScope(c);

  type ReplyBody = {
    text?: string;
    html?: string;
    fromAddress?: string;
    replyAll?: boolean;
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    attachments?: Array<{ filename: string; contentBase64: string }>;
    needsAck?: boolean;
    afterMessageId?: string | null;
    force?: boolean;
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

  const clash = body.force ? null : await replyConflict(c.env.DB, id, body.afterMessageId ?? null, scope.userId);
  if (clash) return c.json({ code: "already_replied", ...clash, error: `${clash.by} already replied.` }, 409);
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
        WHERE thread_id = ? AND direction = 'inbound'${activeCompanySql(c)}
        ORDER BY COALESCE(received_at, created_at) DESC LIMIT 1`,
    )
      .bind(id)
      .first<{ from_address: string | null; to_addresses: string | null; cc_addresses: string | null }>();

    if (toList.length === 0) {
      toList = recipientList(lastInbound?.from_address ?? thread.counterparty_email ?? "");
    }
    if (body.replyAll && ccList.length === 0 && lastInbound) {
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

  const ackPeople = body.needsAck ? await staffRecipients(c.env.DB, [...toList, ...ccList], scope.userId) : [];
  if (body.needsAck && ackPeople.length === 0) return c.json({ error: NO_STAFF_TO_ACK }, 400);
  const requestedFrom = (body.fromAddress ?? "").trim();
  let fromAddress = mailbox;
  if (requestedFrom && (await canSendFrom(c, scope, requestedFrom))) {
    fromAddress = requestedFrom;
  }

  const baseSubject = thread.subject ?? "(no subject)";
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;

  const htmlBody = html || `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;
  const headers = threadingHeaders(await threadMessageIds(c.env.DB, id));

  const userId = c.get("userId") ?? null;
  const fromName = await senderName(c.env.DB, userId);
  const result = await sendEmail(c.env, {
    to,
    cc: ccList.join(", ") || null,
    bcc: bccList.join(", ") || null,
    subject,
    html: htmlBody,
    text: text || undefined,
    purpose: "generic",
    from: await senderFrom(c.env, fromName, companyCodeForRecipient([fromAddress]), fromAddress),
    replyTo: fromAddress || undefined,
    companyCode: companyCodeForRecipient([fromAddress]),
    headers,
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: a.contentBase64.replace(/^data:[^;]+;base64,/, ""),
    })),
  });
  if (result.status !== "sent" && !result.retrying) {
    return c.json(
      { error: result.reason || "failed to send reply" },
      result.status === "skipped" ? 400 : 502,
    );
  }


  const now = new Date().toISOString();
  const snippet = (text || stripHtml(htmlBody)).slice(0, 240);
  const messageId = await recordOutboundMessage(c.env.DB, {
    threadId: id,
    fromAddress,
    fromName,
    to: toList,
    cc: ccList,
    subject,
    text: text || null,
    html: htmlBody,
    userId,
    providerId: result.providerId ?? null,
    outboxId: result.outboxId ?? null,
    inReplyTo: headers?.["In-Reply-To"] ?? null,
    references: headers?.References ?? null,
    companyId: activeCompanyId(c) ?? null,
  });
  await storeAttachments(c.env.DB, c.env, messageId, toStoredMailAttachments(attachments));

  await c.env.DB.prepare(
    `UPDATE email_threads
        SET last_message_at = ?, last_direction = 'outbound',
            last_snippet = ?, message_count = message_count + 1
      WHERE id = ?${activeCompanySql(c)}`,
  )
    .bind(now, snippet, id)
    .run();

  if (scope.userId != null) await setThreadRead(c.env.DB, id, scope.userId, true);
  await afterReplySent(c, id, thread.assigned_to_user_id ?? null, userId, fromName);
  if (ackPeople.length) await requestAcks(c.env, messageId, ackPeople, { subject, senderName: fromName });
  return c.json({ ok: true, messageId, queued: result.status !== "sent" });
});

app.post("/compose", async (c) => {
  const scope = await getMailScope(c);

  type ComposeBody = {
    fromAddress?: string;
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject?: string;
    text?: string;
    attachments?: Array<{ filename: string; contentBase64: string }>;
    needsAck?: boolean;
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

  const ackPeople = body.needsAck ? await staffRecipients(c.env.DB, [...toList, ...ccList], scope.userId) : [];
  if (body.needsAck && ackPeople.length === 0) return c.json({ error: NO_STAFF_TO_ACK }, 400);
  if (!(await canSendFrom(c, scope, fromAddress))) {
    return c.json({ error: "not allowed to send from " + fromAddress }, 403);
  }

  const htmlBody = `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;

  const userId = c.get("userId") ?? null;
  const fromName = await senderName(c.env.DB, userId);
  const result = await sendEmail(c.env, {
    to,
    cc: ccList.join(", ") || null,
    bcc: bccList.join(", ") || null,
    subject,
    html: htmlBody,
    text,
    purpose: "generic",
    from: await senderFrom(c.env, fromName, companyCodeForRecipient([fromAddress]), fromAddress),
    replyTo: fromAddress || undefined,
    companyCode: companyCodeForRecipient([fromAddress]),
    attachments: attachments.map((a) => ({
      filename: a.filename,
      content: a.contentBase64.replace(/^data:[^;]+;base64,/, ""),
    })),
  });
  if (result.status !== "sent" && !result.retrying) {
    return c.json(
      { error: result.reason || "send failed" },
      result.status === "skipped" ? 400 : 502,
    );
  }


  const now = new Date().toISOString();
  const snippet = text.slice(0, 200);
  const threadId = crypto.randomUUID();
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

  const messageId = await recordOutboundMessage(c.env.DB, {
    threadId,
    fromAddress,
    fromName,
    to: toList,
    cc: ccList,
    subject,
    text,
    html: htmlBody,
    userId,
    providerId: result.providerId ?? null,
    outboxId: result.outboxId ?? null,
    inReplyTo: null,
    references: null,
    companyId: companyId ?? null,
  });
  await storeAttachments(c.env.DB, c.env, messageId, toStoredMailAttachments(attachments));

  if (ackPeople.length) await requestAcks(c.env, messageId, ackPeople, { subject, senderName: fromName });
  return c.json({ ok: true, threadId, messageId, queued: result.status !== "sent" }, 201);
});

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
  if (body.unread !== undefined && scope.userId != null) await setThreadRead(c.env.DB, id, scope.userId, !body.unread);
  if (body.trashed !== undefined) {
    sets.push("trashed_at = ?");
    binds.push(body.trashed ? new Date().toISOString() : null);
  }
  if (sets.length === 0 && body.unread === undefined) {
    return c.json({ error: "no fields to update" }, 400);
  }
  if (sets.length) await c.env.DB.prepare(`UPDATE email_threads SET ${sets.join(", ")} WHERE id = ?${activeCompanySql(c)}`).bind(...binds, id).run();

  const row = await c.env.DB.prepare(
    `SELECT * FROM email_threads WHERE id = ?${activeCompanySql(c)} LIMIT 1`,
  )
    .bind(id)
    .first<ThreadRow>();
  const unread = scope.userId != null ? await isThreadUnreadFor(c.env.DB, id, scope.userId) : false;
  return c.json(row ? { ...rowToThread(row), unread } : { id });
});

export default app;
