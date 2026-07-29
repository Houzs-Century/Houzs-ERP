-- Schedule reference REMARK (owner 2026-07-23): solo events have no exhibitor
-- handbook to screenshot, so logistics types the mall's setup/dismantle times
-- as free text instead. Rendered in the same Schedule Reference box as the
-- phase='schedule' screenshot (desktop PMS only).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS schedule_remark text;
