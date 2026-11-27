-- 20261127T1200_scm_stock_transfer_racks.sql
-- REVERSAL (only once no transfer line carries a rack):
--   DROP FUNCTION IF EXISTS scm.fn_stock_transfer_racks_undo(uuid, bigint, uuid);
--   DROP FUNCTION IF EXISTS scm.fn_stock_transfer_apply_racked(uuid, uuid, uuid, text, bigint, uuid, jsonb);
--   ALTER TABLE scm.stock_transfers DROP COLUMN IF EXISTS racks_applied_at, DROP COLUMN IF EXISTS racks_reversed_at;
--   ALTER TABLE scm.stock_transfer_lines DROP COLUMN IF EXISTS from_rack_id, DROP COLUMN IF EXISTS to_rack_id;
--
-- A stock transfer line may name a From rack and a To rack (owner 2026-11-27: both optional,
-- no auto-pick, and the stock move plus both rack moves happen in ONE database transaction).
--
-- fn_stock_transfer_apply is NOT changed: a transfer with no rack on any line still goes
-- through it exactly as before. fn_stock_transfer_apply_racked calls it and then, in the same
-- transaction, takes each line's qty off its From rack (refusing the whole call when the rack
-- holds less) and places it on its To rack, writing the rack history. Any failure rolls back
-- the stock movements too. fn_stock_transfer_racks_undo is the cancel side: once per transfer
-- (racks_reversed_at), only when the racks were applied (racks_applied_at), all or nothing.
-- Schema + functions only; no existing row is touched.

ALTER TABLE scm.stock_transfer_lines
  ADD COLUMN IF NOT EXISTS from_rack_id uuid
    CONSTRAINT stock_transfer_lines_from_rack_id_fkey REFERENCES scm.warehouse_racks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS to_rack_id uuid
    CONSTRAINT stock_transfer_lines_to_rack_id_fkey REFERENCES scm.warehouse_racks(id) ON DELETE SET NULL;

ALTER TABLE scm.stock_transfers
  ADD COLUMN IF NOT EXISTS racks_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS racks_reversed_at timestamptz;

COMMENT ON COLUMN scm.stock_transfer_lines.from_rack_id IS 'Rack the line''s goods were taken off at the From warehouse (optional, 20261127T1200).';
COMMENT ON COLUMN scm.stock_transfer_lines.to_rack_id IS 'Rack the line''s goods were placed on at the To warehouse (optional, 20261127T1200).';
COMMENT ON COLUMN scm.stock_transfers.racks_applied_at IS 'Set when fn_stock_transfer_apply_racked moved the lines'' racks; NULL = racks never touched.';
COMMENT ON COLUMN scm.stock_transfers.racks_reversed_at IS 'Set once by fn_stock_transfer_racks_undo; a second undo is a no-op.';

CREATE OR REPLACE FUNCTION scm.fn_stock_transfer_refresh_rack_status(p_rack_ids uuid[])
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
  UPDATE scm.warehouse_racks r
     SET status = CASE
                    WHEN r.reserved THEN 'RESERVED'
                    WHEN EXISTS (SELECT 1 FROM scm.warehouse_rack_items i WHERE i.rack_id = r.id) THEN 'OCCUPIED'
                    ELSE 'EMPTY'
                  END
   WHERE r.id = ANY (p_rack_ids);
$function$;

