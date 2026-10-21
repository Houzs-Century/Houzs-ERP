-- 20261021T0345_realign_id_counters.sql
-- Team > Members > Save on James Lee Jun Ji (EMP-0167) failed twice on
-- 2026-10-21 with "Something went wrong processing that request." PATCH
-- /api/users/:id had already written his assignment when syncSalesRepFromUser
-- put him on the Sales roster, and that INSERT drew ids 92 and 93 from a
-- counter standing at 91 while sales_reps already held 92-96: five rows
-- (SR-046..SR-050) written on 2026-10-14 with explicit ids and no roster
-- activity entry, i.e. outside the app, so the counter never moved.
--
-- 1. Every id counter at or below its table's highest id moves forward to it.
--    Never backwards: a counter already past its table is left alone. On
--    production that is sales_reps (next 94, max 96) and
--    project_finance.project_id (never drawn: every insert names the project).
-- 2. A member of a Sales department (the name match syncSalesRepFromUser uses)
--    who is not disabled and has no roster row gets the row and the "created"
--    activity entry the app would have written. On production: user 167 only.
--
-- REVERSAL: counters are not moved back, which would re-create the duplicate key.
--   The roster rows are archived the way the Sales Team page archives one:
--   UPDATE public.sales_reps
--      SET archived_at = to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'),
--          updated_at  = to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')
--    WHERE id IN (SELECT rep_id FROM public.sales_team_activity
--                  WHERE note = 'Auto-created from Team (department set to Sales); added after the save failed on a stale id counter');

DO $$
DECLARE
  k        record;
  v_max    bigint;
  v_last   bigint;
  v_called boolean;
BEGIN
  FOR k IN
    SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col,
           pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname)::regclass AS seq
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE a.attnum > 0 AND NOT a.attisdropped
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime',
                             'supabase_functions', 'supabase_migrations', 'extensions', 'graphql',
                             'graphql_public', 'pgsodium', 'vault', 'net', 'cron', 'pgbouncer')
       AND n.nspname NOT LIKE 'pg\_%'
       AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT max(%I)::bigint FROM %I.%I', k.col, k.sch, k.tbl) INTO v_max;
    EXECUTE format('SELECT last_value, is_called FROM %s', k.seq) INTO v_last, v_called;
    IF v_max IS NOT NULL AND (CASE WHEN v_called THEN v_last + 1 ELSE v_last END) <= v_max THEN
      PERFORM setval(k.seq, v_max, true);
    END IF;
  END LOOP;
END $$;

WITH base AS (
  SELECT COALESCE(max(substring(code FROM '^SR-([0-9]+)$')::bigint), 0) AS n
    FROM public.sales_reps
),
missing AS (
  SELECT u.id, u.name, u.email, row_number() OVER (ORDER BY u.id) AS k
    FROM public.users u
    JOIN public.departments d ON d.id = u.department_id
   WHERE lower(d.name) LIKE '%sales%'
     AND u.status IS DISTINCT FROM 'disabled'
     AND NOT EXISTS (SELECT 1 FROM public.sales_reps r WHERE r.user_id = u.id)
),
made AS (
  INSERT INTO public.sales_reps (code, name, email, user_id, status)
  SELECT 'SR-' || lpad((b.n + m.k)::text, GREATEST(3, length((b.n + m.k)::text)), '0'),
         COALESCE(NULLIF(m.name, ''), m.email), m.email, m.id, 'active'
    FROM missing m CROSS JOIN base b
  RETURNING id, code
)
INSERT INTO public.sales_team_activity (rep_id, action, from_value, to_value, note, user_id)
SELECT id, 'created', NULL, code,
       'Auto-created from Team (department set to Sales); added after the save failed on a stale id counter',
       NULL
  FROM made;
