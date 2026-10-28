-- ═══════════════════════════════════════
-- Migration 007 — Reactivate PG warehouse
--
-- KL covers: Johor, Melaka, Negeri Sembilan, Putrajaya, KL, Selangor
-- PG covers: Perak, Pahang, Terengganu, Kelantan, Penang, Kedah, Perlis
-- ═══════════════════════════════════════

-- ── Reactivate PG ────────────────────────────────────────────────
UPDATE warehouses SET is_active = 1 WHERE code = 'PG';

-- ── Fix state → warehouse mapping ────────────────────────────────
DELETE FROM state_warehouse_map;
INSERT OR IGNORE INTO state_warehouse_map (state, warehouse) VALUES
  -- KL warehouse
  ('Kuala Lumpur',    'KL'),
  ('Selangor',        'KL'),
  ('Putrajaya',       'KL'),
  ('Negeri Sembilan', 'KL'),
  ('Melaka',          'KL'),
  ('Johor',           'KL'),
  -- PG warehouse
  ('Penang',          'PG'),
  ('Pulau Pinang',    'PG'),
  ('Kedah',           'PG'),
  ('Perlis',          'PG'),
  ('Perak',           'PG'),
  ('Pahang',          'PG'),
  ('Terengganu',      'PG'),
  ('Kelantan',        'PG'),
  -- EM/SG (ships from KL regardless)
  ('Sabah',           'KL'),
  ('Labuan',          'KL'),
  ('Sarawak',         'KL'),
  ('Singapore',       'KL');

-- ── Move PG lorries back to PG ───────────────────────────────────
UPDATE lorries SET warehouse = 'PG' WHERE plate IN ('PG-17A','PG-17B');

-- ── Remap order_details for PG-covered states ────────────────────
UPDATE order_details SET warehouse = 'PG'
 WHERE state IN ('Penang','Pulau Pinang','Kedah','Perlis','Perak','Pahang','Terengganu','Kelantan')
   AND warehouse = 'KL';
