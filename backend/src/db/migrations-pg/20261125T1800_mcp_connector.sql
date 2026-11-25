-- 20261125T1800_mcp_connector.sql
--
-- WHY. Owner 2026-11-25 「把全部系统的mcp都complete掉」: staff connect Claude /
-- ChatGPT / Gemini to the ERP with THEIR OWN login, READ-ONLY, and the owner sees
-- who connected and what was looked up, approves each person, and can disconnect
-- anyone (routes/mcp.ts, routes/mcpAdmin.ts, services/mcp-store.ts).
--
--   mcp_access           who may connect (approved by an AI Connector admin).
--   mcp_access_requests  "Request access" from the staff page; Approve / Reject.
--   mcp_oauth_clients    OAuth dynamic client registration (each AI app).
--   mcp_auth_requests    a pending "Allow?" screen (10 minutes), between the AI
--                        app's authorize redirect and the person's click.
--   mcp_oauth_codes      one-time authorization codes (PKCE S256), 10 minutes.
--   mcp_tokens           access + refresh tokens, SHA-256 hashes only.
--   mcp_calls            one row per AI lookup: who, which app, what, result.
--
-- 白话（老板版）。员工用自己的 Claude / ChatGPT 问 ERP 的问题：只能看、不能改，只看得到
-- 他自己账号本来就看得到的。这几张表记录：谁被你批准、谁连了哪个 AI、问了什么。
--
-- Additive, idempotent, no data. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS public.mcp_calls, public.mcp_tokens, public.mcp_oauth_codes,
--     public.mcp_auth_requests, public.mcp_oauth_clients, public.mcp_access_requests,
--     public.mcp_access;
--   Revert the code first (routes/mcp.ts reads every table). GRANTS: none to re-apply.

CREATE TABLE IF NOT EXISTS public.mcp_access (
  user_id     bigint      PRIMARY KEY,
  approved_by bigint,
  approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mcp_access_requests (
  id         text        PRIMARY KEY,
  user_id    bigint      NOT NULL,
  reason     text,
  status     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by bigint,
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_access_requests_status_idx ON public.mcp_access_requests (status, created_at);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_clients (
  client_id     text        PRIMARY KEY,
  client_name   text,
  redirect_uris text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mcp_auth_requests (
  id             text        PRIMARY KEY,
  client_id      text        NOT NULL,
  redirect_uri   text        NOT NULL,
  state          text,
  code_challenge text        NOT NULL,
  expires_at     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS public.mcp_oauth_codes (
  code_hash      text        PRIMARY KEY,
  client_id      text        NOT NULL,
  user_id        bigint      NOT NULL,
  redirect_uri   text        NOT NULL,
  code_challenge text        NOT NULL,
  expires_at     timestamptz NOT NULL,
  used           integer     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.mcp_tokens (
  id                 text        PRIMARY KEY,
  user_id            bigint      NOT NULL,
  client_id          text        NOT NULL,
  access_hash        text        NOT NULL,
  access_expires_at  timestamptz NOT NULL,
  refresh_hash       text        NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_tokens_access_idx ON public.mcp_tokens (access_hash);
CREATE INDEX IF NOT EXISTS mcp_tokens_refresh_idx ON public.mcp_tokens (refresh_hash);
CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx ON public.mcp_tokens (user_id);

CREATE TABLE IF NOT EXISTS public.mcp_calls (
  id         text        PRIMARY KEY,
  token_id   text,
  user_id    bigint      NOT NULL,
  client_id  text,
  tool       text        NOT NULL,
  target     text,
  status     integer,
  ok         integer     NOT NULL,
  note       text,
  ms         integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_calls_user_idx ON public.mcp_calls (user_id, created_at);
CREATE INDEX IF NOT EXISTS mcp_calls_created_idx ON public.mcp_calls (created_at);
