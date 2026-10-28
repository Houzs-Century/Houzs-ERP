-- 0165_scm_trip_stop_type_inspection.sql
-- Add 'INSPECTION' to scm.trip_stop_type — the stop type for an ASSR on-site
-- inspection visit (inspection_by='own') scheduled onto a trip from the Delivery
-- Planning board. Mirrors 0128 (SUPPLIER_PICKUP). Standalone ALTER TYPE so the new
-- value is never referenced in the same transaction that adds it (Postgres rule).
ALTER TYPE scm.trip_stop_type ADD VALUE IF NOT EXISTS 'INSPECTION';
