## The money report misused buildLiveIndex and failed on its first dispatch [low]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `priced-specials-money.yml`, dispatched against production for the
first time the moment it reached `main` (run **34138053374**), printed the eleven
priced add-ons correctly and then died:

```
TypeError: liveByCat.get is not a function
    at classifyLine (.../lib/special-order-phrase-mapper.mjs:146:26)
    at main (.../plan-priced-specials-money.mjs:121:19)
```

**Root cause (traced).** `buildLiveIndex(addons)` returns
`{ liveByCat, priceOf, isPriced }`. The script assigned the whole object to a
variable named `liveByCat` and handed it to `classifyLine`, which expects the
Map. `backfill-specials-into-variants.mjs` destructures it correctly on the line
this script was modelled on; the shape was simply not read.

**The second half is the more useful one.** The same block also hand-rolled its
own `priceOf` and `isPriced` instead of taking the ones `buildLiveIndex` returns.
That copy would NOT have failed — it would have quietly been a second opinion
about which lines are priced, next to the predicate the backfill actually uses to
decide what to hold back. A report whose whole purpose is to price the held-back
population must not carry its own definition of "held back". Both are now taken
from the library.

**Fix.** Destructure all three; drop the hand-rolled predicate; key `priceOf` by
the exact code (the library keys it that way, and `classifyLine` returns the
library's own spellings).

**Why it reached production at all.** CLAUDE.md's rule — *"a `workflow_dispatch`
workflow is not shipped until it has been dispatched once and reported
success"* — could not be honoured before merge: GitHub will not dispatch a
workflow that is not on the default branch, so the first possible run was the
first run after merge. The rule still did its job; it just could not run any
earlier. Worth knowing for the next new workflow: **budget the first dispatch as
a post-merge step, and do not report the workflow as working until it has one.**

**Ref.** fix/priced-specials-money-run, 2026-09-07.
