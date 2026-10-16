-- 20261016T1700_mail_reads_acks.sql
-- REVERSAL: DROP TABLE IF EXISTS email_message_acks;
--           DROP TABLE IF EXISTS email_thread_reads;
--           ALTER TABLE email_messages DROP COLUMN IF EXISTS needs_ack,
--             DROP COLUMN IF EXISTS ack_escalated_at;
--           ALTER TABLE email_threads DROP COLUMN IF EXISTS last_inbound_at;
--   Revert the code first: lib/mail-reads.ts and lib/mail-acks.ts read every
--   object here. Dropping loses who read which thread and who acknowledged
--   what; threads fall back to the shared email_threads.unread flag, which
--   this migration leaves in place.
--   GRANTS: none to re-apply — new tables get the schema's default grants.
--
-- WHAT THIS CHANGES (DEV-03 / PRD T-011 P2):
--   email_thread_reads   one row per (thread, person). read_at NULL = that
--                        person marked it unread. Opening a thread used to
--                        clear email_threads.unread for EVERYONE; now it only
--                        writes the opener's row. A person with no row still
--                        sees the old shared flag, so nothing changes at the
--                        cutover until each person opens a thread.
--   email_threads.last_inbound_at
--                        when the newest INBOUND message reached the ERP. A
--                        thread is unread for a person when this is after
--                        their read_at; a colleague's reply does not count.
--                        Backfilled below from the messages already stored.
--   email_messages.needs_ack / ack_escalated_at
--                        the sender asked for acknowledgement; the overdue
--                        chase ran (once).
--   email_message_acks   one row per staff recipient owed an
--                        acknowledgement; acked_at NULL = still owed.
--
-- Company scope: both new tables hang off a thread / message that carries
-- company_id; every read goes through a row already scoped, or is keyed on the
-- caller's own user_id.

ALTER TABLE email_threads
  ADD COLUMN IF NOT EXISTS last_inbound_at text NULL;

UPDATE email_threads t
   SET last_inbound_at = m.at
  FROM (SELECT thread_id, max(COALESCE(received_at, created_at)) AS at
          FROM email_messages
         WHERE direction = 'inbound'
         GROUP BY thread_id) m
 WHERE m.thread_id = t.id AND t.last_inbound_at IS NULL;

CREATE TABLE IF NOT EXISTS email_thread_reads (
  thread_id text NOT NULL,
  user_id   integer NOT NULL,
  read_at   text NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_email_thread_reads_user
  ON email_thread_reads (user_id);

ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS needs_ack integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ack_escalated_at text NULL;

CREATE TABLE IF NOT EXISTS email_message_acks (
  message_id   text NOT NULL,
  user_id      integer NOT NULL,
  requested_at text NOT NULL,
  acked_at     text NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_email_message_acks_owed
  ON email_message_acks (user_id) WHERE acked_at IS NULL;
