-- REVERSAL: ALTER TABLE public.memos DROP COLUMN IF EXISTS doc_type;
--           DELETE FROM public.document_types WHERE code IN ('SOP', 'WARN', 'NTC')
--             AND code NOT IN (SELECT DISTINCT type_code FROM public.document_refs);
-- Verified against: the D1 mirror in backend/tests/memos.test.ts; staging and
--           production through the normal migrate-before-deploy path on merge
--           (public.memos shipped with 20260909T0500, public.document_types
--           with 20260906T1417 — both carry exactly the shape assumed here).
--
-- WHY (owner 2026-09-09, on seeing the memo register: "memo — 放在 Announcement
-- 里面; 每个 memo, SOP, warning, notice 都需要按部门编号"): the register is not
-- a memo-only desk — a department writes SOPs, warning letters and notices
-- outside the ERP too, and each family needs its own department number:
-- OPS-SOP-2609-0001, OPS-WARN-2609-0001, OPS-NTC-2609-0001. Codes are 2–4
-- letters (the shared [DEPT]-[TYPE]-[YYMM]-[NNNN] shape, mig 20260906T1417),
-- hence WARN and NTC.
--
-- WHAT: one column on public.memos — doc_type, NOT NULL DEFAULT 'MEMO', so
-- every row registered so far stays a memo — and three seed rows in the type
-- registry (attachment optional, active; Settings → Documents flips either).
-- Nothing that reads announcements changes.
ALTER TABLE public.memos ADD COLUMN IF NOT EXISTS doc_type text NOT NULL DEFAULT 'MEMO';
--> statement-breakpoint
INSERT INTO public.document_types (code, label, attachment_required, is_active, created_at)
VALUES
  ('SOP', 'Standard operating procedure', 0, 1, now()::text),
  ('WARN', 'Warning', 0, 1, now()::text),
  ('NTC', 'Notice', 0, 1, now()::text)
ON CONFLICT (code) DO NOTHING;
