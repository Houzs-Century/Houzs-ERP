-- 0307 item-code-unify: rename every scm material_code/product_code -> item_code.
-- REVERSAL: rename each item_code back to its material_code/product_code source (per the
--   census below), drop+recreate the 7 views and CREATE OR REPLACE the 9 functions from
--   their material_code/product_code bodies. GRANTS: all 7 views carry NO explicit role
--   grants (verified 2026-08-19 via information_schema.role_table_grants = NONE), so the
--   recreate restores the same empty ACL. No matview references these columns (mv_ar_aging
--   checked). Functions use CREATE OR REPLACE to preserve trg_inventory_movement_fifo and
--   the p_product_code/p_material_code PARAM names (only column refs change, via word-boundary).
-- Verified against: production scm census 2026-08-19 (18 base columns, 7 views, 0 matview, 9 functions, 1 trigger, 0 FK, 0 CHECK).

BEGIN;

-- drop views (dependents first, inventory_balances last)
DROP VIEW IF EXISTS scm.v_inventory_all_skus;
DROP VIEW IF EXISTS scm.v_inventory_product_totals;
DROP VIEW IF EXISTS scm.v_inventory_lots_open;
DROP VIEW IF EXISTS scm.v_inventory_value;
DROP VIEW IF EXISTS scm.v_cogs_entries;
DROP VIEW IF EXISTS scm.suppliers_with_derived_category;
DROP VIEW IF EXISTS scm.inventory_balances;

-- rename 18 base columns -> item_code
ALTER TABLE scm.grn_items RENAME COLUMN material_code TO item_code;
ALTER TABLE scm.inventory_lot_consumptions RENAME COLUMN product_code TO item_code;
ALTER TABLE scm.inventory_lots RENAME COLUMN product_code TO item_code;
ALTER TABLE scm.inventory_movements RENAME COLUMN product_code TO item_code;
ALTER TABLE scm.master_price_history RENAME COLUMN product_code TO item_code;
ALTER TABLE scm.mfg_product_price_history RENAME COLUMN product_code TO item_code;
ALTER TABLE scm.product_dept_configs RENAME COLUMN product_code TO item_code;
ALTER TABLE scm.purchase_consignment_order_items RENAME COLUMN material_code TO item_code;
ALTER TABLE scm.purchase_consignment_receive_items RENAME COLUMN material_code TO item_code;
ALTER TABLE scm.purchase_consignment_return_items RENAME COLUMN material_code TO item_code;
ALTER TABLE scm.purchase_invoice_items RENAME COLUMN material_code TO item_code;
ALTER TABLE scm.purchase_order_items RENAME COLUMN material_code TO item_code;
ALTER TABLE scm.purchase_return_items RENAME COLUMN material_code TO item_code;
ALTER TABLE scm.stock_take_lines RENAME COLUMN product_code TO item_code;
ALTER TABLE scm.stock_transfer_lines RENAME COLUMN product_code TO item_code;
ALTER TABLE scm.supplier_material_bindings RENAME COLUMN material_code TO item_code;
ALTER TABLE scm.warehouse_rack_items RENAME COLUMN product_code TO item_code;
ALTER TABLE scm.warehouse_rack_movements RENAME COLUMN product_code TO item_code;

-- recreate views (inventory_balances first)
CREATE VIEW scm.inventory_balances AS
 SELECT warehouse_id,
    item_code,
    variant_key,
    max(product_name) AS product_name,
    sum(
        CASE
            WHEN movement_type = 'IN'::scm.inventory_movement_type THEN qty
            WHEN movement_type = 'OUT'::scm.inventory_movement_type THEN - qty
            WHEN movement_type = 'ADJUSTMENT'::scm.inventory_movement_type THEN qty
            WHEN movement_type = 'TRANSFER'::scm.inventory_movement_type THEN qty
            ELSE 0
        END) AS qty,
    max(created_at) AS last_movement_at,
    company_id
   FROM scm.inventory_movements
  GROUP BY warehouse_id, item_code, variant_key, company_id;

CREATE VIEW scm.suppliers_with_derived_category AS
 SELECT id,
    code,
    name,
    whatsapp_number,
    email,
    contact_person,
    phone,
    address,
    state,
    country,
    payment_terms,
    status,
    rating,
    notes,
    supplier_type,
    category,
    tin_number,
    business_reg_no,
    postcode,
    area,
    mobile,
    fax,
    website,
    attention,
    business_nature,
    currency,
    statement_type,
    aging_basis,
    credit_limit_sen,
    created_at,
    updated_at,
    registration_no,
    nature_of_business,
    exemption_no,
    phone2,
    company_id,
    ( SELECT
                CASE
                    WHEN count(DISTINCT mp.category) = 0 THEN NULL::text
                    WHEN count(DISTINCT mp.category) = 1 THEN max(mp.category::text)
                    ELSE 'MIXED'::text
                END AS "case"
           FROM scm.supplier_material_bindings smb
             LEFT JOIN scm.mfg_products mp ON mp.code = smb.item_code AND smb.material_kind = 'mfg_product'::scm.material_kind
          WHERE smb.supplier_id = s.id) AS derived_category
   FROM scm.suppliers s;

CREATE VIEW scm.v_cogs_entries AS
 SELECT c.id,
    c.consumed_at,
    c.warehouse_id,
    w.code AS warehouse_code,
    c.item_code,
    c.variant_key,
    c.qty_consumed,
    c.unit_cost_sen,
    c.total_cost_sen,
    c.source_doc_type,
    c.source_doc_no,
    l.received_at AS lot_received_at,
    l.source_doc_no AS lot_source_doc_no,
    c.company_id
   FROM scm.inventory_lot_consumptions c
     JOIN scm.inventory_lots l ON l.id = c.lot_id
     LEFT JOIN scm.warehouses w ON w.id = c.warehouse_id
  ORDER BY c.consumed_at DESC;

CREATE VIEW scm.v_inventory_value AS
 SELECT l.warehouse_id,
    w.code AS warehouse_code,
    l.item_code,
    l.variant_key,
    l.product_name,
    sum(l.qty_remaining) AS qty_on_hand,
    sum(l.qty_remaining * l.unit_cost_sen) AS value_sen,
        CASE
            WHEN sum(l.qty_remaining) > 0 THEN sum(l.qty_remaining * l.unit_cost_sen) / sum(l.qty_remaining)
            ELSE 0::bigint
        END AS avg_unit_cost_sen,
    l.company_id
   FROM scm.inventory_lots l
     LEFT JOIN scm.warehouses w ON w.id = l.warehouse_id
  WHERE l.qty_remaining > 0
  GROUP BY l.warehouse_id, w.code, l.item_code, l.variant_key, l.product_name, l.company_id;

