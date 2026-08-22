-- 150_position_capabilities — D1 test mirror of migrations-pg/0322.
-- Editable per-position operational capabilities (the Roles & Permissions
-- matrix). Presence of a row = granted. See the PG migration for the full
-- rationale + the owner's 2026-08-22 seed ruling.
--
-- Seeds are one INSERT per capability: the replay harness runs under D1's
-- compound-SELECT limit, so a 13-arm UNION ALL is refused
-- ("too many terms in compound SELECT") while these IN-list selects are not.

CREATE TABLE IF NOT EXISTS position_capabilities (
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  capability  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by  INTEGER,
  PRIMARY KEY (position_id, capability)
);

INSERT OR IGNORE INTO position_capabilities (position_id, capability)
SELECT id, 'scm.do.load' FROM positions
WHERE slug IN ('storekeeper', 'storekeeper_supervisor', 'logistic', 'ops_executive', 'ops_director');

INSERT OR IGNORE INTO position_capabilities (position_id, capability)
SELECT id, 'scm.do.dispatch' FROM positions
WHERE slug IN ('driver', 'logistic', 'ops_executive', 'ops_director');

INSERT OR IGNORE INTO position_capabilities (position_id, capability)
SELECT id, 'scm.do.revert' FROM positions
WHERE slug IN ('ops_executive', 'ops_director');

INSERT OR IGNORE INTO position_capabilities (position_id, capability)
SELECT id, 'scm.invoice.issue' FROM positions
WHERE slug IN ('finance_manager', 'logistic');
