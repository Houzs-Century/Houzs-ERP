-- 184_position_policy_outsource_fleet — D1 test mirror of migrations-pg/20261128T1500.
UPDATE position_policy SET is_fleet = 1
 WHERE position_id IN (SELECT id FROM positions WHERE slug IN ('outsource_transporter'));
