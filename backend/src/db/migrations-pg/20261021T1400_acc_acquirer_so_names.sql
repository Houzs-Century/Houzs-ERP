-- 20261021T1400_acc_acquirer_so_names.sql
-- REVERSAL:
--   CREATE OR REPLACE cannot take a column back off a view, so the view is
--   dropped and rebuilt exactly as 0334 left it, with 0334's grants re-applied:
--     DROP VIEW scm.acc_acquirers;
--     CREATE VIEW scm.acc_acquirers AS (the 0334 definition — without g.so_names);
--     GRANT SELECT ON scm.acc_acquirers TO service_role;  plus 0334's copy loop.
--   then:
--     ALTER TABLE scm.acc_acquirer_config DROP COLUMN so_names;
--   GRANTS: this migration REPLACES the view in place (CREATE OR REPLACE keeps
--   its ACL) and re-applies 0334's grants anyway — idempotent either way.
--
-- WHAT THIS CHANGES, and why it is safe against production:
--   1. scm.acc_acquirer_config gains so_names TEXT[] NOT NULL DEFAULT '{}' — the
--      OTHER names the sales team keys a merchant as on a Sales Order or invoice
--      payment. Owner 2026-10-21: 「Pinelabs=AEON，Public=PBB」. AEON's report
--      comes off the Pine Labs terminal and the till's dropdown calls Public
--      Bank "Public", so a payment keyed that way was "somebody else's stream"
--      to Merchant Recon: 48 of the 77 AEON lines and 74 of the 110 PBB lines
--      since September carried their sale's own approval code and amount and
--      still never matched.
--   2. AEON gets {Pinelabs}, PBB gets {Public} — only while still empty, so a
--      re-run or a later edit on the Setup screen is never overwritten.
--   3. scm.acc_acquirers gains so_names as its LAST column. Every existing
--      column keeps its name, type and position (CREATE OR REPLACE refuses
--      anything else), so every reader of the view is unchanged.
--   No other row or column is touched; nothing posts.

ALTER TABLE scm.acc_acquirer_config
  ADD COLUMN IF NOT EXISTS so_names TEXT[] NOT NULL DEFAULT '{}';

UPDATE scm.acc_acquirer_config SET so_names = ARRAY['Pinelabs'], updated_at = now()
 WHERE code = 'AEON' AND so_names = '{}';
UPDATE scm.acc_acquirer_config SET so_names = ARRAY['Public'], updated_at = now()
 WHERE code = 'PBB' AND so_names = '{}';

CREATE OR REPLACE VIEW scm.acc_acquirers AS
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
  (g.is_active AND l.is_active) AS is_active,
  g.so_names
FROM scm.acc_company_acquirers l
JOIN scm.acc_acquirer_config g ON g.code = l.acquirer_code;

/* CREATE OR REPLACE keeps the view's ACL; re-granted anyway, the same grants
   0334 applies, because a reader that loses this view books every card
   payment to the generic EDC transit account in silence (acc/payments.ts). */
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
