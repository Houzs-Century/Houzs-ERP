## Nothing had ever counted how many migrated documents disagree [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner found three separate migrated sales orders whose AutoCount
lines were in a different order from the ERP's — one of them still holding a line
he had deleted, at `Qty 0`. Each was found the same way: by opening the document
and looking. After the third:

> 「之后有问题吗？我不要每次都来 fix 啊」

He chose to measure the whole population rather than keep repairing documents one
at a time as somebody trips over them.

**Why the population was unknown.** Not an oversight — there was nowhere to read
it from:

* The ERP's AutoCount mirror `public.sales_orders` is **header-only**, 25
  columns, no lines. Line order exists nowhere on this side.
* `/doc-read` answers for ONE document. Asking it ~2,700 times is far past what a
  single Worker request survives — this system has already measured that ceiling
  at 503 `Worker exceeded resource limits` after 39 seconds.
* `composeSoState` is ~7 database reads per document, so composing the
  comparison side per-document has the same problem twice over.

**Why it is not a defect in the sync.** A document the ERP CREATES is laid down
in the ERP's own line order, and since `docs/bugs/0607` an add or delete rebuilds
the whole document. The MIGRATED ones were written by AutoCount before the ERP
ever saw them, and an ordinary keyed edit deliberately does not reorder anything
in the book (`scm/lib/ac-line-order.ts` says so in its own words). So these
documents were never going to match, nothing was ever going to fix them
incidentally, and nothing had ever counted them.

**Fix.** Two halves, both read-only.

* `AcSyncService` gains `/line-fingerprints`: ONE SELECT returning every
  document's number, line count and ordered item codes. The whole question in a
  single round trip.
* `POST /autocount-outbox/line-order-sweep` compares that against what a real
  send would produce and classifies each document — `match`, `order`,
  `extra_in_book` (the deleted-line case), `missing_in_book`, `different`,
  `not_in_book`, `cannot_compose`.

**It reuses the send's own machinery, deliberately.** `composeDetails` builds the
expected list, so a sofa's compartment lines collapse the way a send collapses
them; `live()` drops cancelled lines the way a send drops them; `bindingsFor` is
now exported and resolves supplier codes with `material_kind`, `ac_item_code`
before `supplier_sku`, and `is_main_supplier` first. **A hand-written binding read
here got all three of those wrong on the first attempt** and would have
mis-stated real documents — which is the entry's second lesson: the module that
owns a rule is the one to call, not the one to imitate.

**`cannot_compose` is a verdict, not a finding.** A sofa build the gate refuses
or an item code the cutover map does not carry means we cannot say what a send
WOULD do. Reporting that as a mismatch would invent a defect out of our own
inability, so it is counted and deliberately kept off the list of documents to go
and fix.

**Verified.** `backend/tests/acLineOrderSweep.test.ts` — 18 tests over the pure
comparison, including the duplicate-line case a set comparison would silently
cancel out, the empty-document case `''.split('|')` gets wrong, and the ordering
between the two non-comparison verdicts. 701 pass across the 26 AutoCount suites.
`build-local.ps1` — `COMPILES CLEAN - 112640 bytes`.

**UNTESTED against the live book, and it cannot be otherwise yet.**
`/line-fingerprints` is host code, so the sweep answers 502 until
`deploy-on-host.ps1` runs on the office machine. **No sweep has been run and no
population figure exists** — the count in this entry is the count of documents
nobody has measured, which is the whole point of it.

**Ref.** feat/sweep-migrated-line-order, 2026-09-03. Follows
`docs/bugs/0633-the-host-only-rebuilt-when-a-line-happened-to-be-keyless.md`,
which had to be fixed first for a rebuild to repair anything this finds.
