// ---------------------------------------------------------------------------
// houzs-mail-sync — Gmail (Google Workspace) IMAP -> ERP inbound bridge
// ---------------------------------------------------------------------------
// The company mailbox lives on Google Workspace (Gmail). This script polls it
// over IMAP (READ-ONLY — it never alters \Seen, so the humans' unread counts
// are untouched) and POSTs every message to the ERP's secret-guarded endpoint
// POST /api/mail-center/inbound. That endpoint dedups by Message-ID, so
// re-fetching a recent window (or re-running a backfill) NEVER double-inserts.
//
// It is NOT part of the Cloudflare Worker bundle — it runs on a GitHub Actions
// cron (see ../.github/workflows/mail-sync.yml). The payload it POSTs is the
// ERP's InboundEmailPayload (see backend/src/routes/mail-center.ts); the same
// shape the standalone CF Email Worker would send, so receive works whichever
// path is active — with NO MX change required.
//
// FREE-ALIAS MODEL (current): the five department mailboxes — operation@ /
// sales@ / marketing@ / finance@ / hr@houzscentury.com — are ALIASES of the
// single hello@ Google Workspace user in Google Admin, NOT separate accounts.
// So ALL department mail lands in hello@'s ONE inbox. We pull that single mailbox
// (IMAP_USER / IMAP_PASSWORD) and forward each message's Delivered-To / To
// headers; the ERP routes the message to the right department mailbox by matching
// Delivered-To (the alias the sender used) against its registered email_addresses
// — see toPayload + the ERP's ingestInboundEmail. A single hello@ pull is enough.
//
// MULTI-ACCOUNT (back-compat, optional): if the company ever splits the dept
// mailboxes back into SEPARATE Google accounts, set IMAP_ACCOUNTS (a JSON array
// of {user,password}); this job will iterate and pull each in turn. The ERP
// dedups by Message-ID so a cross-posted message is stored once. Dept routing no
// longer DEPENDS on per-account pulls — it is driven by Delivered-To — so this
// path is purely a convenience for a future split, not a requirement.
//
// Required env (GitHub Actions secrets — see README.md):
//   IMAP_USER            the shared Gmail address, hello@houzscentury.com
//   IMAP_PASSWORD        that account's Google App Password (NOT the login pw)
//   MAIL_INBOUND_SECRET  shared secret; MUST equal the ERP's MAIL_INBOUND_SECRET (>= 16 chars)
//   MAIL_INBOUND_URL     the ERP worker, e.g.
//                        https://autocount-sync-api.houzs-erp.workers.dev/api/mail-center/inbound
//
// Optional extra accounts (MERGED with the IMAP_USER/IMAP_PASSWORD pair):
//   IMAP_ACCOUNTS        JSON array of accounts, e.g.
//                          [{"user":"hello@houzscentury.com","password":"app-pw"},
//                           {"user":"sales@houzscentury.com","password":"app-pw"}]
//                        Each `password` is that account's Google App Password.
//
// Optional env (sensible defaults), applied to EVERY account:
//   IMAP_HOST / IMAP_PORT  default imap.gmail.com / 993
//   IMAP_MAILBOX           IMAP folder to read (default INBOX)
//   BACKFILL               "true"/"1" => fetch ALL history once; else incremental
//   SINCE_DAYS             incremental look-back window in days (default 3)
// ---------------------------------------------------------------------------

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const MAIL_INBOUND_URL =
  (process.env.MAIL_INBOUND_URL || "").trim() ||
  "https://autocount-sync-api.houzs-erp.workers.dev/api/mail-center/inbound";
const SECRET = (process.env.MAIL_INBOUND_SECRET || "").trim();
const IMAP_HOST = (process.env.IMAP_HOST || "").trim() || "imap.gmail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993) || 993;
const IMAP_MAILBOX = (process.env.IMAP_MAILBOX || "").trim() || "INBOX";
const BACKFILL = /^(1|true|yes)$/i.test(process.env.BACKFILL || "");
const SINCE_DAYS = Number(process.env.SINCE_DAYS || 3) || 3;

