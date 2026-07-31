-- 0231_po_received_qty_backfill.sql
-- (Renumbered from 0230 on 2026-07-31: #1435 and #1439 were cut from main at
--  the same time and both claimed 0230, so main went red on the
--  migrationNumbers ratchet the moment the second one merged. Neither had
--  reached prod — the applied ledger stops at 0229_venue_canonicalize — so this
--  file just takes the next free number. Nothing about the SQL changed.)
-- Owner 2026-07-31: re-run the PO receipt recount over history, because for a
-- bounded window it never ran at all and 11 fully-received POs are still sitting
-- in the buyer's outstanding list.
--
-- WHAT WENT WRONG
--   postGrnAndRollup (grns.ts:349) flips a GRN to POSTED *first*, then calls
--   recomputePoReceived — and that recount is deliberately best-effort: its whole
--   body is wrapped in a try/catch that only console.errors (grns.ts:782). So any
--   failure between "POSTED" and "recounted" leaves a GRN whose goods are in
--   inventory and whose parent PO knows nothing about it, with no error surfaced
--   anywhere.
--
--   That is exactly what happened to 2990-GRN-2607-011 .. -021 (2026-07-14 04:24Z
--   through 2026-07-22 02:21Z). Eleven consecutive GRNs, none of which moved its
--   PO: every affected purchase_orders.updated_at is still the PO's own creation
--   timestamp. GRN -010 and earlier recounted normally (updated_at == the GRN's
--   created_at, to the second), and -022 onward recount normally again. The GRN
--   rows themselves are structurally identical to the healthy ones (PO header,
--   warehouse, MYR @ 1.0, QTY allocation, every line carrying
--   purchase_order_item_id) and company_id is consistently 2 throughout, so the
--   receipts are sound — only the roll-up is missing.
--
--   The exact throwing statement is NOT established. The window straddles the
--   multi-company cutover and prod logs for it are long gone; grns.ts did not
--   change during the window in which the behaviour healed, so the trigger was a
--   precondition that stopped occurring rather than a fix anyone shipped. Left
--   deliberately unasserted here rather than guessed at.
--
-- WHAT THIS DOES
--   Recomputes from the ledger instead of hardcoding the 11 known rows, so it is
--   convergent: a no-op on every PO that is already correct, and still correct if
--   more rows drifted between writing this and applying it.
--
--     received_qty := SUM(GREATEST(0, qty_accepted - returned_qty)) over live
--                     (non-CANCELLED, non-DRAFT) GRN lines
--
--   matching recomputePoReceived's own rule (grns.ts:735-756): DRAFT GRNs have
--   committed no receipt, and returned goods net back out so the line re-opens
--   for a replacement shipment.
--
-- TWO DELIBERATE DEPARTURES FROM THE APP'S RECOUNT
--   1. Status is re-evaluated only for POs already in SUBMITTED /
--      PARTIALLY_RECEIVED / RECEIVED. The app guards with `.neq(status,
--      'CANCELLED')` alone, which would also drag a DRAFT PO to SUBMITTED. No
--      DRAFT PO can hold a GRN today (the create path rejects a non-receivable
--      PO), but a backfill has no business relying on that.
--   2. received_at is stamped with the LAST GRN's receipt date, not now(). The
--      app uses now() because for it "now" IS when the goods landed; here the
--      goods landed days ago and now() would be a lie in a date column people
--      report on. Already-set values are preserved either way.

-- 1. Recount received_qty from live GRN lines. The LEFT JOIN carries both
--    directions: a line under-counted against its receipts, and a line holding a
--    stale count whose receipts have all gone away (-> 0).
WITH live AS (
  SELECT gi.purchase_order_item_id AS poi_id,
         SUM(GREATEST(0, COALESCE(gi.qty_accepted, 0) - COALESCE(gi.returned_qty, 0))) AS recv
  FROM scm.grn_items gi
  JOIN scm.grns g ON g.id = gi.grn_id
  WHERE gi.purchase_order_item_id IS NOT NULL
    AND g.status NOT IN ('CANCELLED', 'DRAFT')
  GROUP BY gi.purchase_order_item_id
)
UPDATE scm.purchase_order_items poi
SET received_qty = COALESCE(l.recv, 0)
FROM scm.purchase_order_items src
LEFT JOIN live l ON l.poi_id = src.id
WHERE poi.id = src.id
  AND poi.received_qty IS DISTINCT FROM COALESCE(l.recv, 0);

-- 2. Re-evaluate each PO's status + received_at from the now-correct lines.
--    Mirrors recomputePoReceived (grns.ts:766-780): fully received -> RECEIVED,
--    anything received -> PARTIALLY_RECEIVED, else back to SUBMITTED.
WITH rolled AS (
  SELECT po.id,
         po.received_at AS prev_received_at,
         bool_and(COALESCE(poi.received_qty, 0) >= poi.qty) AS fully,
         bool_or(COALESCE(poi.received_qty, 0) > 0) AS any_received,
         (SELECT MAX(g.received_at)
            FROM scm.grn_items gi
            JOIN scm.grns g ON g.id = gi.grn_id
            JOIN scm.purchase_order_items x ON x.id = gi.purchase_order_item_id
           WHERE x.purchase_order_id = po.id
             AND g.status NOT IN ('CANCELLED', 'DRAFT')) AS last_receipt_date
  FROM scm.purchase_orders po
  JOIN scm.purchase_order_items poi ON poi.purchase_order_id = po.id
  WHERE po.status IN ('SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED')
  GROUP BY po.id, po.received_at
)
UPDATE scm.purchase_orders po
SET status = next_status,
    received_at = next_received_at,
    updated_at = NOW()
FROM (
  SELECT id,
         (CASE WHEN fully THEN 'RECEIVED'
               WHEN any_received THEN 'PARTIALLY_RECEIVED'
               ELSE 'SUBMITTED' END)::scm.po_status AS next_status,
         CASE WHEN fully
              THEN COALESCE(prev_received_at, last_receipt_date::timestamptz, NOW())
              ELSE NULL END AS next_received_at
  FROM rolled
) AS want
WHERE po.id = want.id
  AND (po.status IS DISTINCT FROM want.next_status
       OR po.received_at IS DISTINCT FROM want.next_received_at);
