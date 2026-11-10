-- 20261111T0100_scm_delivery_board_shadow_runs.sql
--
-- WHY. The Delivery Planning board is moving from ~800-1,400 PostgREST reads to
-- two SQL statements (lib/delivery-board-sql.ts). Accuracy is the owner's first
-- concern, so before the SQL path serves anyone it runs in SHADOW: the board
-- serves the old result, then rebuilds the same orders through SQL after the
-- response and compares them order by order. Each comparison is one row here,
-- so "how many board loads, how many orders, how many differed, and in which
-- fields" is a count, not a guess.
--
-- WHAT IS STORED. Doc numbers and FIELD NAMES only - never a value, never a
-- customer name, phone or address. `diffs` = [{"doc_no": "...", "fields": [...]}],
-- at most 200 entries per run (`differing` carries the full count).
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.delivery_board_shadow_runs;
--   Purely additive: nothing reads it but the person counting diffs.

SET search_path TO scm, public;

CREATE TABLE IF NOT EXISTS scm.delivery_board_shadow_runs (
  id          bigserial   PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  query       text        NOT NULL,
  compared    integer     NOT NULL,
  differing   integer     NOT NULL,
  rest_ms     integer,
  sql_ms      integer,
  error       text,
  diffs       jsonb       NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS delivery_board_shadow_runs_created_at_idx ON scm.delivery_board_shadow_runs (created_at);

ALTER TABLE scm.delivery_board_shadow_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON TABLE scm.delivery_board_shadow_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE scm.delivery_board_shadow_runs_id_seq TO service_role;

COMMENT ON TABLE scm.delivery_board_shadow_runs IS
  'Delivery Planning SQL-path shadow comparisons (DP_BOARD_SOURCE=shadow): one row per '
  'board load, doc numbers and field names only. See lib/delivery-board-source.ts.';
