-- 20260906T1417_departments_code_document_refs.sql
-- REVERSAL: DROP TABLE IF EXISTS public.document_refs;
--           DROP TABLE IF EXISTS public.document_types;
--           DROP INDEX IF EXISTS public.idx_departments_code_upper;
--           ALTER TABLE public.departments DROP COLUMN IF EXISTS code;
-- Verified against: staging (minnapsemfzjmtvnnvdd) through the normal
--           migrate-before-deploy path on merge; prod (anogrigyjbduyzclzjgn)
--           carries the same 0000 departments shape (id, name, description,
--           color, sort_order, lead_user_id, headcount_target).
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   · one nullable column on public.departments (code) + a unique index on
--     its upper-cased value where set — no backfill, every department starts
--     without a code and an admin assigns one;
--   · two NEW tables, document_types (seeded with one row) and document_refs
--     (empty). Nothing that shipped before this migration reads any of it.
--
-- WHY (owner, 2026-09-06, "标准化编号与文档管理", plan A):
--   A company-wide reference number for NEW document families —
--   [DEPT]-[TYPE]-[YYMM]-[NNNN], e.g. OPS-ANN-2609-0001 — minted per
--   (department, type, month) with the SAME counter the SCM document numbers
--   already use (scm.next_doc_no_n / scm.doc_number_counters, mig 0316): one
--   row lock per series, so two simultaneous saves cannot share a number, the
--   month is part of the series so the running number restarts at 0001 each
--   month, and a voided document keeps its number (the counter only ever
--   rises). SCM documents keep their existing HC-SO-2609-001 numbers — those
--   are in AutoCount and on paper and cannot change (owner decision 2026-09-06).
--   document_refs is the registry: which record holds which number, who minted
--   it, and whether it was voided (with the reason). document_types is the
--   per-type policy table the later "attachment required" rule reads.
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS code text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_code_upper
  ON public.departments (upper(code)) WHERE code IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.document_types (
  code                text PRIMARY KEY,
  label               text NOT NULL,
  attachment_required integer NOT NULL DEFAULT 0,
  is_active           integer NOT NULL DEFAULT 1,
  created_at          text NOT NULL,
  updated_at          text
);
--> statement-breakpoint
INSERT INTO public.document_types (code, label, attachment_required, is_active, created_at)
VALUES ('ANN', 'Announcement', 0, 1, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.document_refs (
  ref_no       text PRIMARY KEY,
  series       text NOT NULL,
  dept_code    text NOT NULL,
  type_code    text NOT NULL,
  yymm         text NOT NULL,
  seq          integer NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE',
  created_by   integer,
  created_at   text NOT NULL,
  voided_by    integer,
  voided_at    text,
  void_reason  text,
  UNIQUE (entity_type, entity_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_document_refs_series ON public.document_refs (series, seq);
