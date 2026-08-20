-- 0311 — Make the 2990 mirror's SKIPS durable, so "the mirror did not touch it"
-- is a fact you can query instead of a log line that has already scrolled away.
--
-- WHY. #2515 made scm's 2990 SO receiver IMPORT-ONCE: a doc_no company 2
-- already holds is not written, and a 2990-side delete of one is refused. Both
-- outcomes return 200 and write a console line, and a console line is gone the
-- moment nobody is tailing the Worker.
--
-- That gap has a concrete cost, found the same day. 2990's outbox
-- (public.sync_outbox, read by scripts/mirror-drift-sentinel.mjs) reported
-- pending=0 sent=0 and a last delivery of 2026-08-19T08:42:39Z — the queue is
-- drained and idle. So the obvious acceptance test, "edit a 2990 order, wait,
-- see whether the edit survives", CANNOT FAIL: a surviving edit is equally true
-- of a mirror that is working and a mirror that sent nothing at all. A test
-- that passes either way measures nothing, which is the trap CLAUDE.md names as
-- "the check that answers a different question".
--
-- This table is the missing half. A row here says a delivery WAS offered for
-- that doc_no and was refused, with the time it last happened. Edit survived
-- AND last_seen moved = proof. Edit survived and nothing moved = the mirror was
-- simply quiet, and the test proved nothing — which is now a distinguishable,
-- honest answer instead of a false pass.
--
-- BOUNDED BY CONSTRUCTION, and that is deliberate. One row per
-- (company_id, doc_no, action), never one per delivery: the drainer retries
-- every 10 seconds (docs/2990-live-sync/02_worker_2990.sql), so an
-- append-per-event table would grow by 8,640 rows a day per wedged document.
-- The ceiling here is (2990 orders) x 2 — 138 rows against the 69 source SOs
-- counted on 2026-08-20. `hits` carries the volume the rows do not.
--
-- IT IS EVIDENCE, NOT STATE. Nothing in the application reads it to decide
-- anything; the import-once gate reads scm.mfg_sales_orders, exactly as before.
-- Deleting this table changes no behaviour, which is what makes the reversal
-- below safe.
--
-- Houzs conventions: schema-qualified scm.*, additive and re-run-safe, no inner
-- BEGIN/COMMIT (pg-migrate owns the transaction) and no DO $$ dollar-quoting
-- (the runner splits on ";\n" BEFORE stripping comments, so a $$ block would
-- fragment). No comment line here ends in a semicolon, for the same reason.
--
-- REVERSAL: DROP TABLE IF EXISTS scm.so_mirror_skips;
--           Purely additive. Nothing reads it in application code, so dropping
--           it changes no behaviour anywhere — the receiver's write is wrapped
--           and a failure there is logged, never fatal (so-mirror.ts).
-- Verified against: NOT a production census, and saying so is the point. This
--           migration takes NO dependency on production state — it creates one
--           new table, with no foreign key, no ALTER of an existing object and
--           no reference to any existing column, so there is no live shape it
--           could be wrong about. What was checked, in this checkout on
--           2026-08-20: `so_mirror_skips` appears in no migration in either
--           tree and in no file under backend/src, so nothing here has created
--           it before.
--
--           THE ONE THING THAT CANNOT BE CHECKED FROM HERE, stated rather than
--           assumed: if a table of that name already existed in production with
--           a different shape, CREATE TABLE IF NOT EXISTS would skip it in
--           silence and the receiver's INSERT would then fail. That is not left
--           to hope — scripts/check-so-mirror-skips.mjs asserts the COLUMN SHAPE
--           on a fresh read and refuses loudly if it differs, and it is the
--           first thing run after this deploys. A count would not catch it; the
--           shape is the check.

SET search_path TO scm, public;

CREATE TABLE IF NOT EXISTS scm.so_mirror_skips (
  company_id  bigint      NOT NULL,
  doc_no      text        NOT NULL,
  -- 'skipped_existing' = a re-delivery of an order Houzs already holds
  -- 'refused_delete'   = 2990 asked to delete an order Houzs owns
  action      text        NOT NULL,
  hits        bigint      NOT NULL DEFAULT 1,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, doc_no, action)
);

COMMENT ON TABLE scm.so_mirror_skips IS
  'Durable count of deliveries the 2990 SO receiver declined to apply (mig 0311). '
  'One row per (company_id, doc_no, action), never per delivery — the drainer '
  'retries every 10s. Evidence that a delivery was OFFERED and refused; nothing '
  'in application code reads it.';

COMMENT ON COLUMN scm.so_mirror_skips.hits IS
  'How many deliveries have been declined for this doc_no + action. High and '
  'climbing means 2990 is actively re-sending an order Houzs owns.';

COMMENT ON COLUMN scm.so_mirror_skips.last_seen IS
  'The moment to compare against a Houzs edit. An edit that survived while this '
  'moved is proof import-once held; an edit that survived while this did not '
  'move proves only that the mirror was quiet.';

-- The read is always "what has the mirror been declining lately", so the index
-- is on recency, not on doc_no (the PK already serves a by-document lookup).
CREATE INDEX IF NOT EXISTS so_mirror_skips_last_seen_idx
  ON scm.so_mirror_skips (last_seen DESC);
