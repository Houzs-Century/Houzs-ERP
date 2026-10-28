-- 119_product_categories_lookup.sql
-- D1 test mirror of migrations-pg/0112 (SQLite dialect).

CREATE TABLE IF NOT EXISTS assr_product_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assr_product_cat_active ON assr_product_categories(active);

INSERT OR IGNORE INTO assr_product_categories (slug, name, sort_order) VALUES
  ('mattress',       'Mattress',          10),
  ('bed_frame',      'Bed Frame',         20),
  ('sofa',           'Sofa',              30),
  ('pillow_bolster', 'Pillow / Bolster',  40),
  ('accessories',    'Accessories',       50);
