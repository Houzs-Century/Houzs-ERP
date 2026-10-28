-- 0112_product_categories_lookup.sql
-- Product Category becomes a managed lookup on the create-case form
-- (Nick 2026-07-14: options should mirror AutoCount's item groups).
-- AutoCount is still disconnected, so this seeds the common furniture
-- groups; the reconnect back-fill replaces/extends them with the
-- authoritative item-group list (existing deferred task).

CREATE TABLE IF NOT EXISTS assr_product_categories (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_assr_product_cat_active ON assr_product_categories(active);

INSERT INTO assr_product_categories (slug, name, sort_order) VALUES
  ('mattress',       'Mattress',          10),
  ('bed_frame',      'Bed Frame',         20),
  ('sofa',           'Sofa',              30),
  ('pillow_bolster', 'Pillow / Bolster',  40),
  ('accessories',    'Accessories',       50)
ON CONFLICT (slug) DO NOTHING;
