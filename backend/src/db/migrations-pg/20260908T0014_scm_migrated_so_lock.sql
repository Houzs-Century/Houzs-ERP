-- 20260908T0014_scm_migrated_so_lock.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE ROW in scm.app_config. No schema change, no DDL, no table touched that
-- carries business data. It seeds the switch that
-- backend/src/scm/lib/migrated-so-lock.ts reads:
--
--     key   = 'scm.migrated_so_lock'
--     value = '1'      -> company 1 (Houzs Century): migrated sales orders are
--                         READ-ONLY. New sales orders are unaffected.
--
-- Owner 2026-09-08: 「只开新单，旧单暂时不能改」 — he asked whether Sales Orders
-- could be opened to staff now and tally later, and ruled that new orders open
-- while migrated ones stay shut. This row is the ERP half of that sentence.
--
-- WHY IT IS SEEDED **ON**, WHICH IS THE OPPOSITE OF 0272.
-- Migration 0272 seeded the write freeze 'off' and said so loudly: "Turning the
-- freeze on is an explicit act, never a side effect of running a migration."
-- That is right for the freeze, whose default state protects nothing. It is
-- wrong here, and the difference is worth being explicit about, because this
-- file otherwise looks like it breaks that rule.
--
-- The write freeze is what is CURRENTLY stopping a migrated order from being
-- edited (scm.write_freeze = '1 - scm.procurement.products'). The very next
-- operational step is to lift scm.sales.orders out of it. The moment that lift
-- happens, every migrated order becomes editable — unless this row is already
-- in place. A row seeded 'off' would therefore be a row that opens the exact
-- documents the owner just ruled shut, at the exact moment nobody is looking at
-- this file any more. So it is seeded to the state he ruled, and turning it OFF
-- is the explicit act.
--
-- WHAT IT PROTECTS AGAINST — two live risks, neither of which touches a NEW
-- order:
--   1. sync-ac-delta runs again and can overwrite a staff edit with no signal.
--   2. Payments taken in AutoCount since 2026-08-28 have not reached the ERP.
--      The 5-minute pull carries AutoCount's outstanding balance into
--      public.sales_orders.balance, a column with ZERO readers, so the balance
--      a salesperson sees on a migrated order is wrong.
--
-- Risk 2 is the one that lifts this. When collections are corrected:
--
--     UPDATE scm.app_config SET value = 'off', updated_at = now()
--      WHERE key = 'scm.migrated_so_lock';
--
-- Effective within 30 seconds (the middleware's per-isolate cache), no deploy.
--
-- ON CONFLICT DO NOTHING so a re-run, or an environment where the owner has
-- already set the value by hand, is never overwritten by a migration.
--
-- Reversal: UPDATE scm.app_config SET value = 'off' WHERE key =
-- 'scm.migrated_so_lock'; (or DELETE the row — an absent row parses as 'off'
-- via parseMigratedSoLock, so deleting it also unlocks). Nothing else in the
-- database depends on the row existing.
-- Verified against: scm.app_config as created by 0272 (key text PRIMARY KEY,
-- value text NOT NULL, description text) — the same table and the same shape
-- the write freeze already uses, read through the service client whose
-- db.schema is 'scm'.

INSERT INTO scm.app_config (key, value, description)
VALUES (
  'scm.migrated_so_lock',
  '1',
  NULL
)
ON CONFLICT (key) DO NOTHING;
