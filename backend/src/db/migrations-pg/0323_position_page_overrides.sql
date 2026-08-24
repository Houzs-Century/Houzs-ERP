-- 0323_position_page_overrides — owner-editable SCM module access per position.
--
-- REVERSAL: DROP TABLE public.position_page_overrides; — additive table with
-- no seeds; hydration treats an absent row set as "no overrides", so the drop
-- returns every position to the code-defined policy baseline exactly.
--
-- 白话（老板版）。Roles & Permissions 矩阵扩到全部 SCM 模块（8-22 裁定）。代码里的
-- positionPolicy 仍是基线；这张表存的是矩阵上打的「覆盖值」——某职位对某个 SCM
-- 页面键（scm.sales.orders / scm.warehouse.inventory …）的 none/view/edit/full。
-- 会话水合时叠加在基线之上，现成的 scmAreaGuard 直接按叠加后的 map 强制。
--
-- Design notes:
--   * Override targets are the SCM LEAF keys the area guard actually reads
--     (validated in code against the pageAccess catalogue — no cascade
--     semantics live here, so a row means exactly the key it names).
--   * God positions (Super Admin / Owner) bypass via the `*` wildcard and the
--     editor locks their rows; sales-JD and money-write RULES run before the
--     map in the guard, so an override can never widen past those.
--   * No seeds: zero rows = today's behaviour, byte for byte.

CREATE TABLE IF NOT EXISTS public.position_page_overrides (
  position_id integer NOT NULL REFERENCES public.positions(id) ON DELETE CASCADE,
  page_key    text    NOT NULL,
  level       text    NOT NULL CHECK (level IN ('none', 'view', 'edit', 'full')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer,
  PRIMARY KEY (position_id, page_key)
);
