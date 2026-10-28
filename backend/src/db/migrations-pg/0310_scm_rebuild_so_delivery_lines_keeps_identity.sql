-- 0310 — The delivery-fee rebuild REUSES its lines instead of deleting them,
-- so a Delivery Order raised against a fee line keeps its `so_item_id`.
--
-- WHY. `rebuild_mfg_so_delivery_lines` (0214, re-created by 0305 for the sen
-- rename) re-derives the delivery fee by DELETing every SVC-DELIVERY* line on
-- the SO and INSERTing a fresh set. The new rows get new ids. But a Delivery
-- Order CAN carry a delivery-fee line — routes/delivery-orders-mfg.ts records a
-- real one, Nico's DO for 2990-SO-2606-034, which was blocked on
-- SVC-DISPOSE-SOFA and SVC-DELIVERY-CROSS being "short" at BALAKONG — and
-- delivery_order_items.so_item_id is ON DELETE SET NULL (0235). So every
-- rebuild silently blanks the link of any DO line that shipped a fee, and the
-- SO still shows a delivery line afterwards: a DIFFERENT row wearing the same
-- item_code.
--
-- That last part is why this path was not suspected. 0302's header sets the FK
-- theory aside because "the SO lines are all still THERE, carrying their
-- original created_at". Delete-and-reinsert produces exactly that appearance
-- for anyone checking whether a line exists — but NOT for anyone checking its
-- created_at, and 0302's own example (2990-SO-2607-012, seven lines all reading
-- the second the order was created) is evidence that at least that order was
-- never rebuilt. So this migration does NOT claim to explain the 26 orphans of
-- 2026-08-17. It closes a mechanism that is real, is reachable from the UI on
-- every fee change, and is verifiable independently:
--
--   -- the fingerprint: a fee line YOUNGER than the order's product lines
--   SELECT doc_no, item_code, created_at FROM scm.mfg_sales_order_items
--    WHERE doc_no = '<doc>' ORDER BY created_at;
--   -- and the direct proof, now that 0302 is recording:
--   SELECT * FROM scm.mfg_so_item_deletions
--    WHERE item_code LIKE 'SVC-DELIVERY%' ORDER BY deleted_at DESC;
--
-- If that second query has rows, this path deleted them and this migration
-- stops it. If it stays empty while the sentinel fires, this is not the
-- mechanism either — a null result there is a real answer, in 0302's words.
--
-- WHAT CHANGES. Same inputs, same outputs, same lock. The body becomes
-- match-update-insert-delete instead of delete-insert:
--   · incoming rows are numbered per item_code by their position in p_rows;
--   · live (non-cancelled) SVC-DELIVERY* lines are numbered per item_code by id;
--   · equal (item_code, seq) => UPDATE that row in place — the id, and every
--     DO link pointing at it, survive;
--   · an existing line with no counterpart => DELETE (unchanged behaviour, and
--     this is where a genuinely vanished component still drops its link);
--   · an incoming row with no counterpart => INSERT.
-- Cancelled lines never match, so they are deleted and re-inserted live,
-- exactly as before. An empty p_rows still clears every fee line.
--
-- The per-item_code sequence matters because item_code is NOT unique in the
-- spec set: buildDeliveryFeeServiceLines emits SVC-DELIVERY-CROSS twice on a
-- follow-up order that also crosses categories (the follow-up base and the
-- cross-category surcharge). Both orderings are stable within the transaction —
-- p_rows position for incoming, id for existing — and the DELETE only ever
-- removes the tail, so the numbering the INSERT sees is the numbering the
-- UPDATE used.
--
-- WHY NOT ON CONFLICT. There is no unique constraint on (doc_no, item_code) to
-- conflict against, and adding one would forbid the legitimate duplicate above.
--
-- THE LOCK IS UNCHANGED, deliberately. 0214 documents two live double-billings
-- (SO-2606-043 2026-06-28, SO-2607-010 2026-07-12) from concurrent rebuilds
-- interleaving as delete/delete/insert/insert under READ COMMITTED. The
-- advisory xact lock is what serialises them, and it is taken first here, on
-- the same key, before any read. Reusing rows does not weaken it: the second
-- transaction still waits, and still reads the rows the first one committed.
--
-- Reversal: re-run the CREATE OR REPLACE from 0305 (the delete-insert body).
--           No schema change — this replaces a function body only, so the
--           reversal is complete and carries no data migration.

SET search_path TO scm, public;

