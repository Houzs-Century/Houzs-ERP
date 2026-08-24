## Adding a SOFA to an existing order queued nothing for AutoCount - an early return past the hook [high]

**Symptom** - none visible: the order saves, the compartments appear, and the
account book simply never hears about them. It would have surfaced after go-live
as sofas silently missing from AutoCount on orders that were otherwise syncing.

**Root cause (traced, not guessed)** - `POST /:docNo/items` has TWO insert paths.
The ordinary one inserts a row and calls `queueAcSoEdit`. The SOFA branch inserts
its N compartment rows, reconciles the free gift, re-derives the delivery fee,
records the audit row, recomputes allocation - and then
`return c.json({ item: firstRow }, 201)`. There is no `queueAcSoEdit` anywhere
between the insert and that return.

The same shape as the `convertSosToPosCore` gap already in this ledger: an early
return past the hook. It survived `tests/autocountWritebackWiring.test.ts`
because that suite greps the ROUTER FILE as a whole for its anchors, and the
anchor is present - in the other branch.

**Fix** - the sofa branch queues an edit before returning, declaring every row
the insert returned so the whole build can go as new lines. The pin is a test
that slices the branch out of the router source and asserts the call is INSIDE
it - a file-wide grep cannot tell one branch from another.

**Ref** - feat/ac-ensure-masters, 2026-08-11.
