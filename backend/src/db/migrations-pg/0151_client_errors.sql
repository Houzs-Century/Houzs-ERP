-- 0151_client_errors.sql -- self-hosted client error reporting (no Sentry).
--
-- NUMBER PICKED AGAINST origin/main ON 2026-07-19 (0150 was the tip). Several
-- PRs are in flight in parallel: RE-VERIFY THIS IS STILL THE NEXT FREE NUMBER
-- AT MERGE TIME by re-listing migrations-pg on origin/main. A duplicate number
-- fails migrationNumbers.test.ts at PR time; a duplicate FILENAME would break
-- the pg-migrate ratchet and block every deploy.
--
-- WHY THIS TABLE EXISTS. The app has a history of frontend white-screen crashes
-- (top cause: FE reading a {success,data} envelope without unwrapping) that were
-- only discovered when a user complained. Every uncaught FE error now lands here
-- via POST /api/client-errors (batched, session-authed), and the daily 02:00
-- cron mails IT a digest -- so a crash becomes visible within a day, not when
-- the owner phones.
--
-- STORM-PROOF BY SHAPE. The unique key (dedup_hash, day, user_id) means a
-- render loop that fires the same error 5,000 times for one user in one day is
-- ONE row with count=5000 -- the table cannot balloon under an error storm.
-- dedup_hash = sha256(message + route + build_id), computed server-side.
-- user_id is INSIDE the key on purpose: it is what lets the daily digest report
-- an honest "affected users" count (rows per hash = distinct users) while still
-- collapsing each user's storm to one row. user_id is NOT NULL -- the endpoint
-- sits behind the auth gate, and the service caller stamps 0.
--
-- TEXT TIMESTAMPS, ISO strings, per the text-timestamp rule mig 0008
-- established and 0126 reaffirmed -- NOT timestamptz. Every timestamp column
-- here is written explicitly by the app as new Date().toISOString(), so the
-- format is uniform and lexicographic range scans (last_seen_at >= ?) are
-- correct. The defaults below are a safety net in the same format, never the
-- normal write path.
--
-- HOUSE STYLE: additive, IF NOT EXISTS, plain statements (the pg-migrate runner
-- splits on ";\n" -- no DO blocks), no runtime self-apply. D1 test mirror:
-- migrations/126_client_errors.sql.

CREATE TABLE IF NOT EXISTS client_errors (
  id           serial PRIMARY KEY,
  -- First occurrence in this row's (hash, day, user) bucket. Client-reported,
  -- server-validated, server clock fallback.
  occurred_at  text NOT NULL,
  -- UTC calendar day (YYYY-MM-DD) the dedup window keys on. Server clock, never
  -- the client's.
  day          text NOT NULL,
  -- From the SESSION, never the request body (a client could otherwise pin its
  -- noise on someone else). 0 = the DASHBOARD_API_KEY service caller.
  user_id      integer NOT NULL DEFAULT 0,
  -- Active company at report time (companyContext), NULL when unresolved
  -- (single-company degrade). Diagnostic only -- reads are super-admin.
  company_id   integer,
  -- SPA pathname only. The endpoint strips query strings and fragments so a
  -- token- or data-carrying URL can never be stored (privacy guarantee).
  route        text NOT NULL DEFAULT '',
  message      text NOT NULL,
  -- Capped at 4KB by the endpoint (client caps too; server re-caps).
  stack        text,
  -- The Vite __BUILD_ID__ of the bundle that crashed -- tells IT whether an
  -- error is from the current deploy or a stale service-worker build.
  build_id     text NOT NULL DEFAULT '',
  user_agent   text,
  dedup_hash   text NOT NULL,
  count        integer NOT NULL DEFAULT 1,
  last_seen_at text NOT NULL,
  created_at   text NOT NULL DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);

-- The upsert target: INSERT ... ON CONFLICT (dedup_hash, day, user_id) DO
-- UPDATE bumps count instead of inserting -- the storm collapse above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_errors_dedup
  ON client_errors (dedup_hash, day, user_id);

-- The digest (last 24h) and the System Health panel (last 7d) both range-scan
-- on recency.
CREATE INDEX IF NOT EXISTS idx_client_errors_last_seen
  ON client_errors (last_seen_at);
