-- 150_position_capabilities — D1 test mirror of migrations-pg/0318.
-- Editable per-position operational capabilities (the Roles & Permissions
-- matrix). Presence of a row = granted. See the PG migration for the full
-- rationale + the owner's 2026-08-22 seed ruling.

CREATE TABLE IF NOT EXISTS position_capabilities (
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  capability  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by  INTEGER,
  PRIMARY KEY (position_id, capability)
);

INSERT OR IGNORE INTO position_capabilities (position_id, capability)
SELECT p.id, s.capability
FROM (
  SELECT 'storekeeper' AS slug, 'scm.do.load' AS capability
  UNION ALL SELECT 'storekeeper_supervisor', 'scm.do.load'
  UNION ALL SELECT 'logistic',               'scm.do.load'
  UNION ALL SELECT 'ops_executive',          'scm.do.load'
  UNION ALL SELECT 'ops_director',           'scm.do.load'
  UNION ALL SELECT 'driver',                 'scm.do.dispatch'
  UNION ALL SELECT 'logistic',               'scm.do.dispatch'
  UNION ALL SELECT 'ops_executive',          'scm.do.dispatch'
  UNION ALL SELECT 'ops_director',           'scm.do.dispatch'
  UNION ALL SELECT 'ops_executive',          'scm.do.revert'
  UNION ALL SELECT 'ops_director',           'scm.do.revert'
  UNION ALL SELECT 'finance_manager',        'scm.invoice.issue'
  UNION ALL SELECT 'logistic',               'scm.invoice.issue'
) AS s
JOIN positions p ON p.slug = s.slug;
