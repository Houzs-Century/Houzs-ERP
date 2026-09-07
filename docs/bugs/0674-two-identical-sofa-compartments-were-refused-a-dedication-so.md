## Two identical sofa compartments were refused a dedication, so neither could ever go READY [medium]

**Symptom.** After the 2026-09-07 sofa repairs the chain audit still reported
seven sofa builds as UNDER-LINKED (run 34138080652, 23:29 local). Every one is
the same shape - the purchase order carries the piece, the sales line points at
nothing:

```
HC-SO-011008 -> HC-PO-009881   SO  1A(LHF)+1NA+CNR+1NA+1A(RHF)
                               PO lacks: 1NA, 1NA   (both ON that purchase order, so_item_id NULL)
```

`repair-po-so-item-dedication.mjs` refused them, in its own words: *"2 purchase
line(s) and 2 sales line(s) could pair here, so no pairing is forced - REFUSED,
not guessed."*

**Root cause (traced).** `lib/po-so-dedication-plan.mjs` buckets a line by
`(item_code, seat)` and assigns only when a bucket holds exactly one purchase
line and one unclaimed sales line. A sofa with TWO `1NA` compartments is two
rows in one bucket by construction, so the rule could never settle it - and the
refusal was permanent, not a pause.

That is not a harmless gap. A bedframe or sofa line is hard-bound
(`isHardBoundLine`, `backend/src/scm/lib/so-stock-allocation.ts`): it reads READY
only through its OWN dedicated purchase order's `received_qty`. A sales line with
no dedication at all therefore can never light, however many of that piece the
factory delivers.

**Measured, not assumed, that there is nothing to choose between.**
`probe-sofa-absent-pieces.mjs` against production (run 34138285314, 2026-09-07
23:31 local) prints every variant axis on both sides. On HC-PO-009881 the two
`9058-1NA` purchase lines agree on code, seat 32, quantity 1, received 0, both
money columns, every variant axis and the Desc2; so do the two sales lines they
compete for. The wide search in the same run also confirmed the piece is not
missing anywhere: `STILL ABSENT 0` on all seven.

**Fix.** The planner settles a bucket - and only a bucket - in which every
candidate on both sides is INDISTINGUISHABLE. The caller passes a `fingerprint`
built from every column it read except `id`, `line_no` and `so_item_id`; when all
N purchase fingerprints match each other and all N sales fingerprints match each
other, any bijection produces the same state, so they are paired in order.

This compares MORE than before, never less. One differing column - a price, a
colour, a special, a received quantity - and the bucket is refused exactly as it
was. A caller that passes no fingerprint gets the old behaviour, so the widening
cannot fire by omission.

Three tests in `lib/po-so-dedication-plan.test.mjs`, fixtures read off
production: the pairing happens and lands on two DIFFERENT sales lines; one
differing column restores the refusal; no fingerprint restores the refusal.
Proved RED on the unfixed planner - 16 pass, 1 fail - and 17 pass after.

**Ref.** fix/sofa-dedication-identical-rows, 2026-09-07.
