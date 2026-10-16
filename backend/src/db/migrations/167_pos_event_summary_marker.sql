-- D1 / test-tree twin of migrations-pg/20261014T1530_pos_event_summary_marker.sql.
ALTER TABLE pos_event_links ADD COLUMN summary_sent_at TEXT;
