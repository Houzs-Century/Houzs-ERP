## The allocation gate quotes the owner's Processing-Date rule and then reads a different column [high]

<!-- area: Sales orders + pricing -->

**Symptom.** An order shows a Processing Date on screen, is locked for editing,
sits on the Delivery Planning board and has been pushed to AutoCount as `PDate` —
and never reaches READY_TO_SHIP. Every line stays PENDING with the stock
physically on the floor. No error, no log line, nothing on screen says why. The
module guide has been calling this "the single most common 'why is my order not
READY'" and labelling it **intended**.

**Root cause (traced, read-only, on `origin/main` `12322f31b`).**
`backend/src/scm/lib/so-stock-allocation.ts:211-218` carries a comment titled
*"Processing-date allocation gate"* quoting the owner verbatim (2026-08-10:
*"有 processing date 才来分配"*). The predicate underneath it, at `:219`, is
`orders.filter((o) => !o.proceeded_at)` — and the `.select()` at `:190` never
fetches `processing_date`. Two different columns.

They diverge on the ORDINARY path. Every surface that sets a Processing Date
writes `processing_date` and leaves `proceeded_at` NULL: the SO Detail screen,
both mobile surfaces, the amendment approve, the 2990 mirror. `proceeded_at` has
exactly two writers left — create-time auto-proceed
(`routes/mfg-sales-orders.ts:4984`) and `PATCH /:docNo/status` → IN_PRODUCTION
(`:5838`) — and **no shipped client reaches either after create**:
`grep -rn "proceededAt" frontend/` returns 0, and nothing in `frontend/src` POSTs
`IN_PRODUCTION` (14 hits, all labels and constants). So an order created without a
Processing Date — which is every AutoCount-imported order, since
`backend/scripts/import-ac-outstanding-so.mjs` writes neither a processing nor a
delivery date — and then given one on the detail screen is proceeded by the
owner's rule, locked by `soProcessingLocked`, on the board, and invisible to
allocation.

This is the unfinished half of the 2026-08-13 unification, and the repo already
said so: `backend/scripts/unify-processing-date.mjs` states in its own header that
`so-stock-allocation.ts` gates on `proceeded_at`, that it does not touch or drop
that column, and that **"the reader flip must wait until this reports zero
remaining on EVERY company"**. Both companies reported zero on 2026-08-13; mig
`0286` then renamed `internal_expected_dd` → `processing_date`. The reader flip
was never done, and nothing re-manufactures the split as loudly as the ordinary
UI path now does.

Two more things kept it invisible. `backend/tests/soAllocationReadShape.test.ts`
sets `proceeded_at` non-null in its fixture, so the gate never fires in test — it
pins the read shape, not the rule. And no migration under
`backend/src/db/migrations-pg` ever back-fills `proceeded_at` from
`processing_date` (13 SQL hits on the name, all DDL, no `UPDATE`).

**Fix.** NOT in this PR — this is a docs-only change and other workflows own the
source files right now. The fix is one line plus one column: read
`processing_date` at `:219` and add it to the select at `:190`. It is independent
of every rename in `docs/modules/dates.md` and should land first and alone.
Retiring `proceeded_at` afterwards must go the long way — stop accepting
`['proceededAt','proceeded_at']` in the header PATCH map, keep stamping for one
release, then stop reading, then drop the column in a LATER deploy, never the
same one, for the reason mig `0189` records (migrations run before
`wrangler deploy`, so the old Worker meets the new schema).

**Doc corrections shipped with this entry.** `docs/modules/sales-order.md` §0.2
no longer calls the current reading "intended"; the same file's claims that POS
Proceed "never writes `processing_date`" (it does — `:5821`), that the allocator
"sorts by" `proceeded_at` (it gates on it), and that *every* server write path
runs the pair rule (`routes/so-mirror.ts` deliberately does not) are corrected in
place, and a stale three-row table that had been left standing above its own
corrections is deleted rather than appended to. The full census is the new
`docs/modules/dates.md`.
