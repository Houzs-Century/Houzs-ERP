-- 20260921T1000_assr_supplier_returns.sql
-- REVERSAL: DROP TABLE IF EXISTS public.assr_supplier_returns;
--   assr_cases.supplier_pickup_at / items_ready_at still carry the CURRENT trip,
--   so dropping this table loses only the per-trip history for cases sent to the
--   factory more than once. GRANTS: none touched.
--
-- WHY (owner 2026-09-21 "我需要2次返厂 Service 功能 / 可以自己添加多少次都可以").
-- A Service Case's supplier leg (stage pending_supplier_pickup) is a factory
-- round-trip: send the item to the supplier/factory, get it back. Its dates lived
-- as SINGLE columns on assr_cases — supplier_pickup_at (out) + items_ready_at
-- (back) — so a case sent back a SECOND time overwrote the first trip's dates. A
-- real case has been back FOUR times with no record of it.
--
-- HOW THIS TABLE IS USED. Every factory trip is a row here (round_no 1..N), added
-- freely as many times as needed. This table is the SOURCE OF TRUTH for the trip
-- dates; assr_cases.supplier_pickup_at / items_ready_at MIRROR the current
-- (highest round_no) row, kept in sync by services/assr.ts, so the Delivery
-- Planning board and the HC Delivery sheet keep reading the trip in progress
-- unchanged. Adding a trip on a completed case reopens it onto the supplier
-- stage. Round 1 is backfilled below from the existing columns so a case already
-- at the factory shows that trip. (qc_receipt_date is the Verification-stage QC
-- date, not a factory date, so it is deliberately not here.)
--
-- Houzs conventions: additive, IF NOT EXISTS, re-runnable; the pg-migrate runner
-- owns ONE transaction, so NO inner BEGIN/COMMIT and one-line DO blocks (it
-- splits on ';\n'). assr_cases lives in PUBLIC (not scm); its id + user columns
-- are BIGINT, so this table matches. Timestamp is the next free one over main at
-- write time; re-pick it at MERGE time if a later migration lands first.
SET search_path = public;

CREATE TABLE IF NOT EXISTS public.assr_supplier_returns (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assr_id         bigint      NOT NULL,
  round_no        integer     NOT NULL,
  pickup_at       text,        -- YYYY-MM-DD, sent to the factory/supplier
  returned_at     text,        -- YYYY-MM-DD, back from the factory/supplier
  qc_result       text,        -- 'pass' | 'fail' | 'na' — did the returned item pass on receipt
  creditor_code   text,        -- which supplier/factory took this trip (may differ per round)
  reason          text,        -- why the item was returned again (QC fail / re-broke / ...)
  note            text,
  created_by      bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

-- Rounds die with the case (mirrors assr_case_access). Guarded so a re-run is a no-op.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assr_supplier_returns_assr_id_fkey') THEN ALTER TABLE public.assr_supplier_returns ADD CONSTRAINT assr_supplier_returns_assr_id_fkey FOREIGN KEY (assr_id) REFERENCES public.assr_cases(id) ON DELETE CASCADE; END IF; END $$;

-- The per-case round list ("show every factory trip for this case, in order").
CREATE INDEX IF NOT EXISTS idx_assr_supplier_returns_case ON public.assr_supplier_returns (assr_id, round_no);

COMMENT ON TABLE public.assr_supplier_returns IS
  'Factory/supplier trips for a service case: one row per trip (round_no 1..N), added freely. Source of truth for the trip dates; assr_cases.supplier_pickup_at / items_ready_at mirror the current (highest round_no) row via services/assr.ts, for the Delivery board + HC sheet. Written via POST/PATCH/DELETE /api/assr/:id/supplier-returns (service_cases.write). See docs/modules/service-case.md.';

-- Backfill round 1 from the existing columns so a case already at the factory
-- shows that trip as row 1. Idempotent: skips a case that already has a trip.
INSERT INTO public.assr_supplier_returns (assr_id, round_no, pickup_at, returned_at, creditor_code)
SELECT c.id, 1, c.supplier_pickup_at, c.items_ready_at, c.creditor_code
  FROM public.assr_cases c
 WHERE (c.supplier_pickup_at IS NOT NULL OR c.items_ready_at IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM public.assr_supplier_returns sr WHERE sr.assr_id = c.id);
