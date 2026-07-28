-- Task C final step — owner-approved mapping 2026-07-28 (Storekeeper,
-- Storekeeper Supervisor and Driver explicitly DEFERRED: "先不授权").
--
-- Context: the SCM sub-page catalogue subdivision shipped earlier; the
-- resolver cascades a parent row's level to children (full → whole subtree,
-- explicit child rows override). In-section access therefore already works
-- off the existing section-level rows — what was missing were the few
-- OUT-of-section sub-pages each ops position needs day-to-day. This grants
-- exactly those, idempotently (re-running updates the level in place).
--
-- Position ids are the stable seeded ids (0004_positions): 12 Operation
-- Executive, 13 Procurement/Purchasing, 14 Logistic Admin, 18 Service Admin.
--
-- Deliberately NOT touched: Operation Manager's scm.sales=view row. It reads
-- like leftover clutter next to his scm=full, but explicit child rows
-- OVERRIDE the parent cascade, so that row actively downgrades his Sales
-- subtree to view — removing it would be a real permission upgrade, parked
-- with the owner as a separate question.

INSERT INTO position_page_access (position_id, page_key, level) VALUES
  (13, 'scm.sales.orders',        'view'),
  (13, 'scm.warehouse.inventory', 'view'),
  (14, 'scm.sales.orders',        'view'),
  (12, 'scm.sales.orders',        'view'),
  (12, 'scm.warehouse',           'edit'),
  (18, 'scm.sales.orders',        'view')
ON CONFLICT (position_id, page_key)
DO UPDATE SET level = EXCLUDED.level, updated_at = now();