CREATE OR REPLACE FUNCTION scm.rebuild_mfg_so_delivery_lines(p_doc_no text, p_source_doc_no text, p_delivery_fee_sen bigint, p_rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_company_id bigint;
BEGIN
  -- Serialize concurrent rebuilds of the SAME SO. hashtextextended gives a
  -- bigint key; the xact lock releases automatically at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtextextended('scm-so-delivery:' || p_doc_no, 0));

  SELECT company_id INTO v_company_id
    FROM scm.mfg_sales_orders
   WHERE doc_no = p_doc_no;
  -- Unknown SO: rebuild nothing rather than orphan lines onto a missing header.
  IF v_company_id IS NULL THEN
    RETURN;
  END IF;

  -- 1. REUSE. Every incoming row that has a live counterpart of the same
  --    item_code updates it in place, so the row id — and any DO line pointing
  --    at it — survives the rebuild.
  WITH incoming AS (
    SELECT p.*, row_number() OVER (PARTITION BY p.item_code ORDER BY e.ord) AS seq
      FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS e(val, ord)
      CROSS JOIN LATERAL jsonb_populate_record(NULL::scm.mfg_sales_order_items, e.val) AS p
  ), live AS (
    SELECT x.id, x.item_code,
           row_number() OVER (PARTITION BY x.item_code ORDER BY x.id) AS seq
      FROM scm.mfg_sales_order_items x
     WHERE x.doc_no = p_doc_no
       AND x.item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
       AND COALESCE(x.cancelled, false) = false
  )
  UPDATE scm.mfg_sales_order_items t
     SET line_no                       = i.line_no,
         line_date                     = i.line_date,
         debtor_name                   = i.debtor_name,
         item_group                    = i.item_group,
         description                   = i.description,
         description2                  = i.description2,
         remark                        = i.remark,
         uom                           = i.uom,
         qty                           = i.qty,
         unit_price_sen                = i.unit_price_sen,
         discount_sen                  = i.discount_sen,
         total_sen                     = i.total_sen,
         total_inc_sen                 = i.total_inc_sen,
         balance_sen                   = i.balance_sen,
         variants                      = i.variants,
         unit_cost_sen                 = i.unit_cost_sen,
         line_cost_sen                 = i.line_cost_sen,
         line_margin_sen               = i.line_margin_sen,
         divan_price_sen               = i.divan_price_sen,
         leg_price_sen                 = i.leg_price_sen,
         special_order_price_sen       = i.special_order_price_sen,
         custom_specials               = i.custom_specials,
         line_delivery_date            = i.line_delivery_date,
         line_delivery_date_overridden = i.line_delivery_date_overridden,
         warehouse_id                  = i.warehouse_id,
         branding                      = i.branding,
         venue                         = i.venue,
         stock_status                  = i.stock_status
    FROM live l
    JOIN incoming i ON i.item_code = l.item_code AND i.seq = l.seq
   WHERE t.id = l.id;

  -- 2. RETIRE. A fee component that no longer exists — and every cancelled
  --    SVC-DELIVERY* line, which never matches — goes, exactly as before. This
  --    is the one remaining path that can blank a DO link, and it should: the
  --    line it pointed at is genuinely gone.
  WITH incoming AS (
    SELECT p.item_code, row_number() OVER (PARTITION BY p.item_code ORDER BY e.ord) AS seq
      FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS e(val, ord)
      CROSS JOIN LATERAL jsonb_populate_record(NULL::scm.mfg_sales_order_items, e.val) AS p
  ), live AS (
    SELECT x.id, x.item_code,
           row_number() OVER (PARTITION BY x.item_code ORDER BY x.id) AS seq
      FROM scm.mfg_sales_order_items x
     WHERE x.doc_no = p_doc_no
       AND x.item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
       AND COALESCE(x.cancelled, false) = false
  ), keep AS (
    SELECT l.id FROM live l JOIN incoming i ON i.item_code = l.item_code AND i.seq = l.seq
  )
  DELETE FROM scm.mfg_sales_order_items t
   WHERE t.doc_no = p_doc_no
     AND t.item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
     AND NOT EXISTS (SELECT 1 FROM keep k WHERE k.id = t.id);

  -- 3. ADD. Only the components with no line to reuse. `live` is re-read after
  --    step 2, which removed only unmatched rows from the tail of each
  --    item_code group, so the surviving sequence numbers are the ones step 1
  --    matched on.
  WITH incoming AS (
    SELECT p.*, row_number() OVER (PARTITION BY p.item_code ORDER BY e.ord) AS seq
      FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS e(val, ord)
      CROSS JOIN LATERAL jsonb_populate_record(NULL::scm.mfg_sales_order_items, e.val) AS p
  ), live AS (
    SELECT x.id, x.item_code,
           row_number() OVER (PARTITION BY x.item_code ORDER BY x.id) AS seq
      FROM scm.mfg_sales_order_items x
     WHERE x.doc_no = p_doc_no
       AND x.item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
       AND COALESCE(x.cancelled, false) = false
  )
  INSERT INTO scm.mfg_sales_order_items (
    company_id, doc_no, line_no, line_date, debtor_name, item_group, item_code,
    description, description2, remark, uom, qty,
    unit_price_sen, discount_sen, total_sen, total_inc_sen, balance_sen,
    variants, unit_cost_sen, line_cost_sen, line_margin_sen,
    divan_price_sen, leg_price_sen, special_order_price_sen, custom_specials,
    line_delivery_date, line_delivery_date_overridden, warehouse_id,
    branding, venue, stock_status
  )
  SELECT v_company_id, i.doc_no, i.line_no, i.line_date, i.debtor_name, i.item_group, i.item_code,
         i.description, i.description2, i.remark, i.uom, i.qty,
         i.unit_price_sen, i.discount_sen, i.total_sen, i.total_inc_sen, i.balance_sen,
         i.variants, i.unit_cost_sen, i.line_cost_sen, i.line_margin_sen,
         i.divan_price_sen, i.leg_price_sen, i.special_order_price_sen, i.custom_specials,
         i.line_delivery_date, i.line_delivery_date_overridden, i.warehouse_id,
         i.branding, i.venue, i.stock_status
    FROM incoming i
   WHERE NOT EXISTS (
     SELECT 1 FROM live l WHERE l.item_code = i.item_code AND l.seq = i.seq
   );

  UPDATE scm.mfg_sales_orders
     SET cross_category_source_doc_no = p_source_doc_no,
         delivery_fee_sen             = p_delivery_fee_sen,
         updated_at                   = now()
   WHERE doc_no = p_doc_no;
END;
$function$;

COMMENT ON FUNCTION scm.rebuild_mfg_so_delivery_lines(text, text, bigint, jsonb) IS
  'Re-derives the SVC-DELIVERY* lines of one SO from p_rows. Reuses existing '
  'live lines in place (0310) so delivery_order_items.so_item_id survives a '
  'fee change; deletes only components that no longer exist. Serialised per '
  'doc_no by an advisory xact lock (0214).';
