// ---------------------------------------------------------------------------
// assistant.ts — the unified ERP Assistant endpoint (spec §2).
//
// POST /api/assistant/chat { message, conversationId? } → one grounded answer +
// which specialist agents were consulted (the routing trace the UI shows) + the
// conversationId the turn was stored under (so the client can thread follow-ups).
// GET /conversations, GET /conversations/:id/messages, DELETE /conversations/:id
// back the widget's history list.
//
// OPEN TO AUTHENTICATED STAFF, with the protection in the SCOPING rather than in
// the door. It was owner-only until the scoping existed, because the specialists'
// briefs carry MARGIN, per-salesperson performance and company-wide receivables —
// the class of aggregate that leaked to every Sales Executive once before
// (fix/c1-reports: "READ-ONLY IS NOT THE SAME AS SAFE").
//
// What changed: services/assistant-scope.ts derives each caller's visibility from
// positionPolicy — the SAME flags every other surface obeys — gates the money
// specialists, and redacts money keys from the payload BEFORE the model is called.
// A rep asking about margin now reaches an agent list that never included the
// commercial-intelligence brief, over a payload where those keys are already
// markers. The door is no longer what protects the numbers, so the door can open.
//
// READ-ONLY for business data: this route never writes a business row. Two writes
// it DOES perform, both here (never in services/assistant.ts, which stays read-
// only): (1) a TEACHING — when the router reads the message as a standing rule,
// the OWNER (wildcard) and only the owner records it to the agent teaching
// notebook, audited; everyone else's teach is refused. (2) per-user chat HISTORY
// (assistant_conversations/_messages) — a best-effort append that must never
// break the chat. History is scoped by user_id; a conversation that is missing,
// unowned, or deleted returns 404, never 403.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import type { Env } from "../types";
import { askAssistant } from "../services/assistant";
import { canUseAssistant, scopeForUser } from "../services/assistant-scope";
import { recordTeaching } from "../services/assistant-teach";
import {
  appendExchange,
  getConversationMessages,
  listConversations,
  resolveOrCreateConversation,
  softDeleteConversation,
} from "../services/assistant-history";
import { buildFileBlocks, parseAssistantForm, type ContentBlock } from "../services/vision-blocks";
import { resolvePositionPolicy } from "../services/positionPolicy";
import { audit } from "../services/audit";

const app = new Hono<{ Bindings: Env }>();

type AnswerData = { answer: string; agents: Array<{ key: string; label: string }>; degraded: boolean };

function assistantUser(c: {
  get: (k: string) => unknown;
}): { permissions?: unknown; position_name?: string | null; department_name?: string | null } | undefined {
  return c.get("user") as
    | { permissions?: unknown; position_name?: string | null; department_name?: string | null }
    | undefined;
}
function callerId(c: { get: (k: string) => unknown }): string | null {
  return c.get("userId") != null ? String(c.get("userId")) : null;
}

