-- ═══════════════════════════════════════
-- Migration 009 — Fleet roles + fleet permissions
--
-- Adds Dispatcher, Driver, and Helper roles with correct
-- permission sets. Updates Member role to include fleet.read.
-- ═══════════════════════════════════════

-- ── Dispatcher role ──────────────────────────────────────────────
-- Full operational access: orders, trips, planner, fleet, delivery tracking.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Dispatcher', 'Trip planning, fleet management, and delivery tracking', '["sales_orders.read","sales_orders.write","delivery_orders.read","delivery_orders.write","purchase_orders.read","service_cases.read","balance.read","overdue.read","logs.read","trips.read.all","trips.write","trips.manage","planner.run","fleet.read","fleet.manage","sync.run"]', 1);

-- ── Driver role ──────────────────────────────────────────────────
-- Mobile app: own trips, clock, inspection, salary view.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Driver', 'Driver mobile app — own trips, clock, inspection, salary', '["trips.read.own","trips.write","fleet.salary"]', 1);

-- ── Helper role ──────────────────────────────────────────────────
-- Simplified mobile app: clock, salary view only.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Helper', 'Helper mobile app — clock and salary view', '["trips.read.own","fleet.salary"]', 1);
