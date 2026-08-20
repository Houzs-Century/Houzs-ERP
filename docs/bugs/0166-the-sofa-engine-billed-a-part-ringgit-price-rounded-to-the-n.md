## The sofa engine billed a part-ringgit price rounded to the nearest ringgit [high]

**Symptom.** Nobody reported it, because the amount is cents and the invoice
looks right. A sofa whose combo is priced RM3152.63 bills **RM3153.00**; one
priced RM5712.11 bills **RM5712.00**. Over-charging on one row, under-charging
on the next, and margin computed against the rounded revenue while cost stays
exact.

**How big, measured not guessed.** Actions -> **Sofa price rounding check
(read-only)**, run 2026-08-14 against production: module SKU flat prices **0**
part-ringgit, seat-height selling overrides **0**, and combo charged prices
**23 of 163**. So the question the ledger held open as B4 — *should a sofa module
ever be priced in cents?* — was already answered by the data: the business
prices in cents, and the engine was rounding it away.

**Root cause.** `SofaProductPricing` carried whole MYR. Inputs arrive in sen,
`sofaCompartmentsFromModulePrices` did `Math.round(sen / 100)` on the way in,
the combo total did `Math.round(comboPriceCenti / 100)`, and
`computeSofaSellingSen` did `Math.round(total * 100)` on the way out. That round
trip is pure loss — up to 50 sen per module and per combo.

**Fix.** The engine carries SEN end to end. Its arithmetic is addition,
subtraction and one integer multiply, so integer sen is strictly better than
fractional MYR: no rounding, and no float either. The public boundary is
unchanged — `computeSofaSellingSen` already took sen and returned sen, so its
one live caller (`mfg-pricing-recompute.ts:613`) needed no change.

**The field was RENAMED, not just re-interpreted.** `price` -> `priceSen`,
`reclinerUpgradePrice` -> `reclinerUpgradeSen`. Changing a unit silently is how a
missed call site becomes 100x wrong with nothing to catch it; renaming makes the
compiler enumerate every site. It found them all — backend and frontend
typecheck both clean on the first run after the change.

**Test.** `backend/src/scm/shared/sofa-price-sen.test.ts` — the engine had NO
arithmetic test before this (`sofa-combo-pricing.test.ts` covers combo
normalisation only). Written as CHARACTERISATION first: three whole-ringgit
cases that must not move, because 140 of the 163 production combos are whole
ringgit and a change there would be a live pricing change; then the three
part-ringgit cases, which reproduced the production deltas exactly (+37 sen on
RM3152.63, -11 sen on RM5712.11) before the fix and are exact after it.

**Ref.** 2026-08-14, ledger B4. **Not covered by this fix:** documents already
priced from those 23 rows carry the rounded figure. Sizing that is a separate
pass and it is recorded in the ledger, not assumed to be nil.
