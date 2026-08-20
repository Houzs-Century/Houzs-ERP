## A batch of Sales Agents lost every Service Case at once — visibility was decided by a NAME typed into a mirrored text field [high]

<!-- area: Service cases (ASSR) -->

**白话.** 有一批 sales 突然一张 Service Case 都看不到了。不是单据不见，也不是
AutoCount 出问题——是我们自己的「谁能看谁」的规则用错了根据。以前系统是拿**名字的文字**
去比对：把 AutoCount 抄过来的「业务员」那一栏，跟这个人（和他手下）的名字做「包含」比
较。名字改过、多一个空格、拼法不一样，比对就不中，这个人手上所有的单就整批消失，而且
系统一句话都不说。老板的决定是：AutoCount 那边的业务员资料本来就不准，所以那边的单
**只看公司授权**——有 Houzs 这家公司的授权就看得到，不看职称、不看上下线；ERP 自己开的
单才继续「自己＋下线」，而且改成用**编号**认人，不再比名字。Office 维持看全部，因为他们
要帮 sales 处理事情。

**Symptom.** Reported 2026-08-20: many Sales Agents could no longer see Service
Cases. Not their data and not the AutoCount binding — the list simply came back
without their cases, and nothing said why.

**Root cause.** Traced through the read path, not guessed. A scoped caller's
rows were selected by `pushVisibilityScope` (`services/assr.ts`) and its
hand-written twin `assrVisibilitySql` (`routes/assr.ts`), both of which OR-ed
`LOWER(COALESCE(sales_agent,'')) LIKE '%<subtree member display name>%'` on top
of the `created_by` / `assigned_to` / `assigned_to_2` id terms. `sales_agent` is
free text mirrored out of AutoCount (mig 010). So the "binding" between a case
and the person who owns it was a **substring comparison between two strings** —
a rename, a stray space or a different spelling silently drops a rep out of
every case they are not also the creator or assignee of. Three things break it
in batches: a tier change, a reporting-line move, or the mirrored text drifting
from the ERP user's name. The route gate had the same shape one level up:
`canAccessServiceCases` admitted on `isSalesUser` — `/^sales/i` over
`position_name` plus a "sales" substring over `department_name`
(`services/pmsAccess.ts`) — so an owner-editable job title also decided access.

**Fix (owner decision 2026-08-20, `docs/SERVICE-CASE-VISIBILITY-DECISION.md`).**
Visibility is keyed off the COMPANY, and off IDs where an id exists.

- Route gate: `isSalesUser` is replaced by `holdsHouzsCompanyGrant(c)`. The
  permission and director terms are unchanged.
- Rows: one predicate, `assrVisibilityPredicateSql`
  (`services/assrVisibility.ts`). A case whose `doc_no` resolves to a live
  `scm."mfg_sales_orders"` row stays self + downline, resolved BY ID through
  `scm.staff.user_id` (mig 0066). Every other case — the AutoCount `sales_orders`
  mirror, or no resolvable SO — is company-scoped only. The `sales_agent`
  substring match is gone from the visibility path entirely.
- The `assrUnrestricted` (office / director) tier is untouched, deliberately:
  office works cases on a salesperson's behalf.
- READ and CREATE only. Every write / manage / approve / delete route keeps its
  `requirePermission` gate.

The two SQL twins and the two TypeScript copies of the row rule (in
`caseInCallerScope` and `assrCaseRowInScope`) all collapse into that one
predicate, so the list, its own totals, the detail GET and the printable can no
longer disagree.

**Measured before shipping, not reasoned about.** `Census — Service Case
visibility (read-only)`, run 32351722894 against production 2026-08-20: 859
non-archived cases, of which **7** are ERP-sourced and **852** AutoCount-sourced;
route admittance 49 -> 77 users (**+28 gained, 0 lost**); of 60 visibility-scoped
users **all 60** gain cases and **36 go from ZERO visible cases to some** — the
reported outage, counted. **0** users lose admittance and **0** user-case pairs
are lost.

**Tests.** `backend/tests/assrVisibilityRule.test.ts` — 21 assertions pinning the
three scope states, that a Sales TITLE alone no longer admits, that the office
tier emits no predicate, that the `sales_agent` LIKE is absent, that a NULL
`doc_no` cannot poison the `NOT IN`, and a source scan asserting the id clause
exists in exactly one file. Both guards were proved RED by reintroducing a
`sales_agent LIKE` arm and a second copy of the id clause before being trusted.

**A second bug, found by the MERGE QUEUE and invisible on this branch.**
`frontend/src/auth/permissionDivergence.test.ts` is a FRONTEND test that reads
BACKEND source and asserted `canAccessServiceCases` ORs in `isSalesUser(user)`.
Replacing the job title with the company grant is the whole point of this fix, so
that mirror went stale the moment the gate changed — it now asserts
`holdsHouzsCompanyGrant(c)`, which is the same invariant (a rep the API would
serve is never Forbidden) against the mechanism that actually decides it. The
stale comment it mirrored, `backend/src/middleware/auth.ts` on the
`/mfg-sales-orders` arm, said the two gates agree; they now differ on purpose and
it says so.

Worth more than the fix: **this branch's own CI could not catch it.** The PR is
backend-only, so `changes` path-filtered every frontend job to `skipping` — the
suite holding the assertion never ran. The merge queue builds against a different
base, the filter matched, `frontend-checks` ran `npm run test:coverage` for the
first time, and it failed there. A cross-tree mirror test is exactly the shape a
path filter cannot reason about: it lives in the tree that did NOT change and
asserts on the tree that DID. This is CLAUDE.md's *"the check that is not
running"* trap wearing a path filter — green on the branch meant "never
executed", not "passed".

**Ref.** `fix/service-case-visibility-by-company`, 2026-08-20. Census merged
separately as #2534.
