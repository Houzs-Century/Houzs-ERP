## A migrated goods receipt cancelled reversing 879 units it never received [critical]

<!-- area: Cutover + migrated data -->

**Symptom.** Not reported by staff — found by reading `grns.ts` on 2026-09-07,
the night before the Company 1 go-live, and reachable by anyone with the Cancel
button. `PATCH /grns/:id/cancel` on one of the 320 migrated goods receipts writes
a reversing inventory OUT per line. Across the live migrated set that is **879
units** taken out of a balance those documents never added to.

Nothing would have looked wrong at the time: the cancel returns 200, the audit
row says "Reversing receipt of N line(s)", and on-hand simply becomes quietly
lower. Against a balance being re-seeded from a fresh AutoCount snapshot the same
night, it is a silent loss with nothing to trace it back to.

**Root cause (traced, not guessed).** Two ways to build a reversal, and this
codebase uses both without the difference being visible from either name:

| | reads | migrated document, 0 movements |
|---|---|---|
| **LINE-derived** | the document's own LINES | writes N rows for stock that never moved |
| **MOVEMENT-derived** | `inventory_movements` for this document | writes nothing, correctly |

`buildGrnCancelReversals` (`backend/src/scm/lib/grn-cancel-reversal.ts:58`) maps
`grn_items` rows to OUT rows. `fn_reverse_do_out` (mig 0307) and
`buildDoReversalRows` both key on
`inventory_movements WHERE source_doc_type='DO'`. So the DELIVERY cancel path is
safe by construction and the GOODS RECEIPT cancel path is not — and
`grns.ts` contained **zero occurrences** of `migrated_no_stock`, the column
migration 0276 added precisely to mark documents with no ledger behind them.

**Why the existing guard does not catch it, which is the part worth remembering.**
`grnReverseWouldGoNegative` asks whether the units are on hand. They are. They
came from the AutoCount balance snapshot rather than from this document, and the
guard cannot see the difference, so it PASSES — which is exactly why the path
reads as protected. A guard that answers a different question is worse than no
guard.

**The same shape elsewhere, found by sweeping every movement writer.** Six more
sites assumed a document's ledger matches its lines. The worst is not a cancel at
all: `resyncInventoryForDo` computes `delta = target_qty − current_net_out`, and
a migrated DO's `current_net_out` is 0 for every bucket, so **editing one line
writes a full OUT for every line on the document**. Reachable from three routes
(`POST /:id/items`, `PATCH /:id/items/:itemId`, `DELETE /:id/items/:itemId`).

**Fix.** `migrated_no_stock` is now read at all seven sites, and the stock
effects are skipped exactly as they already were for a DRAFT — the shape this
file already used for "this document committed nothing":

| file | site | what no longer fires |
|---|---|---|
| `backend/src/scm/routes/grns.ts` | `PATCH /:id/cancel` | reversing OUT per line, rack reversal |
| `backend/src/scm/routes/grns.ts` | `PATCH /:id` | warehouse-relocate OUT + IN |
| `backend/src/scm/routes/grns.ts` | `POST /:id/items` | phantom IN on a line add |
| `backend/src/scm/routes/grns.ts` | `PATCH /:id/items/:itemId` | delta OUT on a qty reduction |
| `backend/src/scm/routes/grns.ts` | `DELETE /:id/items/:itemId` | reversing OUT on a line delete |
| `backend/src/scm/routes/delivery-orders-mfg.ts` | `resyncInventoryForDo` | a full OUT for every line |
| `backend/src/scm/routes/delivery-orders-mfg.ts` | `deductInventoryForDo` | a fresh OUT after revert-then-reship |

PAPERWORK IS NOT SKIPPED. The PO `received_qty` recount, the audit row, the
AutoCount cancel enqueue and the header money recompute all still run; only the
stock moves are suppressed. The cancel audit note now says no stock was reversed
and stamps `qtyReversed` 0 rather than the line total — a number no movement
backs is the same lie the reversal was.

`grnReverseWouldGoNegative` is skipped for these documents too, for the reason
that function already skips service lines: with no IN to reverse, "the goods were
already consumed downstream" names a cause that does not exist, and it would make
a migrated receipt permanently un-cancellable the day its snapshot units happened
to ship.

**PROVED RED ON THE UNFIXED TREE, both halves.**
`backend/tests/migratedNoStockReversal.test.ts` and
`backend/tests/migratedNoStockDoResync.test.ts` drive the real code against a
fake PostgREST, with `inventory_balances` covering the reversal in full and
`inventory_movements` empty — the exact production shape.

- GRN cancel, before the guard: `1 failed | 1 passed`, two OUT rows written
  (`qty` 5 and 3, `notes: 'GRN cancelled — reversing receipt'`).
- DO resync, with the guard temporarily disabled: `1 failed | 1 passed`, two OUT
  rows (`notes: 'Resync: line qty increased / line added (shipped DO).'`).
- Both suites after the fix: `2 passed` each. The NON-migrated control in each
  file still writes its reversal, so the guard does not swallow the real one.

Each handler was made testable by an extraction only — `cancelGrnCommand` is
exported from `grns.ts`, `resyncInventoryForDo` from `delivery-orders-mfg.ts`.
Neither body changed in the extraction commit, and that commit is the one that
shows the tests red.

**Whether it already happened in production: UNKNOWN at the time of writing.**
`backend/scripts/check-migrated-cancel-exposure.mjs` +
`.github/workflows/migrated-cancel-exposure.yml` answer it (read-only, one
statement per question, manual trigger, own concurrency group). Q2 is the one
that decides whether stock is wrong today; Q4 separates "a cancel happened" from
"a reversal was written", because the two can disagree in both directions.

**Ref.** `fix/migrated-no-stock-cancel-guard`, 2026-09-07.