app.post("/chat", async (c) => {
  /* Two body shapes: JSON { message, conversationId? } as before, OR
     multipart/form-data with a `message` field + one-or-more `file` parts (image
     / PDF the assistant reads). Files are validated + encoded here; a bad type or
     oversize file is a 400 BEFORE the model call. */
  const contentType = c.req.header("content-type") || "";
  let message = "";
  let conversationId: string | undefined;
  let contentBlocks: ContentBlock[] | undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData().catch(() => null);
    if (form) {
      const parsed = await parseAssistantForm(form);
      message = parsed.message;
      conversationId = parsed.conversationId;
      if (parsed.files.length) {
        const built = await buildFileBlocks(parsed.files);
        if (built.error) return c.json({ success: false, error: built.error }, 400);
        contentBlocks = built.blocks;
      }
    }
  } else {
    let body: { message?: unknown; conversationId?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      body = {};
    }
    message = typeof body.message === "string" ? body.message : "";
    conversationId = typeof body.conversationId === "string" && body.conversationId ? body.conversationId : undefined;
  }

  const hasFiles = !!(contentBlocks && contentBlocks.length);
  if (!message.trim() && !hasFiles) {
    return c.json({ success: false, error: "message required" }, 400);
  }
  /* Scope is resolved per REQUEST from the caller's own position — never cached,
     never passed in by the client. A user with no position resolves to money
     hidden: the policy has no basis to decide, and "cannot tell" must not become
     "entitled". */
  const user = assistantUser(c);
  /* Field crew are denied the surface outright (owner 2026-07-18: operation gets
     the Assistant EXCEPT driver / helper / storekeeper). Checked here, not only in
     the nav — a hidden menu item is not a control, and this endpoint is reachable
     by anyone who can send a POST. */
  if (!canUseAssistant(user)) {
    return c.json(
      { success: false, error: "The assistant is not available for your role. Your jobs are on the Delivery Planning board." },
      403,
    );
  }
  const scope = scopeForUser(user, (i) => resolvePositionPolicy(i));
  const userId = callerId(c);

  /* Resolve the conversation this turn belongs to. A supplied id that is not the
     caller's live conversation is a 404 (never reveal another user's thread). No
     id → a fresh thread, titled from the first message. */
  let convId: string | null = null;
  if (userId) {
    const conv = await resolveOrCreateConversation(c.env, userId, conversationId, message).catch(() => undefined);
    if (conversationId && !conv) {
      return c.json({ success: false, error: "conversation not found" }, 404);
    }
    convId = conv?.id ?? null;
  }

  const res = await askAssistant(c.env, message, undefined, scope, contentBlocks);

  /* Build the turn's final answer. The router may read the message as teaching an
     agent a standing rule — that steers the agent for everyone, so only the owner
     (wildcard) may record it, and the write happens HERE. */
  let data: AnswerData;
  if (res.teach) {
    if (!scope.wildcard) {
      data = {
        answer: `Only the owner can set an agent's standing rules, so I did not record that. Ask the owner to teach ${res.teach.label} if it should apply.`,
        agents: [],
        degraded: false,
      };
    } else {
      try {
        const rec = await recordTeaching(c.env, {
          family: res.teach.family,
          instruction: res.teach.instruction,
          actor: userId,
        });
        await audit(c, {
          action: "agents.feedback_add",
          entityType: "agent_feedback",
          entityId: rec.id,
          summary: `Taught ${rec.family} via assistant: ${res.teach.instruction.slice(0, 120)}`,
        });
        data = {
          answer: `Recorded for ${rec.label}: "${res.teach.instruction}". It will be applied on that agent's next run. You can review or retire it in the Agent Console under ${rec.label}.`,
          agents: [{ key: rec.family, label: rec.label }],
          degraded: false,
        };
      } catch {
        data = {
          answer: `I could not record that teaching just now. You can add it in the Agent Console under ${res.teach.label}.`,
          agents: [],
          degraded: false,
        };
      }
    }
  } else {
    data = { answer: res.answer, agents: res.agents, degraded: res.degraded };
  }

  /* Persist the turn — best-effort, so a history failure never fails the chat. */
  if (userId && convId) {
    await appendExchange(c.env, {
      conversationId: convId,
      userId,
      userText: message || "(sent a file)",
      answer: data.answer,
      agents: data.agents,
      degraded: data.degraded,
    }).catch(() => {});
  }

  return c.json({ success: true, data: { ...data, conversationId: convId } });
});

app.get("/conversations", async (c) => {
  const user = assistantUser(c);
  if (!canUseAssistant(user)) return c.json({ success: false, error: "not available for your role" }, 403);
  const userId = callerId(c);
  if (!userId) return c.json({ success: true, data: { conversations: [] } });
  const limit = Number(c.req.query("limit")) || 50;
  const before = c.req.query("before") || undefined;
  const conversations = await listConversations(c.env, userId, { limit, before });
  return c.json({ success: true, data: { conversations } });
});

app.get("/conversations/:id/messages", async (c) => {
  const user = assistantUser(c);
  if (!canUseAssistant(user)) return c.json({ success: false, error: "not available for your role" }, 403);
  const userId = callerId(c);
  if (!userId) return c.json({ success: false, error: "not found" }, 404);
  const result = await getConversationMessages(c.env, userId, c.req.param("id"));
  if (!result) return c.json({ success: false, error: "not found" }, 404);
  return c.json({ success: true, data: result });
});

app.delete("/conversations/:id", async (c) => {
  const user = assistantUser(c);
  if (!canUseAssistant(user)) return c.json({ success: false, error: "not available for your role" }, 403);
  const userId = callerId(c);
  if (!userId) return c.json({ success: false, error: "not found" }, 404);
  await softDeleteConversation(c.env, userId, c.req.param("id"));
  return c.json({ success: true });
});

export default app;