CREATE VIEW scm.v_inventory_lots_open AS
 SELECT l.id,
    l.warehouse_id,
    w.code AS warehouse_code,
    l.item_code,
    l.variant_key,
    l.product_name,
    l.qty_received,
    l.qty_remaining,
    l.unit_cost_sen,
    l.qty_remaining * l.unit_cost_sen AS remaining_value_sen,
    l.received_at,
    l.source_doc_type,
    l.source_doc_no,
    l.batch_no,
    l.company_id
   FROM scm.inventory_lots l
     LEFT JOIN scm.warehouses w ON w.id = l.warehouse_id
  WHERE l.qty_remaining > 0
  ORDER BY l.received_at;

CREATE VIEW scm.v_inventory_product_totals AS
 SELECT p.code AS item_code,
    p.name AS product_name,
    p.category,
    p.size_label,
    p.base_price_sen,
    p.price1_sen,
    p.branding,
    COALESCE(b.qty, 0::numeric) AS total_qty,
    COALESCE(v.value_sen, 0::bigint) AS total_value_sen,
    b.last_movement_at,
    ms.supplier_code AS main_supplier_code,
    ms.supplier_name AS main_supplier_name,
    ms.unit_price_sen AS main_supplier_price_sen,
    p.company_id
   FROM scm.mfg_products p
     LEFT JOIN ( SELECT inventory_balances.item_code,
            inventory_balances.company_id,
            sum(inventory_balances.qty) AS qty,
            max(inventory_balances.last_movement_at) AS last_movement_at
           FROM scm.inventory_balances
          GROUP BY inventory_balances.item_code, inventory_balances.company_id) b ON b.item_code = p.code AND b.company_id = p.company_id
     LEFT JOIN ( SELECT inventory_lots.item_code,
            inventory_lots.company_id,
            sum(inventory_lots.qty_remaining * inventory_lots.unit_cost_sen) AS value_sen
           FROM scm.inventory_lots
          WHERE inventory_lots.qty_remaining > 0
          GROUP BY inventory_lots.item_code, inventory_lots.company_id) v ON v.item_code = p.code AND v.company_id = p.company_id
     LEFT JOIN LATERAL ( SELECT sup.code AS supplier_code,
            sup.name AS supplier_name,
            smb.unit_price_sen
           FROM scm.supplier_material_bindings smb
             JOIN scm.suppliers sup ON sup.id = smb.supplier_id
          WHERE smb.item_code = p.code
          ORDER BY smb.is_main_supplier DESC, smb.unit_price_sen
         LIMIT 1) ms ON true
  WHERE p.status = 'ACTIVE'::scm.mfg_product_status;

CREATE VIEW scm.v_inventory_all_skus AS
 SELECT p.code AS item_code,
    p.name AS product_name,
    p.category,
    p.size_label,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    w.name AS warehouse_name,
    COALESCE(b.qty, 0::numeric) AS qty,
    b.last_movement_at,
    COALESCE(v.value_sen, 0::bigint) AS value_sen,
    ms.supplier_code AS main_supplier_code,
    ms.supplier_name AS main_supplier_name,
    ms.unit_price_sen AS main_supplier_price_sen,
    w.company_id
   FROM scm.mfg_products p
     CROSS JOIN scm.warehouses w
     LEFT JOIN ( SELECT inventory_balances.warehouse_id,
            inventory_balances.item_code,
            sum(inventory_balances.qty) AS qty,
            max(inventory_balances.last_movement_at) AS last_movement_at
           FROM scm.inventory_balances
          GROUP BY inventory_balances.warehouse_id, inventory_balances.item_code) b ON b.warehouse_id = w.id AND b.item_code = p.code
     LEFT JOIN ( SELECT inventory_lots.warehouse_id,
            inventory_lots.item_code,
            sum(inventory_lots.qty_remaining * inventory_lots.unit_cost_sen) AS value_sen
           FROM scm.inventory_lots
          WHERE inventory_lots.qty_remaining > 0
          GROUP BY inventory_lots.warehouse_id, inventory_lots.item_code) v ON v.warehouse_id = w.id AND v.item_code = p.code
     LEFT JOIN LATERAL ( SELECT sup.code AS supplier_code,
            sup.name AS supplier_name,
            smb.unit_price_sen
           FROM scm.supplier_material_bindings smb
             JOIN scm.suppliers sup ON sup.id = smb.supplier_id
          WHERE smb.item_code = p.code
          ORDER BY smb.is_main_supplier DESC, smb.unit_price_sen
         LIMIT 1) ms ON true
  WHERE w.is_active = true AND p.status = 'ACTIVE'::scm.mfg_product_status AND p.company_id = w.company_id;

-- CREATE OR REPLACE the 9 functions (column refs only; params + trigger preserved)
CREATE OR REPLACE FUNCTION scm.fn_consume_fifo(p_warehouse_id uuid, p_product_code text, p_variant_key text, p_qty_needed integer, p_source_doc_type text, p_source_doc_id uuid, p_source_doc_no text, p_movement_id uuid, p_created_by uuid)
 RETURNS TABLE(total_cost_sen integer, qty_short integer)
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_lot        RECORD;
  v_take       INTEGER;
  v_remaining  INTEGER := p_qty_needed;
  v_total_cost INTEGER := 0;
