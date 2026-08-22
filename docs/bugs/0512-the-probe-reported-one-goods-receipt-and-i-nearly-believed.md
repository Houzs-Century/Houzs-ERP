## The probe reported one goods receipt for the whole company, and there was no way to tell why [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**白话.** Probe 修好之后第一次干净地跑完，报出来的是：整间公司**一张收货单、其他
全部 0**，两家公司都一样。可是程式码自己的注解写着 company 1 有 291 张收货单、
六万多行销售单行。数字对不上。

问题不在于哪个对 —— 而在于**光看这份报告，分不出是「资料真的这么少」还是「我的
筛选条件把东西都滤掉了」**。这两件事的意义完全相反，一个是「没问题」，一个是
「这份报告整个不能用」。所以先加一段最笨的普查：不带任何条件，直接数每张表几列。

**Symptom.** `probe-convert-link-gaps` runs 32554736407 (company 1) and
32554852579 (both companies), 2026-08-22. Identical output: `GR` = 1 document,
2 lines, `statuses counted: POSTED=1`; `DO`, `IV`, `PI` = 0 documents,
`statuses counted: (none)`. The run was green, and correctly so — every chain
was read.

Contradicted by the codebase's own production measurements:
`routes/grns.ts` cites *"all 291 linked GRNs in company 1"* (2026-08-11), and
`lib/autocount-convert-lines.ts` cites *"46,308 of the 46,318 source lines that
ever moved"* and *"60,939 sales order lines"*.

**Root cause (not yet traced — this entry records the gap, not the answer).**
Two explanations remain open and the report cannot distinguish them:

1. the tables really are nearly empty on the database `secrets.DATABASE_URL`
   points at, and the figures in those comments describe a different corpus
   (a different company, a pre-cutover snapshot, or a different database);
2. a `WHERE` clause in the probe silently excludes almost every row — the status
   exclusion is the obvious suspect, since the enum labels are **not defined in
   this repo** (the types come from 2990's schema) and the probe has never been
   able to verify that `CANCELLED` / `DRAFT` are the right strings.

A filtered count alone cannot tell those apart. `diag-po-receipt-drift` on the
same secret the same morning reported *"every PO line's received_qty agrees with
its live GRN lines"* — consistent with BOTH explanations, so not evidence either
way.

**Fix (this PR).** A RAW CENSUS section: `COUNT(*)` with no predicate at all, on
all four header tables, their four line tables, and the four purchase/sales
source tables. That is the one measurement that separates the two cases. It runs
before anything else and prints first, so no filtered number is read without it.

**Why this is logged as a bug and not just an improvement.** The probe was about
to be used to decide whether hand-entered receipt lines are common enough to
change how goods receipts reach AutoCount — a change to what a live account book
receives. A report that cannot distinguish "no gaps" from "read nothing" is not
a safe input to that decision, and it looked exactly like a clean answer.
Adjacent to `docs/bugs/0511-…`, which is the same probe's previous version
exiting 0 having measured nothing: the exit code was fixed there, but "measured
something" and "measured the right population" are different claims.
