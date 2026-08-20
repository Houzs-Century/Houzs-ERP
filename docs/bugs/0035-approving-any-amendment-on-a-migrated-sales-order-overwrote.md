## Approving any amendment on a MIGRATED sales order overwrote its AutoCount price with the catalogue price [high]

**Symptom** - none observed yet, and that is the only reason this is not
critical: the importer never sets `internal_expected_dd`, so a migrated SO is
never processing-locked, never `amendment_eligible`, and cannot reach the
amendment path today. The moment anyone gives such an order a Processing Date
that then elapses, the next approved amendment - **including a QTY-ONLY one** -
rewrites `unit_price_centi` to `mfg_products.sell_price_sen`.

**Root cause (traced, not guessed)** - `recomputeFromSnapshot` takes
`trustOperatorSelling` as its **15th positional parameter**, defaulting to
`false`. `recomputeOneLine` - the amendment path's only pricing entry point -
called it with **14** positional arguments, so the flag could not be passed at
all and every amendment silently got the authoritative behaviour. Three other
call sites (`mfg-sales-orders.ts` 4113 / 7655 / 8181) DO pass it, derived from
`!isPosTabletCaller(c)`, so a web operator's hand-typed price is trusted at
CREATE time and discarded at AMENDMENT time - the same operator, same order,
same price, a different answer depending on which screen they used. A
15-argument positional call is what made the omission invisible; nothing about
it reads as wrong.

Worse for migrated data specifically: an AutoCount sofa is frequently carried as
the whole-set price on ONE lead module line with **0 on its siblings**. Plain
`trustOperatorSelling: true` would not have saved those siblings either - the
existing guard is `manualUnitSelling > 0`, and `trusted(0) -> 10000` is asserted
in `mfg-pricing-recompute.trust.test.ts` - so each 0 sibling would still have
been handed a catalogue price and the set billed several times over.

**Fix** - `TrustSelling = boolean | 'including-zero'`. `recomputeOneLine` gains
an **options object** (`opts.trustOperatorSelling`), not a 5th positional, and
forwards it; `applySoAmendment` reads `linked_ac_docno` off the SO header it was
already loading for `company_id` and passes `'including-zero'` for a migrated
order, `false` otherwise - so NATIVE orders keep today's authoritative
behaviour exactly. `'including-zero'` treats a stored 0 as a real price.

Converting `recomputeFromSnapshot`'s 14 optional positionals to an options object
was considered and **deliberately not done**: it has 14 call sites, 9 of them in
a 10,000-line route file several agents are editing concurrently, and a
mis-shuffled argument there is a money bug with no type error. The options object
was introduced at `recomputeOneLine` instead, which has exactly two call sites.
The regression guard is behavioural rather than structural: three tests drive
`recomputeOneLine` through a stubbed client, and dropping the forwarded argument
fails two of them (verified by reverting the line).

**Ref** - 2026-08-11, PR #1954 (fix/so-amendment-migrated-price).
