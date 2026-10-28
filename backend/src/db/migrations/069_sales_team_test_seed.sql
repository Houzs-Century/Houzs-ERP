-- 069_sales_team_test_seed.sql
--
-- Boss-requested test hierarchy:
--   1 Director (all 6 brands, admin)
--     ↳ 2 Managers (each 3 brands)
--         ↳ 3 Executives per manager (each 1 brand)
--             ↳ 3 Sales Persons per executive (inherit exec's brand)
-- Total: 1 + 2 + 6 + 18 = 27 reps.
--
-- Two new positions are added to mig 067's seed (Director / Executive
-- / Sub-Executive) so the 4-tier ladder fits cleanly:
--   Manager       (level 15) — between Director and Executive
--   Sales Person  (level 25) — between Executive and Sub-Executive
-- Sub-Executive stays in the picker for backward compat.
--
-- Idempotency: the DELETE block targets only the mig 067 placeholder
-- codes (SR-001..SR-012) and the new test codes (SR-101..SR-127), so
-- any real reps added through the register form are untouched.

INSERT OR IGNORE INTO sales_positions (slug, name, level, sort_order) VALUES
  ('manager',      'Manager',      15, 15),
  ('sales_person', 'Sales Person', 25, 25);

-- ── Wipe placeholder + previous test seeds ────────────────────
-- Cascade clears sales_rep_brands, sales_rep_commission_tiers, and
-- sales_team_activity for the wiped reps (FK ON DELETE CASCADE).
DELETE FROM sales_reps WHERE code IN (
  'SR-001','SR-002','SR-003','SR-004','SR-005','SR-006',
  'SR-007','SR-008','SR-009','SR-010','SR-011','SR-012',
  'SR-101','SR-102','SR-103','SR-104','SR-105','SR-106',
  'SR-107','SR-108','SR-109',
  'SR-110','SR-111','SR-112','SR-113','SR-114','SR-115',
  'SR-116','SR-117','SR-118','SR-119','SR-120','SR-121',
  'SR-122','SR-123','SR-124','SR-125','SR-126','SR-127'
);

-- ── Director ──────────────────────────────────────────────────
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-101', 'Test Director', '+60123456101', 'test.director@example.my',
         (SELECT id FROM sales_positions WHERE slug='director'), NULL, 'active', 1, 8.0, '2024-01-01';

-- ── Managers ──────────────────────────────────────────────────
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-102', 'Test Manager 1', '+60123456102', 'test.manager1@example.my',
         (SELECT id FROM sales_positions WHERE slug='manager'),
         (SELECT id FROM sales_reps WHERE code='SR-101'), 'active', 0, 7.0, '2024-02-01';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-103', 'Test Manager 2', '+60123456103', 'test.manager2@example.my',
         (SELECT id FROM sales_positions WHERE slug='manager'),
         (SELECT id FROM sales_reps WHERE code='SR-101'), 'active', 0, 7.0, '2024-02-15';

-- ── Executives (one brand each) ───────────────────────────────
-- Manager 1 owns AKEMI / ZANOTTI / ERGOTEX
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-104', 'Test Exec — AKEMI', '+60123456104', 'test.exec.akemi@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps WHERE code='SR-102'), 'active', 0, 6.0, '2024-03-01';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-105', 'Test Exec — ZANOTTI', '+60123456105', 'test.exec.zanotti@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps WHERE code='SR-102'), 'active', 0, 6.0, '2024-03-05';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-106', 'Test Exec — ERGOTEX', '+60123456106', 'test.exec.ergotex@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps WHERE code='SR-102'), 'active', 0, 6.0, '2024-03-10';
-- Manager 2 owns DUNLOPILLO / MY SOFA FACTORY / AKEMI C&C
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-107', 'Test Exec — DUNLOPILLO', '+60123456107', 'test.exec.dunlopillo@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps WHERE code='SR-103'), 'active', 0, 6.0, '2024-03-15';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-108', 'Test Exec — MY SOFA FACTORY', '+60123456108', 'test.exec.mysofa@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps WHERE code='SR-103'), 'active', 0, 6.0, '2024-03-20';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-109', 'Test Exec — AKEMI C&C', '+60123456109', 'test.exec.akemicc@example.my',
         (SELECT id FROM sales_positions WHERE slug='executive'),
         (SELECT id FROM sales_reps WHERE code='SR-103'), 'active', 0, 6.0, '2024-03-25';

