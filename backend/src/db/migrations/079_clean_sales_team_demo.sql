-- 079_clean_sales_team_demo.sql
--
-- Remove the dev-phase demo sales reps left behind by mig 067 and
-- mig 069. The authoritative source of reps is now the auto-sync
-- hook (services/salesTeam.ts → syncSalesRepFromUser), fired from
-- users PATCH whenever a user's department is set to "Sales". Reps
-- created that way are linked via user_id and use auto-generated
-- codes outside the SR-1xx range.
--
-- Two markers identify the demo data — OR-ed so a row matching
-- either is dropped:
--   1. email LIKE '%@example.my' — every seeded demo uses this domain
--   2. code IN (SR-001..SR-012, SR-101..SR-127) — the exact code
--      sets from mig 067 / mig 069
--
-- FK cascade (see mig 067):
--   sales_rep_brands.rep_id     ON DELETE CASCADE — auto-clears
--   sales_team_activity.rep_id  ON DELETE CASCADE — auto-clears
--   sales_entries.sales_rep_id  ON DELETE SET NULL — historical sales
--                                                    keep their rows;
--                                                    the rep pointer
--                                                    just nulls out.

DELETE FROM sales_reps
 WHERE email LIKE '%@example.my'
    OR email LIKE '%@example.com'
    OR code IN (
      'SR-001','SR-002','SR-003','SR-004','SR-005','SR-006',
      'SR-007','SR-008','SR-009','SR-010','SR-011','SR-012',
      'SR-101','SR-102','SR-103','SR-104','SR-105','SR-106',
      'SR-107','SR-108','SR-109','SR-110','SR-111','SR-112',
      'SR-113','SR-114','SR-115','SR-116','SR-117','SR-118',
      'SR-119','SR-120','SR-121','SR-122','SR-123','SR-124',
      'SR-125','SR-126','SR-127'
    );
