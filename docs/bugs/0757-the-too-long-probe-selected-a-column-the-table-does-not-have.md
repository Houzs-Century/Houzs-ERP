## The too-long probe selected a column the table does not have [low]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** The first dispatch of `check-too-long-for-the-book.mjs`
(run 34339048564) printed one line and died:

```
AutoCount's field holds 100 characters. Asking about 5 document(s).
DB unreachable or query failed: column "line_no" does not exist
```

The owner had asked twice for this output. He got an error instead.

**Root cause.** The query selected `line_no` from
`scm.mfg_sales_order_items`. That column exists in `scan-sample-review.ts`'s
`SO_ITEM_COLS` — for a different table — and was taken from there rather than
from the table being read. The write-back's own `SO_ITEM_COLS` does not list it,
and the line ORDER it uses is `created_at` then `id` via `inAcLineOrder`.

**A column name read off a neighbouring module is a guess.** The one that
mattered was two files away and says so plainly:
`ac-line-order.ts` — `q.order('created_at').order('id')`.

**Fix.** Read in the write-back's own order and number the lines by their
position in it, which is the position on the document the reader is looking at.
Numbering any other way would disagree with the screen the owner is editing on.
The purchase-order arm was qualified at the same time — it joined two tables and
selected unqualified columns.

**Verified.** `node --check` clean. The failure is a run URL rather than a
claim: run 34339048564, exit 1, message above.

**What would have caught it earlier:** nothing in CI can — the script only
touches production through `workflow_dispatch`, and CLAUDE.md already says a
`workflow_dispatch` workflow is not shipped until it has been dispatched once
and reported success. It had not been. That rule caught this one working
exactly as intended, one dispatch later.

**Ref.** fix/the-too-long-probe-uses-the-real-line-order, 2026-09-09.
