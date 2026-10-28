-- REVERSAL:
--   DROP VIEW scm.acc_acquirers;
--   CREATE TABLE scm.acc_acquirers (...as migration 0298...);
--   INSERT INTO scm.acc_acquirers SELECT ... FROM scm.acc_company_acquirers l
--     JOIN scm.acc_acquirer_config g ON g.code = l.acquirer_code;
--   DROP TABLE scm.acc_company_acquirers; DROP TABLE scm.acc_acquirer_config;
-- The 0298 table is REPLACED BY A VIEW OF THE SAME NAME AND SHAPE, so every
-- existing reader (acc/payments.ts transit lookup, GET /acquirers, the Daily
-- Bank board) keeps working unchanged and the reversal restores the table.
-- No row is lost: the seed below copies 0298's rows out before the drop.
--
-- acc_acquirer_unify — phase 2B layer 3, step 1: the acquirer master follows
-- the owner's standing principle (2026-08-16, stated three times: chart,
-- reconciliation, reports are DEFINED ONCE and every company shares them).
--
--   scm.acc_acquirer_config    — GLOBAL. One row per acquirer. How its
--                                statement is read, whether it carries a
--                                unique transaction reference, how the fee is
--                                presented, how many days of settlement drift
--                                to tolerate. Taught ONCE (决定4).
--   scm.acc_company_acquirers  — PER COMPANY. Only the enablement link: does
--                                this company use this acquirer, into which
--                                bank account does its net land, which transit
--                                and fee accounts carry it.
--
-- Adding a future company is then "tick its acquirers" — never re-teaching a
-- statement format. 0298's config columns are all still NULL (决定4 not yet
-- delivered), so this restructure moves no configured data and is free.
-- NOTE: number re-checked against the tree at merge time.

-- 1. The global config. `code` is what the module reasons with; `display_name`
--    is the exact string the sales payment panel stores in merchant_provider —
--    one row for screen and ledger both (brief §2.13).
CREATE TABLE scm.acc_acquirer_config (
  code                TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL UNIQUE,
  -- 决定4, asked once per acquirer:
  statement_format    TEXT,               -- CSV | XLSX | PDF   (NULL = not taught yet)
  has_unique_ref      BOOLEAN,            -- NULL/FALSE = amount+date only, never auto-confirms
  fee_method          TEXT,               -- stated | gross-minus-net | prorated-summary
  -- The date tolerance lives HERE, in the config, precisely because 系统3 wrote
  -- 3 days in its design document and 7 days in its code.
  date_tolerance_days INTEGER NOT NULL DEFAULT 3,
  -- Which statement column is which. Config, not code: "各家收单行的差异做成
  -- 设定档，不要写死在代码里". Keys: date, ref, gross, fee, net.
  column_map          JSONB,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_acquirer_config_format CHECK (
    statement_format IS NULL OR statement_format IN ('CSV', 'XLSX', 'PDF')
  ),
  CONSTRAINT acc_acquirer_config_fee_method CHECK (
    fee_method IS NULL OR fee_method IN ('stated', 'gross-minus-net', 'prorated-summary')
  ),
  CONSTRAINT acc_acquirer_config_tolerance CHECK (date_tolerance_days BETWEEN 0 AND 30)
);

INSERT INTO scm.acc_acquirer_config (code, display_name, date_tolerance_days, is_active)
SELECT DISTINCT ON (code) code, display_name, date_tolerance_days, is_active
FROM scm.acc_acquirers
ORDER BY code, company_id;

-- 2. The per-company enablement link. ⚠️ Naming pit the brief calls out: the
--    "HLB card machine (acquirer)" and the "Hong Leong bank account" are two
--    different things — they meet HERE, as two named columns, and nowhere else.
CREATE TABLE scm.acc_company_acquirers (
  company_id           INTEGER NOT NULL,
  acquirer_code        TEXT    NOT NULL REFERENCES scm.acc_acquirer_config (code),
  transit_account_code TEXT    NOT NULL DEFAULT '320-0000',  -- settlement-in-transit
  fee_account_code     TEXT    NOT NULL DEFAULT '930-0000',  -- merchant charges
  bank_account_code    TEXT,                                 -- where the NET lands
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, acquirer_code)
);

INSERT INTO scm.acc_company_acquirers
  (company_id, acquirer_code, transit_account_code, fee_account_code, bank_account_code, is_active)
SELECT company_id, code, transit_account_code, fee_account_code, bank_account_code, is_active
FROM scm.acc_acquirers;

-- 3. The old table becomes a view of the same name and shape. Readers written
--    against 0298 (payments.ts, /acquirers, the Daily Bank board) do not change
--    a character; what changed is where the truth is maintained.
DROP TABLE scm.acc_acquirers;

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
  (g.is_active AND l.is_active) AS is_active
FROM scm.acc_company_acquirers l
JOIN scm.acc_acquirer_config g ON g.code = l.acquirer_code;

/* A NEW VIEW INHERITS NOTHING. The dropped table's privileges went with it, so
   without this every reader — acc/payments.ts's transit lookup, /acquirers, the
   Daily Bank board — gets "permission denied for view acc_acquirers", which is
   the failure 0189 shipped and 0190/0191 had to repair. The grants are copied
   from the table this view replaces where they can still be read, and the
   service role is granted unconditionally. Idempotent: GRANT is additive. */
GRANT SELECT ON scm.acc_acquirers TO service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = 'scm'
      AND table_name = 'acc_settlement_batches'   -- a sibling of this module
      AND privilege_type = 'SELECT'
      AND grantee NOT IN ('PUBLIC', 'service_role')
  LOOP
    EXECUTE format('GRANT SELECT ON scm.acc_acquirers TO %I', r.grantee);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;  -- the sibling arrives in 0302; service_role above is enough on its own
END $$;
