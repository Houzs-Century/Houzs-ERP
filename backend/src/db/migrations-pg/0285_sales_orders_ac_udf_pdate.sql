-- 0285 — Rename public.sales_orders.processing_date -> ac_udf_pdate.
--
-- WHAT THIS COLUMN IS. public.sales_orders is the read-only MIRROR of Houzs's
-- AutoCount sales orders (services/pull.ts upserts it every 5-min cron tick
-- from the AutoCount middleware; it feeds Finance/P&L revenue and the ASSR SO
-- lookup). This column is a verbatim copy of AutoCount's own user-defined field
-- SO.UDF_PDate — `dateOnly(o.SOUDF_PDate)` in upsertSalesOrder. It is AutoCount's
-- number for AutoCount's document.
--
-- WHAT IT IS NOT. It is NOT the ERP's Processing Date. The ERP's one true
-- Processing Date is scm.mfg_sales_orders.internal_expected_dd, on a different
-- table, for a different document. Nothing joins the two.
--
-- WHY RENAME RATHER THAN STOP WRITING. Both were open. Renaming wins because:
--   • the mirror's whole job is to be a faithful local copy of what AutoCount
--     holds, and this repo reconciles against AutoCount constantly (see
--     scripts/check-migration-fidelity.mjs, which compares the ERP's date
--     against SO.UDF_PDate). Dropping the write would make the mirror lossy for
--     no gain — the write costs nothing, and the harm was never the DATA, it
--     was the NAME.
--   • the name was the entire problem: a column literally called
--     `processing_date` sitting on a table called `sales_orders` is precisely
--     the trap the owner has now called out more than three times. `ac_udf_pdate`
--     cannot be mistaken for the ERP's field by anybody — it names the system
--     (ac = AutoCount) and the source field (UDF_PDate).
--
-- SAFETY — zero readers, one writer.
--   • ZERO READERS, verified over the whole repo: every reader of sales_orders
--     names its columns explicitly and none lists this one —
--     routes/assr.ts (`doc_no, ref, debtor_name, phone, doc_date, sales_agent`
--     at /search-so, and the same + `region` at the mirror read-back),
--     routes/finance.ts (`doc_date, local_total` for revenue; `doc_no,
--     debtor_name, doc_date, local_total, sales_agent, region` for the
--     drilldown), services/assr.ts (`ref, debtor_name, phone, sales_agent`, and
--     `doc_no, transfer_to`). There is no `SELECT *` against the table and no
--     drizzle query object for it (schema.pg.ts declares `sales_orders` but
--     nothing imports it — the table is reached only through raw SQL on env.DB).
--   • ONE WRITER: upsertSalesOrder in services/pull.ts, renamed in the same
--     commit as this migration (both the INSERT column list and the ON CONFLICT
--     DO UPDATE SET clause).
--
-- DEPLOY WINDOW, and why it is harmless here. deploy.yml applies migrations
-- BEFORE `wrangler deploy`, so for ~a minute the old Worker runs against the new
-- schema and its INSERT naming `processing_date` will fail. That costs at most
-- one AutoCount pull tick, and it SELF-HEALS with no data loss: runPull advances
-- the stored `pull_checkpoint` only `if (mode === "filtered" && failed === 0)`,
-- so a tick with failed upserts leaves the checkpoint where it was and the next
-- 5-min tick re-fetches exactly the same modified-since range. (The only other
-- caller, the ASSR POST mirror-so endpoint, is an operator action that can be
-- retried.) Contrast a user-facing SELECT, which is why the consignment
-- processing_date drop is deliberately NOT in this deploy.

-- Idempotent by hand: Postgres has no `RENAME COLUMN IF EXISTS`, and this
-- runner requires every file to be safe to re-apply. Rename only when the old
-- name is still there and the new one is not; if both somehow exist, fail loudly
-- rather than guess which one holds the data.
DO $$
DECLARE has_old boolean; has_new boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'sales_orders'
                    AND column_name = 'processing_date') INTO has_old;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'sales_orders'
                    AND column_name = 'ac_udf_pdate') INTO has_new;

  IF has_old AND has_new THEN
    RAISE EXCEPTION
      'public.sales_orders has BOTH processing_date and ac_udf_pdate. Refusing to guess which holds the AutoCount SO.UDF_PDate mirror — reconcile by hand, then drop the loser.';
  ELSIF has_old THEN
    ALTER TABLE public.sales_orders RENAME COLUMN processing_date TO ac_udf_pdate;
  END IF;
  -- has_new only, or neither: nothing to do (re-apply / already renamed).
END $$;
