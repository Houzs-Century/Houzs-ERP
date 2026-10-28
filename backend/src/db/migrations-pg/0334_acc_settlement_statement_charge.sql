-- REVERSAL:
--   ALTER TABLE scm.acc_settlement_batches
--     DROP COLUMN stated_net_sen, DROP COLUMN adjustment_sen,
--     DROP COLUMN adjustment_je_no, DROP COLUMN adjustment_je_id,
--     DROP COLUMN adjustment_posted_at;
--   DROP VIEW scm.acc_acquirers;
--   CREATE VIEW scm.acc_acquirers AS (the 0301 definition, without
--     g.total_net_label and g.summary_totals);
--   ⚠️ GRANTS: DROP VIEW discards the view's ACL, so the reverse MUST re-apply
--      them — `GRANT SELECT ON scm.acc_acquirers TO service_role;` plus any
--      other grantee 0301's copy loop picked up (that is the 0189 failure, and
--      0190/0191 were the repair). This migration re-grants below for the same
--      reason.
--   ALTER TABLE scm.acc_acquirer_config DROP COLUMN total_net_label,
--     DROP COLUMN summary_totals, DROP COLUMN dates_have_no_year;
--   DELETE FROM scm.acc_company_acquirers WHERE acquirer_code = 'AEON';
--   DELETE FROM scm.acc_acquirer_config WHERE code = 'AEON';
-- No existing row is modified; every new column is nullable or defaulted.
--
-- acc_settlement_statement_charge — the charge that belongs to no transaction.
--
-- AEON's instalment statement, read on 2026-08-17: one sale of RM 6,000.00 less
-- MDR of RM 72.00 nets RM 5,928.00 on its transaction line, and then the
-- statement charges a SUBVENTION FEE of RM 254.16 against nothing in particular
-- and pays RM 5,673.84. Booking only the lines leaves the bank overstated by
-- 254.16 for ever — and makes an instalment sale look like it cost 1.2% when it
-- really cost 5.4%.
--
-- The posting is deliberately against the BANK, not against settlement-in-
-- transit: the transaction lines clear in-transit correctly by their gross, and
-- what the statement charge represents is money that never arrived.
--
--     Dr Merchant charges   254.16
--         Cr Bank           254.16
--
-- NOTE: number re-checked against the tree at merge time.

-- 1. Where a statement states what it is really paying. Set per acquirer, once,
--    like every other reading rule (AEON: 'TOTAL NET PAYMENT (RM) :').
ALTER TABLE scm.acc_acquirer_config ADD COLUMN total_net_label TEXT;

-- 1b. And for a statement whose FEE is not on its transaction lines at all.
--     Maybank's detail table carries only the gross; the MDR appears once, on a
--     TOTAL row under a summary table with its OWN headings. Naming the row and
--     the two headings lets the fee be READ from the file instead of keyed in —
--     one number fewer to get wrong, on the largest acquirer of the lot.
--     {"rowLabel":"TOTAL","fee":"Disc. Amt","net":"Net Amount"}
ALTER TABLE scm.acc_acquirer_config ADD COLUMN summary_totals JSONB;

-- 1c. Whether this acquirer dates its lines with a year at all. Hong Leong does
--     not — it writes "16-Aug" and nothing in the file says which year — so its
--     upload has to ask. Config, so the screen asks ONLY where the answer is
--     needed instead of putting a field nobody understands in front of everyone.
ALTER TABLE scm.acc_acquirer_config ADD COLUMN dates_have_no_year BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE scm.acc_acquirer_config SET dates_have_no_year = TRUE WHERE code = 'HLB';

-- 2. What the file said, what the lines came to, and whether the difference has
--    reached the ledger yet.
ALTER TABLE scm.acc_settlement_batches
  -- The statement's own "this is what I am paying you" figure. NULL when the
  -- acquirer has no such row configured, which is most of them.
  ADD COLUMN stated_net_sen      BIGINT,
  -- lines' net MINUS stated net. Positive = the statement kept more than its
  -- transactions explain (a charge). Negative = it paid more (a rebate).
  ADD COLUMN adjustment_sen      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN adjustment_je_no    TEXT,
  ADD COLUMN adjustment_je_id    TEXT,
  ADD COLUMN adjustment_posted_at TIMESTAMPTZ;

-- The view is rebuilt so /acquirers and the setup screen carry the new column.
DROP VIEW scm.acc_acquirers;
CREATE VIEW scm.acc_acquirers AS
SELECT
  l.company_id,
  g.code,
  g.display_name,
  l.transit_account_code,
  l.fee_account_code,
  l.bank_account_code,
  g.statement_format,
  g.has_unique_ref,
  g.fee_method,
  g.date_tolerance_days,
  g.column_map,
  g.total_net_label,
  g.summary_totals,
  g.dates_have_no_year,
  (g.is_active AND l.is_active) AS is_active
FROM scm.acc_company_acquirers l
JOIN scm.acc_acquirer_config g ON g.code = l.acquirer_code;

/* The recreated view starts with an EMPTY ACL — dropping a view discards its
   privileges, and the reader that then fails is acc/payments.ts's transit
   lookup, silently booking every card payment to the generic EDC account. Same
   grants as 0301, re-applied. Idempotent. */
GRANT SELECT ON scm.acc_acquirers TO service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = 'scm'
      AND table_name = 'acc_settlement_batches'
      AND privilege_type = 'SELECT'
      AND grantee NOT IN ('PUBLIC', 'service_role')
  LOOP
    EXECUTE format('GRANT SELECT ON scm.acc_acquirers TO %I', r.grantee);
  END LOOP;
END $$;

-- AEON joins the master. Its money lands in Maybank; the per-company link's
-- bank_account_code is filled in by the owner from the setup screen.
INSERT INTO scm.acc_acquirer_config (code, display_name, date_tolerance_days, is_active)
VALUES ('AEON', 'AEON', 7, TRUE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO scm.acc_company_acquirers (company_id, acquirer_code)
SELECT c.company_id, 'AEON' FROM (VALUES (1), (2)) AS c(company_id)
ON CONFLICT (company_id, acquirer_code) DO NOTHING;


