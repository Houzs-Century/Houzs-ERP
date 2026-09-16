-- 20260916T1600_position_policy.sql
-- REVERSAL:
--   DROP TABLE IF EXISTS public.position_policy;
--   Additive table; nothing else references it. Without a row the resolver
--   falls back to the name-keyed rule it used before this table existed
--   (services/positionPolicy.ts), so dropping it restores yesterday's
--   behaviour exactly — the seed below IS yesterday's behaviour, by id.
--
-- Roles & Permissions review 2026-09-16, part B (owner: 「先做 A，然后走 B」).
--
-- 白话。到今天为止，一个职位（Title）是「全开 / 受限 / 销售」哪一档、能不能动钱、
-- 能不能改主数据、是不是司机，全部写在代码里，按职位的「名字」比对。在 Team 页改一
-- 个名字、或把人批量挪到新职位，权限就跟着变，没有任何提示。这张表把同一份决定按
-- 职位 id 存起来，Roles & Permissions 页多一个 Titles 分区可以改；名单式的白名单
-- （storekeeper 看哪些页）仍在代码里，这里只记「用哪一份」。
--
-- Columns:
--   cohort           god | full | restricted | sales
--   profile          restricted: driver_helper | storekeeper | storekeeper_supervisor | calendar_viewer
--                    sales:      director | rep          (god / full: NULL)
--   can_move_money   full only — journals + payment vouchers (Finance Manager)
--   can_write_config full only — SCM master-data writes without the flat key
--   is_fleet         restricted only — own delivery jobs, fails closed when unlinked
-- Flags are INTEGER 0/1 like every other flag column here (positions.active,
-- roles.is_system), so the session fingerprint can CAST them the same way on
-- Postgres and on the D1 test mirror.
CREATE TABLE IF NOT EXISTS public.position_policy (
  position_id      integer PRIMARY KEY REFERENCES public.positions(id) ON DELETE CASCADE,
  cohort           text    NOT NULL CHECK (cohort IN ('god', 'full', 'restricted', 'sales')),
  profile          text    NULL CHECK (profile IS NULL OR profile IN (
                     'driver_helper', 'storekeeper', 'storekeeper_supervisor', 'calendar_viewer',
                     'director', 'rep')),
  can_move_money   integer NOT NULL DEFAULT 0 CHECK (can_move_money IN (0, 1)),
  can_write_config integer NOT NULL DEFAULT 0 CHECK (can_write_config IN (0, 1)),
  is_fleet         integer NOT NULL DEFAULT 0 CHECK (is_fleet IN (0, 1)),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       integer NULL
);

-- Seed: one row per Title, by SLUG, exactly what the name rule resolved on
-- 2026-09-16 (services/positionPolicyRows.ts POSITION_POLICY_SEED; a test pins
-- these tuples against that table and each against its name). A slug this
-- database lacks seeds nothing; a Title with no row keeps the name rule.
INSERT INTO public.position_policy (position_id, cohort, profile, can_move_money, can_write_config, is_fleet)
SELECT p.id, s.cohort, s.profile, s.can_move_money, s.can_write_config, s.is_fleet
  FROM (VALUES
    ('super_admin',            'god',        NULL,                     1, 1, 0),
    ('owner',                  'god',        NULL,                     1, 1, 0),
    ('managing_director',      'god',        NULL,                     1, 1, 0),
    ('hr_manager',             'full',       NULL,                     0, 0, 0),
    ('finance_manager',        'full',       NULL,                     1, 0, 0),
    ('it_developer_executive', 'full',       NULL,                     0, 0, 0),
    ('service_admin',          'full',       NULL,                     0, 0, 0),
    ('pg_wh_assistant',        'full',       NULL,                     0, 0, 0),
    ('ops_director',           'full',       NULL,                     0, 1, 0),
    ('ops_executive',          'full',       NULL,                     0, 1, 0),
    ('purchasing',             'full',       NULL,                     0, 1, 0),
    ('logistic',               'full',       NULL,                     0, 1, 0),
    ('sales_director',         'sales',      'director',               0, 0, 0),
    ('sales_manager',          'sales',      'rep',                    0, 0, 0),
    ('sales_executive',        'sales',      'rep',                    0, 0, 0),
    ('sales_person',           'sales',      'rep',                    0, 0, 0),
    ('storekeeper',            'restricted', 'storekeeper',            0, 0, 0),
    ('storekeeper_supervisor', 'restricted', 'storekeeper_supervisor', 0, 0, 0),
    ('warehouse_crew_kl',      'restricted', 'storekeeper',            0, 0, 0),
    ('driver',                 'restricted', 'driver_helper',          0, 0, 1),
    ('helper',                 'restricted', 'driver_helper',          0, 0, 1),
    ('outsource_transporter',  'restricted', 'driver_helper',          0, 0, 0),
    ('calendar-viewer',        'restricted', 'calendar_viewer',        0, 0, 0)
  ) AS s(slug, cohort, profile, can_move_money, can_write_config, is_fleet)
  JOIN public.positions p ON p.slug = s.slug
ON CONFLICT (position_id) DO NOTHING;
