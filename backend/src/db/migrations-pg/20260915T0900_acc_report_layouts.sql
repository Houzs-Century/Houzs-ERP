-- 20260915T0900_acc_report_layouts.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_report_layouts; — the table is new
--   and additive: nothing existing is altered, backfilled or referenced by a
--   foreign key, and dropping it returns every report to its default layout —
--   the chart's own tree, which is what every report draws until somebody
--   saves a layout. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE NEW TABLE. The deployed application keeps working unchanged whether or
-- not this has run — the routes that read it ship in the same PR and treat
-- "no row" as "draw the chart's own tree", which is the state of every report
-- the moment this applies.
--
-- WHY IT EXISTS (docs/bugs/0911). The P&L printed one flat list of accounts
-- per section. Owner, 2026-09-14: 我想要有 level，父子 account 分层 … 我要能自己调动
-- 排版，然后能自己加大 categories … 做公用然后选要不要，类似 chart of account. A
-- report's layout is a tree of categories arranged over the chart — nestable,
-- renamable, reorderable, accounts as its leaves — and it is presentation
-- only: the chart's SECTION still decides which block of the statement an
-- account's money belongs to.
--
-- WHAT A ROW IS. One per REPORT, for EVERY company at once (做公用): the tree
-- as JSON, with the ids of the companies that unticked a category kept on
-- that category (選要不要). There is no company_id column on purpose — two
-- companies share one chart definition per code (the chart page's union),
-- and the owner asked for one layout he narrows per company, not two layouts
-- to keep alike. The report key is constrained to the four Finance reports
-- the layout engine serves in turn: the P&L first, then the Balance Sheet,
-- the Performance P&L and Receipts & Payments.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.acc_report_layouts (
  -- The report the tree belongs to.
  report      TEXT PRIMARY KEY
              CHECK (report IN ('pnl', 'balance_sheet', 'performance', 'rp')),
  -- { version: 1, blocks: { <block>: [ {kind:'category', id, label, code?,
  --   hiddenFor?: [company ids], children: [...]} | {kind:'account', code} ] } }
  -- Validated by acc/report-layout.ts on every write and every read; a stored
  -- tree that no longer validates is ignored in favour of the default.
  tree        JSONB NOT NULL,

  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
