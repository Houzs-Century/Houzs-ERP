-- 20261117T1900_acc_settlement_sold_by_company.sql
--
-- WHY. Owner 2026-11-17: 2990's AEON instalment sales are swiped on Houzs's
-- AEON terminal (2990's own AEON is switched off), so they arrive on HOUZS's
-- AEON reports with no Houzs sale behind them, and Houzs pays 2990 the money
-- back by payment voucher — 「houzs 那边的报表要确定这些和refund给2990 contra
-- 掉」, then 「可以开始做先」.
--
-- Two things:
--   1. scm.acc_settlement_rows.sold_by_company_id — a report line confirmed as
--      ANOTHER company's sale. Its SETTLEFOR journal (acc/settlement-sold-by.ts)
--      books the line to the account this company keeps for that company: the
--      gross into card clearing and onto that account, the acquirer's fee and
--      the line's share of the statement charge back out of it. The account
--      then holds what the acquirer pays for the line, the voucher paying the
--      other company back clears it, and the report is confirmed so its payout
--      matches on the bank.
--   2. scm.acc_company_links — that account, per pair of companies. One row is
--      written: Houzs Century -> 2990's Home on 350-0070 LOAN TO RELATED PARTY -
--      2990 HOME SDN BHD (owner's choice, 2026-11-17), and only where both
--      companies and the account exist.
--
-- MULTI-COMPANY. company_id on every row; the routes read and write the active
-- company's rows only.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT
-- MERGE.
--
-- REVERSAL: take every such line back first (Merchant Recon, Undo), so each
-- SETTLEFOR journal is reversed and no line is left marked; then:
--   ALTER TABLE scm.acc_settlement_rows DROP COLUMN IF EXISTS sold_by_company_id;
--   DROP TABLE IF EXISTS scm.acc_company_links;

ALTER TABLE scm.acc_settlement_rows
  ADD COLUMN IF NOT EXISTS sold_by_company_id BIGINT NULL REFERENCES public.companies(id);

CREATE TABLE IF NOT EXISTS scm.acc_company_links (
  company_id        BIGINT NOT NULL REFERENCES public.companies(id),
  other_company_id  BIGINT NOT NULL REFERENCES public.companies(id),
  account_code      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_company_links_pkey PRIMARY KEY (company_id, other_company_id),
  CONSTRAINT acc_company_link_not_self CHECK (company_id <> other_company_id)
);

ALTER TABLE scm.acc_company_links ENABLE ROW LEVEL SECURITY;

INSERT INTO scm.acc_company_links (company_id, other_company_id, account_code)
SELECT h.id, t.id, '350-0070'
  FROM public.companies h
  JOIN public.companies t ON t.code = '2990'
 WHERE h.code = 'HOUZS'
   AND EXISTS (SELECT 1 FROM scm.accounts a WHERE a.company_id = h.id AND a.account_code = '350-0070')
ON CONFLICT (company_id, other_company_id) DO NOTHING;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Read and written by the Worker through PostgREST as the service role, like the
-- rest of the acc tables.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.acc_company_links TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.acc_company_links IS
  'The account a company books another company''s money to — a card sale of theirs swiped on this company''s terminal '
  '(acc_settlement_rows.sold_by_company_id, SETTLEFOR journals). See acc/settlement-sold-by.ts.';
COMMENT ON COLUMN scm.acc_settlement_rows.sold_by_company_id IS
  'Set when the line was confirmed as this other company''s sale (SETTLEFOR-<row id>); null otherwise.';

-- Let PostgREST see the new table and column without a manual reload.
NOTIFY pgrst, 'reload schema';
