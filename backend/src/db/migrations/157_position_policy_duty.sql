-- 157_position_policy_duty — D1 test mirror of migrations-pg/20260916T1800.
ALTER TABLE position_policy ADD COLUMN duty TEXT NOT NULL DEFAULT 'other'
  CHECK (duty IN ('management', 'finance', 'purchasing', 'logistic', 'driver', 'helper', 'warehouse', 'other'));
UPDATE position_policy SET duty = 'management'
 WHERE position_id IN (SELECT id FROM positions WHERE slug IN ('super_admin', 'owner', 'managing_director'));
UPDATE position_policy SET duty = 'finance'
 WHERE position_id IN (SELECT id FROM positions WHERE slug IN ('finance_manager'));
UPDATE position_policy SET duty = 'purchasing'
 WHERE position_id IN (SELECT id FROM positions WHERE slug IN ('purchasing'));
UPDATE position_policy SET duty = 'driver'
 WHERE position_id IN (SELECT id FROM positions WHERE slug IN ('driver'));
UPDATE position_policy SET duty = 'helper'
 WHERE position_id IN (SELECT id FROM positions WHERE slug IN ('helper'));
UPDATE position_policy SET duty = 'warehouse'
 WHERE position_id IN (SELECT id FROM positions WHERE slug IN ('storekeeper', 'warehouse_crew_kl'));
