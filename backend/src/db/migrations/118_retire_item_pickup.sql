-- 118_retire_item_pickup.sql -- D1 test mirror of migrations-pg/0110
-- Stage funnel re-cut to 7 stages (Nick 2026-07-14): the standalone
-- Item Pickup stage is retired — collecting the faulty item from the
-- customer is part of the Supplier stage now (which covers both the
-- pickup and the return leg). Mid-flight cases move forward into
-- Pending Supplier Pickup; the retired stage's history rows go the
-- same way stage history went for pending_inspection (mig 0105).

UPDATE assr_cases SET stage = 'pending_supplier_pickup'
 WHERE stage = 'pending_item_pickup';

DELETE FROM assr_stage_history WHERE stage = 'pending_item_pickup';