CREATE OR REPLACE FUNCTION scm.fn_stock_transfer_apply_racked(
  p_from_warehouse_id uuid, p_to_warehouse_id uuid, p_source_doc_id uuid, p_source_doc_no text,
  p_company_id bigint, p_performed_by uuid, p_lines jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_moved     integer;
  v_line      jsonb;
  v_qty       integer;
  v_code      text;
  v_variant   text;
  v_from_rack uuid;
  v_to_rack   uuid;
  v_label     text;
  v_rack_co   bigint;
  v_left      integer;
  v_held      integer;
  v_take      integer;
  v_item      record;
  v_touched   uuid[] := '{}';
BEGIN
  v_moved := scm.fn_stock_transfer_apply(
    p_from_warehouse_id, p_to_warehouse_id, p_source_doc_id, p_source_doc_no,
    p_company_id, p_performed_by, p_lines);

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb))
  LOOP
    v_qty := FLOOR(COALESCE((v_line->>'qty')::numeric, 0))::integer;
    CONTINUE WHEN v_qty <= 0;
    v_code      := v_line->>'item_code';
    v_variant   := COALESCE(v_line->>'variant_key', '');
    v_from_rack := NULLIF(v_line->>'from_rack_id', '')::uuid;
    v_to_rack   := NULLIF(v_line->>'to_rack_id', '')::uuid;

    IF v_from_rack IS NOT NULL THEN
      SELECT rack, company_id INTO v_label, v_rack_co FROM scm.warehouse_racks
       WHERE id = v_from_rack AND warehouse_id = p_from_warehouse_id
         AND (p_company_id IS NULL OR company_id = p_company_id);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'rack_not_in_warehouse: the From rack of % is not a rack of the From warehouse', v_code;
      END IF;

      SELECT COALESCE(SUM(qty), 0) INTO v_held FROM scm.warehouse_rack_items
       WHERE rack_id = v_from_rack AND item_code = v_code;
      IF v_held < v_qty THEN
        RAISE EXCEPTION 'rack_short: % holds only % of %, the transfer moves %', v_label, v_held, v_code, v_qty;
      END IF;

      v_left := v_qty;
      FOR v_item IN
        SELECT id, qty FROM scm.warehouse_rack_items
         WHERE rack_id = v_from_rack AND item_code = v_code
         ORDER BY (variant_key = v_variant) DESC, stocked_in_date ASC, created_at ASC, id ASC
         FOR UPDATE
      LOOP
        EXIT WHEN v_left <= 0;
        v_take := LEAST(v_item.qty, v_left);
        IF v_take >= v_item.qty THEN
          DELETE FROM scm.warehouse_rack_items WHERE id = v_item.id;
        ELSE
          UPDATE scm.warehouse_rack_items SET qty = qty - v_take WHERE id = v_item.id;
        END IF;
        v_left := v_left - v_take;
      END LOOP;
      IF v_left > 0 THEN
        RAISE EXCEPTION 'rack_short: % holds less of % than the transfer moves', v_label, v_code;
      END IF;

      INSERT INTO scm.warehouse_rack_movements (
        company_id, movement_type, rack_id, rack_label, warehouse_id, item_code, variant_key,
        product_name, source_doc_no, quantity, reason, performed_by
      ) VALUES (
        v_rack_co, 'STOCK_OUT', v_from_rack, v_label, p_from_warehouse_id, v_code, v_variant,
        v_line->>'product_name', p_source_doc_no, v_qty, 'Stock transfer ' || p_source_doc_no, p_performed_by
      );
      v_touched := v_touched || v_from_rack;
    END IF;

    IF v_to_rack IS NOT NULL THEN
      SELECT rack, company_id INTO v_label, v_rack_co FROM scm.warehouse_racks
       WHERE id = v_to_rack AND warehouse_id = p_to_warehouse_id
         AND (p_company_id IS NULL OR company_id = p_company_id);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'rack_not_in_warehouse: the To rack of % is not a rack of the To warehouse', v_code;
      END IF;

      INSERT INTO scm.warehouse_rack_items (
        company_id, rack_id, item_code, variant_key, product_name, source_doc_no, qty, stocked_in_date
      ) VALUES (
        v_rack_co, v_to_rack, v_code, v_variant, v_line->>'product_name', p_source_doc_no, v_qty,
        (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      );

      INSERT INTO scm.warehouse_rack_movements (
        company_id, movement_type, rack_id, rack_label, warehouse_id, item_code, variant_key,
        product_name, source_doc_no, quantity, reason, performed_by
      ) VALUES (
        v_rack_co, 'STOCK_IN', v_to_rack, v_label, p_to_warehouse_id, v_code, v_variant,
        v_line->>'product_name', p_source_doc_no, v_qty, 'Stock transfer ' || p_source_doc_no, p_performed_by
      );
      v_touched := v_touched || v_to_rack;
    END IF;
  END LOOP;

  IF array_length(v_touched, 1) > 0 THEN
    PERFORM scm.fn_stock_transfer_refresh_rack_status(v_touched);
    UPDATE scm.stock_transfers SET racks_applied_at = now() WHERE id = p_source_doc_id;
  END IF;

  RETURN v_moved;
END;
$function$;

CREATE OR REPLACE FUNCTION scm.fn_stock_transfer_racks_undo(
  p_transfer_id uuid, p_company_id bigint, p_performed_by uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_head    record;
  v_line    record;
  v_item    record;
  v_label   text;
  v_left    integer;
  v_take    integer;
  v_removed integer;
  v_touched uuid[] := '{}';
  v_undone  integer := 0;
BEGIN
  UPDATE scm.stock_transfers
     SET racks_reversed_at = now()
   WHERE id = p_transfer_id
     AND racks_applied_at IS NOT NULL
     AND racks_reversed_at IS NULL
     AND (p_company_id IS NULL OR company_id = p_company_id)
  RETURNING id, transfer_no, from_warehouse_id, to_warehouse_id, company_id INTO v_head;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  FOR v_line IN
    SELECT item_code, COALESCE(variant_key, '') AS variant_key, product_name, qty, from_rack_id, to_rack_id
      FROM scm.stock_transfer_lines
     WHERE stock_transfer_id = p_transfer_id
       AND qty > 0
       AND (from_rack_id IS NOT NULL OR to_rack_id IS NOT NULL)
  LOOP
    IF v_line.to_rack_id IS NOT NULL THEN
      SELECT rack INTO v_label FROM scm.warehouse_racks WHERE id = v_line.to_rack_id;
      v_left := v_line.qty;
      FOR v_item IN
        SELECT id, qty FROM scm.warehouse_rack_items
         WHERE rack_id = v_line.to_rack_id AND item_code = v_line.item_code
           AND source_doc_no = v_head.transfer_no
         ORDER BY created_at ASC, id ASC
         FOR UPDATE
      LOOP
        EXIT WHEN v_left <= 0;
        v_take := LEAST(v_item.qty, v_left);
        IF v_take >= v_item.qty THEN
          DELETE FROM scm.warehouse_rack_items WHERE id = v_item.id;
        ELSE
          UPDATE scm.warehouse_rack_items SET qty = qty - v_take WHERE id = v_item.id;
        END IF;
        v_left := v_left - v_take;
      END LOOP;
      v_removed := v_line.qty - v_left;
      IF v_removed > 0 THEN
        INSERT INTO scm.warehouse_rack_movements (
          company_id, movement_type, rack_id, rack_label, warehouse_id, item_code, variant_key,
          product_name, source_doc_no, quantity, reason, performed_by
        ) VALUES (
          v_head.company_id, 'STOCK_OUT', v_line.to_rack_id, v_label, v_head.to_warehouse_id, v_line.item_code,
          v_line.variant_key, v_line.product_name, v_head.transfer_no, v_removed,
          'Stock transfer ' || v_head.transfer_no || ' cancelled', p_performed_by
        );
      END IF;
      v_touched := v_touched || v_line.to_rack_id;
    END IF;

    IF v_line.from_rack_id IS NOT NULL THEN
      SELECT rack INTO v_label FROM scm.warehouse_racks WHERE id = v_line.from_rack_id;
      INSERT INTO scm.warehouse_rack_items (
        company_id, rack_id, item_code, variant_key, product_name, source_doc_no, qty, stocked_in_date
      ) VALUES (
        v_head.company_id, v_line.from_rack_id, v_line.item_code, v_line.variant_key, v_line.product_name,
        v_head.transfer_no, v_line.qty, (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      );
      INSERT INTO scm.warehouse_rack_movements (
        company_id, movement_type, rack_id, rack_label, warehouse_id, item_code, variant_key,
        product_name, source_doc_no, quantity, reason, performed_by
      ) VALUES (
        v_head.company_id, 'STOCK_IN', v_line.from_rack_id, v_label, v_head.from_warehouse_id, v_line.item_code,
        v_line.variant_key, v_line.product_name, v_head.transfer_no, v_line.qty,
        'Stock transfer ' || v_head.transfer_no || ' cancelled', p_performed_by
      );
      v_touched := v_touched || v_line.from_rack_id;
    END IF;
    v_undone := v_undone + 1;
  END LOOP;

  IF array_length(v_touched, 1) > 0 THEN
    PERFORM scm.fn_stock_transfer_refresh_rack_status(v_touched);
  END IF;
  RETURN v_undone;
END;
$function$;
