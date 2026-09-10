## The too-long probe selected a column the table does not have [low]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** The first dispatch of `check-too-long-for-the-book.mjs`
(run 34339048564) printed one line and died:

```
AutoCount's field holds 100 characters. Asking about 5 document(s).
DB unreachable or query failed: column "line_no" does not exist
```

The owner had asked twice for that output. He got an error instead.

**Root cause.** The query selected `line_no` from
`scm.mfg_sales_order_items`. That name appears in `scan-sample-review.ts`'s own
`SO_ITEM_COLS` and was taken from there rather than from the table being read.
The write-back's `SO_ITEM_COLS` does not list it, and the line ORDER the
write-back uses is `created_at` then `id`, via `inAcLineOrder`.

**A column name read off a neighbouring module is a guess.** The authority was
two files away and states it in one line — `ac-line-order.ts`:
`q.order('created_at').order('id')`.

**Fix.** Read in the write-back's own order, and number the lines by position in
that order — which is the position on the document the reader is looking at.
Numbering any other way would disagree with the screen the owner edits on. The
purchase-order arm was qualified in the same change; it joined two tables and
selected unqualified columns.

**Verified.** Run 34339048564 exited 1 with the message above; run 34340403272
on the fix printed all six over-long lines with their text and lengths.

**What would NOT have caught it.** Nothing in CI can: the script only reaches
production through `workflow_dispatch`, and no test has a database with these
tables in it. CLAUDE.md already carries the rule that caught it — *a
`workflow_dispatch` workflow is not shipped until it has been dispatched once
and reported success* — and it worked exactly as written, one dispatch later.

**Ref.** fix/the-too-long-probe-uses-the-real-line-order (merged), entry landed
with fix/shorten-the-specials-the-owner-approved, 2026-09-09.
