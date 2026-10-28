-- 20260908T0300_announcement_doc_type.sql
-- REVERSAL: ALTER TABLE public.announcements DROP COLUMN IF EXISTS doc_type; DELETE FROM public.document_types WHERE code = 'MEMO' AND NOT EXISTS (SELECT 1 FROM public.document_refs WHERE type_code = 'MEMO');
-- Verified against: staging (minnapsemfzjmtvnnvdd) through the normal
--           migrate-before-deploy path on merge; prod (anogrigyjbduyzclzjgn)
--           carries the same announcements + document_types shape
--           (0058 … 20260907T1030, 20260906T1417).
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One additive column, announcements.doc_type text NOT NULL DEFAULT 'ANN' —
--   every row that exists today is an announcement, which is what the DEFAULT
--   says — and one seed row in document_types (MEMO / Memo, attachment not
--   required, active), ON CONFLICT DO NOTHING. Nothing that shipped before
--   reads the column.
--
-- WHY (owner, 2026-09-08, "每个部门自动生成 memo reference number"):
--   A department's memo is the same document as a notice — written in the
--   composer, approved, numbered, attached, voided — but it carries the MEMO
--   type in its reference number: OPS-MEMO-2609-0001, its own sequence per
--   department and month beside OPS-ANN-2609-0001. doc_type is the [TYPE]
--   segment the approval mints with (services/announcementApproval.ts) and
--   the key the attachment policy is read by (services/announcementFiles.ts).
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS doc_type text NOT NULL DEFAULT 'ANN';

INSERT INTO public.document_types (code, label, attachment_required, is_active, created_at)
VALUES ('MEMO', 'Memo', 0, 1, now()::text)
ON CONFLICT (code) DO NOTHING;
