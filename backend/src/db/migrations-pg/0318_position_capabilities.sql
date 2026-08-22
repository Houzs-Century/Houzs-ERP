-- 0318_position_capabilities — editable per-position operational capabilities.
--
-- 白话（老板版）。8-22 拍板：Roles & Permissions 屏要「界面可编辑」。页面/菜单级
-- 的进入权仍由代码里的 positionPolicy 决定（7-18 架构不变），这张表管的是另一根
-- 轴 —— 「这个职位可以做哪些关键动作」：仓库装车(置 LOADED)、发车(Dispatch，扣
-- 库存)、例外撤回(发错拉回)、开发票(DO→SI)。矩阵屏上打勾/取消就是改这张表。
--
-- Design notes:
--   * Presence of a row = the position holds that capability. No levels — the
--     verbs are binary by nature; scoping (own rows only, own dept) is carried
--     by the enforcement site, not here.
--   * God positions (Super Admin / Owner) bypass via the injected `*` wildcard
--     at session hydration — they need no rows and the editor locks their line.
--   * Enforcement lands with the warehouse-line PR (scan-to-LOADED / dispatch
--     split / revert endpoint). Until then this table + its editor are the
--     declared intent the guards will read.
--   * Keys are validated against services/positionCapabilities.ts — the
--     catalogue is code, the GRANTS are data. Unknown keys are rejected at the
--     API, so a typo cannot mint a phantom capability.
--
-- Seeds mirror the owner's 2026-08-22 ruling (by position SLUG, stable):
--   scm.do.load      → storekeeper, storekeeper_supervisor, logistic,
--                      ops_executive, ops_director
--   scm.do.dispatch  → driver, logistic, ops_executive, ops_director
--   scm.do.revert    → ops_executive, ops_director        ("Ops Executive 及以上")
--   scm.invoice.issue→ finance_manager, logistic          ("开票员 = Finance Manager + Logistic Admin")

CREATE TABLE IF NOT EXISTS public.position_capabilities (
  position_id integer NOT NULL REFERENCES public.positions(id) ON DELETE CASCADE,
  capability  text    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  integer,
  PRIMARY KEY (position_id, capability)
);

INSERT INTO public.position_capabilities (position_id, capability)
SELECT p.id, s.capability
FROM (
  VALUES
    ('storekeeper',            'scm.do.load'),
    ('storekeeper_supervisor', 'scm.do.load'),
    ('logistic',               'scm.do.load'),
    ('ops_executive',          'scm.do.load'),
    ('ops_director',           'scm.do.load'),
    ('driver',                 'scm.do.dispatch'),
    ('logistic',               'scm.do.dispatch'),
    ('ops_executive',          'scm.do.dispatch'),
    ('ops_director',           'scm.do.dispatch'),
    ('ops_executive',          'scm.do.revert'),
    ('ops_director',           'scm.do.revert'),
    ('finance_manager',        'scm.invoice.issue'),
    ('logistic',               'scm.invoice.issue')
) AS s(slug, capability)
JOIN public.positions p ON p.slug = s.slug
ON CONFLICT (position_id, capability) DO NOTHING;
