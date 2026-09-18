-- 0348_scm_so_edit_lease_holder.sql (Postgres)
--
-- WHO holds a sales order's save lock.
--
-- 0172 gave the lock a token and an expiry and nothing else, so the server
-- could never tell a lock left behind by the CALLER'S OWN crashed save from one
-- a colleague is holding right now. Both refusals came out as "this order is
-- being saved on another screen", and on 2026-09-03 the owner hit that working
-- alone: a save of his timed out, its lock stayed, and every retry blamed a
-- screen that did not exist.
--
--   「我现在一个人只能 edit 一次，不可以呀。」
--
-- With the holder recorded, the same person takes their own lock back instead
-- of waiting it out, and a refusal can finally name which of the two it is.
--
-- NULLABLE, and it stays nullable: every lock written before this migration has
-- no holder, and a lock with no holder must keep behaving exactly as it does
-- today (refuse, expire on its own). Backfilling an owner onto those rows would
-- be inventing one.
--
-- REVERSAL: ALTER TABLE scm.mfg_sales_orders DROP COLUMN IF EXISTS edit_lease_user_id;
--   Safe at any time. The column is advisory: it only ever decides whether a
--   refusal is softened into a takeover, so dropping it returns the lock to
--   0172's behaviour and loses no document data. No view, index or grant
--   depends on it.
ALTER TABLE scm.mfg_sales_orders
  ADD COLUMN IF NOT EXISTS edit_lease_user_id bigint;

COMMENT ON COLUMN scm.mfg_sales_orders.edit_lease_user_id IS
  'Houzs user id that acquired edit_lease_token. NULL = a lock written before '
  'mig 0348, or by a path with no authenticated user; those are never taken '
  'over, they expire. Advisory only - the token remains the identity of the '
  'lock, this names its holder so the same person is not locked out of their '
  'own order.';
