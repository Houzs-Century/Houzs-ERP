-- 20261002T1200_grn_post_capability.sql
-- REVERSAL:
--   DELETE FROM public.position_capabilities WHERE capability = 'scm.grn.post';
--   With no grant rows only the `*` positions (Super Admin / Owner / Managing
--   Director) can post a GRN. To restore the old behaviour (anyone with Goods
--   Receipt edit posts) the gate in scm/lib/grn-post-capability.ts must be
--   reverted too; deleting rows alone tightens, never loosens.
--
-- 白话。收货流程改成：仓库（Storekeeper / Warehouse Crew）拍送货单建草稿、扫货架，
-- 采购确认（Post GRN）才入库（老板 2026-10-01）。「确认收货」从 Goods Receipt 编辑权
-- 里拆出来，成为职位能力 scm.grn.post，在 Roles & Permissions 矩阵里可勾选。
--
-- Seed (owner's pick 2026-10-01, by position SLUG): Operation Executive (posts
-- every GRN today, per entity_audit_log over the last 60 days), Operation
-- Manager, Procurement/Purchasing. Storekeeper Supervisor and PG WH Assistant
-- had GRN edit and could post; they keep drafting but no longer post.
-- Must run before the Worker that enforces it — deploy.yml migrates first.

INSERT INTO public.position_capabilities (position_id, capability)
SELECT p.id, 'scm.grn.post'
FROM public.positions p
WHERE p.slug IN ('ops_executive', 'ops_director', 'purchasing')
ON CONFLICT (position_id, capability) DO NOTHING;
