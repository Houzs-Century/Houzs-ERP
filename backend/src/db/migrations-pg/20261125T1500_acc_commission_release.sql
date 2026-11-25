-- 20261125T1500_acc_commission_release.sql
--
-- WHY. Owner 2026-11-25: the commission bills (the salespeople's pay, billed by
-- the company that pays them) sit on PREPAYMENT COMMISSION, and each month the
-- part whose orders became sales moves to the commission expense — 「系统自动转」,
-- for the actual P&L, on net sales (sales invoices plus deposit invoices less the
-- credit notes that contra them). The release posts one entry per month
-- (source COMMREL, acc/commission-release.ts) from the nightly cron.
--
--   • scm.acc_company_settings.commission_release_on — the company's switch.
--     Off by default: nothing is booked until Finance turns it on, after the
--     owner has seen what the first run will post.
--   • scm.acc_commission_release_runs — every run, the quiet "no change" ones
--     included (the stock close's trail, acc_stock_close_runs, is the model).
--
-- Additive, idempotent, schema-qualified, no data. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_commission_release_runs;
--   ALTER TABLE scm.acc_company_settings DROP COLUMN IF EXISTS commission_release_on;
--   Revert the code first (acc/commission-release.ts reads both). The release's
--   journal entries (source COMMREL) stay in the books; they come out only by
--   reversing them. GRANTS: none to re-apply.

ALTER TABLE scm.acc_company_settings
  ADD COLUMN IF NOT EXISTS commission_release_on boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS scm.acc_commission_release_runs (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   bigint      NOT NULL,
  month        date        NOT NULL CHECK (extract(day FROM month) = 1),
  ran_at       timestamptz NOT NULL DEFAULT now(),
  trigger      text        NOT NULL CHECK (trigger IN ('cron', 'manual')),
  released_sen bigint      NOT NULL DEFAULT 0,
  action       text        NOT NULL CHECK (action IN ('posted', 'reposted', 'cleared', 'unchanged', 'failed')),
  je_no        text,
  note         text,
  parts        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parts) = 'object')
);

CREATE INDEX IF NOT EXISTS acc_commission_release_runs_company_ran
  ON scm.acc_commission_release_runs (company_id, ran_at DESC);

-- Only the Worker reads or writes it, like the newest acc tables: row level
-- security on with no policy (the Worker's roles bypass it), the service role
-- granted by name.
ALTER TABLE scm.acc_commission_release_runs ENABLE ROW LEVEL SECURITY;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON scm.acc_commission_release_runs TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.acc_commission_release_runs IS
  'Monthly commission release (source COMMREL): one row per month per run - posted, re-posted, cleared, unchanged or failed - with the release per bill month (parts).';
COMMENT ON COLUMN scm.acc_company_settings.commission_release_on IS
  'The monthly commission release books for this company (acc/commission-release.ts). Off = shown on the page, nothing posted.';

NOTIFY pgrst, 'reload schema';