BEGIN
  FOR v_lot IN
    SELECT id, qty_remaining, unit_cost_sen
      FROM inventory_lots
     WHERE warehouse_id = p_warehouse_id
       AND item_code = p_product_code
       AND variant_key  = p_variant_key
       AND qty_remaining > 0
     ORDER BY received_at ASC, id ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_lot.qty_remaining, v_remaining);
    v_total_cost := v_total_cost + (v_take * v_lot.unit_cost_sen);
    v_remaining := v_remaining - v_take;

    UPDATE inventory_lots
       SET qty_remaining = qty_remaining - v_take
     WHERE id = v_lot.id;

    INSERT INTO inventory_lot_consumptions (
      lot_id, warehouse_id, item_code, variant_key,
      qty_consumed, unit_cost_sen, total_cost_sen,
      source_doc_type, source_doc_id, source_doc_no, movement_id, created_by
    ) VALUES (
      v_lot.id, p_warehouse_id, p_product_code, p_variant_key,
      v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
      p_source_doc_type, p_source_doc_id, p_source_doc_no, p_movement_id, p_created_by
    );
  END LOOP;

  RETURN QUERY SELECT v_total_cost, GREATEST(v_remaining, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION scm.fn_consume_fifo_batch(p_warehouse_id uuid, p_product_code text, p_variant_key text, p_qty_needed integer, p_batch_no text, p_source_doc_type text, p_source_doc_id uuid, p_source_doc_no text, p_movement_id uuid, p_created_by uuid)
 RETURNS TABLE(total_cost_sen integer, qty_short integer)
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_lot        RECORD;
  v_take       INTEGER;
  v_remaining  INTEGER := p_qty_needed;
  v_total_cost INTEGER := 0;
BEGIN
  FOR v_lot IN
    SELECT id, qty_remaining, unit_cost_sen
      FROM inventory_lots
     WHERE warehouse_id = p_warehouse_id
       AND item_code = p_product_code
       AND variant_key  = p_variant_key
       AND batch_no     = p_batch_no
       AND qty_remaining > 0
     ORDER BY received_at ASC, id ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_lot.qty_remaining, v_remaining);
    v_total_cost := v_total_cost + (v_take * v_lot.unit_cost_sen);
    v_remaining := v_remaining - v_take;

    UPDATE inventory_lots
       SET qty_remaining = qty_remaining - v_take
     WHERE id = v_lot.id;

    INSERT INTO inventory_lot_consumptions (
      lot_id, warehouse_id, item_code, variant_key,
      qty_consumed, unit_cost_sen, total_cost_sen,
      source_doc_type, source_doc_id, source_doc_no, movement_id, created_by
    ) VALUES (
      v_lot.id, p_warehouse_id, p_product_code, p_variant_key,
      v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
      p_source_doc_type, p_source_doc_id, p_source_doc_no, p_movement_id, p_created_by
    );
  END LOOP;

  RETURN QUERY SELECT v_total_cost, GREATEST(v_remaining, 0);
END;
$function$;

CREATE OR REPLACE FUNCTION scm.fn_inventory_movement_fifo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_result    RECORD;
  v_fallback  RECORD;
  v_abs_qty   INTEGER;
  v_cost      INTEGER;
  v_short     INTEGER;
  v_avg_cost  INTEGER;
  v_unit_cost INTEGER;
