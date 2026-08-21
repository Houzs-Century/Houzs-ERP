## The inch mark was typed three ways and each one priced differently [medium]

**Symptom.** Found while quantifying the total-height shortfall (the entry
above), not reported: 2990's live `totalHeights` pool lists `17“`, `19“`, `25”`
and `27“` — curly — right next to straight-quoted `18"` and `26"`. One document
line stores its gap as `12“`. Products · Maintenance therefore shows the same
kind of value two different ways, and a line whose spelling did not match the
pool's priced its surcharge at 0.

**Root cause (traced, not guessed).** Every maintenance-pool lookup in
`scm/shared/mfg-pricing.ts` is `pool.find((o) => o.value === value)`. `"`
(U+0022), `“` (U+201C), `”` (U+201D) and `″` (U+2033) are four distinct strings,
so `18"` and `18“` are unrelated keys — and a miss returns 0, which is
indistinguishable from a tier that is genuinely free. That is the same failure
shape as the missing `totalHeight` argument in the entry above, arriving by a
different road: a value silently worth nothing.

Curly marks are what a phone keyboard and a paste out of Word produce, and the
Maintenance screen accepts whatever is typed.

**Fix.** `findOption` — exact match first, then a quote-insensitive one. The
ordering is the whole safety argument: **no line that already matches can be
re-priced**, so the pools that carry one height twice under different spellings
AND different prices (supplier `07204b99` has `19“` at RM120 and `19"` at RM40)
keep resolving exactly as they do today. Only a value that matches nothing —
and therefore prices at 0 — can start matching. Deliberately narrow: quote
characters only, no trim, no case folding; this same string family also composes
`variant_key`, which is the inventory bucket identity.

**The data is a SEPARATE, refusable step.** `scripts/normalise-maintenance-quotes.mjs`
straightens the stored pool values, but it ADDS a config version rather than
rewriting one (the table is versioned and the app reads the newest row), and it
REFUSES any pool where two spellings would fold together at different prices —
merging those leaves two identical keys whose answer depends on array order, i.e.
the ambiguity made permanent instead of removed. Which price is right is a
business fact nobody wrote down.

**What was NOT done, deliberately.** Stored document `variants` are untouched.
`gap` / `divanHeight` / `legHeight` are components of `variant_key`
(`fabriccode=bf-01|gap=8"|divanheight=14"|legheight=2"`), so rewriting one moves
that line's inventory bucket. The lookup fix makes the rewrite unnecessary for
pricing, which is the only place the mismatch cost money.

**Also found, not fixed (needs pricing, not code).** Ten bedframe PO lines carry
a total height that is in NO pool at all — `8"` ×7, `9"`, `30"`, `40"` — so their
surcharge is 0 by absence rather than by price. `8"` is shorter than the cheapest
listed tier (`10"` = RM400).

**Ref.** PR (branch `fix/maintenance-pool-smart-quotes`), 2026-08-17.
Tests: `backend/tests/mfgPricingSmartQuotes.test.ts`,
`backend/tests/maintenanceQuoteNormalise.test.ts`.
