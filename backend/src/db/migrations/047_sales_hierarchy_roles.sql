-- 047_sales_hierarchy_roles.sql
-- Models the sales org chart in roles + permissions:
--
--   Admin (Owner / IT Admin) ── full access via "*"
--     └── Sales Director  ── PIC of projects: chat + tick + log sales,
--                            no project config, no finance edits.
--           └── Sales Person ── chats on their director's projects via
--                               manager_id one-hop scope. No checklist
--                               tick, no config.
--
-- Idempotent. Safe to re-run.

-- ── Sales Director / Sales PIC ───────────────────────────────
-- Seeded as a regular (non-system) role so admins can rename or
-- retune permissions later without touching code.
INSERT OR IGNORE INTO roles (name, description, permissions, is_system, scope_to_pic)
VALUES (
  'Sales Director',
  'Sales PIC. Owns projects assigned to them as PIC: can chat, tick checklist items, and log sales entries. Cannot edit project configuration, finance, or archive. Their direct reports inherit visibility of any project they PIC.',
  '["projects.read","projects.chat","projects.checklist.tick","sales.read","sales.write"]',
  0,
  1
);

-- ── Sales Person — widen to allow chat ───────────────────────
-- Reps could already see their director's projects but were 403'd by
-- POST /:id/notes. Add projects.chat so they can message in those
-- projects. Idempotent — only widens, never narrows hand-edited roles.
UPDATE roles
   SET permissions = json_insert(permissions, '$[#]', 'projects.chat')
 WHERE name = 'Sales Person'
   AND json_type(permissions) = 'array'
   AND NOT EXISTS (
     SELECT 1 FROM json_each(roles.permissions)
      WHERE json_each.value = 'projects.chat'
   );
