-- 014_qms_roles.sql
-- Seed the four QMS roles needed for the Service module and for the
-- Customer / Supplier portal work coming next. Follows the same
-- permission-array JSON shape used by migrations 001 & 009.

-- ── Sales Person ─────────────────────────────────────────────
-- Can register new service cases, view SO context, and attach media.
-- Cannot triage, assign suppliers, approve, or see cost data.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Sales Person',
   'Showroom / delivery staff — registers service cases and captures evidence',
   '["sales_orders.read","purchase_orders.read","service_cases.read","service_cases.write"]',
   1);

-- ── Service Admin ────────────────────────────────────────────
-- Full service-case handling: triage, resolution method, supplier
-- assignment, logistics scheduling, closure. The day-to-day operator
-- role for the QMS.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Service Admin',
   'Triages, routes, and closes service cases',
   '["sales_orders.read","purchase_orders.read","service_cases.read","service_cases.write","service_cases.manage","fleet.read"]',
   1);

-- ── Logistic Admin ───────────────────────────────────────────
-- Schedules pickup / delivery logistics on cases; also sees trips
-- and fleet context for coordination.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Logistic Admin',
   'Schedules pickup / delivery logistics for service cases',
   '["service_cases.read","service_cases.write","trips.read.all","trips.write","fleet.read","fleet.manage"]',
   1);

-- ── Manager ──────────────────────────────────────────────────
-- Quality review and sign-off. Read everything, approve cases,
-- access reports and cost data.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Manager',
   'Quality review, approvals, and reporting',
   '["sales_orders.read","delivery_orders.read","purchase_orders.read","service_cases.read","service_cases.write","service_cases.manage","service_cases.approve","balance.read","overdue.read","logs.read","trips.read.all","fleet.read","reports.read"]',
   1);

-- ── Customer ─────────────────────────────────────────────────
-- External portal role. Can only see their own cases, add comments,
-- upload additional photos. Scoped via user_id = customer at query time.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Customer',
   'External customer portal — view own cases, add comments and photos',
   '["portal.customer","service_cases.read.own","service_cases.comment"]',
   1);

-- ── Supplier ─────────────────────────────────────────────────
-- External portal role. Sees POs assigned to them, updates job
-- status, uploads proof photos. Cannot see customer contacts or cost.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system) VALUES
  ('Supplier',
   'External supplier portal — view assigned POs, update status, upload proof',
   '["portal.supplier","service_cases.read.assigned","service_cases.supplier_update"]',
   1);
