-- 20261125T1700_acc_opening_bill_goods.sql
--
-- WHY. Owner 2026-11-25 (「如果系统可以分得出purchase of sofa 和purchase of
-- bedding 更加好」, then 「可以做回最好」): a payment of an opening bill (an
-- AutoCount purchase invoice brought over at go-live, scm.ap_invoices.opening)
-- reads in the Cash Flow by what that bill bought — sofa, bed frames,
-- mattresses… — the way a payment of an ERP purchase invoice already reads by
-- its own product groups. The bill's own line is the opening clearing, which
-- says nothing of what was bought, so this keeps it: one row per bill and
-- product group, the value of those lines in MYR sen before tax, read from
-- AutoCount's own lines by backend/scripts/set-opening-bill-goods.mjs.
--
-- group_code is the product group as scm.acc_item_group_accounts names it
-- ('' = lines with no product group). Only the proportions are used: the
-- report splits each payment of the bill in them, a group with a purchase
-- account on that account, the rest as the bill would read without this.
-- Cash Flow only: nothing posts, no journal moves.
--
-- Additive, idempotent, schema-qualified, no data. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_opening_bill_goods;
--   Revert the code first. Dropping the table loses what was read from
--   AutoCount (the script reads it again) and nothing in the books.
--   GRANTS: none to re-apply.

CREATE TABLE IF NOT EXISTS scm.acc_opening_bill_goods (
  company_id    bigint      NOT NULL,
  ap_invoice_id uuid        NOT NULL REFERENCES scm.ap_invoices(id) ON DELETE CASCADE,
  group_code    text        NOT NULL,
  myr_sen       bigint      NOT NULL,
  ac_doc_no     text        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  PRIMARY KEY (company_id, ap_invoice_id, group_code)
);

-- Only the Worker and the script read or write it: row level security on with
-- no policy (their roles bypass it), the service role granted by name.
ALTER TABLE scm.acc_opening_bill_goods ENABLE ROW LEVEL SECURITY;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.acc_opening_bill_goods TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.acc_opening_bill_goods IS
  'Cash Flow only: what an opening bill bought, by product group (MYR sen before tax, from AutoCount''s own lines); a payment of the bill reads in these proportions. Nothing posts.';
