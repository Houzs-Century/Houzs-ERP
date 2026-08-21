## The company-scope checker could not see a raw-SQL master read [medium]

**Symptom.** 老板在一张 2990 的销货单上看到印了 Houzs 的商标。查下去发现：我们本来
就有一个检查程序，专门用来抓「读别家公司资料」这种错 —— 但它完全没有报这一条。
换句话说，**守门的那个检查根本看不到这个门。**

**Root cause (traced, and it is TWO causes, not one).** Both verified on
2026-08-21 by patching a copy of `backend/scripts/check-company-scope.mjs` and
running it, not by reading it:

1. `RAW_SQL_TABLES` is a **hand-written list of fifteen table names**.
   `project_brands` was never on it. Adding it produced **zero** new findings —
   because of (2).
2. `if (delegated || hasScopedQuery || wrapsABuilder) return;` acquits the
   **whole handler** before a single statement is read. `GET /:docNo` in
   `mfg-sales-orders.ts` calls `salesDocOutOfScope` and `scopeToCompany`, so all
   ~300 lines of it were excused — the unscoped
   `SELECT name, logo_r2_key FROM project_brands` included. Only lifting that
   return surfaced `L2759`.

So the checker was blind in two independent ways, and each one alone was enough.

**Fix — a SECOND script, deliberately, not a patch to the first.** Folding both
fixes into `check-company-scope.mjs` was MEASURED and rejected. Its `--strict`
mode enforces *handler WRITE findings stay at ZERO*:

| variant | findings | of which WRITE |
|---|---|---|
| as it stands | 12 | 0 |
| + table list derived from migrations | 72 | 20 |
| + whole-handler acquittal lifted | 76 | 22 |

The only ways to land it there were to loosen `--strict` or to grandfather 20
WRITE findings into the baseline that exists to keep writes at zero. Both are
forbidden here — a guard relaxed to make a build green protects nothing.

`backend/scripts/check-master-read-scope.mjs` therefore covers the raw-SQL class
on its own terms: **statement-level, never handler-level**; a table list
**DERIVED from `src/db/migrations-pg/`** (both the `ALTER ... ADD COLUMN
company_id` and the `CREATE TABLE (... company_id ...)` shapes, because reading
only the first silently drops `payment_vouchers`); its own shrink-only baseline
with `--check` and `--ratchet-against`; and a per-statement
`// company-scope: <reason>` escape that leaves the decision where the next
reader will find it.

**Proved RED first, both directions.** On the unfixed tree it names
`backend/src/scm/routes/mfg-sales-orders.ts :: GET /:docNo :: project_brands`
(77 keys); on the fixed tree that key is gone (76). The ratchet was proved to
BITE by injecting an unscoped `SELECT ... FROM project_brands WHERE active = 1`
into `scm/routes/staff.ts` — `--check` exited **1** naming it; adding
`${activeCompanySql(c)}` to the same statement took it back to **0**.

**And its own self-test earned its keep immediately.** The first version built
its table regex from a plain `"\b(?:FROM|..."` string, where `\b` is the
BACKSPACE character — it compiled and matched **nothing**. The startup self-test
refused to run rather than report a clean tree. That is the repo's standing rule
(*a verdict computed over nothing must never read as a pass*) catching a live
instance of the exact failure it was written for, inside the change that quotes
it. The fix is `String.raw`.

**Ref.** `fix/company-scope-class-sweep`, 2026-08-21. Triage table for every
raw `env.DB` site — including the CLEARED ones and why — is in
`docs/company-scope-raw-sql-sweep.md`. The instance itself is
`docs/bugs/0489-a-2990-sales-order-pdf-printed-houzs-s-zanotti-logo.md`.
