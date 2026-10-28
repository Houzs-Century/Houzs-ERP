-- D1 test-mirror of migrations-pg/0158_assr_inspection_visit.sql.
-- inspection_visit_at — the date an OWN-TEAM technician goes on-site to
-- inspect the reported issue. Distinct from customer_pickup_at (the date we
-- collect the faulty item to hand to the supplier); previously the on-site
-- inspection visit was overloaded onto customer_pickup_at, conflating it with
-- the pickup. This de-conflates it into its own column so the visit shows as a
-- dedicated INSPECTION leg on the Delivery Planning board.
-- See docs/delivery-planning-jobtypes-spec.md (P1).
ALTER TABLE assr_cases ADD COLUMN inspection_visit_at TEXT;
