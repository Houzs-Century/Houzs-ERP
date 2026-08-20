## The document counter re-issued numbers the account book already held [high]

<!-- area: SCM -->

**Symptom.** On 2026-08-20 four documents the ERP raised were refused by
AutoCount with `Primary Key Error`. In plain terms: 单据号码被重复发出 —— ERP 又
开了一次 `HC-SO-2608-001`、`HC-SO-2608-002`、`HC-PO-2608-001`，而 AED_HOUZS 账本
在 08-14/17 就已经收过这三个号码。AutoCount 拒绝得没错，号码确实被占了。

**Root cause (traced, not guessed).** Document numbers are minted
`max(suffix)+1` over the rows that STILL EXIST for the month
(`backend/src/scm/lib/doc-no.ts:18-29`). There is no counter table and no
sequence — the surviving rows ARE the counter. The header comment there
anticipates a deleted MID-month row (max+1 steps over the gap and self-heals)
but not a deleted TOP-of-month row, which lowers the max and hands the number
straight back.

`backend/scripts/golive-wipe-hc.mjs` then does exactly that, deliberately and in
writing — its own header says *"deleting HC's document rows IS the reset: with
zero surviving HC rows in a month, the next mint reads max=0 and hands out
001"*. It ran in production with `MODE=apply` twelve times between 09:03 and
10:16 UTC on 2026-08-20 (workflow `golive-wipe-hc.yml`, runs 32351933153 …
32358148080). The four documents were raised 12:27-14:27 UTC, after every one of
those runs.

The wipe's CLEAR list also includes `scm.autocount_outbox`
(`golive-wipe-hc.mjs:185`), so the ERP's only record of what it had already
EXPORTED was deleted with the documents. Measured on production: the outbox
holds 6 rows and **zero** created before 2026-08-20. That is why the queue
reported `sentBefore=0` for numbers the book demonstrably already had.

**Measured, read-only, on production** (`check-doc-no-reissue.mjs`, run
32393349778):

- **No two ERP documents share a number.** All 41 identity doc-number columns
  are backed by a full unique index; zero duplicates. The 6 columns that do
  repeat a number are REFERENCE columns (SO lines, audit rows, queue rows)
  naming their parent.
- **Four numbers are provably re-issued** — an ERP row created after the book
  received the same number: `HC-SO-2608-001` (ERP 08-20T12:37 / book 08-14),
  `HC-SO-2608-002` (08-20T14:27 / 08-14), `HC-PO-2608-001` (08-20T12:27 /
  08-17), and **`HC-PI-2608-001` (08-20T12:31 / 08-17)** — the fourth was not in
  the reported set because its outbox row is `skipped` (no source GRN), not
  `failed`, so it never appeared as a rejection.
- **Two more are armed but not yet fired.** The book holds `HC-DO-2608-001`,
  `HC-DO-2608-002` and `HC-SI-2608-001`; `scm.delivery_orders` and
  `scm.sales_invoices` hold no HC 2608 row at all, so the next HC delivery order
  and the next HC sales invoice of this month will mint those same numbers.

**Fix.** NOT SHIPPED — diagnosis only. Document numbering is a money path and
the numbering behaviour was deliberately left unchanged in this PR. Three named
options with a recommendation are in `docs/doc-number-reissue-coe.md`; the owner
chooses. What ships here is the read-only detector
(`backend/scripts/check-doc-no-reissue.mjs` + `.github/workflows/doc-no-integrity.yml`)
so the question can be re-asked at any time without a SQL console.

**Ref.** 2026-08-20. Census runs 32392865876 (crashed on a table with no `id`)
and 32393349778 (complete). Wipe runs 32351933153-32358148080.
`docs/doc-number-reissue-coe.md`.
