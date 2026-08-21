## A special add-on was costed and never charged, and the exempt lines were the migrated ones [high]

**Symptom** - the owner: *"让收费追上成本."* A priced special add-on on a sofa
line moved `unit_cost_sen` and never moved `unit_price_sen`. It could only ever
reduce margin. The same was true of any line whose product carried
`sell_price_sen = 0`, in any category.

**Root cause (traced, not guessed)** - the selling surcharge reached the
customer through exactly one expression in `mfg-pricing-recompute.ts`,
`effectiveBaseSen + breakdown.unitPriceSen`, behind one gate:

```
const hasAuthoritativeSelling = category !== 'SOFA' && effectiveBaseSen > 0;
```

Both halves of that gate were an exemption. `category !== 'SOFA'` sent every
sofa to a branch that rebuilt the price as `sofaSellingSen + fabricAddonCenti +
extraSen` and never re-added the surcharges - while the COST branch six lines
above it DID re-add its own, as `costSurchargesSen = costBreakdown.unitPriceSen
- costBreakdown.basePriceSen` on top of the module costs. One side of the same
function re-added the surcharge and the other dropped it. `effectiveBaseSen > 0`
then exempted every 0-priced product regardless of category.

**The trap in fixing it.** The exempt populations and the MIGRATED corpus are
very nearly the same set: 10,856 of 13,909 migrated lines are priced 0 and 549
of those are SOFA. A naive `|| surcharges > 0` therefore lands precisely on the
documents the owner's standing "A" ruling protects, and it lands there through
the CREATE path, which passes plain `true` rather than the `'including-zero'`
that #1954 gave the amendment path - and plain `true` reads a stored 0 as "not
provided" and fills a catalogue price anyway.

**Fix** - name the surcharge once as `breakdown.unitPriceSen -
breakdown.basePriceSen` (a subtraction, not a bare `unitPriceSen`, so a
future non-zero selling base cannot silently double-charge), add it to the sofa
branch so both sides of the function agree, and admit a 0-priced line to the
authoritative path when it carries a surcharge. The new arm is made **inert
under `trustOperatorSelling === 'including-zero'`** rather than relying on the
trust overwrite at the end of the function, so the migrated marker blocks it
structurally.

**Lesson** - when one function computes the same quantity twice, once for cost
and once for price, the two expressions must be written so that they cannot
drift - here, literally the same subtraction. And before widening a pricing
gate, count the rows the widened arm newly admits: the exemption you are
removing may be the only thing that was protecting history.

**Also settled** - `specialAddonsSurchargeSen` has no caller in either tree.
It is a WIRING GAP, not dead code: it is what a price-SUBMITTING client (the
drift-gated POS) must call now that the surcharge is charged, and it is inert
only while every add-on is priced 0. Deleting it would remove the fix for a
400 that the first priced add-on will cause.

**Ref** - 2026-08-11, owner decision in person, PR #1973. Pinned in
`backend/src/scm/lib/mfg-pricing-recompute.surcharge.test.ts`. Prod evidence:
read-only run **31452346210** measured the blast radius as **zero live
documents** - 11 of 36 catalogue codes ARE priced, but not one document line
carries any of them in `variants.specials` (SO migrated 0, SO live 0, PO
migrated 0, PO live 0). The same run states the old asymmetry in money: REAL
SELLING exposure 0 sen against REAL COST exposure 755,000 sen on all 27
candidate lines - the margin moved and the price never did.
