## Reducing a line on a shipped DO returned the stock at a made-up cost, and minted a lot at it [high]

**Symptom.** None visible, which is why it lasted. An operator lowers a qty on an
already-shipped DO; the stock comes back; the numbers look plausible. What
actually happened is that the returning units were priced at a figure no lot ever
charged, and a NEW inventory lot was opened at that figure for the next FIFO
consumer to eat.

**Root cause.** `resyncInventoryForDo` priced the compensating IN at the bucket's
weighted average:

```
unit_cost_sen = round(out_total_cost / out_qty)
```

That average blends units that HAVE a cost with units that do not. A "ship
anyway" oversell leaves its short units with no lot consumption, so they
contribute 0 to `out_total_cost` while still counting in `out_qty`. Return 4 of an
OUT of 10 where 6 cost 100 sen and 4 cost nothing and it hands back 60 sen/unit —
240 sen of capitalised value for stock that is worth either 400 or 0 depending
on which units came back, and the qty delta does not say which.

**Correction 2026-08-13 (audit).** This paragraph first read "120 sen/unit — 480
sen … either 1,000 or 0". The arithmetic is `600 / 10 = 60`, and both the code
this entry describes and the migration that replaced it say 60: mig 0286's
header worked example, and `delivery-orders-mfg.ts:1788`. The mechanism was
right; the numbers were not.

The DO CANCEL path never had this problem: `fn_reverse_do_out` (0198) walks
`inventory_lot_consumptions`, the row-level record of which lot paid for which
unit, and restores each unit to its own lot at its own cost. The partial path had
no equivalent, so it invented one.

**Fix.** Migration 0286 `fn_return_do_units_at_cost` — the PARTIAL form of the
same function. Unwinds the bucket's consumptions newest-first, returns each unit
to the lot that paid for it, shrinks or deletes the consumption row, restamps the
OUT's COGS from what survives, and writes ONE balancing IN at cost 0 with its
minted lot closed (the value went back to the original lots; pricing it again
would capitalise it twice). Units with no consumption behind them return at
nothing and are REPORTED in `qty_uncosted`, never smeared into a per-unit figure.
The old blended row survives only as a fallback for a database without 0286,
because a reduction that posts nothing leaves shipped stock permanently deducted —
worse than an imprecise cost. Owner decision 2026-08-13 ("按原成本退回").

**Lesson.** When the truth was recorded at the time of the event, do not
re-derive it from an aggregate afterwards. The average was computed from
`SUM(total_cost)/SUM(qty)` over a bucket, and every fact needed to avoid it was
sitting one join away in `inventory_lot_consumptions`. Also: a rule that cannot be
derived from the data — LIFO here — is a CHOICE, and it belongs in the migration
header in words, or the next reader will read it as a fact and preserve it for
the wrong reason.

**Ref.** mig 0286 + `tests-pg/returnDoUnitsAtCost.pg.test.ts` (9 cases; the first
asserts the OLD arithmetic is wrong on the fixture, so the suite cannot pass
vacuously), audit ledger B6, 2026-08-13.
