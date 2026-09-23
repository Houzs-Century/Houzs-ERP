-- Delivery Planning: the customer-message follow-up workflow status shown and
-- edited in the "Delivery Status" column (owner 2026-09-22) — one of 23 values
-- (To Send Delivery Date / Pending Customer Reply (D) / … / Done Remind) or NULL.
-- Kept as free TEXT (the allowed set is validated in the route) so the value set
-- can change without a new enum. The coarse scm.delivery_state that drives the
-- top state tabs is a SEPARATE, derived field and is unaffected. Deliberately NOT
-- added to any shared SO-list view (view-trap) — the planning board reads the
-- base table mfg_sales_orders directly.
-- Nullable, no default: an order carries a workflow value only once dispatch (or
-- the send flow) puts it into the conversation. The separate SEND status (its own
-- column, derived from scm.wa_message_log) is the one that reads "Done All".
-- Plus two free-text admin fields in the same board group (owner 2026-09-22):
-- disposal_request (what to do with the old item) and dp_remark (a general
-- delivery-planning remark, distinct from the delivery-sheet's remark2/3/4).
-- REVERSAL: ALTER TABLE scm.mfg_sales_orders DROP COLUMN IF EXISTS delivery_message_status, DROP COLUMN IF EXISTS disposal_request, DROP COLUMN IF EXISTS dp_remark;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS delivery_message_status text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS disposal_request text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS dp_remark text;