// Resolve the account list. DEFAULT path is the single shared hello@ mailbox
// (IMAP_USER / IMAP_PASSWORD) — enough for the free-alias model. The optional
// IMAP_ACCOUNTS (JSON [{user,password}, …]) ADDS further accounts (e.g. another
// company's hello@2990shome.com); the two sources MERGE, de-duplicated by
// lowercased user. Returns a normalised list of {user,password}.
function resolveAccounts() {
  const raw = (process.env.IMAP_ACCOUNTS || "").trim();
  let list = [];
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(
        "FATAL: IMAP_ACCOUNTS is not valid JSON. Expected an array like " +
          '[{"user":"hello@houzscentury.com","password":"app-pw"}]. ' +
          ((e && e.message) || e),
      );
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      console.error("FATAL: IMAP_ACCOUNTS must be a JSON ARRAY of {user,password} objects.");
      process.exit(1);
    }
    list = parsed.map((a) => ({
      user: String((a && (a.user ?? a.email)) || "").trim(),
      password: String((a && (a.password ?? a.pass)) || ""),
    }));
  }

  // MERGE the legacy single-account pair (IMAP_USER / IMAP_PASSWORD) rather
  // than letting IMAP_ACCOUNTS override it: adding another company's mailbox
  // (hello@2990shome.com) then needs ONE new secret, not re-entering the
  // existing hello@houzscentury.com app password into IMAP_ACCOUNTS. A blank
  // pair is dropped by the empties filter below; a double listing is de-duped.
  list.push({
    user: (process.env.IMAP_USER || "").trim(),
    password: process.env.IMAP_PASSWORD || "",
  });

  // Drop empties + de-dup by lowercased user (a repeated address is harmless via
  // Message-ID dedup, but skipping it saves a needless IMAP login).
  const seen = new Set();
  const out = [];
  for (const a of list) {
    if (!a.user || !a.password) continue;
    const key = a.user.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

if (SECRET.length < 16) {
  console.error(
    "FATAL: MAIL_INBOUND_SECRET is unset or < 16 chars. Set it as a GitHub secret AND on the ERP worker (Cloudflare) — the two MUST match.",
  );
  process.exit(1);
}

const ACCOUNTS = resolveAccounts();
if (ACCOUNTS.length === 0) {
  console.error(
    "FATAL: no mailbox accounts configured. Set IMAP_ACCOUNTS (JSON [{user,password}, …]) " +
      "or the single IMAP_USER + IMAP_PASSWORD (each password is a Google App Password).",
  );
  process.exit(1);
}

// Flatten mailparser address objects (from/to/cc) to bare "user@host" strings.
// mailparser returns { value: [{ address, name }], text, html } for each.
function addrList(field) {
  if (!field) return [];
  const value = Array.isArray(field) ? field : field.value;
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const a of value) {
    if (a && a.address) out.push(String(a.address).trim());
    if (a && a.group) out.push(...addrList({ value: a.group }));
  }
  return out.filter(Boolean);
}

function firstAddress(field) {
  const list = addrList(field);
  return list.length ? list[0] : "";
}

function firstName(field) {
  if (!field) return undefined;
  const value = Array.isArray(field) ? field : field.value;
  if (Array.isArray(value) && value[0] && value[0].name) {
    const n = String(value[0].name).trim();
    return n || undefined;
  }
  return undefined;
}

// Pull every Delivered-To / X-Original-To header off the parsed message. These
// are the ENVELOPE recipients the receiving server saw — with the free-alias
// model (operation@/sales@/marketing@/finance@/hr@ are all aliases of hello@),
// the dept alias the sender used lands HERE, not necessarily in To:. We surface
// them so the ERP can route the message to the right department mailbox.
//
// mailparser exposes headers two ways: parsed.headers (a Map, lowercased keys,
// value collapsed to a string when single / array when repeated) and
// parsed.headerLines (the raw "key: value" lines). Gmail repeats Delivered-To,
// so we read BOTH sources and union the addresses. Returns bare addresses.
const ADDR_IN_ANGLE_RE = /<([^>]+)>/g;
function extractAddresses(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const out = [];
  let m;
  ADDR_IN_ANGLE_RE.lastIndex = 0;
  while ((m = ADDR_IN_ANGLE_RE.exec(s))) {
    const a = m[1].trim();
    if (a.includes("@")) out.push(a);
  }
  if (out.length === 0 && s.includes("@")) {
    // No angle brackets — split on commas/whitespace and keep the @-tokens.
    for (const tok of s.split(/[,\s]+/)) {
      const t = tok.trim().replace(/^<|>$/g, "");
      if (t.includes("@")) out.push(t);
    }
  }
  return out;
}

