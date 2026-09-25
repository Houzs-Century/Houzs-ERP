-- 20260924T2300_assr_supplier_return_ref_no.sql
-- REVERSAL: DROP INDEX IF EXISTS public.uq_assr_supplier_returns_ref_no;
--           ALTER TABLE public.assr_supplier_returns DROP COLUMN IF EXISTS ref_no;
--           (the SVC-RTN rows in public.document_refs and the counter rows in
--           scm.doc_number_counters are deliberately left: a number that was
--           handed out stays burnt, same rule as every other series.)
--
-- WHY (owner 2026-09-24, "service case - return supplier 可以 generate own
-- reference document number? … B，前缀 SVC-RTN，旧的也补号"). Each factory trip
-- (assr_supplier_returns, mig 20260921T2300) was identified only by its round
-- number inside the case, so three trips of one case printed the same ASSR
-- number and the supplier could not tell the paperwork apart. Every trip now
-- carries its own document number SVC-RTN-YYMM-NNNN, minted by the company-wide
-- registry (services/documentRefs.ts, mig 20260906T1417) on the SAME counter
-- the SCM numbers use (scm.next_doc_no_n, mig 0316): unique under concurrency,
-- restarts at 0001 each month (Malaysia time), never re-issued; removing a trip
-- VOIDs its number in the registry instead of freeing it.
--
-- BACKFILL. Every live trip without a number gets one, in created_at order, in
-- the month (MYT) it was created. Archived trips (recorded by mistake) get none.
-- Prod's created_at is TEXT ('YYYY-MM-DD HH:MM:SS', UTC — written by
-- datetime('now')), not the timestamptz the 20260921T2300 file declares; all
-- 137 rows on 2026-09-24 matched that shape. The cast below reads it as UTC
-- either way. Idempotent: a trip that already has a registry row reuses that number, and
-- the loop only visits rows whose ref_no is still NULL.
SET search_path = public;

ALTER TABLE public.assr_supplier_returns ADD COLUMN IF NOT EXISTS ref_no text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_assr_supplier_returns_ref_no
  ON public.assr_supplier_returns (ref_no) WHERE ref_no IS NOT NULL;

INSERT INTO public.document_types (code, label, attachment_required, is_active, created_at)
VALUES ('RTN', 'Supplier Return', 0, 1, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (code) DO NOTHING;

DO $$
DECLARE
  r        record;
  v_yymm   text;
  v_series text;
  v_floor  integer;
  v_n      integer;
  v_ref    text;
  v_ts     timestamptz;
BEGIN
  FOR r IN
    SELECT sr.id, sr.created_by, sr.created_at
      FROM public.assr_supplier_returns sr
     WHERE sr.ref_no IS NULL AND sr.archived_at IS NULL
     ORDER BY sr.created_at, sr.id
  LOOP
    SELECT dr.ref_no INTO v_ref
      FROM public.document_refs dr
     WHERE dr.entity_type = 'assr_supplier_return' AND dr.entity_id = r.id::text;
    IF v_ref IS NULL THEN
      v_ts     := (r.created_at::text)::timestamp AT TIME ZONE 'UTC';
      v_yymm   := to_char(v_ts AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM');
      v_series := 'SVC-RTN-' || v_yymm;
      SELECT COALESCE(MAX(seq), 0) INTO v_floor FROM public.document_refs WHERE series = v_series;
      v_n   := scm.next_doc_no_n(v_series, v_floor);
      v_ref := v_series || '-' || lpad(v_n::text, 4, '0');
      INSERT INTO public.document_refs
        (ref_no, series, dept_code, type_code, yymm, seq, entity_type, entity_id, status, created_by, created_at)
      VALUES
        (v_ref, v_series, 'SVC', 'RTN', v_yymm, v_n, 'assr_supplier_return', r.id::text, 'ACTIVE',
         r.created_by::integer, to_char(v_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    END IF;
    UPDATE public.assr_supplier_returns SET ref_no = v_ref WHERE id = r.id;
  END LOOP;
END $$;

COMMENT ON COLUMN public.assr_supplier_returns.ref_no IS
  'The trip''s own document number, SVC-RTN-YYMM-NNNN (MYT month), minted via services/documentRefs.ts on scm.next_doc_no_n; registry row in document_refs (entity_type assr_supplier_return). Voided there, never re-issued, when the trip is removed.';
