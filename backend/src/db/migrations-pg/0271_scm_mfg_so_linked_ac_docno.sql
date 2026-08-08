-- Go-live cutover: link each imported ERP Sales Order back to its ORIGIN
-- AutoCount SO number. The one-time import (scripts/import-ac-outstanding-so.mjs)
-- brings AutoCount OUTSTANDING SOs into scm.mfg_sales_orders with doc_no =
-- "HC-<AutoCount DocNo>" and stores the raw AutoCount number here. ERP->AutoCount
-- write-back reads linked_ac_docno to UPDATE that existing AutoCount SO instead
-- of creating a duplicate; brand-new ERP orders (linked_ac_docno IS NULL) CREATE.
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS linked_ac_docno text;
CREATE INDEX IF NOT EXISTS mfg_so_linked_ac_docno_idx ON scm.mfg_sales_orders (linked_ac_docno);
