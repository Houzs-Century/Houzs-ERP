## One column had five titles, and the note under it was a data contract nobody had counted the readers of [high]

<!-- area: Purchase orders + GRN + PI -->

**What the owner asked for.** Unify the provenance vocabulary, including the
stored note. He was given the recommendation NOT to touch the stored note — it is
a data contract, not a label, and a backfill risks provenance on existing POs —
and chose to unify anyway (2026-08-18). So it is unified, in the one order that
makes it safe.

**The stored note, and why the order matters.** A PO raised by the MRP
shortage->PO convert carries NO per-line `so_item_id`. Its
`purchase_orders.notes` — `From SOs: <doc>, <doc>` — is therefore the ONLY
record of which Sales Orders it was bought for. `document-conversion.md` §9 said
**three** regexes parse it back. Counted from source, there are **eight**
readers, and the three the write-up missed are the dangerous ones: they are SQL
predicates (`notes ~* 'From SOs?:'` in `backfill-po-so-item-links.mjs`,
`audit-mrp-pairing.mjs`, `repair-2990-doc-refs.mjs`) that narrow to candidate
rows BEFORE any JS parser runs. A SQL predicate that knows fewer labels than the
parser does not throw — it makes a prod-touching script report a clean pass over
rows it never fetched.

So every reader learned the new wording AND both old spellings before one byte
of new text was written anywhere. The proof is a corpus file both test suites
read (`backend/tests/fixtures/provenance-note-corpus.json`): 20 notes spanning
both eras, fed to every parser, asserting identical extraction. Run against the
unchanged readers it failed 19 times — exactly the 9 new-form cases x 2 stale
parsers, plus the writer round-trip — and every legacy case passed, which is what
proves the corpus was not simply rewritten to match the new code.

**One home instead of four.** The #2370 rule lived in
`frontend/src/lib/convertScope.tsx`, so it could only ever reach BUTTONS: the
backend writer could not import a frontend `.tsx`, and the `.mjs` scripts cannot
import TypeScript at all. The words moved to
`backend/src/scm/shared/transfer-vocabulary.ts`, mirrored byte-identically into
`frontend/src/vendor/shared/` (refereed by `check-shared-mirrors.mjs` and a
byte-identity test) with a script twin for the `.mjs` side that CI compares on
the same corpus. `convertScope.tsx` re-exports; a test asserts it re-exports
rather than re-declares, by object identity.

**The rule gained the short form it was missing.** A lineage column is 110-160px
and holds a document number, so `Transfer from Sales Order` does not fit — which
is precisely why fifteen headers were hand-written rather than generated. Before
this, the SAME column was titled five ways: `From SO`/`From DO`/`From PO`/`From
GRN`, `Source PO`/`Source GRN`, `Transfer From (SO)`, `Transfer From
(Order)`/`(Receive)`, `Transfer To (DO)`. Now one generated title,
`Transfer From (<DOC>)`, across 24 sites.

**Two defects found while unifying, both fixed.**

1. `purchase-order-pdf.ts`'s private copy of the regex omitted the `m` flag, so a
   note whose label sat on line 2 printed NO source SO on the PRINTED PO while
   the relationship map beside it showed one. It also decided single-vs-multi
   source with `.includes(',')`, so a trailing comma read as multi-source.
2. `PurchaseConsignmentReceives`'s `source_po` column showed a PURCHASE ORDER
   number under `Transfer From (Order)` — the identical header the `pc_number`
   column two columns away uses for a CONSIGNMENT ORDER number.

**Deliberately not renamed.** Three columns still read `Source PO`
(`SalesInvoicesListV2`, `MfgDeliveryOrdersListV2`, `mobile/source-chips.tsx`).
They name the PO the GOODS came from, resolved from `batch_no` on the stock
ledger, and can read "STOCK ADJ". A Sales Invoice is never transferred FROM a
Purchase Order; titling them `Transfer From (PO)` would assert a lineage that
does not exist. Different relationship, different words.

**The backfill is shipped and has NOT been run.**
`relabel-provenance-notes.mjs` + its workflow: dry-run by default, census by
exact form per company first, refuses any row whose doc numbers would change,
writes a complete `{id, po_number, company_id, before, after}` manifest as a
90-day artifact on EVERY run (a dry run's manifest is the review copy), updates
`WHERE notes = <exact prior value>`, then RE-READS every touched row and
re-parses it — the invariant is proven against the bytes the database holds, not
against the string the plan computed. Idempotent by identity. `MODE=revert`
restores from the manifest, and only where the row still holds exactly what the
migration wrote. Exercised end to end against an in-memory driver: 7 of 12 rows
migrated, second apply wrote zero, revert returned every note byte-exact. The
post-condition was then verified non-vacuous by corrupting one write and
confirming the job fails and prints the revert command.

**What review found in the rollback, and what it now does.** The rollback could
not restore the rows its own failure message pointed at, and said it had.
`MODE=revert` updates `WHERE id = <id> AND notes = <after>` — only rows still
holding exactly what the migration wrote. But every row that can trip the
post-condition is, by construction, a row whose `notes` is NOT `after`: the
violation is literally "stored bytes are not what was written". So the apply run
would fail, print `Revert with the manifest artifact`, and the revert it named
would match zero of those rows — reporting each through `warn()` (a
`::warning::` does not fail an Actions job) and ending on an unconditional
`process.exit(0)`. A green job, an operator who believes the rollback completed,
and the corrupted provenance still there. Three changes: an unrestorable row is
now a `fail()` with its PO number and exits NON-ZERO; a revert that restores
zero of a non-empty manifest is itself a failure; and the apply run's
instruction now says plainly that rows flagged "stored bytes are not what was
written" will NOT be restored by that command and must be recovered by hand from
the manifest's `before`.

A DRY-RUN revert was weaker still — `if (!APPLY) continue` skipped the loop
entirely and then printed `would attempt N restore(s)`, N being the manifest's
own length, which is true even when not one row could come back. It now READS
each row and answers the question actually being asked: how many would restore.

**The rollback route itself was inoperable.** The workflow's header documented
"download the manifest artifact from the run, then dispatch with mode=revert",
but the job had no `download-artifact` step and no input carrying the manifest's
CONTENTS — only a path defaulting to `out/relabel-provenance-notes.json`, which
does not exist in a fresh checkout. `readFileSync` would throw ENOENT during the
one event the path exists for. There is now a `manifest_run_id` input and a
`download-artifact` step (with `actions: read`) that pulls the apply run's
artifact into `backend/out/`, and the script answers a missing manifest with a
sentence naming the fix instead of a stack trace.

**The leftover count was miscounting successes as failures.** The closing check
excluded rows matching `^\s*Transfer from Sales Order:`. Postgres ARE is not
newline-sensitive by default, so `^` anchors to the start of the whole string
and `\s*` cannot consume `Rush job.\n` — a correctly migrated multi-line note
(a first-class case the corpus carries) was counted as NOT migrated. The
predicate now asks whether the note contains the current label at all, which
needs no anchor and no newline flag.

**The rename had left three screens speaking two languages.** `GoodsReceivedDetailV2`
showed `From PO HC-PO-…` in its header and `Transfer From (PO)  HC-PO-…` in the
Receipt-info grid below it; `SalesInvoiceDetailV2` and `DeliveryReturnDetailV2`
the same, and four list pages kept the old wording in the card view while the
table and drawer used the new one. Before this PR each of those screens said one
thing. Eight hand-written labels now call `transferFromColumnLabel` like the
other twenty-four sites, so the count of live wordings for that relationship is
one everywhere it is a document lineage.
