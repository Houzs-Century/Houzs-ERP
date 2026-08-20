## A priced SOFA special add-on is costed but never charged [med]

**Symptom** - `scm.special_addons` rows carry `selling_price_sen` and
`cost_price_sen`, and the SOFA-category rows are priced like the BEDFRAME ones
(`Seat Behind Extend 5"` 50000/50000, `5540 Backrest` 5000/5000). Picking such
an add-on on a sofa line raises the line's COST by the add-on's cost price but
never raises what the customer is charged. Margin moves the wrong way, silently,
and a director who prices a sofa add-on gets no revenue from it.

**Root cause (traced, not guessed)** - the selling and cost paths disagree about
whether SOFA takes the specials surcharge.

- SELLING: `mfg-pricing.ts:400` computes `specialsSurchargeSen` for SOFA from
  `maintenanceConfig.sofaSpecials`, and `:408-415` folds it into
  `breakdown.unitPriceSen`. But `mfg-pricing-recompute.ts` consumes that value in
  exactly one place - `:435`, `authoritativeSellingSen = effectiveBaseSen +
  breakdown.unitPriceSen` - and `:436` gates it on
  `category !== 'SOFA' && effectiveBaseSen > 0`. The SOFA branch prices from
  `computeSofaSellingSen + fabricAddonCenti + extraSen` (`:563`) and never adds
  the specials surcharge; the un-priceable sofa falls through to the operator's
  own price (`:571`). In the whole recompute file `specialsSurchargeSen`
  otherwise appears only in a comment (`:369`) and as the persisted REPORTING
  field `special_order_sen` (`:603`).
- COST: `:463` sets `unitCostSen = costBreakdown.unitPriceSen`, which includes
  the specials cost for every category, and the sofa module-cost branch then
  re-adds the same surcharges (`:490-491`) - its own comment says "line-level
  cost surcharges (sofa leg / specials) stay on top".

The client cannot compensate either: `specialAddonsSurchargeSen`
(`mfg-pricing.ts:275`), whose docstring says "the POS configurator adds this to
the line's live total so it matches the server recompute", has **no callers** in
`backend/src` or `frontend/src`.

**Fix** - none yet; recorded here because it changes an owner pricing decision
rather than being a safe unilateral edit. Either the sofa selling path should add
`breakdown.specialsSurchargeSen` the way the cost path does, or the SOFA add-on
rows should not carry a selling price. Whichever way it is settled, selling and
cost must agree - today they cannot both be right.

**Lesson** - a surcharge that is computed is not a surcharge that is charged.
`specialsSurchargeSen` was present in the breakdown, persisted to a column named
`special_order_sen`, and visible in reports, which made it look live; the money
question is only ever answered by tracing which branch writes
`unitToPersistSen`.

**Ref** - fix/special-addon-prices-from-autocount, 2026-08-11
