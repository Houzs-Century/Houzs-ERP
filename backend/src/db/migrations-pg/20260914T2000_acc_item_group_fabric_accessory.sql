-- 20260914T2000_acc_item_group_fabric_accessory.sql
-- REVERSAL: DELETE FROM scm.acc_item_group_accounts WHERE group_code = 'FABRIC_ACCESSORY';
--   DELETE FROM scm.acc_item_groups WHERE code = 'FABRIC_ACCESSORY';
--   Safe only while no document line carries item_group 'fabric_accessory' - a
--   posted invoice's journal is not touched either way, but a later post of a
--   Sofa Accessory line would refuse as unbound again.
--
-- Register the Sofa Accessory group (FABRIC_ACCESSORY, added to both category
-- enums by 20260914T1800) in the accounting item-group registry, and bind it to
-- the SAME four accounts ACCESSORY already uses in each company.
--
-- Why: an invoice posts each line to the account bound to the line's product
-- group (acc/item-group-split.ts), and an unbound group REFUSES to post by
-- name. 20260914T1800 added the category to the enums but not to this registry,
-- so the first invoice carrying a Sofa Accessory line would have been refused.
-- Copying ACCESSORY's bindings keeps the books exactly as they are today: every
-- pillow that becomes a Sofa Accessory was an Accessory until now. The owner
-- can rebind it on Accounting -> Item Groups.
--
-- A company with no ACCESSORY binding gets none here (nothing to copy), and an
-- existing FABRIC_ACCESSORY binding is left alone, so a replay is a no-op.

INSERT INTO scm.acc_item_groups (code, name)
VALUES ('FABRIC_ACCESSORY', 'Sofa Accessory')
ON CONFLICT (code) DO NOTHING;

INSERT INTO scm.acc_item_group_accounts
  (company_id, group_code, purchase_account, sales_account, sales_return_account, purchase_return_account, updated_by)
SELECT company_id, 'FABRIC_ACCESSORY', purchase_account, sales_account, sales_return_account, purchase_return_account,
       'migration 20260914T2000 (copied from ACCESSORY)'
  FROM scm.acc_item_group_accounts
 WHERE group_code = 'ACCESSORY'
ON CONFLICT (company_id, group_code) DO NOTHING;
