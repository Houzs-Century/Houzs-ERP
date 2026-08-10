-- Migration documents: paperwork carried over from AutoCount that must NEVER
-- move stock.
--
-- Owner 2026-08-10, approving the design: GR and DO both use this one pattern.
-- Two things are true at the same time and the schema has to say so:
--
--   1. AutoCount already received these goods, and already delivered part of
--      some orders. Staff need to SEE those documents in the ERP, or the two
--      systems do not agree and nobody can reconcile a customer's history.
--   2. The stock effect of both already happened. On-hand came in through the
--      AutoCount balance snapshot, which counts the receipts as IN and the
--      deliveries as already OUT. A GRN that posts an IN, or a DO that posts an
--      OUT, would apply the same movement a second time.
--
-- So these documents are created POSTED / DELIVERED, with the quantities and the
-- links intact, and with NO inventory movement behind them. This column is what
-- tells every future reconciliation, repair sweep and reposting job to leave
-- them alone. A document carrying it has no movements ON PURPOSE, and "fixing"
-- that is how you double the inventory.
ALTER TABLE scm.grns
  ADD COLUMN IF NOT EXISTS migrated_no_stock boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS linked_ac_docno text;

ALTER TABLE scm.delivery_orders
  ADD COLUMN IF NOT EXISTS migrated_no_stock boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS linked_ac_docno text;

COMMENT ON COLUMN scm.grns.migrated_no_stock IS
  'TRUE = paperwork carried over from AutoCount at the 2026-08 cutover. The goods are already on hand via the balance snapshot, so this GRN has NO inventory movement behind it, deliberately. Never post movements for it and never treat the absence as corruption - doing either double-counts the stock. See docs/autocount-cutover-ledger.md.';
COMMENT ON COLUMN scm.grns.linked_ac_docno IS
  'The AutoCount GR document this row mirrors. Reference only.';
COMMENT ON COLUMN scm.delivery_orders.migrated_no_stock IS
  'TRUE = paperwork carried over from AutoCount at the 2026-08 cutover, for the part of an order AutoCount had already delivered. The balance snapshot already counts those units as gone, so this DO has NO inventory movement behind it, deliberately. Never post movements for it. See docs/autocount-cutover-ledger.md.';
COMMENT ON COLUMN scm.delivery_orders.linked_ac_docno IS
  'The AutoCount DO document this row mirrors. Reference only.';

-- Finding them is a predicate, not a guess.
CREATE INDEX IF NOT EXISTS grns_migrated_no_stock_idx
  ON scm.grns (company_id) WHERE migrated_no_stock;
CREATE INDEX IF NOT EXISTS delivery_orders_migrated_no_stock_idx
  ON scm.delivery_orders (company_id) WHERE migrated_no_stock;
