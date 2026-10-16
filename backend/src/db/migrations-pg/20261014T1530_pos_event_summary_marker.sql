-- 20261014T1530_pos_event_summary_marker.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Houzs POS build, step 7: the end-of-event summary email is sent ONCE per
-- event, when the event has ended and every linked terminal shows zero
-- pending. This nullable stamp on the event link is what makes "once" true
-- across cron runs. One nullable column; no row is touched.
--
-- REVERSAL: ALTER TABLE pos_event_links DROP COLUMN summary_sent_at. GRANTS: none.
-- Verified against: the migrations-pg tree (pos_event_links from 20261014T1304).

SET search_path = public;

ALTER TABLE pos_event_links ADD COLUMN IF NOT EXISTS summary_sent_at TIMESTAMPTZ;
