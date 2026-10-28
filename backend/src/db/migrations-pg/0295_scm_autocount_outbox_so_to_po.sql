-- ----------------------------------------------------------------------------
-- 0295 — scm.autocount_outbox admits `so_to_po`.
--
-- WHY. 0277 pinned the operation vocabulary with a CHECK, which is right: an
-- op the drain does not recognise would sit pending forever with nothing to say
-- about it. The ninth operation is the sales-order-to-purchase-order TRANSFER
-- (AutoCount's AddSOToPOTransferDetail), which the ERP sends only when every
-- purchase line maps 1:1 to a sales line the account book already has a key
-- for. A consolidated purchase — one line serving several customers plus stock,
-- the shape mig 0235 exists for — is still a plain `create_po`, because a
-- transfer would split it or drop the stock quantity.
--
-- WIDENS ONLY. No existing row changes, no value is removed, and a database
-- that has never seen the new op is indistinguishable from one that has.
--
-- REVERSAL: re-create the constraint without 'so_to_po' — but DELETE or
-- re-classify any row already carrying it first, or the ADD fails on its own
-- data:
--   ALTER TABLE scm.autocount_outbox DROP CONSTRAINT autocount_outbox_op_check;
--   ALTER TABLE scm.autocount_outbox ADD CONSTRAINT autocount_outbox_op_check
--     CHECK (op IN ('create_so','create_po','so_to_do','po_to_gr',
--                   'do_to_iv','gr_to_pi','cancel','edit'));
--
-- Verified against: scm.autocount_outbox on production, 6 rows, all
-- create_so (autocount-outbox-health.yml, run 31866360833) — so no existing row
-- can conflict with either direction of this change.
-- ----------------------------------------------------------------------------

ALTER TABLE scm.autocount_outbox DROP CONSTRAINT IF EXISTS autocount_outbox_op_check;

ALTER TABLE scm.autocount_outbox ADD CONSTRAINT autocount_outbox_op_check
  CHECK (op IN (
    'create_so', 'create_po', 'so_to_do', 'po_to_gr',
    'do_to_iv', 'gr_to_pi', 'cancel', 'edit',
    'so_to_po'));
