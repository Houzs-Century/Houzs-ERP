// ---------------------------------------------------------------------------
// assistant-history.ts — per-user Assistant conversation history. The chat
// endpoint is otherwise stateless; these helpers give each user a durable thread
// list the chat widget can reopen.
//
// SCOPE IS PER-USER. Every read is filtered by user_id; a conversation that is
// missing, not owned, or soft-deleted resolves to null so the route can 404 (not
// 403 — do not reveal existence). The service-role client the rest of the app
// uses is not involved here; these are public-schema tables on env.DB.
//
// Called from the ROUTE, never from services/assistant.ts, so the answerer keeps
// its read-only invariant. Answers are already money-redacted at gather (they are
// worded strictly from the redacted payload), so stored history carries nothing
// the user could not see. Best-effort by contract: a history failure must never
// break the chat — callers wrap appendExchange in try/catch.
// ---------------------------------------------------------------------------

import type { Env } from "../types";

export interface AgentRef {
  key: string;
  label: string;
}
export interface ConversationSummary {
  id: string;
  title: string | null;
  message_count: number;
  updated_at: string;
}
export interface HistoryMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  agents?: AgentRef[];
  degraded: boolean;
  createdAt: string;
}

function safeAgents(raw: unknown): AgentRef[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as AgentRef[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an existing owned+live conversation, or create a fresh one when no id
 * is given. Returns null when an id IS given but does not resolve to the user's
 * live conversation (the route turns that into a 404).
 */
export async function resolveOrCreateConversation(
  env: Env,
  userId: string,
  conversationId: string | undefined,
  firstMessage: string,
): Promise<{ id: string; created: boolean } | null> {
  if (conversationId) {
    const row = await env.DB.prepare(
      "SELECT id FROM assistant_conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
      .bind(conversationId, userId)
      .first<{ id: string }>();
    return row ? { id: row.id, created: false } : null;
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = firstMessage.trim().slice(0, 80) || null;
  await env.DB.prepare(
    "INSERT INTO assistant_conversations (id, user_id, title, message_count, created_at, updated_at) VALUES (?,?,?,0,?,?)",
  )
    .bind(id, userId, title, now, now)
    .run();
  return { id, created: true };
}

/**
 * Append one turn — the user message then the assistant answer — and bump the
 * conversation's recency + count. The two rows are stamped 1ms apart so the user
 * message always sorts before its answer.
 */
export async function appendExchange(
  env: Env,
  p: {
    conversationId: string;
    userId: string;
    userText: string;
    answer: string;
    agents?: AgentRef[];
    degraded?: boolean;
  },
): Promise<void> {
  const base = Date.now();
  const userTs = new Date(base).toISOString();
  const asstTs = new Date(base + 1).toISOString();
  await env.DB.prepare(
    "INSERT INTO assistant_messages (id, conversation_id, user_id, role, content, agents, degraded, created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), p.conversationId, p.userId, "user", p.userText, null, 0, userTs)
    .run();
  await env.DB.prepare(
    "INSERT INTO assistant_messages (id, conversation_id, user_id, role, content, agents, degraded, created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      p.conversationId,
      p.userId,
      "assistant",
      p.answer,
      p.agents && p.agents.length ? JSON.stringify(p.agents) : null,
      p.degraded ? 1 : 0,
      asstTs,
    )
    .run();
  await env.DB.prepare(
    "UPDATE assistant_conversations SET updated_at = ?, message_count = message_count + 2 WHERE id = ? AND user_id = ?",
  )
    .bind(asstTs, p.conversationId, p.userId)
    .run();
}

/** The caller's live threads, newest first. */
export async function listConversations(
  env: Env,
  userId: string,
  opts?: { limit?: number; before?: string },
): Promise<ConversationSummary[]> {
  const limit = Math.min(Math.max(Math.round(opts?.limit ?? 50), 1), 100);
  const before = opts?.before;
  const res = before
    ? await env.DB.prepare(
        "SELECT id, title, message_count, updated_at FROM assistant_conversations WHERE user_id = ? AND deleted_at IS NULL AND updated_at < ? ORDER BY updated_at DESC LIMIT ?",
      )
        .bind(userId, before, limit)
        .all<ConversationSummary>()
    : await env.DB.prepare(
        "SELECT id, title, message_count, updated_at FROM assistant_conversations WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?",
      )
        .bind(userId, limit)
        .all<ConversationSummary>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    title: r.title ?? null,
    message_count: Number(r.message_count) || 0,
    updated_at: r.updated_at,
  }));
}

/**
 * One thread's messages, oldest first. Returns null when the conversation is not
 * the user's live conversation (route → 404). `role` is mapped to the frontend's
 * 'bot' at this boundary.
 */
export async function getConversationMessages(
  env: Env,
  userId: string,
  conversationId: string,
): Promise<{ conversation: { id: string; title: string | null }; messages: HistoryMessage[] } | null> {
  const conv = await env.DB.prepare(
    "SELECT id, title FROM assistant_conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(conversationId, userId)
    .first<{ id: string; title: string | null }>();
  if (!conv) return null;
  const res = await env.DB.prepare(
    "SELECT id, role, content, agents, degraded, created_at FROM assistant_messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 200",
  )
    .bind(conversationId, userId)
    .all<{ id: string; role: string; content: string; agents: string | null; degraded: number | string; created_at: string }>();
  const messages: HistoryMessage[] = (res.results ?? []).map((r) => ({
    id: r.id,
    role: r.role === "assistant" ? "bot" : "user",
    text: r.content,
    agents: safeAgents(r.agents),
    degraded: Number(r.degraded) === 1,
    createdAt: r.created_at,
  }));
  return { conversation: { id: conv.id, title: conv.title ?? null }, messages };
}

/** Soft-delete (reversible — never a hard delete). Scoped to the owner. */
export async function softDeleteConversation(
  env: Env,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE assistant_conversations SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(now, conversationId, userId)
    .run();
  return true;
}
