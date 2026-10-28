-- 0055_drop_old_fleet_lorries.sql
--
-- Retire the old Houzs Fleet `public.lorries` table + its arc of orphan tables,
-- in favour of the new TMS module's `scm.lorries` (mig 0053). The Setup &
-- Dismantle crew picker on Project detail now reads scm.lorries instead.
--
-- WHAT MOVES:
--   • 3 active rows from public.lorries → scm.lorries
--     (VNB 9058 / VPC 9058 / VQE 9058, all warehouse=KL, is_internal=1)
--     - public.lorries.size text ("4 ton (21ft)" / "3 Ton (17ft)") is mapped to
--       the scm.lorry_type enum by parsing the ftXX suffix; default OTHER.
--     - public.lorries.warehouse (text code, e.g. "KL", FK to public.warehouses)
--       is NOT carried over — scm.warehouses is a SEPARATE UUID-keyed table; the
--       owner can re-assign warehouse_id in the SCM lorries page later.
--     - model / road_tax_expiry / insurance_expiry / puspakom_expiry are dropped
--       (scm.lorries has no equivalent — compliance lives in scm.lorry_maintenance).
--
-- WHAT STAYS DEAD:
--   • projects.setup_lorry_id (3 rows) all point to INACTIVE lorries
--     (KL-17A id=3 / PG-17A id=4, both is_active=0). Owner abandoned these long
--     ago. NULL them out before the type-change.
--   • projects.dismantle_lorry_id has ZERO non-null rows.
--   • public.driver_clock_records (1 stale row), public.trips (2 legacy rows
--     from mig 003 planner), public.lorry_compliance (0 rows),
--     public.lorry_maintenance (0 rows) — all reference public.lorries and have
--     no live consumers. DROPped.
--
-- RUNTIME IMPACT:
--   • Old /api/fleet/* (users-by-role) STAYS — it reads public.users, not these
--     dropped tables, and the project crew picker still consumes it for the
--     Driver/Helper/Storekeeper dropdowns.
--   • Old /api/lorries is being removed in the same PR (backend/src/routes/
--     lorries.ts + its mount). The new picker hits /api/scm/lorries.
--
-- IDEMPOTENCY: every step is guarded (IF EXISTS / IF NOT EXISTS / NULL-safe).
-- NOTE: pg-migrate.mjs wraps each file in its own transaction — no inner
-- BEGIN/COMMIT here (they'd break the splitter).

-- ── Step 1: null out the 3 dead projects.setup_lorry_id values ───────────────
-- They reference inactive lorries (KL-17A / PG-17A, is_active=0) — already dead
-- data; this is a no-op cleanup, not a loss.
UPDATE public.projects SET setup_lorry_id = NULL WHERE setup_lorry_id IS NOT NULL;

-- ── Step 2: migrate the 3 active lorries before dropping the source ──────────
-- Type derivation from the freeform size text: "21ft" → LORRY_21FT, "17ft" →
-- LORRY_17FT, etc. Fallback OTHER. warehouse_id stays NULL (different schema).
INSERT INTO scm.lorries (plate, type, is_internal, capacity_m3, capacity_kg, active, notes)
SELECT
  l.plate,
  (CASE
     WHEN l.size ILIKE '%10ft%' THEN 'LORRY_10FT'
     WHEN l.size ILIKE '%14ft%' THEN 'LORRY_14FT'
     WHEN l.size ILIKE '%17ft%' THEN 'LORRY_17FT'
     WHEN l.size ILIKE '%21ft%' THEN 'LORRY_21FT'
     WHEN l.size ILIKE '%van%'  THEN 'VAN'
     ELSE 'OTHER'
   END)::scm.lorry_type,
  COALESCE(l.is_internal, 1) <> 0,
  l.capacity_m3,
  l.capacity_kg,
  COALESCE(l.is_active, 1) <> 0,
  -- Preserve any human context we'd lose: warehouse code + size text + model.
  NULLIF(CONCAT_WS(' · ',
    CASE WHEN l.warehouse IS NOT NULL THEN 'warehouse=' || l.warehouse END,
    CASE WHEN l.size      IS NOT NULL THEN 'size: '     || l.size      END,
    CASE WHEN l.model     IS NOT NULL THEN 'model: '    || l.model     END
  ), '')
FROM public.lorries l
WHERE l.is_active = 1
  AND NOT EXISTS (SELECT 1 FROM scm.lorries s WHERE s.plate = l.plate);

-- ── Step 3: type-change the BIGINT FK columns → UUID ─────────────────────────
-- No FK constraint exists, so a straight ALTER TYPE works (USING handles the
-- all-NULL case cleanly after step 1). projects.setup_helper_*/driver_user_id
-- still reference public.users — leave them alone.
ALTER TABLE public.projects ALTER COLUMN setup_lorry_id     TYPE uuid USING NULL;
ALTER TABLE public.projects ALTER COLUMN dismantle_lorry_id TYPE uuid USING NULL;

-- ── Step 4: drop the orphan tables (CASCADE handles any leftover FK) ─────────
-- All confirmed empty / dead: driver_clock_records=1 stale, trips=2 legacy,
-- lorry_compliance=0, lorry_maintenance=0. None of the live SCM code touches
-- these — that's the new scm.trips / scm.lorry_maintenance / etc.
DROP TABLE IF EXISTS public.driver_clock_records CASCADE;
DROP TABLE IF EXISTS public.trips                CASCADE;
DROP TABLE IF EXISTS public.lorry_compliance     CASCADE;
DROP TABLE IF EXISTS public.lorry_maintenance    CASCADE;

-- ── Step 5: drop the source table ────────────────────────────────────────────
DROP TABLE IF EXISTS public.lorries CASCADE;
