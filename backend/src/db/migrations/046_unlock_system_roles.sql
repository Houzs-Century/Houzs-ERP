-- 046_unlock_system_roles.sql
-- Per-tenant policy change: only Owner and IT Admin are true system
-- roles (full access, never editable). Every other previously-seeded
-- role (Member, Dispatcher, Driver, Helper, Sales Person, Service
-- Admin, Logistic Admin, Manager, Customer, Supplier) becomes a
-- regular custom role so admins can rename, retune permissions, or
-- delete them as their org evolves.
--
-- Idempotent. Safe to re-run.
--
--   * INSERT OR IGNORE seeds IT Admin only when missing.
--   * UPDATE re-asserts ["*"] on IT Admin even if it was hand-edited
--     to something narrower (the role's identity is "full access").
--   * Single UPDATE flips is_system off for everyone except the two
--     roles we keep locked.

INSERT OR IGNORE INTO roles (name, description, permissions, is_system, scope_to_pic)
VALUES (
  'IT Admin',
  'Platform administrator. Full access to every module, equivalent to Owner. Use for the engineering / IT team account that maintains the ERP.',
  '["*"]',
  1,
  0
);

UPDATE roles
   SET permissions = '["*"]',
       is_system   = 1,
       scope_to_pic = 0
 WHERE name = 'IT Admin';

UPDATE roles
   SET is_system = 0
 WHERE name NOT IN ('Owner', 'IT Admin')
   AND is_system = 1;
