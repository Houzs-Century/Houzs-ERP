## Project visibility no longer filtered by PIC or brand — only by company [medium]

<!-- area: Projects + PMS + fair report -->

白话：以前一个销售只看得到「自己是负责人 (PIC)」而且「品牌在自己名单里」的项目，别人的
活动 / 展会他看不到。老板 2026-08-19 决定：**同一间公司里，只要有项目权限的人，就能看到
这间公司的所有项目** —— 不再按负责人、不再按品牌来挡。跨公司还是挡住的（2990 看不到
HOUZS，反之亦然），这一点没变。

**What changed.** The project row-level ACL (`getProjectScope` / `canSeeProject` /
`projectAccessLevel` / `isScopedProjectUser`, all in the now-deleted
`backend/src/services/projectAcl.ts`) filtered a scoped Sales rep to projects on
their one-hop PIC line whose brand was in their `user_brands` allow-list, plus a
30-day grace window. Every read that keyed off it now returns the whole
company-scoped set instead.

**Root cause (this is a deliberate change, not a defect).** The two-dimensional
PIC + brand model (migs 048/049) was more restriction than the business wanted:
staff routinely needed to see events they were not the PIC of. Owner decision
2026-08-19: visibility is governed only by (a) the projects page-access gate and
(b) company scope.

**Fix.** Removed the PIC/brand predicate at every read site — project list
(`services/projects.ts`), detail GET + printable debrief, the calendar (its
scoped-PIC and PIC-self arms; crew + attendee arms kept), notifications, and the
two finance reads (`/finance/by-project`, `/finance/lines`, money math
untouched). Removed the matching write gates (create/patch PIC restriction, the
`canPicProjectBrand` brand-on-PIC gate, and the finance-write PIC gate); the
company predicate + `projects.write`/`projects.finances` gates stay. Deleted
`projectAcl.ts`. `AuthUser.brand_scope` is now always `null` (vestigial; the
signed-session claims contract was left unchanged). Frontend: removed the
per-user brand-assignment panel (`UserBrandsPanel`) and its triggers from
`Team.tsx`.

**Kept on purpose (not dead):** `user_brands` and the backend
`GET/PUT /api/users/:id/brands` routes stay — `user_brands` still powers the
DIRECTOR APPROVAL-LANE brand split (Kris/Peter stock-out approvals, owner
2026-08-10) via `approverBrandBlocked` (`projectGates.ts`) and the My-Pending
approver query. That is a separate axis from project visibility and is
unaffected. NOTE: with the visibility-oriented `UserBrandsPanel` gone, there is
no longer an admin UI to EDIT those approval-split brands; existing rows persist.

**Crew scoping is a separate axis and is untouched:** helpers / storekeepers /
drivers still see only the events they are crewed on.

**Ref.** `chore/remove-project-row-acl`, 2026-08-19.
