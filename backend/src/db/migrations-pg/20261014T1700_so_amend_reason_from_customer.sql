-- Delivery Planning: the CUSTOMER's reason for asking to move the delivery
-- ("Renovation Delay" / "Date Unavailable", the buttons the WhatsApp amend
-- flow offers) gets its own column, paired with amend_date_from_customer.
--
-- Until now /api/chat-callback wrote it into amend_reason — but amend_reason is
-- OUR reason (the board's "Amend Reason" preset list: "Our strict quality
-- control checks", "Unforeseen production constraints", …), the one the
-- Postpone notice prints after "due to". One column, two owners: a customer
-- tap silently replaced the reason staff had chosen (owner, 2026-10-14).
--
-- Deliberately NOT added to any shared SO-list view (view-trap): the planning
-- board reads the base table mfg_sales_orders directly.
-- REVERSAL: ALTER TABLE scm.mfg_sales_orders DROP COLUMN IF EXISTS amend_reason_from_customer;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS amend_reason_from_customer text;

-- The two values only a customer tap ever wrote: move them to where they
-- belong, so no staff reason is overwritten and no customer reason is lost.
UPDATE scm.mfg_sales_orders
   SET amend_reason_from_customer = amend_reason,
       amend_reason = NULL
 WHERE amend_reason IN ('Renovation Delay', 'Date Unavailable')
   AND amend_reason_from_customer IS NULL;
