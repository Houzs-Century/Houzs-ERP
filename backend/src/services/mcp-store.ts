// ---------------------------------------------------------------------------
// mcp-store.ts — storage for the AI Connector (MCP), routes/mcp.ts + routes/mcpAdmin.ts.
//
// Owner 2026-11-25 「把全部系统的mcp都complete掉」: staff connect Claude / ChatGPT
// to the ERP with THEIR OWN login, read-only, and the owner sees who connected
// and what was looked up. Tables: migration 20261125T2200_mcp_connector.sql.
// Tokens are stored as SHA-256 hashes only.
// ---------------------------------------------------------------------------
import type { Env } from "../types";

type Db = Env["DB"];

export const MCP_TOKEN_PREFIX = "hzmcp_";
export const MCP_REFRESH_PREFIX = "hzmcpr_";
export const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;

/** Who may manage the connector (approve, disconnect). The Owner's "*" covers it. */
export const MCP_ADMIN_PERMISSION = "ai_connector.manage";


export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge. */
export async function pkceS256(verifier: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const str = (r: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null) return String(v);
  }
  return "";
};


/** Admins (holders of MCP_ADMIN_PERMISSION, via "*" too) always may; others need approval. */
export async function hasMcpAccess(db: Db, userId: number, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  const row = await db.prepare("SELECT user_id FROM mcp_access WHERE user_id = ?").bind(userId).first();
  return !!row;
}


export type McpClient = { clientId: string; clientName: string; redirectUris: string[] };

export async function getClient(db: Db, clientId: string): Promise<McpClient | null> {
  const r = await db.prepare("SELECT client_id, client_name, redirect_uris FROM mcp_oauth_clients WHERE client_id = ?").bind(clientId).first<Record<string, unknown>>();
  if (!r) return null;
  let uris: string[] = [];
  try {
    uris = JSON.parse(str(r, "redirect_uris")) as string[];
  } catch {
    uris = [];
  }
  return { clientId: str(r, "client_id"), clientName: str(r, "client_name") || "AI app", redirectUris: uris };
}

