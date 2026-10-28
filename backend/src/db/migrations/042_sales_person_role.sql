-- 042_sales_person_role.sql
-- Seeds a "Sales Person" role preset so admins don't have to assemble
-- the permission set by hand for every new sales rep.
--
-- Idempotent:
--   * INSERT OR IGNORE creates the role only when the name is free.
--   * UPDATE is conditional — it flips scope_to_pic on only if it was
--     off, and never touches permissions (so any admin-side tweaks to
--     an existing "Sales Person" role survive).

INSERT OR IGNORE INTO roles (name, description, permissions, is_system, scope_to_pic)
VALUES (
  'Sales Person',
  'Field sales rep. Logs their own sales and sees only projects where they or their manager is the PIC. Finance, logistics, linked trips and payment panels stay hidden for them on project pages.',
  '["sales.read","sales.write","projects.read"]',
  0,
  1
);

-- If a "Sales Person" role already exists (maybe created by hand before
-- this migration ran) but hasn't been flagged as scoped yet, turn it on.
-- Keeps existing custom permissions untouched.
UPDATE roles
   SET scope_to_pic = 1
 WHERE name = 'Sales Person'
   AND scope_to_pic = 0;
