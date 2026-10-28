-- Operation Manager (position 10) holds scm=full, but an explicit
-- scm.sales=view child row survived from an earlier grant pass. Under the
-- resolver's explicit-child-overrides-parent rule that row actively
-- DOWNGRADES his whole Sales subtree to view. Owner ruling 2026-07-28
-- ("删行升 full"): remove it so the scm=full cascade takes over and Sales
-- resolves to full like every other SCM section for this position.
DELETE FROM position_page_access
 WHERE position_id = 10 AND page_key = 'scm.sales';
