## The reshape plan compared the money it writes against a column nothing keeps in step [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** `reshape-migrated-grns.mjs` PLAN against production, run
34144939745, 2026-09-08 00:45 local:

```
MONEY — the migrated receipts hold RM 210513.43 today; this plan writes RM 461371.95.
```

A writer whose whole design is "the money is CARRIED, never recomputed" printed a
figure more than double the one it claimed to be carrying, while the unit count
moved only from 879 to 957 (+8.9%). Read as printed, it says the run invents
RM 250,858.52.

**Root cause (traced).** The two figures are not the same shape, so the
comparison never meant what it read as.

- `moneyBefore` summed `grn_items.line_total_sen` — a STORED column, written once
  at import.
- The plan's figure is `qty x unit_price_sen - discount_sen`, COMPUTED, because
  that is what the run writes.

Several repairs have moved `unit_price_sen` on these lines since import without
re-summing the total beside it — `stamp-migrated-source-prices.mjs` is the one
that writes all three together precisely because the app recomputes
`line_total = qty*unit - discount` on every edit (`grns.ts:1654`, `:1885`,
`:2256`). So the stored column and the computed value legitimately disagree, and
comparing the plan against the stored one reports that PRE-EXISTING gap as money
this run created.

**Fix.** The plan now prints three figures and the per-unit rate for each: what
the lines STORE, what those same lines COMPUTE, and what the plan writes. The
computed figure is the like-for-like one and the report says so. It also prints
the movement in money PER UNIT — the invariant that actually holds, because the
unit count legitimately changes (a sofa is one book line and one ERP row per
compartment) while the money per unit must not — and says loudly when that moves
by more than 2%.

Second fix in the same change, found while tracing the first: a line that exists
today now keeps its own money INCLUDING A ZERO. The fallback chain used
`held.unit > 0`, so a line genuinely worth RM 0 fell through to the purchase
order's price, which would have WRITTEN money onto a line that holds none — the
opposite of carrying, and the owner's 空白不覆盖 rule inverted.

The RED measurement is the run above: the plan printed one number where the
honest comparison needs two, and the number it printed was not the one a reader
would act on.

**Ref.** `fix/gr-reshape-money-comparison`, 2026-09-08.
