## A Date object sliced as a string became NaN, so the costing script found no receipt for any sofa and the oldest for everything else [high]

**Symptom.** Stock that came over from AutoCount with no cost books revenue and
no cost of goods when it is invoiced, so the profit on that sale is overstated by
the whole value of the goods. `cost-zero-cutover-lots-2026-09-09.mjs` was written
to close that, and on its first production apply
([run 34374384637](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34374384637))
it costed **34 of 277** lots and reported the rest as:

```
228 unit(s), 81 code(s) — sofa: the book has no priced receipt for this model, or the piece has no weight
115 unit(s), 17 code(s) — not a sofa: neither the book nor our own purchase history has a price
```

Read as a data gap. It was not one.

**Root cause (traced).** `diag-zero-cost-lots-remaining.mjs`, production
[run 34382805936](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34382805936),
separated the causes the sentence above had folded together, and **184 of the
remaining lots came back as "model X is priced and weighted — should have been
costed"**: 8030 (50 lots), 9058 (42), 9028 (38), 8051 (15), 5535 (14), 8069 (8),
9050 (8), 5527 (3), 8050 (3), 5119 (2), 3068 (1).

The lot's own date was the problem.

```js
const dayOf = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getTime() : null);
```

`l.received_at::date` arrives from postgres.js as a **JS Date**, not a string.
`String(new Date(...))` is `"Mon Sep 07 2026 00:00:00 GMT+0000"`, so `.slice(0, 10)`
is `"Mon Sep 0"` and the parse yields **NaN — not null**. The two readers then
diverged in opposite directions, and both looked like they had worked:

- `sofaBookCost` starts at `bestGap = Infinity` and takes a candidate only when
  `g < bestGap`. `NaN < Infinity` is **false**, so `best` stayed `null` and
  **every sofa was reported as unpriceable**.
- `nearestReceipt` seeds `best = rs[0]` before the loop and its comparison fails
  the same way, so it **returned the OLDEST priced receipt** — silently, while
  the log said "the book's nearest receipt of this item".

So the 34 lots that WERE costed carry a real receipt cost that is not the one the
run log claimed. This is CLAUDE.md's *check that answers a different question*: a
successful-looking result that is also true of a smaller, wrong answer. Nothing
threw, nothing was empty, and the verification passed — because every assertion
it made was about counts, and the counts were right.

**A second, independent miss in the same run.** 32 lots carry a whole-sofa code —
`8030-1S`, `2379-1S`, `5527-1S` and the like. The mapping folds `AMN-SF9058 SOFA`
onto `9058-1S`, so the book prices those codes **directly**; but the item-level
lookup was gated behind `!isSofa`, so they were pushed into the compartment split,
which has no weight for a whole sofa and therefore produced nothing.

**Fix.** `dayOf` accepts a `Date` as well as a string and returns null on an
unparseable value, and the SQL returns `to_char(l.received_at,'YYYY-MM-DD')` so
the reader never has to guess. The item's own nearest priced receipt is now tried
for sofa lots too, before the compartment split. `RECOST=1` repairs the rows this
bug wrote, under a fingerprint predicate — the stored cost must be **exactly** the
oldest priced receipt of that item AND the corrected rule must give a different
one — because every other write in the file refuses to touch a non-zero cost, and
that refusal is what keeps a settled COGS settled.

**What would have caught it.** Not a type checker: the script is `.mjs` and the
value is `any` all the way down. Not the verification: it counted rows. The thing
that found it was asking the output to say WHY, per row, instead of accepting a
summary that named two possible causes — which is the whole reason
`diag-zero-cost-lots-remaining.mjs` exists.

**Ref.** fix/cost-coverage-round2, 2026-09-09.
