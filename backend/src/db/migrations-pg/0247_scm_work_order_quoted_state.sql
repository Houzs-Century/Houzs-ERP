-- 0247 — QUOTED: the state between "we know what is wrong" and "go ahead".
--
-- WHY. Owner, 2026-08-03, on the work-order stepper: "正常不是应该我 report 了这个
-- 问题，然后 diagnose，然后 for quotation，然后 approve，然后 in repair，然后
-- waiting parts complete，最后 verify 等等吗?"
--
-- The machine went DIAGNOSED -> APPROVED with nothing in between, so "the
-- workshop has sent a price and we have not decided yet" was invisible: the job
-- sat in DIAGNOSED whether the quote had arrived or not. The irony is that the
-- document this module was built around is literally headed "Workshop quotation
-- WJO00403", and the work order has carried quotation_no since mig 0241 — the
-- number had a home, the WAITING did not.
--
-- DIAGNOSED KEEPS ITS DIRECT ROUTE TO APPROVED. Two reasons, and the first is
-- the load-bearing one:
--   1. Every work order sitting in DIAGNOSED right now was created under a
--      machine where APPROVED was its only next move. Removing that edge would
--      strand them behind a state they never passed through.
--   2. Not every job is quoted. A RM60 bulb change approved on the spot should
--      not have to fake a quotation to move.
-- So QUOTED is the normal path, not a toll gate.
--
-- QUOTED IS AN OPEN STATE and does NOT ground dispatch. isWorkOrderOpen() counts
-- everything but COMPLETED/VERIFIED, and workOrderSeam() only reacts to
-- IN_REPAIR / WAITING_PARTS — a lorry waiting on a price is still on the road.
-- That is unchanged here by design.
--
-- ADDITIVE ONLY. Widening a CHECK's allowed set cannot fail on existing rows:
-- every stored value is still in the list. Nothing is backfilled — no existing
-- work order can be known to have been quoted.
--
-- HOUSE STYLE. Idempotent, schema-qualified, one transaction. RE-CHECK THE
-- NUMBER AT MERGE — 0247 was next free above 0246.

SET search_path = scm, public;

ALTER TABLE scm.lorry_work_orders
  DROP CONSTRAINT IF EXISTS lorry_work_orders_status_check;

ALTER TABLE scm.lorry_work_orders
  ADD CONSTRAINT lorry_work_orders_status_check
  CHECK (status IN (
    'REPORTED','DIAGNOSED','QUOTED','APPROVED','IN_REPAIR','WAITING_PARTS',
    'COMPLETED','VERIFIED'
  ));
