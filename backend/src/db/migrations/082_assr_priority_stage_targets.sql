-- 082_assr_priority_stage_targets.sql
--
-- Lead time driven by priority (TODO item 1).
--
-- Before this mig the per-stage SLA window came purely from the
-- currently-active Lead Time profile (Normal / Peak / etc.) — one
-- global setting. Operationally we want Urgent cases to compress every
-- internal stage and Low-priority cases to extend them, which the
-- single-profile model couldn't express without manual amendments.
--
-- This mig adds a per-priority × per-stage target table. On case
-- creation the priority's targets (if any) override the active
-- profile's. Editing a priority's targets only affects FUTURE stages —
-- the case row's `stage_target_days` column is already snapshotted at
-- stage entry, so historic SLAs stay frozen.
--
-- The Lead Time profile remains as a fallback when:
--   - The chosen priority has no targets defined (cheap rollback path).
--   - A case is created outside the priority dropdown (legacy imports).

CREATE TABLE assr_priority_stage_targets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  priority_id   INTEGER NOT NULL REFERENCES assr_priorities(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  target_days   REAL NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(priority_id, stage)
);

CREATE INDEX idx_assr_priority_stage_targets_lookup
  ON assr_priority_stage_targets(priority_id, stage);

-- Seed defaults. Numbers come from the Normal Lead Time profile
-- (mig 075 seed) adjusted by priority. Internal stages compress hard
-- for high priority and stretch for low; supplier-dependent stages
-- (pickup, ready, delivery) flex less because they're bottlenecked by
-- external parties.
--
-- E2E totals:
--   urgent = 12 days, high = 16 days, normal = 21 days, low = 30 days

-- Urgent
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_review',            1.0 FROM assr_priorities WHERE slug = 'urgent';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'under_verification',        1.0 FROM assr_priorities WHERE slug = 'urgent';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_solution',          1.0 FROM assr_priorities WHERE slug = 'urgent';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_inspection',        1.0 FROM assr_priorities WHERE slug = 'urgent';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_item_pickup',       1.0 FROM assr_priorities WHERE slug = 'urgent';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_supplier_pickup',   2.0 FROM assr_priorities WHERE slug = 'urgent';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_item_ready',        3.0 FROM assr_priorities WHERE slug = 'urgent';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_delivery_service',  2.0 FROM assr_priorities WHERE slug = 'urgent';

-- High
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_review',            1.0 FROM assr_priorities WHERE slug = 'high';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'under_verification',        1.0 FROM assr_priorities WHERE slug = 'high';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_solution',          1.0 FROM assr_priorities WHERE slug = 'high';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_inspection',        2.0 FROM assr_priorities WHERE slug = 'high';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_item_pickup',       2.0 FROM assr_priorities WHERE slug = 'high';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_supplier_pickup',   2.0 FROM assr_priorities WHERE slug = 'high';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_item_ready',        4.0 FROM assr_priorities WHERE slug = 'high';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_delivery_service',  3.0 FROM assr_priorities WHERE slug = 'high';

-- Normal (matches Normal Lead Time profile)
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_review',            1.0 FROM assr_priorities WHERE slug = 'normal';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'under_verification',        2.0 FROM assr_priorities WHERE slug = 'normal';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_solution',          2.0 FROM assr_priorities WHERE slug = 'normal';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_inspection',        2.0 FROM assr_priorities WHERE slug = 'normal';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_item_pickup',       2.0 FROM assr_priorities WHERE slug = 'normal';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_supplier_pickup',   3.0 FROM assr_priorities WHERE slug = 'normal';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_item_ready',        5.0 FROM assr_priorities WHERE slug = 'normal';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_delivery_service',  4.0 FROM assr_priorities WHERE slug = 'normal';

-- Low
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_review',            2.0 FROM assr_priorities WHERE slug = 'low';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'under_verification',        3.0 FROM assr_priorities WHERE slug = 'low';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_solution',          3.0 FROM assr_priorities WHERE slug = 'low';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_inspection',        3.0 FROM assr_priorities WHERE slug = 'low';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_item_pickup',       3.0 FROM assr_priorities WHERE slug = 'low';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_supplier_pickup',   4.0 FROM assr_priorities WHERE slug = 'low';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_item_ready',        7.0 FROM assr_priorities WHERE slug = 'low';
INSERT INTO assr_priority_stage_targets (priority_id, stage, target_days) SELECT id, 'pending_delivery_service',  5.0 FROM assr_priorities WHERE slug = 'low';
