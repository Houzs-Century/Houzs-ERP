-- Per-attachment ACTION TIMELINE (owner 2026-07-29): each uploaded defect-list
-- file gets an append-only log of Ongoing / Done entries with an optional
-- remark — clicked by the Purchaser (Sim) or BD, never overwritten. A file
-- whose LATEST entry is 'done' is resolved; a project whose live defect
-- attachments are all resolved drops out of the purchaser's My Pending.
-- Generic table (any checklist attachment), gated to defect items in the UI.
CREATE TABLE IF NOT EXISTS project_checklist_attachment_actions (
  id bigserial PRIMARY KEY,
  attachment_id bigint NOT NULL,
  status text NOT NULL,          -- 'ongoing' | 'done'
  remark text,                   -- optional, may be empty
  user_id bigint,
  created_at text DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_pcaa_attachment ON project_checklist_attachment_actions(attachment_id);
