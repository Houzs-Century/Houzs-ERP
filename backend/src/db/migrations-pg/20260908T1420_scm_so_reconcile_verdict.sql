-- 20260908T1420_scm_so_reconcile_verdict.sql
--
-- WHAT THIS CHANGES: ONE new table, scm.so_reconcile_verdict, plus one small
-- provenance table beside it. NOTHING existing is altered. In particular:
--
--   *** scm.mfg_sales_orders IS NOT TOUCHED. ***
--
-- That is the point of the table existing at all. Owner, 2026-09-08, on the
-- suggestion of stamping a flag onto the migrated rows:
--
--     「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了啊」
--
-- A marker written onto a migrated row IS a change to the migrated data, and
-- the whole cutover rests on those rows still being what AutoCount handed us.
-- So the verdict lives BESIDE the data, keyed by document number, and can be
-- truncated and rebuilt at any time without a migrated row changing.
--
-- ── WHAT THE TABLE IS FOR ───────────────────────────────────────────────────
-- The migrated-sales-order lock (docs/migrated-so-lock.md) shuts a document
-- because of where it CAME FROM. That locks 2,882 orders to protect the handful
-- that are actually wrong, and it blocks the three things the cutover exists to
-- allow — sales proceeding an order, purchasing raising a PO, logistics
-- converting to a DO (owner, 2026-09-08).
--
-- These rows re-grain it onto CORRECTNESS: one row per migrated sales order
-- saying whether it still differs from the AutoCount book, and on which axes.
-- The guard opens a document whose row says `clean` and shuts every other case.
--
-- ── THE ROWS ARE DERIVED, NEVER TYPED ───────────────────────────────────────
-- Written ONLY by backend/scripts/publish-so-reconcile-verdict.mjs, from the
-- output of check-ac-erp-reconcile.mjs — the same run, and the same definition
-- of "different", that prints the summary the owner reads. There is no
-- hand-maintained list and there must never be one:
-- sofa-compartment-corrections-2026-08.json was a hand-written file stating what
-- a sofa was with nothing grading it against the book, and three sofas were
-- built wrong.
--
-- ── WHY measured_at IS ON EVERY ROW ─────────────────────────────────────────
-- It denormalises the run's timestamp onto each verdict so the guard answers
-- BOTH "what does this document say" and "is that still evidence" in ONE read,
-- on the request path. A verdict older than two days expires to `unknown`,
-- which LOCKS (backend/src/scm/lib/so-reconcile-verdict.ts). Two days is the
-- AutoCount snapshot's own limit in check-ac-erp-reconcile.mjs: a verdict
-- cannot be fresher than the book it was measured against.
--
-- ── SAFE TO RUN ─────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS only. No data is read, moved or deleted. An empty
-- table is the correct starting state and is NOT an outage: with no rows
-- published, every document reads `no-verdict-published`, which locks — exactly
-- the behaviour that is live today. The feature turns on only when the
-- scm.migrated_so_lock switch is moved to `verdict:1`, which this migration
-- deliberately does not do.
--
-- REVERSAL: DROP TABLE IF EXISTS scm.so_reconcile_verdict; DROP TABLE IF EXISTS
--   scm.so_reconcile_verdict_run;  Nothing references either by foreign key, and
--   the guard treats an unreadable verdict as `unknown`, which LOCKS - so
--   dropping them re-shuts every migrated sales order rather than opening one.
--   The two indexes go with their tables. No GRANT is created here, so none has
--   to be put back (mig 0189 took the SO list down for every user by recreating
--   a view whose ACL nobody had written down).
--
-- Verified against: scm.app_config as created by 0272 for the schema name and
--   the service client's `db.schema = 'scm'`; scm.mfg_sales_orders.doc_no as the
--   key shape (text, the ERP document number) - deliberately NOT declared as a
--   foreign key, see doc_no's comment below.

CREATE TABLE IF NOT EXISTS scm.so_reconcile_verdict (
  -- The ERP document number (scm.mfg_sales_orders.doc_no), e.g. 'HC-SO-010789'.
  -- NOT a foreign key, deliberately: this table must be truncatable and
  -- rebuildable without taking a lock on the sales-order table during a
  -- cutover, and a verdict for a document that has since been renumbered is
  -- simply a row nobody reads (which locks, correctly).
  doc_no        text PRIMARY KEY,
  company_id    integer NOT NULL,
  -- The AutoCount document the verdict was measured against, for the operator
  -- who has to go and look at both sides.
  ac_doc_no     text,
  -- TRUE means: this run compared the document against the book and found no
  -- difference on any axis it checks. Only TRUE opens a document.
  clean         boolean NOT NULL,
  -- The reconcile's OWN axis names ('document total', 'line count', 'sofa
  -- compartments', ...) so the sentence a salesperson reads uses the same word
  -- the reconcile printed. Empty for a clean row.
  axes          text[] NOT NULL DEFAULT '{}',
  -- One line of human detail per axis, for the person repairing it.
  detail        text,
  -- The run that produced this row. Denormalised (see the header) so the guard
  -- reads freshness and verdict in one statement.
  measured_at   timestamptz NOT NULL,
  run_id        uuid NOT NULL
);

-- The operator's "when did this last run, and what did it say" surface, and the
-- publisher's own record. One row per publish.
CREATE TABLE IF NOT EXISTS scm.so_reconcile_verdict_run (
  id                    uuid PRIMARY KEY,
  company_id            integer NOT NULL,
  measured_at           timestamptz NOT NULL,
  -- exported_at of the AutoCount snapshot the reconcile ran against. The
  -- verdict is only ever as good as this.
  snapshot_exported_at  timestamptz,
  doc_count             integer NOT NULL,
  clean_count           integer NOT NULL,
  differ_count          integer NOT NULL,
  -- Free text: the workflow run URL or the machine that produced it.
  source                text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS so_reconcile_verdict_company_clean_idx
  ON scm.so_reconcile_verdict (company_id, clean);

CREATE INDEX IF NOT EXISTS so_reconcile_verdict_run_measured_idx
  ON scm.so_reconcile_verdict_run (company_id, measured_at DESC);
