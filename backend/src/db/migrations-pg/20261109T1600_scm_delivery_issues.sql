-- "Delivered with issue" (owner-approved, sister review item A2): the crew ticks
-- what went wrong at proof of delivery (damaged, missing part, wrong item or
-- colour, customer refused part, other + note), adds photos, and a Service Case
-- opens. The delivery is NOT blocked: the DO / job stays delivered; this row is
-- what tells the office "delivered, with this issue" on the DO, the SO and Last
-- Mile, and links the Service Case (public.assr_cases) that was opened for it.
--
-- One row per report. A Delivery Order report carries delivery_order_id (+ its
-- do_number / so_doc_no); a non-DO job (scm.job_progress identity) carries
-- source_type / source_id / leg. kinds and photo_keys are JSON arrays.
--
-- One new empty table and its indexes; nothing existing is rewritten.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.delivery_issues;
--   Revert the code first (routes/delivery-issues.ts, lib/delivery-issue.ts read
--   and write it). GRANTS: none to re-apply; the table rides the scm schema's
--   default privileges (service_role), like scm.job_progress.

CREATE TABLE IF NOT EXISTS scm.delivery_issues (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         BIGINT,
  delivery_order_id  UUID,
  do_number          TEXT,
  so_doc_no          TEXT,
  source_type        TEXT CHECK (source_type IS NULL OR source_type IN ('dp', 'project', 'assr')),
  source_id          TEXT,
  leg                TEXT,
  kinds              JSONB NOT NULL DEFAULT '[]'::jsonb,
  note               TEXT,
  photo_keys         JSONB NOT NULL DEFAULT '[]'::jsonb,
  assr_case_id       BIGINT,
  assr_no            TEXT,
  reported_by        BIGINT,
  reported_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_issues_has_target CHECK (
    delivery_order_id IS NOT NULL
    OR (source_type IS NOT NULL AND source_id IS NOT NULL AND leg IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_delivery_issues_do ON scm.delivery_issues (delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_issues_do_number ON scm.delivery_issues (do_number);
CREATE INDEX IF NOT EXISTS idx_delivery_issues_so ON scm.delivery_issues (so_doc_no);
CREATE INDEX IF NOT EXISTS idx_delivery_issues_job ON scm.delivery_issues (source_type, source_id, leg);
