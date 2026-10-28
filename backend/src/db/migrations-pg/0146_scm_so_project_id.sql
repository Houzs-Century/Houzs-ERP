-- 0146_scm_so_project_id.sql (Postgres)
-- Fair Report FOUNDATION (owner 2026-07-19): every SO belongs to a fair, and a
-- fair IS an exhibition PROJECT (public.projects). This HARD-LINKS the SO to its
-- fair by adding scm.mfg_sales_orders.project_id, stamped at create by the
-- active-fair resolver in routes/mfg-sales-orders.ts (createSalesOrderCore). The
-- report that consumes this column is a LATER PR; this migration only adds the
-- column + an index so the create path can begin persisting the link.
--
-- TYPE — public.projects.id is `serial` (integer, see 0000_baseline.sql), so the
-- link column is `integer`.
--
-- WHY NO FOREIGN KEY (plain indexed column instead):
--   * CROSS-SCHEMA — projects lives in `public`, this table in `scm`. A
--     scm->public FK is legal but couples this money table's inserts to a
--     public-schema constraint check on a hot path, for a column whose only job
--     (today) is to label rows for a report. The index gives the report its
--     lookup speed without that coupling.
--   * BLAST RADIUS — this file auto-applies to PROD on deploy and a failed file
--     blocks EVERY deploy. A plain ADD COLUMN + CREATE INDEX cannot fail on
--     existing data; an FK that ever meets an orphan id would. The resolver only
--     ever writes ids it just SELECTed from projects, so orphans are not expected
--     — but "not expected" is not worth a deploy-wide outage on a label column.
--
-- WHY IT IS SAFE TO AUTO-APPLY ON DEPLOY:
--   * ADD COLUMN IF NOT EXISTS — idempotent, a no-op after the first apply.
--   * NULLABLE, no DEFAULT, NO backfill — nothing to compute or fail on the
--     existing rows; every current SO simply reads NULL (unlinked) until a new
--     SO is created under an active fair. A NULL link is an unreported SO, never
--     a broken one.
--   * scm.mfg_sales_orders is a core table present on prod (many prior 0033/0034/
--     0053 ADD COLUMNs target it).

ALTER TABLE scm.mfg_sales_orders
  ADD COLUMN IF NOT EXISTS project_id integer;

-- Index the link so the Fair Report can gather a fair's SOs without a seq scan.
CREATE INDEX IF NOT EXISTS idx_mfg_sales_orders_project_id
  ON scm.mfg_sales_orders (project_id);
