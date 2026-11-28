-- 185_outsource_transporter_dispatch — D1 test mirror of migrations-pg/20261128T1700.
INSERT INTO position_capabilities (position_id, capability)
SELECT p.id, 'scm.do.dispatch' FROM positions p WHERE p.slug = 'outsource_transporter'
ON CONFLICT (position_id, capability) DO NOTHING;
