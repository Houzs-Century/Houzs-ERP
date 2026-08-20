## Four project-detail buttons rendered for people the server refuses [high]

<!-- area: Projects + PMS + fair report -->

**白话.** 项目详情页上有四个按钮 —— 封存/还原、状态下拉、「+ Total Sales」、
「+ Quick Log」—— 在电脑版对**每一个能打开项目的人**都显示。手机版一直是分权限的，
只有电脑版没有。同事按下去，画面就弹出一句「你没有权限」的英文错误 —— 单子没坏，
只是那个按钮本来就不该出现在他面前。反过来也有一个：真正有权限填「总销售额」的
财务同事，因为按钮问错了权限，反而**从来看不到那个按钮**。现在四个按钮问的都是
后端真正在检查的那一条规则，跟手机版同一份逻辑。

**Symptom.** On desktop `Projects.tsx` a user opens any project and sees the
Archive/Restore split button, the STATUS dropdown, "+ Total Sales" and
"+ Quick Log". Clicking any of them returns the API's raw refusal — "You don't
have permission to do that." / "You don't have permission to view financial
information." The same four controls are correctly hidden on mobile. And the
inverse on Total Sales: a finance/ops user holding `projects.write` plus finance
visibility, but no sales grant, never saw a button for a number they are
authorised to set.

**Root cause (traced in source, not guessed).** Four separate client gates, each
asking something the route does not:

1. **Archive / Restore** — the header `actions` prop was `p ? (...)`, so the
   split button rendered for anyone who could open the project. The only
   conditions on the two menu items were `disabled={!!p.archived_at}` and
   `disabled={!p.archived_at}`, which are STATE, not permission. Both routes are
   `requirePermission("projects.manage")` (`routes/projects.ts`).
2. **Status dropdown** — gated only on `!p.archived_at`. `canEditDetail` was
   computed ~150 lines above in the same component and simply never applied to
   this control. `PATCH /:id` is `requirePermission("projects.write")`.
3. **+ Total Sales** — gated on `can("sales.write")`, passed in as
   `ProjectSalesEntriesSection`'s `canWrite`. Its `saveQuickTotal` fires
   `PATCH /api/projects/:id/finance`, whose rule is
   `requirePermission("projects.write")` + `denyFinance(c)`. `sales.write` is
   not a term in that rule, which is why it was wrong in BOTH directions.
4. **+ Quick Log / + New Sale** — same `can("sales.write")`. The write route is
   `app.post("/entries", requirePageAccess("sales"))` (`routes/sales.ts`). Note
   the READ route one screen above uses `requirePageAccessOrSalesView`, so the
   Sales-staff/director org-position fallback applies to READS ONLY: a Sales
   Director (no `sales` matrix row) got the list, got the button, filled it in,
   and got a 403.

The shape underneath all four: `Projects.tsx` derived each gate from scratch
instead of from the rule, and nothing compared the derivation to the route.

**Fix.** Two composite predicates now live once, in
`frontend/src/auth/salesAccess.ts`, beside the DO/SI/procurement operate gates
that exist for this same reason — `canLogSalesEntry(salesPageLevel)` mirrors
`requirePageAccess("sales")` through `ACCESS_RANK`, and
`canWriteProjectFinance(user, can)` mirrors `projects.write` + `denyFinance` ->
`financeHiddenForUser` (`position_id == null` OR `project_finance_viewer`, both
arms). Desktop asks `can("projects.manage")` for archive/restore and
`can("projects.write") && canEditDetail` for status — `canEditDetail` being the
same PMS-EDIT term mobile carries (owner 2026-07-20). `MobilePMS.tsx`'s
`canLogSale` now reads the shared helper rather than its own `!== "none"` copy,
so the surfaces cannot drift.

**Deliberately NOT `access.canFinancial`** for Total Sales. That per-project flag
is the DIRECTOR-only PMS section tier and is a strict SUBSET of what the write
route accepts — it excludes the granular `projects.finance.view` holders (the BD
role, owner 2026-07-23). Gating a write on the section flag would have kept half
of the second symptom alive.

**`Projects.tsx` did not grow.** It is the largest file in the repo and sits
above its ceiling, which may only fall. The gates were paid for by expressing
`canViewSales` in terms of the new helper (it was the same rank comparison
written out) and by deleting a dead `{false && <div className="hidden">noop</div>}`
line. Committed size is identical to the merge base, so the ratchet charges
nothing.

**Test.** `frontend/src/auth/projectActionGates.test.ts` — 12 assertions, all
RED before this change: 7 unit tests on the two predicates (including the two
inverse cases from the symptom), and 5 source-scans that pin which predicate each
of the four sites reads, anchored on the control's own markup so a match cannot
be satisfied from elsewhere in a 15,000-line file. Source-scanning follows
`soMaintenanceGate.test.ts`: rendering these sites would couple the test to the
page's router, lazy boundaries and query client.

**Ref.** PR #2561, 2026-08-20.
