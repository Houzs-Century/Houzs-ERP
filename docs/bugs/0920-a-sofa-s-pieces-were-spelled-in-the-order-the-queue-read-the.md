## A sofa's pieces were spelled in the order the queue read them, not the order of the document lines [low]

<!-- area: AutoCount sync + write-back -->

**Symptom.** After HC-SO-002861 and HC-PO-009827 were re-sent on 2026-09-15, the
book read `1EL + C + 1B + CT + 1NA` on the sales order and
`1EL + C + CT + 1B + 1NA` on the purchase order. They are the same sofa, spelled
two ways, and neither matched the salesperson's lines, which read 1A(LHF), CNR,
1NA, Console, 1B(RHF). The owner's rule, recorded in migration
`20260910T0547_scm_po_item_line_no.sql`: 「我们的 Sales Order 都是从 L 到 R（L 在
第一，R 在最后）」.

**Root cause (traced).**

- Every read that becomes an AutoCount payload orders rows by `created_at`, then
  row id (`inAcLineOrder`).
- An amendment re-derives a build's pieces in one statement, so they share
  `created_at` and the row id decides. That order is arbitrary and differs
  between the SO and its PO.
- `collapseRun` spelled the pieces in that order whenever the book's stored text
  had no arrangement to follow. HC-SO-002861's old text is
  `Size:28"/Col:.../Bottom wrap nylon`, with no arrangement in it.
- `line_no`, which holds the document's order on both sales and purchase lines,
  was never selected for the payload.

The decode gate could not catch it: the text round-trips to exactly the
sequence it was given.

**Fix.**

- `SO_ITEM_COLS` and `PO_ITEM_COLS` select `line_no`.
- `soLine` carries it onto `ErpLine`, and `CollapsibleLine` declares it.
- `collapseRun` spells a build's pieces in `line_no` order when every piece has
  a distinct one; otherwise they stay in arrival order.
- The payload's line order and the key zip are untouched. The sort is local to
  spelling one build.
- The contract test's schema registers `purchase_order_items.line_no`
  (migration 20260910T0547). The column exists on production:
  `information_schema`, read 2026-09-15.

Pinned in `backend/src/services/autocount-sofa-collapse.line-order.test.ts`,
using the production rows in their read order. It fails on the unfixed tree (the
text comes out `1EL + C + 1B + CT + 1NA`) and passes after. Its control confirms
that pieces with no line numbers keep their arrival order. The sofa fold,
write-back and outbox suites pass: 30 files, 632 tests.

**Ref.** fix/ac-sofa-line-order, 2026-09-15.
