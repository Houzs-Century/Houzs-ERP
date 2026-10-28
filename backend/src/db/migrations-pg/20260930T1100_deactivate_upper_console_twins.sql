-- 20260930T1100_deactivate_upper_console_twins.sql
-- REVERSAL: UPDATE scm.mfg_products SET status = 'ACTIVE', updated_at = now()
--           WHERE company_id = 1 AND code IN ('8030-CONSOLE','8038-CONSOLE','9058-CONSOLE');
--   GRANTS: none — a data update on an existing table.
--
-- WHAT THIS CHANGES: three company-1 sofa SKUs go ACTIVE -> INACTIVE. No row is
-- deleted, no code is renamed, no order line is re-keyed.
--
-- WHY (owner confirmed in writing 2026-09-30: "确认:在生产停用 8030、8038、9058
-- 三个大写 CONSOLE SKU。"): each is an upper-case twin of a mixed-case SKU on the
-- SAME Model (8030-Console / 8038-Console / 9058-Console, created 2026-08-08/09
-- and carrying most of the orders). The scan keys its SKU canon by UPPER(code),
-- so the twin shadowed the real SKU and every scanned console on these models
-- was refused (ZNT 4821). The case-insensitive compartment check in the same PR
-- unblocks the scan; this removes the duplicate from the pickers.
--
-- WHY IT IS SAFE: measured on production 2026-09-30 — the twins hold no stock
-- (inventory_movements / inventory_balances: 0 rows), 7 live SO lines and 3 PO
-- lines. Existing lines stay editable: the ACTIVE gate fires only on a CHANGED
-- code (mfg-sales-orders.ts PATCH line, owner 2026-08-08). Supplier bindings on
-- the twins are left in place; the mixed-case SKUs carry their own.

SET search_path = public, scm;

UPDATE scm.mfg_products
   SET status = 'INACTIVE', updated_at = now()
 WHERE company_id = 1
   AND code IN ('8030-CONSOLE', '8038-CONSOLE', '9058-CONSOLE')
   AND status = 'ACTIVE';
