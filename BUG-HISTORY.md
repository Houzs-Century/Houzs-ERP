## Adding a line at RM 0 took the catalogue price; editing one to RM 0 did not [medium]
## The money rename cut the 2990 mirror: payments loud, totals silent [high]

**Symptom.** Two at once, 2026-08-19. Loud: 2990's outbox drainer failing every
10 seconds — `null value in column "amount_sen" of relation
"mfg_sales_order_payments" violates not-null constraint`, five rows per burst in
the Postgres log, from the moment migration 0305 deployed. Quiet: an operator's
SO amendment on `2990-SO-2608-006` bounced with the generic "operation was
rolled back" — which is what sent anyone looking at the logs at all.

**Root cause (traced, not guessed).** Migration 0305 renamed every money column
`*_centi` → `*_sen` — 30 across the SO trio alone (`mfg_sales_orders` ×20,
`mfg_sales_order_items` ×9, `mfg_sales_order_payments.amount`). 2990 is a
SEPARATE repository on its own deploy schedule, so its pg_cron drainer kept
POSTing the old names — including rows already queued before the deploy.

`applyMap` in the mirror receiver filters an inbound row against the DEST
table's columns and drops anything it does not recognise. So every money field
arriving under its old name was dropped: the payments INSERT then died on
`amount_sen`'s NOT NULL (loud, retried forever), while header and item money
columns are nullable and went NULL **silently under a 200** — a mirrored order
losing its totals with no error anywhere.

**The receiver's own header had already predicted this**, for the Processing
Date rename: `SO_HEADER_ALIASES` exists precisely because "on the day Houzs
renames a column, 2990 keeps POSTing the old one… no error, this route returns
200, and the value silently stops arriving." The money rename shipped without
anyone adding the 30 aliases that note demands — which is the real defect: a
hand-kept alias list fails exactly when the person renaming doesn't know it
exists.

**Fix.** The `*_centi → *_sen` aliases are now DERIVED from the dest schema in
`mirror-map.ts`: for every dest column `X_sen`, alias `X_centi → X_sen`. Safe by
construction — `aliasInbound` already requires `from` to be GONE from dest and
`to` PRESENT, keeps the new spelling when a payload carries both, and explicit
config aliases win over derived pairs. The next rename is covered the day it
deploys here, with no list to remember.

Proven: removing the derivation turns the regression test red.

**Recovery is the drainer's own retry.** The failed payment rows are still
PENDING in 2990's outbox; once this deploys they deliver on the next cycle.
Header/item money that went NULL during the window self-heals on each SO's next
re-delivery — verify with the mirror sentinel's missing-check rather than
assuming.

**Not claimed:** that this alone explains the amendment failure. That apply
collided with the same window and should be retried after deploy; if it still
fails, it is its own investigation.

**Ref.** PR (branch `fix/mirror-centi-sen-alias`), 2026-08-19.

## An approved amendment could carry any price except RM 0 [medium]

<!-- area: Sales orders + pricing -->

**白话.** 同一个 RM 0，改现有的那一行可以，新增一行就不行 —— 新增的那行会被自动
填回目录价，而且不报错。原因是 8 月 18 号让「打出来的 0」生效的那个开关只接到了
「改行」这条路上，「加行」那条没接。销售看到的就是：同一个金额，点这里可以，点那里
不行。现在两条路一致了。

**Symptom.** In the ERP SO editor, setting an EXISTING line to RM 0 saves as 0.
Adding a NEW line at RM 0 on the same order silently comes back at the catalogue
price. Same amount, same screen, same person — accepted on one click, replaced on
another, with no error either way.

**Root cause (traced).** `'operator-zero'` — the mode that lets a TYPED zero
survive the honest-pricing recompute — was wired to `PATCH /:docNo/items/:itemId`
only. `POST /:docNo/items` passed plain `!(await isPosTabletCaller(c))`, and
plain `true` reads `manualUnitSelling > 0`, so a 0 falls to the catalogue fill.
The editor did not send `zeroPriceIntended` on the ADD payload either, so even a
willing backend had nothing to read.

Found while mapping every path a 0 can take after "saving RM 0 is inconsistent"
was reported. The full map at the time: line PATCH honoured it; ADD did not; the
approved-amendment path did not (fixed separately, #2470); the POS tablet must
not and still does not.

**Fix.** The ADD route selects `'operator-zero'` on the SAME strict terms as the
PATCH — off the POS, only when the price is actually 0, and only on
`zeroPriceIntended === true`. The editor sends the claim on a staged ADD exactly
as it does on an edit. `isPosTabletCaller` is now resolved ONCE into
`addLinePosTablet` rather than awaited twice in one expression.

`operatorZeroPriceWiring.test.ts` grew with it: the "selected in exactly ONE
place" assertion becomes TWO, each with its own strictness assertion, plus a
shape-independent backstop that fails if any selection of the mode appears
without the claim near it. The count is deliberately kept exact — a third
occurrence should be a decision, not a diff nobody read.

**Deliberately unchanged: an approved AMENDMENT's ADD line.** That path carries
no `zeroPriceIntended` — it has only `new_unit_price_sen`, which cannot
distinguish a typed 0 from an unfilled field — so it still reads 0 as "not
provided" and takes the catalogue figure. See `addLineTrust` in so-revision.ts
and the test that pins it. The difference is the CLAIM, not the operation.

**Ref.** fix/add-line-operator-zero, 2026-08-19. Completes #2425 + #2470.

