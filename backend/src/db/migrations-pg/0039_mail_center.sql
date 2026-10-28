-- 0039_mail_center.sql (Postgres). Mail Center — in-ERP shared inbox ported from
-- Hookka (src/api/routes/mail-center.ts). Houzs is SINGLE-TENANT, so every
-- org_id column / index / WHERE the Hookka source carried is DROPPED here. IDs
-- that reference users are integer FKs (users.id is serial). Every timestamp is
-- TEXT (written via new Date().toISOString() or the d1-compat shim's
-- datetime('now')) — never timestamptz, per mig 0008.
--
-- Houzs migrates-before-deploy (owner pastes this into the SQL Editor BEFORE the
-- route code ships). Unlike Hookka there is NO runtime self-apply; the route
-- assumes these tables exist. Idempotent (IF NOT EXISTS / ON CONFLICT) so a
-- re-run is a no-op.
--
-- Eight tables (folds in Hookka's separate 0171_email_labels), plus an
-- email_alias convenience column on users (the member's outward address shown in
-- User Management). The label catalogue is name->colour; per-thread labels stay a
-- JSON name array on email_threads.

-- Our outward-facing addresses / aliases (support@, sales@, lim@ ...). A row maps
-- an address to a person / dept / position.
CREATE TABLE IF NOT EXISTS email_addresses (
  id text PRIMARY KEY,
  address text NOT NULL,
  label text,
  assigned_user_id integer,
  assigned_user_name text,
  assigned_dept text,
  assigned_position text,
  active integer NOT NULL DEFAULT 1,
  created_at text,
  created_by integer
);
-- Case-insensitive uniqueness on the address (Hookka used a per-org index; here
-- it is just lower(address)).
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_addresses_addr
  ON email_addresses (lower(address));

-- Shared-mailbox grant matrix. A user always has their own assigned alias; these
-- rows ADDITIONALLY grant access to a shared mailbox (support@/hr@/finance@).
CREATE TABLE IF NOT EXISTS email_address_access (
  id text PRIMARY KEY,
  address_id text NOT NULL,
  user_id integer NOT NULL,
  created_at text,
  created_by integer
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_access_addr_user
  ON email_address_access (address_id, user_id);
CREATE INDEX IF NOT EXISTS ix_email_access_user
  ON email_address_access (user_id);

-- Per-user mail visibility level: 'personal' (own + granted) | 'department' |
-- 'company'. Absent row => 'personal'.
CREATE TABLE IF NOT EXISTS mail_user_scope (
  user_id integer PRIMARY KEY,
  level text NOT NULL DEFAULT 'personal',
  created_at text
);

-- One conversation with an external party, grouped by RFC threading.
CREATE TABLE IF NOT EXISTS email_threads (
  id text PRIMARY KEY,
  mailbox_address text,
  subject text,
  counterparty_email text,
  counterparty_name text,
  status text NOT NULL DEFAULT 'open',
  assigned_to_user_id integer,
  assigned_to_name text,
  last_message_at text,
  last_direction text,
  last_snippet text,
  message_count integer NOT NULL DEFAULT 0,
  unread integer NOT NULL DEFAULT 1,
  starred integer NOT NULL DEFAULT 0,
  labels text,
  trashed_at text,
  created_at text
);
CREATE INDEX IF NOT EXISTS ix_email_threads_box
  ON email_threads (mailbox_address, last_message_at);

-- Individual messages (both directions).
CREATE TABLE IF NOT EXISTS email_messages (
  id text PRIMARY KEY,
  thread_id text NOT NULL,
  direction text NOT NULL,
  message_id text,
  in_reply_to text,
  reference_ids text,
  from_address text,
  from_name text,
  to_addresses text,
  cc_addresses text,
  subject text,
  text_body text,
  html_body text,
  sent_at text,
  received_at text,
  sent_by_user_id integer,
  sent_by_name text,
  provider_message_id text,
  created_at text
);
CREATE INDEX IF NOT EXISTS ix_email_messages_thread
  ON email_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS ix_email_messages_msgid
  ON email_messages (message_id);

-- Inbound attachments. The bytes live in R2 (POD_BUCKET) under storage_path; this
-- row is the index the detail view reads to render a download chip. size_bytes is
-- the byte count; content_id is the MIME Content-ID (for a future cid: inliner).
CREATE TABLE IF NOT EXISTS email_attachments (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  filename text,
  content_type text,
  size_bytes integer,
  storage_path text,
  content_id text,
  created_at text
);
CREATE INDEX IF NOT EXISTS ix_email_attachments_msg
  ON email_attachments (message_id);

-- Label registry (name -> colour catalogue, adapted from Hookka 0171, org_id
-- dropped). Per-thread labels themselves stay a JSON name array on email_threads;
-- this table is the canonical catalogue so the sidebar can render a coloured dot.
CREATE TABLE IF NOT EXISTS email_labels (
  id text PRIMARY KEY,
  name text NOT NULL,
  color text,
  created_at text,
  created_by integer
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_labels_name
  ON email_labels (lower(name));

-- Email Alias per member — the member's assigned outward address (e.g.
-- lim@houzscentury.com), surfaced in User Management. Complements
-- email_addresses.assigned_user_id (the canonical mailbox<->person link); this is
-- the simpler owner-facing convenience knob.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_alias text;