function deliveredToList(parsed) {
  const out = [];
  const push = (raw) => {
    for (const a of extractAddresses(raw)) out.push(a);
  };
  const headers = parsed.headers;
  if (headers && typeof headers.get === "function") {
    for (const key of ["delivered-to", "x-original-to"]) {
      const v = headers.get(key);
      if (Array.isArray(v)) v.forEach(push);
      else if (v) push(v);
    }
  }
  // Belt-and-braces: also scan the raw header lines (catches repeated headers
  // that the Map collapsed, and X-Original-To variants).
  const lines = Array.isArray(parsed.headerLines) ? parsed.headerLines : [];
  for (const ln of lines) {
    const key = String((ln && ln.key) || "").toLowerCase();
    if (key === "delivered-to" || key === "x-original-to") {
      const line = String((ln && ln.line) || "");
      const colon = line.indexOf(":");
      push(colon >= 0 ? line.slice(colon + 1) : line);
    }
  }
  // De-dup, order-preserving (lowercased compare).
  const seen = new Set();
  const dedup = [];
  for (const a of out) {
    const lc = a.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    dedup.push(a);
  }
  return dedup;
}

// Per-attachment and per-message size caps. We base64-encode attachment bytes
// into the JSON POST, so we cap individual files at ~8 MB and the TOTAL across
// one message at ~15 MB to keep the request body sane. Anything over is dropped
// (logged) — the ERP stores the email regardless; only the oversized file is
// skipped.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Build the ERP attachments payload from mailparser's parsed.attachments.
// Each item: { filename, contentType, contentId, contentBase64 }. Drops files
// over MAX_ATTACHMENT_BYTES or once the running total exceeds the message cap.
function toAttachments(parsed) {
  const list = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  if (list.length === 0) return undefined;
  const out = [];
  let total = 0;
  for (const att of list) {
    const buf = att && att.content;
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) continue;
    const filename = (att && att.filename) || "attachment";
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      console.warn(
        `  SKIP attachment "${filename}" — ${buf.length} bytes > ${MAX_ATTACHMENT_BYTES} cap`,
      );
      continue;
    }
    if (total + buf.length > MAX_TOTAL_ATTACHMENT_BYTES) {
      console.warn(
        `  SKIP attachment "${filename}" — message total would exceed ${MAX_TOTAL_ATTACHMENT_BYTES} cap`,
      );
      continue;
    }
    total += buf.length;
    out.push({
      filename,
      contentType: (att && att.contentType) || "application/octet-stream",
      contentId: (att && att.contentId) || undefined,
      contentBase64: buf.toString("base64"),
    });
  }
  return out.length ? out : undefined;
}

async function postToErp(payload) {
  const res = await fetch(MAIL_INBOUND_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mail-secret": SECRET },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `ERP POST ${res.status} ${res.statusText} ${detail}`.trim(),
    );
  }
  return res.json().catch(() => ({}));
}