/** A redirect URI a client may register: https anywhere, http only for loopback. */
export function validRedirectUri(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export async function registerClient(db: Db, name: string, redirectUris: string[]): Promise<McpClient> {
  const clientId = `mcpc_${randomToken(18)}`;
  const clientName = (name || "AI app").slice(0, 80);
  await db
    .prepare("INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .bind(clientId, clientName, JSON.stringify(redirectUris), new Date().toISOString())
    .run();
  return { clientId, clientName, redirectUris };
}

/** A friendly app name for the admin page, from the registered client name. */
export function appLabel(clientName: string): string {
  const n = clientName.toLowerCase();
  if (n.includes("claude")) return "Claude";
  if (n.includes("chatgpt") || n.includes("openai")) return "ChatGPT";
  if (n.includes("gemini") || n.includes("google")) return "Gemini";
  return clientName || "AI app";
}


export type AuthRequest = { id: string; clientId: string; redirectUri: string; state: string; codeChallenge: string };

export async function createAuthRequest(db: Db, a: Omit<AuthRequest, "id">): Promise<string> {
  const id = `mcpa_${randomToken(18)}`;
  await db
    .prepare("INSERT INTO mcp_auth_requests (id, client_id, redirect_uri, state, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, a.clientId, a.redirectUri, a.state, a.codeChallenge, new Date(Date.now() + CODE_TTL_MS).toISOString())
    .run();
  return id;
}

export async function getAuthRequest(db: Db, id: string): Promise<AuthRequest | null> {
  const r = await db
    .prepare("SELECT id, client_id, redirect_uri, state, code_challenge FROM mcp_auth_requests WHERE id = ? AND expires_at > ?")
    .bind(id, new Date().toISOString())
    .first<Record<string, unknown>>();
  if (!r) return null;
  return { id: str(r, "id"), clientId: str(r, "client_id"), redirectUri: str(r, "redirect_uri"), state: str(r, "state"), codeChallenge: str(r, "code_challenge") };
}

/** Single use: whoever deletes the row owns the decision. */
export async function takeAuthRequest(db: Db, id: string): Promise<AuthRequest | null> {
  const r = await db
    .prepare("DELETE FROM mcp_auth_requests WHERE id = ? AND expires_at > ? RETURNING id, client_id, redirect_uri, state, code_challenge")
    .bind(id, new Date().toISOString())
    .first<Record<string, unknown>>();
  if (!r) return null;
  return { id: str(r, "id"), clientId: str(r, "client_id"), redirectUri: str(r, "redirect_uri"), state: str(r, "state"), codeChallenge: str(r, "code_challenge") };
}


export async function createCode(db: Db, a: { clientId: string; userId: number; redirectUri: string; codeChallenge: string }): Promise<string> {
  const code = randomToken(32);
  await db
    .prepare(
      `INSERT INTO mcp_oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at, used)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(await sha256Hex(code), a.clientId, a.userId, a.redirectUri, a.codeChallenge, new Date(Date.now() + CODE_TTL_MS).toISOString())
    .run();
  return code;
}

/** Single use: the UPDATE claims the code; a replay finds used = 1 and fails. */
export async function consumeCode(db: Db, code: string): Promise<{ clientId: string; userId: number; redirectUri: string; codeChallenge: string } | null> {
  const r = await db
    .prepare(
      `UPDATE mcp_oauth_codes SET used = 1
        WHERE code_hash = ? AND used = 0 AND expires_at > ?
        RETURNING client_id, user_id, redirect_uri, code_challenge`,
    )
    .bind(await sha256Hex(code), new Date().toISOString())
    .first<Record<string, unknown>>();
  if (!r) return null;
  return { clientId: str(r, "client_id"), userId: Number(str(r, "user_id")), redirectUri: str(r, "redirect_uri"), codeChallenge: str(r, "code_challenge") };
}


export type IssuedTokens = { accessToken: string; refreshToken: string; expiresIn: number; tokenId: string };

export async function issueTokens(db: Db, userId: number, clientId: string): Promise<IssuedTokens> {
  const accessToken = MCP_TOKEN_PREFIX + randomToken(32);
  const refreshToken = MCP_REFRESH_PREFIX + randomToken(32);
  const tokenId = `mcpt_${randomToken(12)}`;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO mcp_tokens (id, user_id, client_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tokenId,
      userId,
      clientId,
      await sha256Hex(accessToken),
      new Date(now + ACCESS_TTL_MS).toISOString(),
      await sha256Hex(refreshToken),
      new Date(now + REFRESH_TTL_MS).toISOString(),
      new Date(now).toISOString(),
    )
    .run();
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), tokenId };
}

/** Rotate: the old refresh token stops working the moment a new pair is issued. */
export async function refreshTokens(db: Db, refreshToken: string, clientId: string): Promise<(IssuedTokens & { userId: number }) | null> {
  const h = await sha256Hex(refreshToken);
  const r = await db
    .prepare("SELECT id, user_id, client_id FROM mcp_tokens WHERE refresh_hash = ? AND revoked_at IS NULL AND refresh_expires_at > ?")
    .bind(h, new Date().toISOString())
    .first<Record<string, unknown>>();
  if (!r || str(r, "client_id") !== clientId) return null;
  const accessToken = MCP_TOKEN_PREFIX + randomToken(32);
  const newRefresh = MCP_REFRESH_PREFIX + randomToken(32);
  const now = Date.now();
  const upd = await db
    .prepare(
      `UPDATE mcp_tokens SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?
        WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL
        RETURNING id`,
    )
    .bind(await sha256Hex(accessToken), new Date(now + ACCESS_TTL_MS).toISOString(), await sha256Hex(newRefresh), new Date(now + REFRESH_TTL_MS).toISOString(), str(r, "id"), h)
    .first();
  if (!upd) return null;
  return { accessToken, refreshToken: newRefresh, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), tokenId: str(r, "id"), userId: Number(str(r, "user_id")) };
}

export type McpTokenRow = { tokenId: string; userId: number; clientId: string };

/** The token row behind an access token (unknown / expired / revoked → null). Access is re-checked by the caller. */
export async function resolveAccessToken(db: Db, token: string): Promise<McpTokenRow | null> {
  if (!token.startsWith(MCP_TOKEN_PREFIX)) return null;
  const r = await db
    .prepare(
      `SELECT id, user_id, client_id, last_used_at FROM mcp_tokens
        WHERE access_hash = ? AND revoked_at IS NULL AND access_expires_at > ?
        LIMIT 1`,
    )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<Record<string, unknown>>();
  if (!r) return null;
  const row: McpTokenRow = { tokenId: str(r, "id"), userId: Number(str(r, "user_id")), clientId: str(r, "client_id") };
  const last = str(r, "last_used_at");
  if (!last || Date.now() - Date.parse(last) > 60_000) {
    try {
      await db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), row.tokenId).run();
    } catch {
    }
  }
  return row;
}

export async function revokeToken(db: Db, tokenId: string, userId: number | null): Promise<number> {
  const r = await db
    .prepare(`UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL ${userId === null ? "" : "AND user_id = ?"} RETURNING id`)
    .bind(new Date().toISOString(), tokenId, ...(userId === null ? [] : [userId]))
    .all();
  return r.results.length;
}

export async function revokeUserTokens(db: Db, userId: number): Promise<number> {
  const r = await db
    .prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL RETURNING id")
    .bind(new Date().toISOString(), userId)
    .all();
  return r.results.length;
}


export async function logCall(
  db: Db,
  c: { tokenId: string; userId: number; clientId: string; tool: string; target: string; status: number; ok: boolean; note: string; ms: number },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO mcp_calls (id, token_id, user_id, client_id, tool, target, status, ok, note, ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(`mcpl_${randomToken(12)}`, c.tokenId, c.userId, c.clientId, c.tool, c.target.slice(0, 500), c.status, c.ok ? 1 : 0, c.note.slice(0, 300), c.ms, new Date().toISOString())
      .run();
  } catch (e) {
    console.warn("[mcp] call log failed:", e instanceof Error ? e.message : String(e));
  }
}


const ACTIONS_KEY = "mcp_actions_enabled";

/** "Allow AI actions (meetings, email)" — OFF unless an admin turned it on. A failed read is OFF. */
export async function actionsEnabled(db: Db): Promise<boolean> {
  try {
    const r = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(ACTIONS_KEY).first<Record<string, unknown>>();
    return str(r ?? {}, "value") === "true";
  } catch (e) {
    console.warn("[mcp] actions switch read failed, treating as off:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

export async function setActionsEnabled(db: Db, on: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(ACTIONS_KEY, on ? "true" : "false", new Date().toISOString())
    .run();
}

/** The per-action switches (owner 2026-11-26, round 4b): each new write action has its own, OFF until an admin turns it on. */
export const ACTION_SWITCH_KEYS = { mail_reply: "mcp_action_mail_reply_enabled", note: "mcp_action_note_enabled" } as const;
export type SwitchedKind = keyof typeof ACTION_SWITCH_KEYS;
export type ActionSwitches = { master: boolean } & Record<SwitchedKind, boolean>;
export const ALL_OFF: ActionSwitches = { master: false, mail_reply: false, note: false };

/** The master switch and every per-action switch in one read. A failed read is all OFF. */
export async function actionSwitches(db: Db): Promise<ActionSwitches> {
  const keys = [ACTIONS_KEY, ...Object.values(ACTION_SWITCH_KEYS)];
  try {
    const r = await db.prepare(`SELECT key, value FROM app_settings WHERE key IN (${keys.map(() => "?").join(", ")})`).bind(...keys).all<Record<string, unknown>>();
    const on = new Set(r.results.filter((x) => str(x, "value") === "true").map((x) => str(x, "key")));
    return { master: on.has(ACTIONS_KEY), mail_reply: on.has(ACTION_SWITCH_KEYS.mail_reply), note: on.has(ACTION_SWITCH_KEYS.note) };
  } catch (e) {
    console.warn("[mcp] action switches read failed, treating as off:", e instanceof Error ? e.message : String(e));
    return ALL_OFF;
  }
}

/** Turn one per-action switch on or off (the master switch is setActionsEnabled). */
export async function setActionSwitch(db: Db, kind: SwitchedKind, on: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(ACTION_SWITCH_KEYS[kind], on ? "true" : "false", new Date().toISOString())
    .run();
}

export type PendingAction = { id: string; kind: string; payload: Record<string, unknown>; summary: string };

export async function createPendingAction(
  db: Db,
  a: { tokenId: string; userId: number; kind: string; payload: Record<string, unknown>; summary: string; ttlMs: number },
): Promise<string> {
  const id = `mcpx_${randomToken(18)}`;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO mcp_pending_actions (id, token_id, user_id, kind, payload_json, summary, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, a.tokenId, a.userId, a.kind, JSON.stringify(a.payload), a.summary.slice(0, 500), new Date(now).toISOString(), new Date(now + a.ttlMs).toISOString())
    .run();
  return id;
}

/**
 * Single use: the UPDATE claims the action for this token + person while it is
 * unused and unexpired; a replay, another token or a late confirm gets null.
 * `outcome` = 'confirmed' or 'cancelled'.
 */
export async function claimPendingAction(db: Db, id: string, tokenId: string, userId: number, outcome: "confirmed" | "cancelled"): Promise<PendingAction | null> {
  const nowIso = new Date().toISOString();
  const r = await db
    .prepare(
      `UPDATE mcp_pending_actions SET used_at = ?, outcome = ?
        WHERE id = ? AND token_id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?
        RETURNING id, kind, payload_json, summary`,
    )
    .bind(nowIso, outcome, id, tokenId, userId, nowIso)
    .first<Record<string, unknown>>();
  if (!r) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(str(r, "payload_json")) as Record<string, unknown>;
  } catch {
    return null;
  }
  return { id: str(r, "id"), kind: str(r, "kind"), payload, summary: str(r, "summary") };
}

/** How a confirmed action ended ('done' / 'failed'), for the admin page. */
export async function finishPendingAction(db: Db, id: string, outcome: "done" | "failed", note: string): Promise<void> {
  await db.prepare("UPDATE mcp_pending_actions SET outcome = ?, outcome_note = ? WHERE id = ?").bind(outcome, note.slice(0, 300), id).run();
}

/** Actions this person confirmed in the last 24 hours (the daily cap counts these). */
export async function confirmedLastDay(db: Db, userId: number): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM mcp_pending_actions WHERE user_id = ? AND used_at > ? AND outcome <> 'cancelled'")
    .bind(userId, new Date(Date.now() - 24 * 3600_000).toISOString())
    .first<Record<string, unknown>>();
  return Number(str(r ?? {}, "n") || 0);
}
