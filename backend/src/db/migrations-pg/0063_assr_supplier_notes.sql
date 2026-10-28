-- Two free-text notes that travel with the service item between
-- Houzs and the supplier.
--   goods_returned_note   — the send-out slip WE write and hand off
--                           with the item when the supplier picks it
--                           up for repair.
--   supplier_service_note — the service record the supplier writes
--                           and hands back with the item on return.
-- Both are editable from their respective UI surfaces (main case
-- page + supplier portal) so ops and the supplier can each keep
-- their side of the paperwork current.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS goods_returned_note TEXT;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS supplier_service_note TEXT;
