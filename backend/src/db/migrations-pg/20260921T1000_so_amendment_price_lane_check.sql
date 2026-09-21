-- 20260921T1000_so_amendment_price_lane_check.sql
-- Owner 2026-09-21: a 2990 SO amendment that changes ONLY the sell price (or
-- discount) of a product line signs with Finance (Kris), not the Purchaser. It
-- rides a THIRD approval lane, 'PRICE', alongside 'LINES' and 'DELIVERY'
-- (backend/src/scm/shared/amendment-lane.ts). This widens the lane CHECK to
-- admit it. HOUZS is unaffected — its price changes stay on the 'LINES' lane, so
-- no 'PRICE' row is ever created for company 1.
--
-- The open-per-lane unique index uq_so_amendment_open_lane (mig 0216) is keyed
-- on the lane column generically — WHERE status = 'REQUESTED' AND lane IS NOT
-- NULL — so it already admits a third value and needs no change.
--
-- REVERSAL: the constraint's prior form only holds once no lane='PRICE' rows
-- remain; drop the PRICE rows (or reject them) first, then --
--   ALTER TABLE scm.so_amendments DROP CONSTRAINT IF EXISTS so_amendments_lane_chk;
--   ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_lane_chk CHECK (lane IS NULL OR lane IN ('LINES','DELIVERY'));

ALTER TABLE scm.so_amendments DROP CONSTRAINT IF EXISTS so_amendments_lane_chk;

ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_lane_chk CHECK (lane IS NULL OR lane IN ('LINES','DELIVERY','PRICE'));
