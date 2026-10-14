-- 20261014T1400_project_sales_bills.sql
-- REVERSAL: DROP TABLE IF EXISTS public.project_sales_bills;
--   The bills are a copy of a chat message the project keeps; dropping the table
--   loses the per-bill, per-person record of a fair's sales reports and nothing
--   else — orders, sales entries and Total Sales are untouched. GRANTS: none touched.
--
-- WHY (owner 2026-10-14). Every evening a salesperson posts the booth's sales
-- report in the WhatsApp group, one bill per line: booklet number, amount, who
-- sold it. Until each bill is keyed into the Sales Order module days later,
-- that message is the ONLY record of what the fair sold and whose it is. Pasted
-- into the project's chat and saved here, it lets the project say which bills
-- are still not opened as orders (by booklet number, the SO's Ref No.) and how
-- much of that sits with each salesperson under Sales Attending.
--
-- HOW THIS TABLE IS USED. One row per (company, project, booklet number); the
-- same number pasted again updates the row (amount, name, date) rather than
-- counting twice. Nothing here is money owed — the amount is what the slip
-- said. routes/project-sales-bills.ts reads and writes it (Drizzle:
-- db/schema.pg.ts project_sales_bills); matching against orders happens at
-- read time, nothing is stored about the match.
--
-- Houzs conventions: additive, IF NOT EXISTS, re-runnable; the pg-migrate runner
-- owns ONE transaction, so NO inner BEGIN/COMMIT. projects lives in PUBLIC (not
-- scm); its id and user ids are BIGINT, so this table matches. Timestamp is the
-- next free one over main at write time; re-pick it at MERGE time if a later
-- migration lands first.
SET search_path = public;
CREATE TABLE IF NOT EXISTS public.project_sales_bills (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          bigint      NOT NULL,
  project_id          bigint      NOT NULL,
  ref_token           text        NOT NULL,   -- booklet number, normalised: upper, letters+digits (HC8993)
  ref_raw             text        NOT NULL,   -- as typed in the report
  amount_sen          bigint      NOT NULL,
  salesperson_name    text,                   -- as typed in the report
  report_date         text,                   -- YYYY-MM-DD from the report header, when it had one
  source_activity_id  bigint,                 -- project_activity row (chat message) it was saved from
  created_by          bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- One row per booklet number per event: a re-paste updates, never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_sales_bills_token ON public.project_sales_bills (company_id, project_id, ref_token);
CREATE INDEX IF NOT EXISTS idx_project_sales_bills_project ON public.project_sales_bills (project_id);
