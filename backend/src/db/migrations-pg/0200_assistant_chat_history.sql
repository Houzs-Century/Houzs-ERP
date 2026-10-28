-- 0200_assistant_chat_history.sql — per-user ASSISTANT CHAT HISTORY so the chat
-- widget can list a user's past conversations and reopen one.
--
-- WHY. POST /api/assistant/chat (routes/assistant.ts) is stateless today. These
-- two tables give each user a durable thread list. Answers are ALREADY money-
-- redacted at gather (services/assistant.ts redactFacts, BEFORE the model is
-- called), so a stored answer never carries a figure the user could not see.
--
-- SCOPE IS PER-USER, NOT PER-COMPANY. A thread belongs to the person; the
-- per-company axis (agent-company.ts) is for headless agents planning books.
-- Every read is filtered by user_id.
--
-- PUBLIC schema + 0091_agent_console.sql house style (these sit beside
-- agent_feedback): text PK = crypto.randomUUID(), TEXT ISO timestamps, integer
-- 0/1 booleans, user id as TEXT (users.id is serial; agent_feedback.created_by
-- stores it as text the same way). NOT the scm uuid/timestamptz style.
--
-- HOUSE STYLE: additive, idempotent (IF NOT EXISTS), no runtime self-apply,
-- plain statements only (pg-migrate splits on ';\n').

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id            text PRIMARY KEY,               -- crypto.randomUUID()
  user_id       text NOT NULL,                  -- users.id as text (owner)
  title         text,                           -- first user message, trimmed
  message_count integer NOT NULL DEFAULT 0,
  created_at    text NOT NULL,                  -- ISO string
  updated_at    text NOT NULL,                  -- ISO; bumped on each append
  deleted_at    text                            -- soft delete; NULL = live
);

CREATE INDEX IF NOT EXISTS idx_assistant_conv_user
  ON assistant_conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id              text PRIMARY KEY,             -- crypto.randomUUID()
  conversation_id text NOT NULL,                -- assistant_conversations.id
  user_id         text NOT NULL,                -- denormalized owner (authz w/o join)
  role            text NOT NULL,                -- 'user' | 'assistant'
  content         text NOT NULL,                -- question, or worded (redacted) answer
  agents          text,                         -- JSON [{key,label}] routing trace
  degraded        integer NOT NULL DEFAULT 0,   -- 0/1; deterministic fallback answer
  created_at      text NOT NULL                 -- ISO; thread order + retention key
);

CREATE INDEX IF NOT EXISTS idx_assistant_msg_conv
  ON assistant_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_assistant_msg_user
  ON assistant_messages (user_id, created_at);
