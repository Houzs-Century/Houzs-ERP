-- Mail Center "is writing a reply" (owner 2026-11-21): a row per person with
-- text in a thread's reply box, refreshed every 20 s and ignored after 90 s, so a
-- colleague opening the same email sees it and two people do not both answer.
-- Short-lived state only; nothing else reads it.
-- REVERSAL: DROP TABLE IF EXISTS mail_thread_replying;
CREATE TABLE IF NOT EXISTS mail_thread_replying (
  thread_id   text NOT NULL,
  user_id     integer NOT NULL,
  company_id  integer,
  at          text NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
