## A restricted salesperson could re-price, re-pay and cancel ANY consignment order [high]

**Symptom.** None until someone noticed a document had changed. Consignment
order doc numbers are enumerable, so a scoped rep with a doc_no could PATCH the
header, override a line price, add or delete a payment, or cancel the order
outright — on an order belonging to a rep they have no relationship with.

**Root cause — the reads were guarded and the writes were not.** `GET /:docNo`,
`/audit-log` and `/payments` all ran `salesDocOutOfScope`. Every one of the TEN
write verbs had COMPANY scope only. So the module correctly refused to SHOW a
rep an order outside their scope, and cheerfully let them WRITE to it.

**This is the second time.** `mfg-sales-orders.ts:806` fixed exactly this on the
Sales Order on 2026-07-22, in these words: *"a scoped salesperson could PATCH /
delete / repay / reassign ANY SO by enumerable doc_no"*, covering *"all four SO
payment verbs, which WRITE money"*. The consignment order is described in-repo
as an SO clone — the clone did not inherit the fix, because a fix applied to one
file is not applied to its copy.

**Fix.** `selfScopedConsignmentBlocked`, a direct mirror of the SO's
`selfScopedSalesBlocked`: company checked FIRST and for everyone (view-all
included, via the degrading three-state sentinel), salesperson checked second
and only for the self-scoped tier, same refusal body byte for byte. It scopes
the LOAD, not a stamp. Company scope was ADDED TO, never replaced. The guard
sits ahead of `coHasDownstream` in every verb so an authorization refusal is
never dressed up as a 409 `co_has_downstream` — the SO's own 2026-07-22 lesson,
now pinned by a test.

27 tests across three layers, including a STRUCTURAL sweep of the route source
so a write verb added later cannot skip the guard and the create's exemption
must be documented to pass. Non-vacuity proved twice by reverting individual
guards.

**Deliberately NOT fixed, and written into the source rather than skipped:** the
CO create takes `body.salespersonId` VERBATIM, while the SO gates it on
`scm.so.attribute_other` and overrides a self-scoped caller's pick. So a scoped
rep can still book a NEW consignment order under another rep's name. That
changes who gets paid, it is a different control from row scope, and the owner's
ruling was about reaching an EXISTING order — so it is his call, not the fix's.

**Lesson.** When a module is a clone, its bug ledger is shared whether anyone
says so or not. Fixing a rule in the original and not grepping for its twin is
how the same defect ships twice — and `check-shared-mirrors` only refereed
`shared/` rule modules, not two route files that are copies of each other.

**Ref.** the SO's fix 2026-07-22, this one 2026-08-13.