BEGIN
  IF NEW.movement_type = 'IN' THEN
    INSERT INTO inventory_lots (
      warehouse_id, item_code, variant_key, product_name,
      qty_received, qty_remaining, unit_cost_sen,
      received_at, source_doc_type, source_doc_id, source_doc_no,
      movement_id, created_by, batch_no, company_id
    ) VALUES (
      NEW.warehouse_id, NEW.item_code, NEW.variant_key, NEW.product_name,
      NEW.qty, NEW.qty, COALESCE(NEW.unit_cost_sen, 0),
      NEW.created_at,
      NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
      NEW.id, NEW.performed_by, NEW.batch_no, NEW.company_id
    );
    UPDATE inventory_movements
       SET total_cost_sen = NEW.qty * COALESCE(NEW.unit_cost_sen, 0)
     WHERE id = NEW.id;

  ELSIF NEW.movement_type = 'OUT' THEN
    v_abs_qty := ABS(NEW.qty);
    IF NEW.batch_no IS NOT NULL THEN
      -- Exact dye-lot batch consume first (sofa set stays colour-matched).
      SELECT * INTO v_result
        FROM fn_consume_fifo_batch(
          NEW.warehouse_id, NEW.item_code, NEW.variant_key, v_abs_qty, NEW.batch_no,
          NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
          NEW.id, NEW.performed_by
        );
      v_cost  := v_result.total_cost_sen;
      v_short := v_result.qty_short;
      -- Ledger-divergence fix (0195): the exact batch matched no (or too few) open
      -- lots. Rather than DISCARD the short (leaving the OUT uncosted + the lots
      -- un-decremented forever — the MAKOTO false-short), fall back to plain
      -- product+variant FIFO (any batch) for the residual so present stock of the
      -- same SKU is consumed + costed. Genuine shorts (no stock at all) survive
      -- the fallback and stay on the 0154 retro-cost path, unchanged.
      IF v_short > 0 THEN
        SELECT * INTO v_fallback
          FROM fn_consume_fifo(
            NEW.warehouse_id, NEW.item_code, NEW.variant_key, v_short,
            NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
            NEW.id, NEW.performed_by
          );
        v_cost  := v_cost + v_fallback.total_cost_sen;
        v_short := v_fallback.qty_short;
      END IF;
    ELSE
      SELECT * INTO v_result
        FROM fn_consume_fifo(
          NEW.warehouse_id, NEW.item_code, NEW.variant_key, v_abs_qty,
          NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
          NEW.id, NEW.performed_by
        );
      v_cost  := v_result.total_cost_sen;
      v_short := v_result.qty_short;
    END IF;
    UPDATE inventory_movements
       SET total_cost_sen = v_cost,
           unit_cost_sen  = CASE WHEN v_abs_qty > 0
                                 THEN v_cost / v_abs_qty
                                 ELSE 0 END
     WHERE id = NEW.id;

  ELSIF NEW.movement_type = 'ADJUSTMENT' THEN
    IF NEW.qty > 0 THEN
      SELECT CASE WHEN SUM(qty_remaining) > 0
                  THEN SUM(qty_remaining * unit_cost_sen) / SUM(qty_remaining)
                  ELSE 0 END
        INTO v_avg_cost
        FROM inventory_lots
       WHERE warehouse_id = NEW.warehouse_id
         AND item_code = NEW.item_code
         AND variant_key  = NEW.variant_key
         AND qty_remaining > 0;

      v_unit_cost := COALESCE(NULLIF(NEW.unit_cost_sen, 0), v_avg_cost, 0);

      INSERT INTO inventory_lots (
        warehouse_id, item_code, variant_key, product_name,
        qty_received, qty_remaining, unit_cost_sen,
        received_at, source_doc_type, source_doc_id, source_doc_no,
        movement_id, created_by, batch_no, company_id
      ) VALUES (
        NEW.warehouse_id, NEW.item_code, NEW.variant_key, NEW.product_name,
        NEW.qty, NEW.qty, v_unit_cost,
        NEW.created_at,
        NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
        NEW.id, NEW.performed_by, NEW.batch_no, NEW.company_id
      );
      UPDATE inventory_movements
         SET total_cost_sen = NEW.qty * v_unit_cost,
             unit_cost_sen  = v_unit_cost
       WHERE id = NEW.id;

    ELSIF NEW.qty < 0 THEN
      v_abs_qty := ABS(NEW.qty);
      IF NEW.batch_no IS NOT NULL THEN
        SELECT * INTO v_result
          FROM fn_consume_fifo_batch(
            NEW.warehouse_id, NEW.item_code, NEW.variant_key, v_abs_qty, NEW.batch_no,
            NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
            NEW.id, NEW.performed_by
          );
        v_cost  := v_result.total_cost_sen;
        v_short := v_result.qty_short;
        -- Same batch-drift fallback as the OUT branch: a batched write-off that
        -- matches no exact-batch lot consumes present same-SKU stock plain-FIFO
        -- instead of silently stranding the units.
        IF v_short > 0 THEN
          SELECT * INTO v_fallback
            FROM fn_consume_fifo(
              NEW.warehouse_id, NEW.item_code, NEW.variant_key, v_short,
              NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
              NEW.id, NEW.performed_by
            );
          v_cost  := v_cost + v_fallback.total_cost_sen;
          v_short := v_fallback.qty_short;
        END IF;
      ELSE
        SELECT * INTO v_result
          FROM fn_consume_fifo(
            NEW.warehouse_id, NEW.item_code, NEW.variant_key, v_abs_qty,
            NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
            NEW.id, NEW.performed_by
          );
        v_cost  := v_result.total_cost_sen;
        v_short := v_result.qty_short;
      END IF;
      UPDATE inventory_movements
         SET total_cost_sen = v_cost,
             unit_cost_sen  = CASE WHEN v_abs_qty > 0
                                   THEN v_cost / v_abs_qty
                                   ELSE 0 END
       WHERE id = NEW.id;
    END IF;
    -- NEW.qty = 0 ADJUSTMENT is a no-op.
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION scm.fn_stock_transfer_apply(p_from_warehouse_id uuid, p_to_warehouse_id uuid, p_source_doc_id uuid, p_source_doc_no text, p_company_id bigint, p_performed_by uuid, p_lines jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_line     JSONB;
  v_qty      INTEGER;
  v_variant  TEXT;
  v_batch    TEXT;
  v_out_id   UUID;
  v_out_qty  INTEGER;
  v_out_cost INTEGER;
  v_in_unit  INTEGER;
  v_moved    INTEGER := 0;
BEGIN
  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb))
  LOOP
    v_qty := FLOOR(COALESCE((v_line->>'qty')::numeric, 0))::integer;
    CONTINUE WHEN v_qty <= 0;                       -- mirror JS `if (ln.qty <= 0) continue`
    v_variant := COALESCE(v_line->>'variant_key', '');
    v_batch   := NULLIF(v_line->>'batch_no', '');   -- '' / absent -> NULL -> plain FIFO

    -- 1) OUT @ source. The AFTER-INSERT FIFO trigger consumes the source lots
    --    (FOR UPDATE row locks, held to txn end) and stamps this row's
    --    total_cost_sen via its own UPDATE — visible to us below in this same txn.
    INSERT INTO scm.inventory_movements (
      company_id, movement_type, warehouse_id, item_code, variant_key,
      product_name, qty, source_doc_type, source_doc_id, source_doc_no,
      batch_no, performed_by, notes
    ) VALUES (
      p_company_id, 'OUT', p_from_warehouse_id, v_line->>'item_code', v_variant,
      v_line->>'product_name', v_qty, 'STOCK_TRANSFER', p_source_doc_id, p_source_doc_no,
      v_batch, p_performed_by, 'Transfer to warehouse ' || p_to_warehouse_id::text
    ) RETURNING id INTO v_out_id;

    -- 2) Read the consumed cost the trigger just stamped (same txn sees its own
    --    writes) and derive the IN unit cost = weighted-avg of the source lots.
    SELECT qty, COALESCE(total_cost_sen, 0)
      INTO v_out_qty, v_out_cost
      FROM scm.inventory_movements
     WHERE id = v_out_id;
    v_in_unit := CASE WHEN v_out_qty > 0
                      THEN round(v_out_cost::numeric / v_out_qty)::integer
                      ELSE 0 END;

    -- 3) IN @ destination at that cost. The FIFO trigger opens the dest lot with
    --    the carried cost + batch. If THIS raises, the whole call (including the
    --    OUT above and every prior line) rolls back — stock is never half-moved.
    INSERT INTO scm.inventory_movements (
      company_id, movement_type, warehouse_id, item_code, variant_key,
      product_name, qty, unit_cost_sen, source_doc_type, source_doc_id, source_doc_no,
      batch_no, performed_by, notes
    ) VALUES (
      p_company_id, 'IN', p_to_warehouse_id, v_line->>'item_code', v_variant,
      v_line->>'product_name', v_qty, v_in_unit, 'STOCK_TRANSFER', p_source_doc_id, p_source_doc_no,
      v_batch, p_performed_by, 'Transfer from warehouse ' || p_from_warehouse_id::text
    );

    v_moved := v_moved + 1;
  END LOOP;

  RETURN v_moved;
END;
$function$;

