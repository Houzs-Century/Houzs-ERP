-- 20260916T1500_roles_cleanup_dead_keys_and_unused_roles.sql
-- REVERSAL:
--   There is no SQL reversal: the removed grants were never in force (every key
--   below is absent from PERMISSIONS[] and was dropped at session hydration,
--   docs/bugs/0478 in the archive), and the five deleted roles had no user of
--   any status and no invitation. To restore either, re-create the role in
--   Team > Roles & Permissions, or re-add the key there once it is declared in
--   backend/src/services/permissions.ts. Nothing a user could do changes.
--
-- Roles & Permissions review 2026-09-16 (owner: 「先做 A，然后走 B」), part A.
--
-- 1. Strip the dead keys from each role. A key that is not in PERMISSIONS[]
--    is filtered out by parsePermissions() at login, so the checkbox the owner
--    sees ticked grants nothing; the Roles screen has shown them as
--    unknown_permissions since #2554. Prod on 2026-09-16 held them on 8 of the
--    14 non-wildcard roles that have active members (Driver kept 1 of 4 keys,
--    Logistic 14 of 25). The list is the ledger's 17 retired + 5 legacy-closed
--    keys (UNDECLARED_ROLE_KEYS) plus two keys that live only in prod rows and
--    gate nothing anywhere: sales_team.read, scm.po_cancel.approve.
--    The legacy-closed udf keys are shut ON PURPOSE (udf.ts); removing the
--    grant changes nothing and stops the matrix implying otherwise.
UPDATE roles
   SET permissions = COALESCE(
         (SELECT jsonb_agg(t.k ORDER BY t.ord)
            FROM jsonb_array_elements_text(permissions::jsonb) WITH ORDINALITY AS t(k, ord)
           WHERE t.k <> ALL (ARRAY[
             'trips.read.own', 'trips.read.all', 'trips.write', 'trips.manage',
             'planner.run', 'fleet.manage', 'fleet.salary', 'sync.run', 'reports.read',
             'sales_orders.read', 'sales_orders.write',
             'delivery_orders.read', 'delivery_orders.write',
             'purchase_orders.read', 'balance.read', 'overdue.read', 'overdue.write',
             'portal.customer', 'portal.supplier',
             'service_cases.read.own', 'service_cases.read.assigned',
             'service_cases.comment', 'service_cases.supplier_update',
             'sales_team.read', 'scm.po_cancel.approve'
           ])),
         '[]'::jsonb)::text
 WHERE permissions::jsonb ?| ARRAY[
         'trips.read.own', 'trips.read.all', 'trips.write', 'trips.manage',
         'planner.run', 'fleet.manage', 'fleet.salary', 'sync.run', 'reports.read',
         'sales_orders.read', 'sales_orders.write',
         'delivery_orders.read', 'delivery_orders.write',
         'purchase_orders.read', 'balance.read', 'overdue.read', 'overdue.write',
         'portal.customer', 'portal.supplier',
         'service_cases.read.own', 'service_cases.read.assigned',
         'service_cases.comment', 'service_cases.supplier_update',
         'sales_team.read', 'scm.po_cancel.approve'
       ];

-- 2. Delete the legacy seed roles nobody holds. Guarded by id AND by "no user
--    of any status, no invitation", so a role picked up between review and
--    deploy survives. Left alone on purpose: Member / Sales Director (Stock +
--    Agreement Approver) (disabled users still hold them), Service Admin (an
--    open invitation names it), Calendar Viewer / PG WH Assistant (each pairs
--    with a live position of the same name), Managing Director (0 members,
--    owner-created 2026-09-07 — a decision, not a leftover).
--      4 Dispatcher   — retired Trips module (2026-04-09)
--     11 Manager      — 2026-04-14 seed
--     12 Customer     — portal is capability-token gated, never a role
--     13 Supplier     — same
--    322 Purchaser    — duplicate name; the live Purchaser is id 330
DELETE FROM role_page_access
 WHERE role_id IN (4, 11, 12, 13, 322)
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = role_page_access.role_id)
   AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.role_id = role_page_access.role_id);

DELETE FROM roles
 WHERE id IN (4, 11, 12, 13, 322)
   AND is_system = 0
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = roles.id)
   AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.role_id = roles.id);
