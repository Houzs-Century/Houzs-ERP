-- 20261024T1400_scm_threepl_bill_lines.sql
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.threepl_bill_lines;
--   DROP TABLE IF EXISTS scm.threepl_bill_reads;
--   ALTER TABLE scm.threepl_do_charges DROP COLUMN IF EXISTS billed_by_hand;
--   Revert the code first (scm/lib/threepl-bill-import.ts writes all three;
--   the 3PL invoices tab and the */30 cron read them). Dropping them loses
--   every bill line read and how a person assigned it; the per-DO charges stay.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new
-- empty tables and one NOT NULL column with a constant default on a table of
-- 0 rows (scm.threepl_do_charges, 2026-10-24); no existing row is altered.
--
-- WHY (owner 2026-10-24, 「做，好了叫我」 on: 手动还是要保留 / 对不上的 … 我想要
-- assign 看这个是去哪里，可能是service, 可能是setup dismantle，可能不算): every line of
-- a transport bill read off its AP invoice is KEPT, not only the ones matched to
-- a delivery order. A line is assigned to a DO, to a service case, to a fair
-- (setup / dismantle) or to nothing (storage, handling, dispose) — by the
-- reader where it can tell, by a person otherwise — so a bill's parts add up to
-- the AP invoice. The bills are read by a cron every 30 minutes; the read log
-- says which files a reading saw, so a file added later (BRIGHTSUN's goods
-- list) is read again. billed_by_hand keeps a DO amount a person corrected
-- when the lines are summed again.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.threepl_bill_lines (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          bigint      NOT NULL REFERENCES public.companies(id),
  ap_invoice_id       uuid        NOT NULL REFERENCES scm.ap_invoices(id) ON DELETE CASCADE,
  threepl_company_id  uuid        NULL REFERENCES scm.threepl_companies(id) ON DELETE SET NULL,
  line_no             int         NOT NULL,
  text                text        NOT NULL DEFAULT '',
  line_date           date        NULL,
  kind                text        NOT NULL DEFAULT 'other',
  amount_sen          bigint      NULL,
  printed             text[]      NOT NULL DEFAULT '{}',
  read_status         text        NOT NULL,
  assign              text        NULL CHECK (assign IN ('do', 'service', 'event', 'none')),
  do_ids              uuid[]      NOT NULL DEFAULT '{}',
  service_ref         text        NULL,
  project_id          bigint      NULL,
  assigned_by         text        NULL,
  assigned_at         timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT threepl_bill_lines_uq UNIQUE (ap_invoice_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_threepl_bill_lines_company
  ON scm.threepl_bill_lines (company_id, ap_invoice_id);

CREATE TABLE IF NOT EXISTS scm.threepl_bill_reads (
  ap_invoice_id       uuid        NOT NULL PRIMARY KEY REFERENCES scm.ap_invoices(id) ON DELETE CASCADE,
  company_id          bigint      NOT NULL REFERENCES public.companies(id),
  threepl_company_id  uuid        NULL REFERENCES scm.threepl_companies(id) ON DELETE SET NULL,
  read_by             text        NOT NULL,
  files_count         int         NOT NULL DEFAULT 0,
  files_latest        timestamptz NULL,
  attempts            int         NOT NULL DEFAULT 0,
  error               text        NULL,
  read_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_threepl_bill_reads_company
  ON scm.threepl_bill_reads (company_id, read_at DESC);

ALTER TABLE scm.threepl_do_charges
  ADD COLUMN IF NOT EXISTS billed_by_hand boolean NOT NULL DEFAULT false;

-- Same as 20261014T1610: RLS on, no policies; the Worker's service_role bypasses RLS.
ALTER TABLE scm.threepl_bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE scm.threepl_bill_reads ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.threepl_bill_lines TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.threepl_bill_reads TO service_role;

NOTIFY pgrst, 'reload schema';