CREATE OR REPLACE FUNCTION scm.fn_reverse_do_out(p_do_id uuid, p_performed_by uuid, p_batched_only boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_bucket   RECORD; -- $
  v_con      RECORD; -- $
  v_adj_id   UUID; -- $
  v_net      INTEGER; -- $
  v_written  INTEGER := 0; -- $
  v_existing INTEGER; -- $
BEGIN
  -- Idempotency — reversal rows are tagged source_doc_type='ADJUSTMENT' +
  -- this DO's id (same signal the route-side guard checks). Already there ->
  -- the reversal (this fn or the legacy route path) already ran.
  SELECT COUNT(*) INTO v_existing
    FROM scm.inventory_movements
   WHERE source_doc_type = 'ADJUSTMENT'
     AND source_doc_id   = p_do_id; -- $
  IF v_existing > 0 THEN
    RETURN 0; -- $
  END IF; -- $

  FOR v_bucket IN
    SELECT m.warehouse_id,
           m.item_code,
           COALESCE(m.variant_key, '')                                   AS vkey,
           m.batch_no,
           SUM(CASE WHEN m.movement_type = 'OUT' THEN m.qty ELSE 0 END)  AS out_qty,
           SUM(CASE WHEN m.movement_type = 'IN'  THEN m.qty ELSE 0 END)  AS in_qty,
           MAX(m.product_name)                                           AS product_name,
           MAX(m.source_doc_no)                                          AS doc_no,
           MAX(m.company_id)                                             AS company_id
      FROM scm.inventory_movements m
     WHERE m.source_doc_type = 'DO'
       AND m.source_doc_id   = p_do_id
       AND m.movement_type IN ('IN', 'OUT')
       AND (NOT p_batched_only OR m.batch_no IS NOT NULL)
     GROUP BY m.warehouse_id, m.item_code, COALESCE(m.variant_key, ''), m.batch_no
  LOOP
    -- a. Restore every lot consumption linked to this DO's OUT movements in
    --    the bucket (GRN-reconcile consumptions AND normal FIFO-trigger
    --    consumptions alike): the consumed lot gets its qty back at its
    --    ORIGINAL cost, and the consumption row (COGS attribution to a now-
    --    cancelled DO) is deleted. batch_no match is NULL-safe so a plain
    --    (unbatched) bucket restores its own OUT's consumptions too.
    FOR v_con IN
      SELECT c.id, c.lot_id, c.qty_consumed
        FROM scm.inventory_lot_consumptions c
        JOIN scm.inventory_movements mo ON mo.id = c.movement_id
       WHERE mo.source_doc_type = 'DO'
         AND mo.source_doc_id   = p_do_id
         AND mo.movement_type   = 'OUT'
         AND mo.warehouse_id    = v_bucket.warehouse_id
         AND mo.item_code    = v_bucket.item_code
         AND COALESCE(mo.variant_key, '') = v_bucket.vkey
         AND mo.batch_no IS NOT DISTINCT FROM v_bucket.batch_no
       FOR UPDATE OF c
    LOOP
      UPDATE scm.inventory_lots
         SET qty_remaining = qty_remaining + v_con.qty_consumed
       WHERE id = v_con.lot_id; -- $
      DELETE FROM scm.inventory_lot_consumptions WHERE id = v_con.id; -- $
    END LOOP; -- $

    -- b. Zero the OUT movements' cost stamps — their consumptions are gone, so
    --    a stamped cost would be a COGS figure with no ledger backing.
    UPDATE scm.inventory_movements
       SET total_cost_sen = 0, unit_cost_sen = 0
     WHERE source_doc_type = 'DO'
       AND source_doc_id   = p_do_id
       AND movement_type   = 'OUT'
       AND warehouse_id    = v_bucket.warehouse_id
       AND item_code    = v_bucket.item_code
       AND COALESCE(variant_key, '') = v_bucket.vkey
       AND batch_no IS NOT DISTINCT FROM v_bucket.batch_no; -- $

    -- c. Close still-intact lots minted by this DO's OWN delta-IN movements
    --    (a resync qty-decrease wrote an IN whose lot double-counts stock now
    --    that (a) has restored the original lots). Only fully-untouched lots
    --    (qty_remaining = qty_received) are closed — a lot another document
    --    already consumed from is left alone.
    UPDATE scm.inventory_lots l
       SET qty_remaining = 0
     WHERE l.qty_remaining = l.qty_received
       AND l.qty_received > 0
       AND l.movement_id IN (
         SELECT mi.id FROM scm.inventory_movements mi
          WHERE mi.source_doc_type = 'DO'
            AND mi.source_doc_id   = p_do_id
            AND mi.movement_type   = 'IN'
            AND mi.warehouse_id    = v_bucket.warehouse_id
            AND mi.item_code    = v_bucket.item_code
            AND COALESCE(mi.variant_key, '') = v_bucket.vkey
            AND mi.batch_no IS NOT DISTINCT FROM v_bucket.batch_no
       ); -- $

    -- d. One balancing ADJUSTMENT (+net_out) so inventory_balances nets to the
    --    physical truth, then close the lot the trigger's ADJUSTMENT branch
    --    opened: the goods were either restored to their original lots in (a),
    --    or were never physically received (pure drop-ship, C2) — a fresh open
    --    lot here would double-count / be phantom coverage either way.
    v_net := COALESCE(v_bucket.out_qty, 0) - COALESCE(v_bucket.in_qty, 0); -- $
    IF v_net > 0 THEN
      INSERT INTO scm.inventory_movements (
        movement_type, warehouse_id, item_code, variant_key, product_name,
        qty, batch_no, source_doc_type, source_doc_id, source_doc_no,
        performed_by, notes, company_id
      ) VALUES (
        'ADJUSTMENT', v_bucket.warehouse_id, v_bucket.item_code, v_bucket.vkey,
        v_bucket.product_name, v_net, v_bucket.batch_no,
        'ADJUSTMENT', p_do_id, v_bucket.doc_no, p_performed_by,
        CASE WHEN p_batched_only
             THEN 'Drop-ship DO ' || COALESCE(v_bucket.doc_no, p_do_id::text)
                  || ' cancelled - reversing shipment (balance restored, no lot minted)'
             ELSE 'DO ' || COALESCE(v_bucket.doc_no, p_do_id::text)
                  || ' cancelled - original lots restored at original cost, balance-only add-back (no lot minted)'
        END,
        v_bucket.company_id
      ) RETURNING id INTO v_adj_id; -- $

      UPDATE scm.inventory_lots SET qty_remaining = 0 WHERE movement_id = v_adj_id; -- $
      UPDATE scm.inventory_movements SET total_cost_sen = 0, unit_cost_sen = 0 WHERE id = v_adj_id; -- $
      v_written := v_written + 1; -- $
    END IF; -- $
  END LOOP; -- $

  RETURN v_written; -- $
END; -- $
$function$;

CREATE OR REPLACE FUNCTION scm.fn_reconcile_dropship_batch(p_warehouse_id uuid, p_product_code text, p_variant_key text, p_batch_no text, p_created_by uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_out         RECORD;
  v_lot         RECORD;
  v_already     INTEGER;
  v_short       INTEGER;
  v_take        INTEGER;
  v_consumed    INTEGER := 0;
BEGIN
  IF p_batch_no IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_out IN
    SELECT m.id, m.qty, m.source_doc_type, m.source_doc_id, m.source_doc_no
      FROM scm.inventory_movements m
     WHERE m.movement_type = 'OUT'
       AND m.warehouse_id  = p_warehouse_id
       AND m.item_code  = p_product_code
       AND COALESCE(m.variant_key, '') = COALESCE(p_variant_key, '')
       AND m.batch_no      = p_batch_no
       AND m.source_doc_type = 'DO'
       AND EXISTS (
         SELECT 1 FROM scm.delivery_orders d
          WHERE d.id = m.source_doc_id
            AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
            AND (
              d.is_dropship = TRUE
              OR EXISTS (
                SELECT 1 FROM scm.delivery_order_items di
                 WHERE di.delivery_order_id       = d.id
                   AND di.committed_po_batch_no   = p_batch_no
                   AND di.item_code               = p_product_code
                   /* Scoped to the VARIANT too, for symmetry with the OUT loop
                      above (which is variant-keyed). Two lines of one DO can
                      carry the same item_code in different fabrics; without
                      this they cross-claim each other's batch. */
                   AND COALESCE(di.committed_variant_key, '') = COALESCE(p_variant_key, '')
              )
            )
       )
     ORDER BY m.created_at ASC, m.id ASC
     FOR UPDATE OF m
  LOOP
    SELECT COALESCE(SUM(qty_consumed), 0) INTO v_already
      FROM scm.inventory_lot_consumptions
     WHERE movement_id = v_out.id;
    v_short := ABS(v_out.qty) - v_already;
    CONTINUE WHEN v_short <= 0;

    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost_sen, company_id
        FROM scm.inventory_lots
       WHERE warehouse_id = p_warehouse_id
         AND item_code = p_product_code
         AND COALESCE(variant_key, '') = COALESCE(p_variant_key, '')
         AND batch_no     = p_batch_no
         AND qty_remaining > 0
       ORDER BY received_at ASC, id ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_short <= 0;
      v_take := LEAST(v_lot.qty_remaining, v_short);

      UPDATE scm.inventory_lots
         SET qty_remaining = qty_remaining - v_take
       WHERE id = v_lot.id;

      INSERT INTO scm.inventory_lot_consumptions (
        lot_id, warehouse_id, item_code, variant_key,
        qty_consumed, unit_cost_sen, total_cost_sen,
        source_doc_type, source_doc_id, source_doc_no, movement_id, created_by,
        company_id
      ) VALUES (
        v_lot.id, p_warehouse_id, p_product_code, p_variant_key,
        v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
        v_out.source_doc_type, v_out.source_doc_id, v_out.source_doc_no, v_out.id, p_created_by,
        v_lot.company_id
      );

      v_short    := v_short - v_take;
      v_consumed := v_consumed + v_take;
    END LOOP;

    UPDATE scm.inventory_movements m
       SET total_cost_sen = sub.total_cost,
           unit_cost_sen  = CASE WHEN ABS(m.qty) > 0 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
      FROM (
        SELECT COALESCE(SUM(total_cost_sen), 0) AS total_cost
          FROM scm.inventory_lot_consumptions
         WHERE movement_id = v_out.id
      ) sub
     WHERE m.id = v_out.id;
  END LOOP;

  RETURN v_consumed;
END;
$function$;

CREATE OR REPLACE FUNCTION scm.fn_reconcile_uncosted_out(p_warehouse_id uuid, p_product_code text, p_variant_key text, p_before_ts timestamp with time zone, p_created_by uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_out       RECORD;
  v_lot       RECORD;
  v_already   INTEGER;
  v_short     INTEGER;
  v_take      INTEGER;
  v_consumed  INTEGER := 0;
BEGIN
  FOR v_out IN
    SELECT m.id, m.qty, m.company_id,
           m.source_doc_type, m.source_doc_id, m.source_doc_no
      FROM scm.inventory_movements m
     WHERE m.movement_type   = 'OUT'
       AND m.warehouse_id     = p_warehouse_id
       AND m.item_code     = p_product_code
       AND COALESCE(m.variant_key, '') = COALESCE(p_variant_key, '')
       AND m.source_doc_type  = 'DO'
       AND m.created_at       < p_before_ts
       AND EXISTS (
         SELECT 1 FROM scm.delivery_orders d
          WHERE d.id = m.source_doc_id
            AND COALESCE(d.is_dropship, FALSE) = FALSE
            AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
       )
       /* The mirror exclusion — STRICT-BATCH LINES ONLY (see the header). A
          committed SOFA OUT belongs to the batched reconcile, because costing it
          from an arbitrary lot means another dye lot. A committed MATTRESS OUT
          has no dye lot to protect and MUST stay repairable here, or a cancelled
          / re-raised PO would strand its COGS at RM0 for good — which is what
          this migration exists to stop, not to cause. */
       AND NOT (
         m.batch_no IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM scm.delivery_order_items di
            WHERE di.delivery_order_id     = m.source_doc_id
              AND di.committed_po_batch_no = m.batch_no
              AND di.item_code             = m.item_code
              AND COALESCE(di.committed_variant_key, '') = COALESCE(m.variant_key, '')
              AND di.committed_batch_strict = TRUE
         )
       )
     ORDER BY m.created_at ASC, m.id ASC
     FOR UPDATE OF m
  LOOP
    SELECT COALESCE(SUM(qty_consumed), 0) INTO v_already
      FROM scm.inventory_lot_consumptions
     WHERE movement_id = v_out.id;
    v_short := ABS(v_out.qty) - v_already;
    CONTINUE WHEN v_short <= 0;

    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost_sen, company_id
        FROM scm.inventory_lots
       WHERE warehouse_id = p_warehouse_id
         AND item_code = p_product_code
         AND COALESCE(variant_key, '') = COALESCE(p_variant_key, '')
         AND company_id   = v_out.company_id
         AND qty_remaining > 0
       ORDER BY received_at ASC, id ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_short <= 0;
      v_take := LEAST(v_lot.qty_remaining, v_short);

      UPDATE scm.inventory_lots
         SET qty_remaining = qty_remaining - v_take
       WHERE id = v_lot.id;

      INSERT INTO scm.inventory_lot_consumptions (
        lot_id, warehouse_id, item_code, variant_key,
        qty_consumed, unit_cost_sen, total_cost_sen,
        source_doc_type, source_doc_id, source_doc_no, movement_id, created_by,
        company_id
      ) VALUES (
        v_lot.id, p_warehouse_id, p_product_code, COALESCE(p_variant_key, ''),
        v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
        v_out.source_doc_type, v_out.source_doc_id, v_out.source_doc_no,
        v_out.id, p_created_by, v_lot.company_id
      );

      v_short    := v_short - v_take;
      v_consumed := v_consumed + v_take;
    END LOOP;

    UPDATE scm.inventory_movements m
       SET total_cost_sen = sub.total_cost,
           unit_cost_sen  = CASE WHEN ABS(m.qty) > 0
                                 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
      FROM (
        SELECT COALESCE(SUM(total_cost_sen), 0) AS total_cost
          FROM scm.inventory_lot_consumptions
         WHERE movement_id = v_out.id
      ) sub
     WHERE m.id = v_out.id;
  END LOOP;

  RETURN v_consumed;
END;
$function$;

CREATE OR REPLACE FUNCTION scm.fn_return_do_units_at_cost(p_do_id uuid, p_warehouse_id uuid, p_product_code text, p_variant_key text, p_batch_no text, p_qty integer, p_correction_seq integer, p_performed_by uuid, p_notes text)
 RETURNS TABLE(qty_returned integer, qty_costed integer, qty_uncosted integer, cost_restored_sen bigint)
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_con       RECORD; -- $
  v_need      INTEGER := p_qty; -- $
  v_take      INTEGER; -- $
  v_costed    INTEGER := 0; -- $
  v_cost      BIGINT  := 0; -- $
  v_in_id     UUID; -- $
  v_doc_no    TEXT; -- $
  v_name      TEXT; -- $
  v_company   BIGINT; -- $
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN QUERY SELECT 0, 0, 0, 0::BIGINT; -- $
    RETURN; -- $
  END IF; -- $

  -- Bucket identity for the balancing row. Read from the DO's own movements so
  -- the IN matches the OUT it compensates (name, doc number, company) instead of
  -- being re-derived from the document and drifting.
  SELECT MAX(m.source_doc_no), MAX(m.product_name), MAX(m.company_id)
    INTO v_doc_no, v_name, v_company
    FROM scm.inventory_movements m
   WHERE m.source_doc_type = 'DO'
     AND m.source_doc_id   = p_do_id
     AND m.warehouse_id    = p_warehouse_id
     AND m.item_code    = p_product_code
     AND COALESCE(m.variant_key, '') = COALESCE(p_variant_key, '')
     AND m.batch_no IS NOT DISTINCT FROM p_batch_no; -- $

  -- 1. Unwind this bucket's lot consumptions, newest first, up to p_qty units.
  --    Each unit goes back to the lot that paid for it, at that lot's cost.
  FOR v_con IN
    SELECT c.id, c.lot_id, c.qty_consumed, c.unit_cost_sen
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_movements mo ON mo.id = c.movement_id
     WHERE mo.source_doc_type = 'DO'
       AND mo.source_doc_id   = p_do_id
       AND mo.movement_type   = 'OUT'
       AND mo.warehouse_id    = p_warehouse_id
       AND mo.item_code    = p_product_code
       AND COALESCE(mo.variant_key, '') = COALESCE(p_variant_key, '')
       AND mo.batch_no IS NOT DISTINCT FROM p_batch_no
     ORDER BY c.created_at DESC, c.id DESC
     FOR UPDATE OF c
  LOOP
    EXIT WHEN v_need <= 0; -- $
    v_take := LEAST(v_need, v_con.qty_consumed); -- $
    IF v_take <= 0 THEN
      CONTINUE; -- $
    END IF; -- $

    UPDATE scm.inventory_lots
       SET qty_remaining = qty_remaining + v_take
     WHERE id = v_con.lot_id; -- $

    IF v_take >= v_con.qty_consumed THEN
      -- Wholly returned: the consumption never happened. Deleting rather than
      -- zeroing matches fn_reverse_do_out — a 0-qty consumption row still reads
      -- as "this DO consumed this lot" to every report that joins on it.
      DELETE FROM scm.inventory_lot_consumptions WHERE id = v_con.id; -- $
    ELSE
      UPDATE scm.inventory_lot_consumptions
         SET qty_consumed  = qty_consumed - v_take,
             total_cost_sen = (qty_consumed - v_take) * COALESCE(unit_cost_sen, 0)
       WHERE id = v_con.id; -- $
    END IF; -- $

    v_costed := v_costed + v_take; -- $
    v_cost   := v_cost + (v_take::BIGINT * COALESCE(v_con.unit_cost_sen, 0)); -- $
    v_need   := v_need - v_take; -- $
  END LOOP; -- $

  -- 2. Restamp every OUT in the bucket from the consumptions that SURVIVED, so
  --    the shipment's COGS is what is still shipped. Same shape as 0088's
  --    re-stamp. An OUT whose consumptions are all gone lands on 0, correctly.
  UPDATE scm.inventory_movements m
     SET total_cost_sen = sub.total_cost,
         unit_cost_sen  = CASE WHEN ABS(m.qty) > 0 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
    FROM (
      SELECT mo.id AS movement_id,
             COALESCE((SELECT SUM(c.total_cost_sen)
                         FROM scm.inventory_lot_consumptions c
                        WHERE c.movement_id = mo.id), 0) AS total_cost
        FROM scm.inventory_movements mo
       WHERE mo.source_doc_type = 'DO'
         AND mo.source_doc_id   = p_do_id
         AND mo.movement_type   = 'OUT'
         AND mo.warehouse_id    = p_warehouse_id
         AND mo.item_code    = p_product_code
         AND COALESCE(mo.variant_key, '') = COALESCE(p_variant_key, '')
         AND mo.batch_no IS NOT DISTINCT FROM p_batch_no
    ) sub
   WHERE m.id = sub.movement_id; -- $

  -- 3. ONE balancing IN so the movement ledger nets to the physical truth. Cost 0
  --    and its minted lot closed: the value went back into the ORIGINAL lots in
  --    step 1, and a second lot here would double-count both stock and cost.
  INSERT INTO scm.inventory_movements (
    movement_type, warehouse_id, item_code, variant_key, product_name,
    qty, batch_no, source_doc_type, source_doc_id, source_doc_no,
    correction_seq, performed_by, notes, company_id
  ) VALUES (
    'IN', p_warehouse_id, p_product_code, COALESCE(p_variant_key, ''), v_name,
    p_qty, p_batch_no, 'DO', p_do_id, v_doc_no,
    p_correction_seq, p_performed_by,
    COALESCE(p_notes, 'Resync: line qty reduced / line deleted (shipped DO).')
      || ' Original lots restored at original cost'
      || CASE WHEN v_need > 0
              THEN ' (' || v_need || ' unit(s) had no cost to return - uncosted at shipment).'
              ELSE '.' END,
    v_company
  ) RETURNING id INTO v_in_id; -- $

  UPDATE scm.inventory_lots SET qty_remaining = 0 WHERE movement_id = v_in_id; -- $
  UPDATE scm.inventory_movements SET total_cost_sen = 0, unit_cost_sen = 0 WHERE id = v_in_id; -- $

  RETURN QUERY SELECT p_qty, v_costed, v_need, v_cost; -- $
END; -- $
$function$;

CREATE OR REPLACE FUNCTION scm.rename_sofa_compartment(p_from text, p_to text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_from    text := trim(p_from);
  v_to      text := trim(p_to);
  tok_from  text;
  tok_to    text;
  counts    jsonb := '{}'::jsonb;
  n         int;
  re_from   text;
BEGIN
  IF v_from = '' OR v_to = '' THEN
    RAISE EXCEPTION 'empty_code';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION 'same_code';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM maintenance_config_history h
     WHERE h.scope = 'master'
       AND h.effective_from <= CURRENT_DATE
       AND (h.config->'sofaCompartments') ? v_to
     ORDER BY h.effective_from DESC, h.created_at DESC
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'code_exists';
  END IF;

  tok_from := to_jsonb(v_from)::text;
  tok_to   := to_jsonb(v_to)::text;
  re_from  := regexp_replace(v_from, '([\^$.|?*+()\[\]{}])', '\\\1', 'g');

  -- ── SKU master: code suffix + name suffix ────────────────────────────
  UPDATE mfg_products
     SET code = left(code, length(code) - length(v_from)) || v_to,
         name = CASE WHEN right(name, length(v_from) + 1) = ' ' || v_from
                     THEN left(name, length(name) - length(v_from)) || v_to
                     ELSE name END
   WHERE category = 'SOFA'
     AND right(code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('mfg_products', n);

  -- ── Doc line code suffixes (TEXT snapshots across the doc flow) ──────
  UPDATE mfg_sales_order_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mfg_sales_order_items_code', n);

  UPDATE mfg_so_price_overrides SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mfg_so_price_overrides', n);

  UPDATE delivery_order_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('delivery_order_items', n);

  UPDATE delivery_return_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('delivery_return_items', n);

  UPDATE sales_invoice_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sales_invoice_items', n);

  -- consignment_note_items (2990) -> consignment_delivery_order_items (scm)
  UPDATE consignment_delivery_order_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('consignment_delivery_order_items', n);

  -- consignment_order_items (2990) -> consignment_sales_order_items (scm)
  UPDATE consignment_sales_order_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('consignment_sales_order_items', n);

  -- purchase_consignment_note_items (2990) -> purchase_consignment_receive_items (scm);
  -- column is item_code on the scm side (NOT item_code).
  UPDATE purchase_consignment_receive_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_consignment_receive_items', n);

  UPDATE grn_items SET
         item_code = CASE WHEN right(item_code, length(v_from) + 1) = '-' || v_from
                              THEN left(item_code, length(item_code) - length(v_from)) || v_to ELSE item_code END,
         supplier_sku  = CASE WHEN right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from
                              THEN left(supplier_sku, length(supplier_sku) - length(v_from)) || v_to ELSE supplier_sku END
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from
      OR right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('grn_items', n);

  UPDATE purchase_order_items SET
         item_code = CASE WHEN right(item_code, length(v_from) + 1) = '-' || v_from
                              THEN left(item_code, length(item_code) - length(v_from)) || v_to ELSE item_code END,
         supplier_sku  = CASE WHEN right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from
                              THEN left(supplier_sku, length(supplier_sku) - length(v_from)) || v_to ELSE supplier_sku END
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from
      OR right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_order_items', n);

  UPDATE purchase_consignment_order_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_consignment_order_items', n);

  UPDATE purchase_invoice_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_invoice_items', n);

  UPDATE purchase_return_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_return_items', n);

  UPDATE supplier_material_bindings SET
         item_code = CASE WHEN right(item_code, length(v_from) + 1) = '-' || v_from
                              THEN left(item_code, length(item_code) - length(v_from)) || v_to ELSE item_code END,
         supplier_sku  = CASE WHEN right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from
                              THEN left(supplier_sku, length(supplier_sku) - length(v_from)) || v_to ELSE supplier_sku END
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from
      OR right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('supplier_material_bindings', n);

  UPDATE pwp_codes SET
         trigger_item_code  = CASE WHEN right(coalesce(trigger_item_code, ''), length(v_from) + 1) = '-' || v_from
                                   THEN left(trigger_item_code, length(trigger_item_code) - length(v_from)) || v_to ELSE trigger_item_code END,
         redeemed_item_code = CASE WHEN right(coalesce(redeemed_item_code, ''), length(v_from) + 1) = '-' || v_from
                                   THEN left(redeemed_item_code, length(redeemed_item_code) - length(v_from)) || v_to ELSE redeemed_item_code END
   WHERE right(coalesce(trigger_item_code, ''), length(v_from) + 1) = '-' || v_from
      OR right(coalesce(redeemed_item_code, ''), length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('pwp_codes', n);

  -- ── Plain-text descriptions (word-boundary rename) ───────────────────
  UPDATE mfg_sales_order_items
     SET description  = regexp_replace(description,  '(^|[^A-Za-z0-9)])' || re_from || '($|[^A-Za-z0-9(])', '\1' || v_to || '\2', 'g'),
         description2 = CASE WHEN description2 IS NOT NULL
                             THEN regexp_replace(description2, '(^|[^A-Za-z0-9)])' || re_from || '($|[^A-Za-z0-9(])', '\1' || v_to || '\2', 'g')
                             ELSE description2 END
   WHERE description ~ ('(^|[^A-Za-z0-9)])' || re_from || '($|[^A-Za-z0-9(])')
      OR coalesce(description2, '') ~ ('(^|[^A-Za-z0-9)])' || re_from || '($|[^A-Za-z0-9(])');
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mfg_sales_order_items_desc', n);

  -- ── JSONB token replacements ─────────────────────────────────────────
  UPDATE product_models
     SET allowed_options = replace(allowed_options::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in allowed_options::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('product_models', n);

  UPDATE sofa_combo_pricing
     SET modules = replace(modules::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in modules::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sofa_combo_pricing', n);

  UPDATE sofa_quick_picks
     SET modules = replace(modules::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in modules::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sofa_quick_picks', n);

  UPDATE sofa_personal_quick_picks
     SET modules = replace(modules::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in modules::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sofa_personal_quick_picks', n);

  UPDATE pos_carts
     SET lines = replace(lines::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in lines::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('pos_carts', n);

  UPDATE mfg_sales_order_items
     SET variants = replace(variants::text, tok_from, tok_to)::jsonb
   WHERE variants IS NOT NULL AND position(tok_from in variants::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mfg_sales_order_items_variants', n);

  UPDATE maintenance_config_history
     SET config = replace(config::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in config::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('maintenance_config_history', n);

  -- ── Legacy retail compartment library + per-Model pricing ───────────
  INSERT INTO compartment_library (id, comp_group, label, width_cm, depth_cm, cushions, default_price, art_filename, is_accessory, sort_order)
  SELECT v_to, comp_group, label, width_cm, depth_cm, cushions, default_price, art_filename, is_accessory, sort_order
    FROM compartment_library WHERE id = v_from
  ON CONFLICT (id) DO NOTHING;

  UPDATE product_compartments SET compartment_id = v_to WHERE compartment_id = v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('product_compartments', n);

  DELETE FROM compartment_library
   WHERE id = v_from AND EXISTS (SELECT 1 FROM compartment_library WHERE id = v_to);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('compartment_library', n);

  RETURN jsonb_build_object('from', v_from, 'to', v_to, 'changed', counts);
END;
$function$;

COMMIT;
