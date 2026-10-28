-- 025_finance_ledger.sql
-- Replaces the flat project_finance column model with a proper ledger:
-- one row per income or cost line item. Totals (rental, contractor cost,
-- license fee, deposit, total sales…) are now computed by SUM over the
-- lines, tagged by category.
--
-- project_finance stays as a 1:1 rollup cache — the application keeps
-- it in sync on every line edit so existing read-paths (list query,
-- dashboard tiles) don't need to change. Existing field values on
-- project_finance are preserved and re-seeded as lines.

CREATE TABLE IF NOT EXISTS project_finance_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  -- 'income' = money coming in (sales reports, rebates, etc.)
  -- 'cost'   = money going out (rental, contractor, license, misc…)
  kind TEXT NOT NULL CHECK (kind IN ('income', 'cost')),
  -- Free-text category so you can add new buckets ("insurance",
  -- "cleaning fee") without a migration. A handful of canonical
  -- categories exist and the UI surfaces them as a picker —
  -- everything else is still a first-class row.
  category TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  -- When the money moved (payment date). Falls back to created_at
  -- in the UI when null.
  occurred_at TEXT,
  -- Optional attached evidence (invoice, receipt, sales sheet).
  r2_key TEXT,
  file_name TEXT,
  mime_type TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pfl_project ON project_finance_lines(project_id, kind, category);
CREATE INDEX IF NOT EXISTS idx_pfl_category ON project_finance_lines(category);

-- ── Backfill existing project_finance rows into lines ─────────
-- One-shot: for every project with finance data, create the
-- corresponding line items. Idempotent via NOT EXISTS guard so the
-- migration can be re-run safely.

INSERT INTO project_finance_lines (project_id, kind, category, description, amount, created_at)
SELECT project_id, 'cost', 'rental', 'Imported from legacy finance.rental', rental, datetime('now')
  FROM project_finance
 WHERE rental IS NOT NULL AND rental > 0
   AND NOT EXISTS (
     SELECT 1 FROM project_finance_lines l
      WHERE l.project_id = project_finance.project_id
        AND l.category = 'rental'
        AND l.kind = 'cost'
   );

INSERT INTO project_finance_lines (project_id, kind, category, description, amount, created_at)
SELECT project_id, 'cost', 'contractor', 'Imported from legacy finance.contractor_cost', contractor_cost, datetime('now')
  FROM project_finance
 WHERE contractor_cost IS NOT NULL AND contractor_cost > 0
   AND NOT EXISTS (
     SELECT 1 FROM project_finance_lines l
      WHERE l.project_id = project_finance.project_id
        AND l.category = 'contractor'
        AND l.kind = 'cost'
   );

INSERT INTO project_finance_lines (project_id, kind, category, description, amount, created_at)
SELECT project_id, 'cost', 'license', 'Imported from legacy finance.license_fee', license_fee, datetime('now')
  FROM project_finance
 WHERE license_fee IS NOT NULL AND license_fee > 0
   AND NOT EXISTS (
     SELECT 1 FROM project_finance_lines l
      WHERE l.project_id = project_finance.project_id
        AND l.category = 'license'
        AND l.kind = 'cost'
   );

INSERT INTO project_finance_lines (project_id, kind, category, description, amount, created_at)
SELECT project_id, 'cost', 'deposit', 'Imported from legacy finance.deposit_paid', deposit_paid, datetime('now')
  FROM project_finance
 WHERE deposit_paid IS NOT NULL AND deposit_paid > 0
   AND NOT EXISTS (
     SELECT 1 FROM project_finance_lines l
      WHERE l.project_id = project_finance.project_id
        AND l.category = 'deposit'
        AND l.kind = 'cost'
   );

-- Deposit refunds are negative-cost income (money coming back). Model as
-- income with a distinct category so the ledger view makes it obvious.
INSERT INTO project_finance_lines (project_id, kind, category, description, amount, created_at)
SELECT project_id, 'income', 'deposit_refund', 'Imported from legacy finance.deposit_refund', deposit_refund, datetime('now')
  FROM project_finance
 WHERE deposit_refund IS NOT NULL AND deposit_refund > 0
   AND NOT EXISTS (
     SELECT 1 FROM project_finance_lines l
      WHERE l.project_id = project_finance.project_id
        AND l.category = 'deposit_refund'
        AND l.kind = 'income'
   );

INSERT INTO project_finance_lines (project_id, kind, category, description, amount, created_at)
SELECT project_id, 'cost', 'misc', 'Imported from legacy finance.misc_cost', misc_cost, datetime('now')
  FROM project_finance
 WHERE misc_cost IS NOT NULL AND misc_cost > 0
   AND NOT EXISTS (
     SELECT 1 FROM project_finance_lines l
      WHERE l.project_id = project_finance.project_id
        AND l.category = 'misc'
        AND l.kind = 'cost'
   );

-- total_sales is already represented as project_sales_reports rows for
-- any project that has explicit reports. For legacy rows where
-- total_sales was typed into the finance block without a corresponding
-- report, seed a single "Legacy sales total" line. When the user starts
-- adding real sales reports, the rollup trigger (service layer) will
-- overwrite the cached value — this line is a historical anchor only.
INSERT INTO project_finance_lines (project_id, kind, category, description, amount, created_at)
SELECT pf.project_id, 'income', 'sales', 'Imported from legacy finance.total_sales', pf.total_sales, datetime('now')
  FROM project_finance pf
 WHERE pf.total_sales IS NOT NULL AND pf.total_sales > 0
   AND NOT EXISTS (
     SELECT 1 FROM project_finance_lines l
      WHERE l.project_id = pf.project_id
        AND l.category = 'sales'
        AND l.kind = 'income'
   )
   -- Skip projects that already have sales reports (rollup handles those)
   AND NOT EXISTS (
     SELECT 1 FROM project_sales_reports sr
      WHERE sr.project_id = pf.project_id AND sr.archived_at IS NULL
   );
