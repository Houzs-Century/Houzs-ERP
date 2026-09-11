## A goods receipt could not be saved without a price [medium]

**Symptom.** The owner opened a New Goods Receipt with three bedframe lines at
`0.00` and got **Save failed**: *"These lines would receive stock at zero cost,
but the item has been purchased at a real price before."* His instruction, twice:
「GRN 没有amount 也要可以save」 and 「然后我要GRN 没有amount也可以save」.

**Root cause.** Not a defect — the zero-cost receipt guard doing exactly what it
was built to do. It refuses a receipt whose zero would open a zero-cost stock
lot on a SKU the system has already seen carry money.

The reasoning behind it is still correct and is worth restating rather than
deleting: a zero that reaches a lot is consumed at RM0 COGS, the margin then
reads 100%, and once the unit ships the COGS is settled and must never be
rewritten. This company has already paid that bill once — the 2026-09-02
clean-up moved 5,030 units off zero cost and put RM 1,038,168 back into the
inventory value.

What was wrong was the SHAPE of the refusal. It was a hard wall against the
owner's own standing rule for this system (「尽量放宽 ... 不要有硬墙」): the receipt
could not be saved at all until somebody typed a price they did not have or
ticked a box per line, and a hard wall with no way through is what trains people
to type a fake price — strictly worse than a recorded zero, as the guard's own
header says.

**Fix.** The receipt SAVES. The lines that would have been refused are STAMPED
instead, by `recordReceivedWithNoPrice`:

```
zero_cost_ack    = true    -> the post proceeds
zero_cost_ack_by = NULL    -> NOBODY said this arrived free
zero_cost_reason = 'Received with no price on the supplier document ...'
```

That keeps the half that actually mattered. The guard's own case against a zero
is that it is INVISIBLE — "nothing downstream distinguishes 'free' from 'we
forgot the price'". These are now distinguishable in one predicate:
**`zero_cost_ack = true AND zero_cost_ack_by IS NULL`** is exactly "received with
no price, unclaimed", which is what `backfill-zero-cost-lots.mjs` needs to price
them when the supplier invoice arrives. A line an operator really ticks still
carries their id, and the two can never be confused.

`recordReceivedWithNoPrice` never throws and never blocks: the point of the
ruling is that the save succeeds, so a failure to write the marker must not undo
that.

**Ref.** `feat/grn-saves-without-a-price`, 2026-09-10.
