-- 0058_announcements.sql (Postgres). Announcements — office posts that every
-- logged-in user sees as a top-of-screen banner with a "Got it" acknowledgement.
-- Ported from Hookka (src/api/routes/announcements.ts); collapses the 5 source
-- migs (0186 + 0188 + 0193 + 0194 + 0196) into one consolidated shape.
--
-- HOUZS ADAPTATIONS vs Hookka:
--   - Single-tenant: org_id column dropped (Hookka is multi-tenant ready).
--   - No worker portal: ack rows key on users.id (integer) not workers.id.
--   - Targeting reframed for office staff: ALL_USERS | DEPARTMENT_IDS |
--     POSITION_IDS | USER_IDS | MIXED. target_dept_ids / target_position_ids /
--     target_user_ids are JSON string arrays of integers (matches the rest of
--     Houzs's targeting patterns, e.g. project_brands).
--   - No runtime self-apply: Houzs migrates-before-deploy (owner pastes this
--     into the SQL Editor BEFORE the route code ships, per CLAUDE.md). Route
--     code assumes the table exists.
--   - All timestamps stay TEXT (ISO strings via new Date().toISOString()) to
--     match the rest of the schema (Hookka uses timestamptz; mig 0008 forced
--     TEXT here so the d1-compat datetime('now') value lands cleanly).
--
-- Idempotent (IF NOT EXISTS) so a re-run is a no-op. announcements is org-wide,
-- not SCM — lives in public.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS announcements (
  id                 text PRIMARY KEY,                                 -- 'ann-' + 12 hex
  title              text NOT NULL,
  body               text NOT NULL DEFAULT '',
  is_active          integer NOT NULL DEFAULT 1,                       -- 0/1 (matches rest of schema)
  expires_at         text,                                             -- ISO string, NULL = never
  reminded_at        text,                                             -- last time office tapped Remind
  created_by         integer,                                          -- users.id (NULL when posted by service user)
  created_at         text NOT NULL DEFAULT (now()::text),
  updated_at         text,
  -- Auto-translation blob populated on POST/PATCH by translate-announcement.ts.
  -- Shape: { en:{title,body}, ms:{...}, zh:{...}, my:{...} }. NULL when the
  -- ANTHROPIC_API_KEY is unset or the call failed; FE falls back to title/body.
  translations       text,                                             -- JSON string (keep TEXT for d1-compat parity)
  -- Media manifest — JSON-stringified array of {fileId,name,mime}. The fileId
  -- resolves to an R2 object key written by the upload endpoint.
  attachments        text,
  -- Audience targeting. Derived target_type kept in lock-step with the lists.
  target_type        text NOT NULL DEFAULT 'ALL_USERS',                -- ALL_USERS | DEPARTMENT_IDS | POSITION_IDS | USER_IDS | MIXED
  target_dept_ids    text,                                             -- JSON array of integers, e.g. '[1,3,5]'
  target_position_ids text,                                            -- JSON array of integers
  target_user_ids    text,                                             -- JSON array of integers
  -- Category (presentation): icon + colored pill on the list + banner.
  category           text NOT NULL DEFAULT 'GENERAL',                  -- GENERAL | WARNING | SOP | LEARNING
  CONSTRAINT chk_ann_target_type CHECK (target_type IN ('ALL_USERS','DEPARTMENT_IDS','POSITION_IDS','USER_IDS','MIXED')),
  CONSTRAINT chk_ann_category    CHECK (category    IN ('GENERAL','WARNING','SOP','LEARNING'))
);

-- The list page reads the newest ACTIVE rows; the banner reads the newest
-- ACTIVE row matching the user's audience. Both scan (is_active, created_at DESC).
CREATE INDEX IF NOT EXISTS idx_announcements_active_created
  ON announcements (is_active, created_at DESC);

-- Per-user read-receipts. ONE row the moment a user taps "Got it"; the
-- composite PK is the idempotency guard for fire-and-forget ack POSTs.
CREATE TABLE IF NOT EXISTS announcement_acks (
  announcement_id text NOT NULL,
  user_id         integer NOT NULL,
  acked_at        text NOT NULL DEFAULT (now()::text),
  PRIMARY KEY (announcement_id, user_id)
);

-- The banner queries "this user's acked ids" keyed on user_id; the office
-- acks/remind paths key on announcement_id (covered by the PK's lead column).
CREATE INDEX IF NOT EXISTS idx_announcement_acks_user
  ON announcement_acks (user_id);
