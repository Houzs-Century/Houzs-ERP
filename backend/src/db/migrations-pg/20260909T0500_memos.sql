-- 20260909T0500_memos.sql
-- REVERSAL: DROP TRIGGER IF EXISTS trg_memos_no_hard_delete ON public.memos; DROP FUNCTION IF EXISTS public.memos_no_hard_delete(); DROP TABLE IF EXISTS public.memos;
-- Verified against: staging (minnapsemfzjmtvnnvdd) through the normal
--           migrate-before-deploy path on merge; prod (anogrigyjbduyzclzjgn)
--           carries departments (code, mig 20260906T1417), document_types
--           (MEMO seeded by 20260908T0300) and document_refs.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One new table and its no-delete trigger. Nothing existing changes; nothing
--   that shipped before reads it.
--
-- WHY (owner, 2026-09-08, "每个部门自动生成 memo reference number" — the
-- register half of "两个都要"):
--   A department writes a memo outside the ERP (Word / PDF) and needs the
--   official number for it. The register is that: one row per memo — title,
--   department, date, the file, who registered it — numbered AT CREATION
--   through the same mint the announcement approval uses
--   (services/documentRefs.ts, series <DEPT>-MEMO-<YYMM>), so a memo
--   registered here and a memo composed as a notice count on ONE sequence per
--   department and month. A memo is numbered, so it is never deleted: it is
--   voided with a reason (the number goes VOID in the registry and is never
--   re-issued); the trigger refuses a DELETE outright — there is no draft
--   state to discard.
CREATE TABLE IF NOT EXISTS public.memos (
  id text PRIMARY KEY,
  title text NOT NULL,
  department_id integer NOT NULL,
  dept_code text NOT NULL,
  memo_date text NOT NULL,
  notes text,
  file_key text,
  file_name text,
  file_mime text,
  file_size integer,
  ref_no text UNIQUE,
  created_by integer,
  created_at text NOT NULL,
  voided_by integer,
  voided_at text,
  void_reason text
);
CREATE INDEX IF NOT EXISTS idx_memos_department_created
  ON public.memos (department_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.memos_no_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'memos: % is a numbered document — void it with a reason, never delete it', OLD.ref_no
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_memos_no_hard_delete ON public.memos;
CREATE TRIGGER trg_memos_no_hard_delete
  BEFORE DELETE ON public.memos
  FOR EACH ROW EXECUTE FUNCTION public.memos_no_hard_delete();
