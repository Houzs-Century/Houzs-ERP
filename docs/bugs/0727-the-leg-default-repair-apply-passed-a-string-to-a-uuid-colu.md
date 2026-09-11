## The leg-default repair's apply passed a string to a uuid column, leaving three DOs half-repaired [medium]

<!-- area: Inventory, costing, FIFO -->
<!-- status: fixed -->

**白话.** 修「脚高 Default」那五行的 apply 工具第一次跑就炸了。它在 resync 之前
先用 raw SQL 把三张 DO 的行 variants 剥干净、把幽灵 OUT 删掉（这些都 commit 了），
然后呼叫正规 re-ship 时把 `performed_by` 传成字串 `"repair:do-leg-default-0722"`
—— 那个栏位是 uuid，插入失败。结果三张 DO 变成「出了货、行干净、却没有任何 sofa
OUT」的半成品状态。**没有动到钱或库存**：删掉的幽灵 OUT 本来 0 消耗 0 成本，五个
目标 lot 从没被扣、现在也还满着。

**Symptom.** `apply-do-leg-default-stock.mjs` run 34564234710 (2026-09-11,
APPLY=1) exited failure:
`[inventory] movement insert failed: invalid input syntax for type uuid:
"repair:do-leg-default-0722"` then `[do-resync] movement write FAILED for DO
cdff459c-…`. Read live after: on HC-DO-2609-004 / -009 / -011 the phantom
`legheight=default` OUTs were gone (0), no OUT existed for the five sofa
item_codes (0), no line still carried `legHeight` (0), and the five target lots
were still open (qty 1 each).

**Root cause (traced).** `scm.inventory_movements.performed_by` is `uuid` (and
NULLABLE — 3487 of 4201 live rows carry a null performer, the system-write norm).
The apply script invented a string ACTOR (`repair:do-leg-default-0722`) and
passed it as `performedBy` into `resyncInventoryForDo`, whose movement insert
binds it to that uuid column. Postgres rejected the string. Because the script
does its variant-strip + phantom-delete in raw SQL BEFORE the resync, and catches
the resync failure per-DO, those two writes had already committed for all three
DOs while the re-ship never ran.

**Why it was not worse.** The deleted phantom OUTs had zero
`inventory_lot_consumptions` and zero cost, so deleting them moved no stock and
no money; the lots were never decremented. The net ledger position was identical
to before the apply — only the (correct) variant strip and the phantom removal
landed. No double-count, nothing to unwind. The partial state is exactly the
precondition for the re-ship.

**Fix.**
- Root: the apply script now passes `null` for the performer, not a string — the
  system-write norm, and a non-uuid string can never reach that insert again.
- Recovery: `complete-do-leg-default-stock.mjs` + its workflow target the three
  DOs by number (the original tool can no longer find them — it scoped on the
  `legheight=default` OUTs it had already deleted), ASSERT the expected partial
  state (no line carries legHeight, no sofa OUT, lot open), and run only the
  remaining half — the canonical `resyncInventoryForDo` + `restampSiFromDo` with
  a null performer. DRY-RUN default, APPLY behind CONFIRM, fresh-connection
  verify that each DO ends with a costed sofa OUT and a nonzero line cost.

**Lesson.** A repair that writes in two transports (raw SQL for the delete/strip,
a canonical function for the re-ship) can half-commit: the raw half lands and the
function half throws. Either make the write one transaction, or — as here — make
the raw half the SAFE precondition (a clean strip + a zero-consumption delete move
no money) and make the recovery assert that precondition. And bind every value to
its real column type: performed_by is a uuid, and "a readable label" is not one.

**Follow-up 2026-09-11 — the SAME root bit the verify step too.** After the
recovery APPLY committed correctly (independently confirmed on production: the 5
target lots decremented 1 -> 0, 5 costed OUT rows, 5 consumptions, DO lines
stamped RM 5,216.14), the run STILL exited failure — its post-write verify query
read `delivery_order_items.line_cost_centi`, and the column is `line_cost_sen`
(money is sen on current main). So a completed, correct repair reported red.
Both leg-default scripts carried the wrong column in their verify (the apply's
was copied into the recovery). Corrected to `line_cost_sen` in
fix/verify-column-sen; no write path changed, and neither script re-runs in
practice. Second instance of this entry's own lesson — bind every value to its
real column, and it is not only the WRITE that must: a verify naming a column
that does not exist turns a success into a false failure.

**Ref.** fix/complete-do-leg-default-stock, 2026-09-11. Sibling of docs/bugs/0722
(the bug this repair addresses) and its plan/apply tools (#3594, #3624).
