-- 145_assr_case_categories.sql
-- D1 test mirror of migrations-pg/0256 (SQLite dialect).

CREATE TABLE IF NOT EXISTS assr_case_categories (
  case_id INTEGER NOT NULL REFERENCES assr_cases(id) ON DELETE CASCADE,
  slug    TEXT    NOT NULL,
  PRIMARY KEY (case_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_assr_case_categories_slug ON assr_case_categories(slug);

INSERT OR IGNORE INTO assr_case_categories (case_id, slug)
SELECT c.id, p.slug
  FROM assr_cases c
  JOIN assr_product_categories p
    ON lower(trim(p.name)) = lower(trim(c.service_category))
 WHERE c.service_category IS NOT NULL AND trim(c.service_category) <> '';
