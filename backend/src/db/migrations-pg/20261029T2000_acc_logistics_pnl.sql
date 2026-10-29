-- 20261029T2000_acc_logistics_pnl.sql
-- REVERSAL: revert the code first (scm/routes/acc-logistics-pnl.ts, the Logistics
--   cost P&L view). Then:
--     DROP TABLE IF EXISTS scm.acc_logistics_trip_marks;
--     DROP TABLE IF EXISTS scm.acc_logistics_spreads;
--     DROP TABLE IF EXISTS scm.acc_logistics_area_rates;
--     ALTER TABLE scm.acc_logistics_settings DROP COLUMN IF EXISTS do_income_bp;
--   Finance's rates, spreads and ticks are lost; the defaults read again.
--   GRANTS: none to re-apply — like scm.acc_logistics_settings, the tables ride
--   the scm schema's default privileges (service_role); this file grants nothing.
-- Verified against: PENDING — run on PRODUCTION inside one transaction ROLLED BACK
--   before merge (backend/scripts/try-logistics-pnl.mjs); the run is named here.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new column
-- with a default on a small settings table, three new, empty tables. Nothing
-- existing is read, written or altered.
--
-- WHY (owner 2026-10-29, 做 — his own "Logistic Cost Report", built from the books
-- instead of typed: 「不要我填」). Three things in it are Finance's to keep:
--   • the share of the DOs' value counted as transport income (3% on his sheet);
--   • the rate per setup / dismantle trip by area (「我要自己能维护」 — RM 400 for
--     KL, RM 600 for other areas to start);
--   • how many months each upkeep or insurance bill is spread over
--     (「根据情况定的，这个我可以自己定」);
-- and which setup / dismantle trips were our own: the rule decides (an outsourced
-- bill on the fair says not), Finance may tick or untick any trip.

ALTER TABLE scm.acc_logistics_settings
  ADD COLUMN IF NOT EXISTS do_income_bp integer NOT NULL DEFAULT 300;
ALTER TABLE scm.acc_logistics_settings DROP CONSTRAINT IF EXISTS acc_logistics_settings_do_income_bp_check;
ALTER TABLE scm.acc_logistics_settings
  ADD CONSTRAINT acc_logistics_settings_do_income_bp_check CHECK (do_income_bp BETWEEN 0 AND 10000);

-- One row per area Finance priced; an area with no row is at its default. A row
-- with no rate says that area's trips are not priced.
CREATE TABLE IF NOT EXISTS scm.acc_logistics_area_rates (
  company_id  bigint NOT NULL REFERENCES public.companies (id),
  area        text   NOT NULL,
  rate_sen    bigint CHECK (rate_sen IS NULL OR rate_sen >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (company_id, area)
);

-- One row per ledger line Finance spread; a line with no row is spread by its
-- kind's default (upkeep its own month, insurance & road tax twelve).
CREATE TABLE IF NOT EXISTS scm.acc_logistics_spreads (
  company_id  bigint  NOT NULL REFERENCES public.companies (id),
  line_id     text    NOT NULL,
  months      integer NOT NULL CHECK (months BETWEEN 1 AND 36),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (company_id, line_id)
);

-- One row per setup / dismantle trip Finance ticked (ours) or unticked (not);
-- a trip with no row is decided by the rule.
CREATE TABLE IF NOT EXISTS scm.acc_logistics_trip_marks (
  company_id  bigint  NOT NULL REFERENCES public.companies (id),
  trip_key    text    NOT NULL,
  in_house    boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (company_id, trip_key)
);