// Build the ERP InboundEmailPayload. We forward `to` (the header recipients) AND
// `deliveredTo` (the envelope recipients). Under the FREE-ALIAS model every dept
// mailbox is an alias of the single hello@ account we pull from, so the alias the
// sender actually used (sales@, finance@, …) lives in Delivered-To, NOT in To:.
// The ERP prefers Delivered-To when matching one of our registered addresses, so
// we must NOT inject the source mailbox into `to` (that would force hello@ to win
// the match and collapse every dept's mail onto the general inbox).
function toPayload(parsed, sourceMailbox) {
  const from = firstAddress(parsed.from);
  const fromName = firstName(parsed.from);
  const to = addrList(parsed.to);
  const cc = addrList(parsed.cc);
  // Envelope recipients (Delivered-To / X-Original-To). Fall back to the mailbox
  // we fetched from when no such header exists, so routing still has a signal.
  let deliveredTo = deliveredToList(parsed);
  if (deliveredTo.length === 0 && sourceMailbox) {
    deliveredTo = [sourceMailbox];
  }
  // mailparser exposes references as string | string[]; normalise to string[].
  let references;
  if (Array.isArray(parsed.references)) {
    references = parsed.references.map((s) => String(s).trim()).filter(Boolean);
  } else if (typeof parsed.references === "string") {
    references = parsed.references
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const date =
    parsed.date instanceof Date
      ? parsed.date.toISOString()
      : parsed.date || undefined;
  return {
    from,
    fromName,
    // `to` falls back to deliveredTo so the stored header recipient is never
    // empty when the original To: was absent (BCC-only / list mail).
    to: to.length ? to : deliveredTo,
    deliveredTo: deliveredTo.length ? deliveredTo : undefined,
    cc: cc.length ? cc : undefined,
    subject: parsed.subject || undefined,
    text: parsed.text || undefined,
    html: parsed.html || undefined,
    messageId: parsed.messageId || undefined,
    inReplyTo: parsed.inReplyTo || undefined,
    references: references && references.length ? references : undefined,
    date,
    attachments: toAttachments(parsed),
  };
}

async function syncMailbox(account) {
  const { user: imapUser, password: imapPassword } = account;
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: imapUser, pass: imapPassword },
    logger: false,
  });
  let total = 0;
  let added = 0;
  let deduped = 0;
  let failed = 0;
  await client.connect();
  try {
    // readOnly (EXAMINE) + source uses BODY.PEEK[] — two layers of guarantee
    // that we never flip \Seen on the humans' mailbox.
    const lock = await client.getMailboxLock(IMAP_MAILBOX, { readOnly: true });
    try {
      let range = null;
      let useUid = false;
      if (BACKFILL) {
        range = "1:*"; // every message, one-time history import (sequence range)
      } else {
        const since = new Date(Date.now() - SINCE_DAYS * 86_400_000);
        const uids = await client.search({ since }, { uid: true });
        if (uids && uids.length) {
          range = uids;
          useUid = true;
        }
      }
      if (range) {
        for await (const msg of client.fetch(
          range,
          { source: true },
          useUid ? { uid: true } : {},
        )) {
          total++;
          try {
            if (!msg.source) {
              failed++;
              continue;
            }
            const parsed = await simpleParser(msg.source);
            const payload = toPayload(parsed, imapUser);
            if (!payload.from) {
              failed++;
              continue;
            }
            const r = await postToErp(payload);
            if (r && r.deduped) deduped++;
            else added++;
          } catch (e) {
            failed++;
            console.error(`  msg fail:`, (e && e.message) || e);
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  console.log(
    `${imapUser}: ${total} seen, ${added} new, ${deduped} dup, ${failed} failed`,
  );
}

// Sync every configured account in sequence. One account's failure (bad app
// password, IMAP disabled, transient network) is isolated — it's logged and the
// run continues to the next mailbox, and the process exits non-zero so the
// GitHub Actions run is flagged red.
let anyHardFail = false;
console.log(
  `Syncing ${ACCOUNTS.length} mailbox${ACCOUNTS.length === 1 ? "" : "es"}: ${ACCOUNTS.map((a) => a.user).join(", ")}`,
);
for (const account of ACCOUNTS) {
  try {
    await syncMailbox(account);
  } catch (e) {
    anyHardFail = true;
    console.error(`MAILBOX ${account.user} FAILED:`, (e && e.message) || e);
  }
}
console.log(
  `Done. mode=${BACKFILL ? "BACKFILL(all)" : `incremental(${SINCE_DAYS}d)`} -> ${MAIL_INBOUND_URL}`,
);
process.exit(anyHardFail ? 1 : 0);
