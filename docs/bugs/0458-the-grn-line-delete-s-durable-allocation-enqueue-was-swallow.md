## The GRN line DELETE's "durable" allocation enqueue was swallowed by a best-effort catch [medium]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 删掉收货单的一行，系统会把那笔货退出库存，然后本来要叫「重算订单可出货
状态」。那句叫重算的指令被包在一个「出错就当没事」的壳里 —— 一旦它出错，货已经退
出去了，订单那边却还标着可以出，而且没有任何声音。旁边的注解偏偏写着「这句不会被
吞掉」，所以看代码的人只会更放心。

**Symptom.** No incident reported. Found while converting the NEXT GRN route to
the same pattern: the line-delete route shipped the day before carried the
comment *"DURABLE: queues with the OUT above, and is NOT caught - a failed
enqueue must fail the delete"*, and the statement it described sat inside a
`try { ... } catch { /* best-effort */ }`.

**Root cause, traced.** `grns.ts`'s `DELETE /:id/items/:itemId` reverses a
posted line's receipt inside a best-effort block — the reversing OUT must never
block the delete — and `scheduleStockAllocationAfterCommand` was written on the
line after `writeMovements`, INSIDE that block. Read top-down the comment is
true of the line beside it; read for reachability, the enclosing `catch` eats a
throw from the enqueue and the request goes on to return 204. The transaction
then COMMITS the stock reversal with no queue row — which is the exact state
(`stock moved, no recompute, no retry`) the PG-command conversion exists to make
unreachable. Confirmed by brace nesting, not by inference: the `try` opens at
the `qty_accepted > 0` branch and its `catch` closes after the `if (warehouseId)`
block that holds the enqueue.

**Why nothing caught it.** `stockAllocationDurabilityScope.test.ts` counts the
CALL, not its reachability; `grnLineDeleteAtomicity.pg.test.ts` injects a throw
AFTER the enqueue rather than making the enqueue itself fail; and the comment
made a reviewer's read agree with the intent.

**Fix.** Both GRN transactional routes now set a `stockReversed` flag inside the
best-effort block and call `scheduleStockAllocationAfterCommand` AFTER it, so a
failed enqueue propagates and rolls the whole command back. The new
`tests-pg/grnCancelAtomicity.pg.test.ts` adds the assertion that was missing —
it renames the queue table out from under the enqueue mid-transaction, so the
real upsert really fails, and asserts the CANCEL did not survive.

**Class.** A comment is not a control-flow proof. Where a guarantee depends on a
statement NOT being caught, put the statement outside the `try` where a reader
can see it, rather than asserting it in prose next to a line that is inside one.

**Ref.** 2026-08-20.
