## BUG CLASS - unscoped-query-by-omission: forgetting the company predicate and choosing to omit it are the same text [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**白话.** 我们两家公司（Houzs 和 2990）的资料能不能分开，全靠每一句查询里面那一句
「只看这家公司」。数据库那层的保护是关掉的（mig 0061 开了 RLS 但一条规则都没写），
而系统用的是最高权限的连线，所以那句话就是唯一的墙。问题是：**写漏了，跟故意不写，
在代码里长得一模一样。** 谁看都看不出来。这次做的是让「不写」变成一件要**打出来**的
事——不写就编译不过。先只改一支单（库存调拨），量一量改一支要多少工。

**The shape.** A statement's `company_id` predicate is the entire tenant boundary
— mig 0061 enabled RLS on every scm table with ZERO policies and the SCM client
is the service-role client, so no policy is ever evaluated on an app request.
The predicate is written by hand at 2,654 `.from(` call sites across 213 files
in `backend/src/scm` (measured 2026-08-20:
`git grep -c ".from(" -- backend/src/scm`), and its ABSENCE is invisible: `sb.from('stock_transfers').update(x).eq('id', id)` is
either a forgotten predicate or a deliberate cross-company write, and the source
does not say which. No compile error, no failing test, no runtime signal. This
is **BUG CLASS optional-param-noop** with the parameter removed entirely.

**It is not hypothetical, and this module is where it landed.** The 2026-07-22
owner audit scoped the sibling flows and missed `PATCH /stock-transfers/:id/cancel`:
a caller in company A holding company B's transfer UUID could cancel B's POSTED
transfer and drive `reverseMovements` over B's stock. Found 2026-08-13 by a code
audit, fixed then. Nothing structural stopped it recurring — the fix was a
predicate somebody had to remember.

**Why the existing guards do not close it.** `check-company-scope.mjs` is
regexes over lines and says so in its own header: a NON-ZERO result is worth
reading, a ZERO result means "this heuristic found nothing". It has been wrong
in five distinct ways in a single day, one of them the *stamp is not a predicate*
blind spot — seven cross-company MONEY writes hid behind
`insert({ company_id: activeCompanyId(c) })` while it printed `0 WRITE`.

**The remedy, and its measured cost.** `backend/src/scm/lib/scopedDb.ts` makes
the scope a REQUIRED second argument: `db.from(table, scope)`. Omitting it is a
TS2554. "This one is deliberately centralised" is `CENTRALISED('<why>')` with a
non-empty reason — a sentence in the diff instead of an absence. The four
constructors DELEGATE to `companyScope.ts` and re-derive none of its logic; in
particular the two context-derived scopes carry the CONTEXT rather than a
resolved id, because the three-state sentinel's UNRESOLVED state is not a number
and collapsing it either way is a leak or an app-wide blank (asserted in
`scopedDb.test.ts` against `fake-postgrest.ts`, all three states, both scopes).

**The one trap inside the remedy.** The INSERT arm STAMPS; every other arm
PREDICATES. Swapping them is silent — a predicate on an insert filters nothing,
and a stamp on an update rewrites `company_id` on every row the statement
matched. That would rebuild the seven-money-writes blind spot inside the
abstraction meant to end it, so it is pinned by test, not by comment
(`update PREDICATES and never stamps`, proven red by making `update` stamp).

**MEASURED on the pilot** (`backend/src/scm/routes/stock-transfers.ts`, 14
`.from(` sites), with `npm --prefix backend run typecheck`:

| step | errors |
| --- | --- |
| swap the 5 `c.get('supabase')` for `scmDb(c)`, change nothing else | **17** (12 TS2554 + 5 TS2345) |
| also retype the file's two `sb: any` parameters | **21** (14 TS2554 + 6 TS2345 + 1 TS2339) |

The 12-vs-14 gap is the honest part: two `.from(` sites sit inside a helper
taking `sb: any`, and `any` absorbs the requirement until the parameter is
typed. A first draft of the wrapper typed `select(columns?: string)`, which
erased supabase-js's column-literal row types and added phantom TS2352/TS2322
casts — 2 at the swap step and 4 after the retype, so 19 / 25 instead of 17 / 21.
A generic `Cols extends string` removed them. A wrapper that manufactures conversion work is a wrapper nobody adopts.

**No defect was found by this conversion.** Every statement kept the scope it
already had; the four that carry no predicate today now carry a `CENTRALISED`
reason saying why. `check-company-scope.mjs` reports the same 12 findings / 0
WRITE over 1034 handlers before and after.

**What it does NOT solve, stated so a green run is not over-read.** It binds
CONVERTED files only (1 of the 99 modules in `backend/src/scm/routes` on day
one, and 14 of those 2,654 call sites). It cannot check the scope is the RIGHT
one — `companyIdScope(theOtherCompany)` compiles. `any` absorbs it: 371
`sb: any` declarations across 105 files in `backend/src/scm`, measured the same
day with `git grep -c "sb: any" -- backend/src/scm`. Raw
`env.DB` SQL and `.rpc()` are outside it entirely. And one
`const sb = c.get('supabase')` re-opens a converted file completely — which is
why `backend/scripts/company-scope-converted.json` plus a fourth pass in
`check-company-scope.mjs --strict` (inside the required `backend-typecheck` job)
fails on exactly that line, with a startup self-test and a FATAL on a missing or
empty list so a verdict computed over nothing can never read as a pass.

**Ref.** feat/scoped-db-pilot, 2026-08-20.
