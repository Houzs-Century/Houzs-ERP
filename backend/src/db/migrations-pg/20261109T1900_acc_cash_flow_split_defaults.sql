-- 20261109T1900_acc_cash_flow_split_defaults.sql
-- The Cash Flow's Settlement / Deposit columns (owner 2026-11-09, his Receipt & Payment
-- workbook: 「houzs 的cash flow 我想要这样呈现…一行settlement一行deposit」; 「每一行放哪
-- 一栏，我先照上面的表设好。你以后可以在 Cash Flow 的版面设定里自己改，包括 1/3 和 2/3
-- 这个比例」 → 可以). The saved Cash Flow tree (acc_report_layouts, report 'rp', one tree
-- shared by every company) gets each operating group's split as his workbook splits it,
-- in whole parts (acc/report-layout.ts CashSplit):
--   CASH IN              cf:in             0 : 1  Deposit (an order payment still goes by
--                                                   its kind: Deposit or Settlement)
--   OPERATIONS OUTFLOWS  cf:ops            1 : 2  whatever is not set below it
--   COST OF FUNDS        cf:ops:cost       1 : 0  Settlement (purchases, AP, trade finance)
--   EXHIBITION & ROADSHOW cf:ops:exh       0 : 1  Deposit (with the transport and the
--                                                   commission he keeps under it)
--   WAREHOUSE EXPENSE    cf:ops:warehouse  1 : 2  a third Settlement, two thirds Deposit
--   GENERAL EXPENSES     cf:ops:general    1 : 2  his "Operations O/H"
--   SHOWROOMS EXPENSE    cf:ops:showroom   0 : 1  Deposit
-- Below the operations (other income, taxation, finance cost, funding, transfers) nothing
-- is split: one figure a month, as in his workbook.
--
-- Data only. A category that already carries a split keeps it (one he set in the layout
-- editor is never overwritten); an id not on the tree is not there; no saved tree, no
-- change. The tree's updated_at / updated_by stay his.
--
-- HOUSE STYLE. Idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL: walk the tree the same way and drop the key from those seven categories —
--   it := it - 'split' where it->>'id' is one of the ids above.

CREATE OR REPLACE FUNCTION pg_temp.cf_with_split(items jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  done jsonb := '[]'::jsonb;
  it   jsonb;
  dflt jsonb;
BEGIN
  IF items IS NULL OR jsonb_typeof(items) <> 'array' THEN RETURN items; END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(items) LOOP
    IF it->>'kind' = 'category' THEN
      dflt := CASE it->>'id'
        WHEN 'cf:in'            THEN '{"settlement": 0, "deposit": 1}'::jsonb
        WHEN 'cf:ops'           THEN '{"settlement": 1, "deposit": 2}'::jsonb
        WHEN 'cf:ops:cost'      THEN '{"settlement": 1, "deposit": 0}'::jsonb
        WHEN 'cf:ops:exh'       THEN '{"settlement": 0, "deposit": 1}'::jsonb
        WHEN 'cf:ops:warehouse' THEN '{"settlement": 1, "deposit": 2}'::jsonb
        WHEN 'cf:ops:general'   THEN '{"settlement": 1, "deposit": 2}'::jsonb
        WHEN 'cf:ops:showroom'  THEN '{"settlement": 0, "deposit": 1}'::jsonb
      END;
      IF dflt IS NOT NULL AND NOT (it ? 'split') THEN
        it := it || jsonb_build_object('split', dflt);
      END IF;
      IF jsonb_typeof(it->'children') = 'array' THEN
        it := jsonb_set(it, '{children}', pg_temp.cf_with_split(it->'children'));
      END IF;
    END IF;
    done := done || jsonb_build_array(it);
  END LOOP;
  RETURN done;
END;
$$;

UPDATE scm.acc_report_layouts
   SET tree = jsonb_set(tree, '{blocks,accounts}', pg_temp.cf_with_split(tree->'blocks'->'accounts'))
 WHERE report = 'rp'
   AND jsonb_typeof(tree->'blocks'->'accounts') = 'array';
