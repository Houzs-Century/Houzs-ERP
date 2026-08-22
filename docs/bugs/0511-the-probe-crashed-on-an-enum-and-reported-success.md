## The probe crashed on an enum on all four chains and reported success [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**白话.** 昨天新加的那支只读 probe，第一次对 prod 跑，**四条链全部当掉**，可是整个
run 还是绿的、退出码 0。当掉的原因是 `status` 那一栏是 Postgres 的 enum，我却写
`COALESCE(status, '')` —— 空字串不是 enum 的合法值，所以一行都还没读就先炸。绿的原因
是我那道「有没有量到东西」的检查问错了问题：后面一小段不相干的读取成功了，就把旗子
插上了。**一份什么都没量到的报告，长得跟一份全部是零的干净报告一模一样。**

**Symptom.** `probe-convert-link-gaps` run 32545397250 (prod, company 1),
2026-08-22. Every chain printed
`NOT MEASURED — invalid input value for enum scm.<t>_status: "" [22P02]`, the
summary printed four `NOT MEASURED` lines, and the workflow was **green**.

**Root cause (traced), part 1 — the crash.** `scm.do_status`,
`scm.grn_status`, `scm.sales_invoice_status` and `scm.purchase_invoice_status`
are ENUM types. `COALESCE(h.status, '')` coerces the `''` literal INTO the enum
at PLAN time; `''` is not a label, so the statement raises 22P02 before reading
a row. **The system had already learned this**: migration `0155` fixed the
identical shape in `fn_reconcile_dropship_batch`, where it had been silently
no-opping in production and understating drop-ship COGS. Its header states both
the cause and the fix. The probe reintroduced it.

**Root cause (traced), part 2 — the green run.** The exit-code guard tracked
`measuredSomething`, a single boolean set by ANY successful read. The
`RECOUNT_FAILED` section — incidental, not the subject — answered `0`, flipped
the flag, and the run exited 0. The guard was written specifically to stop "a
report that measured nothing reading as a clean result", and it did not, because
it asked whether anything at all had answered rather than whether the SUBJECT
had.

**Fix.** `UPPER(COALESCE(status::text, ''))` — cast BEFORE the coalesce — at all
five sites, with `0155` cited inline so the next reader gets the reason and not
just the shape. The guard now counts CHAINS: fewer than four read is exit 1.

**And a third thing the crash exposed.** The enum LABELS are not defined in this
repo — the types come from 2990's schema — so the exclusion list
(`CANCELLED`, `DRAFT`) is not something the probe can verify. A cancelled
document under a label not in that list would silently inflate every count. Each
chain now PRINTS the statuses it actually counted beside the list it excluded, so
a missed label is visible in the output rather than folded into a number.

**Ref.** Introduced by #2642, fixed by #2646. The general lesson is the one
CLAUDE.md already states and this is a fresh instance of: an exit code of 0 is
not evidence of success, and a guard against that has to be pointed at the thing
being measured.
