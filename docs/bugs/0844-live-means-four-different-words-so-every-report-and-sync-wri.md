## Live means four different words, so every report and sync writes the rule four times [medium]

<!-- area: Database + schema -->

**Symptom.** Owner, 2026-09-12, reading the six-document comparison:

> 你的 PI、SI、GR、PO、SO 都要改成 submitted，然后跟 draft 基本上这几个全部都是一样
> … 除非是 load 吧，DO 则是分成 draft、load、dispatch，这个没关系

"This document is live" is spelled four ways today — `CONFIRMED` on a sales
order, `SUBMITTED` on a purchase order, `POSTED` on a goods receipt and a
purchase invoice, `SENT` on a sales invoice — so every filter, every report and
the AutoCount mapping each carry four spellings of one idea, and a new one has
to be taught to all of them.

He also set the condition for doing anything about it: 「你改的东西前因后果，所有
连接、API 等等都要查看」 — measure first.

**Root cause (traced).** Not a defect: six documents were built at different
times, each borrowing the word its own trade uses. The cost is not in any one
of them, it is that nothing maps them onto one another, so a rename is the only
way to make the six documents answer one question.

**Fix (this entry ships the MEASUREMENT, not the rename).**
`backend/scripts/check-status-vocabulary.mjs` +
`.github/workflows/status-vocabulary-census.yml` (prod / staging / code-only,
read-only) count the three estates a rename touches, because each fails
differently:

- **CODE** — a quoted value in a route, a client, a test. Fails loudly at build
  or in CI. Measured on `origin/main` 6bb723d95, 2026-09-12:
  `CONFIRMED` **93 files / 179 values**, `SUBMITTED` 49 / 106,
  `POSTED` **124 / 356**, `SENT` 49 / 98.
- **RULES** — a `CHECK` constraint or an enum naming one of the words. This half
  REFUSES the write, so it decides the ORDER of operations rather than the size
  of the job. Six migration lines in the live tree name one, and the ones that
  matter are enums (`scm.payment_voucher_status`, `scm.purchase_return_status`),
  where a new value must be added to the TYPE before any row can move.
- **DATA** — rows already carrying the old word. Nothing fails; a list silently
  stops showing documents. Counted per table when a `DATABASE_URL` is given, and
  the script also reports which status columns are enums rather than free text.

The count deliberately matches the status VALUE only (a quoted `'POSTED'`), not
the word in prose or in `SUBMITTED_AT`, so the numbers are a work estimate and
not a word-frequency table.

Read-only by construction, exits 0 for every legitimate answer (a red job would
read as "the check broke"), and the code half runs in a fresh worktree with no
`node_modules`.

**Ref.** docs/status-vocabulary-census, 2026-09-12.
