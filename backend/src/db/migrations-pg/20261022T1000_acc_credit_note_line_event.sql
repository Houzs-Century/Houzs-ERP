-- A credit / debit note line names the event its money is for, as a voucher
-- or AP invoice line does (20260930T0400_acc_event_per_line). Owner
-- 2026-10-22: 「这个rental如果是有cn, 显示的是扣了cn的？」 — a supplier credit
-- note on an event's rental posted with no event tag, so the event page never
-- took it off. Posted, the line's leg carries the tag
-- (journal_entry_lines.project_id) and the event's books net it.
--
-- One nullable column, nothing back-filled: no existing note changes.
-- REVERSAL: ALTER TABLE scm.acc_credit_note_lines DROP COLUMN IF EXISTS project_id;
ALTER TABLE scm.acc_credit_note_lines ADD COLUMN IF NOT EXISTS project_id bigint;
