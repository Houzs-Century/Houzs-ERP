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