-- ── Sales Persons (3 per executive, inherit brand) ────────────
-- AKEMI persons under SR-104
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-110', 'Test Sales — AKEMI 1', '+60123456110', 'test.sales.akemi1@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-104'), 'active', 0, 5.0, '2024-04-01';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-111', 'Test Sales — AKEMI 2', '+60123456111', 'test.sales.akemi2@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-104'), 'active', 0, 5.0, '2024-04-02';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-112', 'Test Sales — AKEMI 3', '+60123456112', 'test.sales.akemi3@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-104'), 'active', 0, 5.0, '2024-04-03';
-- ZANOTTI persons under SR-105
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-113', 'Test Sales — ZANOTTI 1', '+60123456113', 'test.sales.zanotti1@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-105'), 'active', 0, 5.0, '2024-04-04';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-114', 'Test Sales — ZANOTTI 2', '+60123456114', 'test.sales.zanotti2@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-105'), 'active', 0, 5.0, '2024-04-05';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-115', 'Test Sales — ZANOTTI 3', '+60123456115', 'test.sales.zanotti3@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-105'), 'active', 0, 5.0, '2024-04-06';
-- ERGOTEX persons under SR-106
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-116', 'Test Sales — ERGOTEX 1', '+60123456116', 'test.sales.ergotex1@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-106'), 'active', 0, 5.0, '2024-04-07';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-117', 'Test Sales — ERGOTEX 2', '+60123456117', 'test.sales.ergotex2@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-106'), 'active', 0, 5.0, '2024-04-08';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-118', 'Test Sales — ERGOTEX 3', '+60123456118', 'test.sales.ergotex3@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-106'), 'active', 0, 5.0, '2024-04-09';
-- DUNLOPILLO persons under SR-107
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-119', 'Test Sales — DUNLOPILLO 1', '+60123456119', 'test.sales.dunlopillo1@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-107'), 'active', 0, 5.0, '2024-04-10';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-120', 'Test Sales — DUNLOPILLO 2', '+60123456120', 'test.sales.dunlopillo2@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-107'), 'active', 0, 5.0, '2024-04-11';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-121', 'Test Sales — DUNLOPILLO 3', '+60123456121', 'test.sales.dunlopillo3@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-107'), 'active', 0, 5.0, '2024-04-12';
-- MY SOFA FACTORY persons under SR-108
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-122', 'Test Sales — MY SOFA 1', '+60123456122', 'test.sales.mysofa1@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-108'), 'active', 0, 5.0, '2024-04-13';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-123', 'Test Sales — MY SOFA 2', '+60123456123', 'test.sales.mysofa2@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-108'), 'active', 0, 5.0, '2024-04-14';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-124', 'Test Sales — MY SOFA 3', '+60123456124', 'test.sales.mysofa3@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-108'), 'active', 0, 5.0, '2024-04-15';
-- AKEMI C&C persons under SR-109
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-125', 'Test Sales — AKEMI C&C 1', '+60123456125', 'test.sales.akemicc1@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-109'), 'active', 0, 5.0, '2024-04-16';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-126', 'Test Sales — AKEMI C&C 2', '+60123456126', 'test.sales.akemicc2@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-109'), 'active', 0, 5.0, '2024-04-17';
INSERT INTO sales_reps (code, name, phone, email, position_id, upline_id, status, is_admin, commission_rate, joined_on)
  SELECT 'SR-127', 'Test Sales — AKEMI C&C 3', '+60123456127', 'test.sales.akemicc3@example.my',
         (SELECT id FROM sales_positions WHERE slug='sales_person'),
         (SELECT id FROM sales_reps WHERE code='SR-109'), 'active', 0, 5.0, '2024-04-18';

-- ── Brand assignments ─────────────────────────────────────────
-- Director: all 6 brands
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI'           FROM sales_reps WHERE code='SR-101';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ZANOTTI'         FROM sales_reps WHERE code='SR-101';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ERGOTEX'         FROM sales_reps WHERE code='SR-101';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'DUNLOPILLO'      FROM sales_reps WHERE code='SR-101';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'MY SOFA FACTORY' FROM sales_reps WHERE code='SR-101';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI C&C'       FROM sales_reps WHERE code='SR-101';
-- Manager 1: AKEMI, ZANOTTI, ERGOTEX
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI'           FROM sales_reps WHERE code='SR-102';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ZANOTTI'         FROM sales_reps WHERE code='SR-102';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ERGOTEX'         FROM sales_reps WHERE code='SR-102';
-- Manager 2: DUNLOPILLO, MY SOFA FACTORY, AKEMI C&C
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'DUNLOPILLO'      FROM sales_reps WHERE code='SR-103';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'MY SOFA FACTORY' FROM sales_reps WHERE code='SR-103';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI C&C'       FROM sales_reps WHERE code='SR-103';
-- Each Executive: 1 brand
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI'           FROM sales_reps WHERE code='SR-104';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ZANOTTI'         FROM sales_reps WHERE code='SR-105';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ERGOTEX'         FROM sales_reps WHERE code='SR-106';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'DUNLOPILLO'      FROM sales_reps WHERE code='SR-107';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'MY SOFA FACTORY' FROM sales_reps WHERE code='SR-108';
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI C&C'       FROM sales_reps WHERE code='SR-109';
-- Sales Persons: inherit executive's brand
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI'           FROM sales_reps WHERE code IN ('SR-110','SR-111','SR-112');
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ZANOTTI'         FROM sales_reps WHERE code IN ('SR-113','SR-114','SR-115');
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'ERGOTEX'         FROM sales_reps WHERE code IN ('SR-116','SR-117','SR-118');
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'DUNLOPILLO'      FROM sales_reps WHERE code IN ('SR-119','SR-120','SR-121');
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'MY SOFA FACTORY' FROM sales_reps WHERE code IN ('SR-122','SR-123','SR-124');
INSERT INTO sales_rep_brands (rep_id, brand) SELECT id, 'AKEMI C&C'       FROM sales_reps WHERE code IN ('SR-125','SR-126','SR-127');

-- Audit row per seeded rep so the UI shows a "created" entry.
INSERT INTO sales_team_activity (rep_id, action, to_value, note, user_id)
  SELECT id, 'created', code, 'Seeded by mig 069 (test hierarchy)', NULL
    FROM sales_reps
   WHERE code LIKE 'SR-1%';
