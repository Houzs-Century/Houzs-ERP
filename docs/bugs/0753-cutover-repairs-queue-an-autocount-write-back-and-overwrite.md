## Cutover repairs queue an AutoCount write-back and overwrite the account book [high]

**Symptom.** The owner opened the AutoCount write-back page on 2026-09-09 and
found **173 sales orders WAITING**, all queued that day, and asked whether it
was us:

> 「正常来说你的这批更改不应该是syncback autocount啊 应该remain啊」
> 「你不可以有记录再这边啊 这是你import进来的错误 所以没有影响这些啊」

He is right. A cutover repair COPIES a value out of the account book. Sending
that same value back is pointless at best, and where the repair and the book
disagree it overwrites his single source of truth with our version.

**Observed so far (PROVEN).** Health report run `34332967454`, 2026-09-09
09:08 UTC, against production:

```
queue: 618 row(s) — pending 115 / sent 435 / failed 18 / skipped 50
  - edit  SENT 370 (of 533: failed 1, skipped 49, pending 113)
```

Against the same report at 08:0x (run `34331766799`, quoted in the brief):
`pending 167 / sent 381`, `edit SENT 316`. **The queue is draining while this
is being written** — 54 further rows reached the live account book between the
two runs.

The stuck-row listing shows 36 of the pending rows are `edit` on MIGRATED sales
orders, all queued in the same minute (`queued=2026-09-09T08:48`), all with
`erpRaised=2026-08-28T08:11` (the import timestamp) and an AutoCount-shaped
`linked_ac_docno` (`sentAs="SO-013376" DIFFERS FROM ERP doc_no
"HC-SO-013376"`). A single burst on cutover-imported documents is not staff
activity.

Two pending rows in the same window are the opposite and must be preserved:
`HC-PO-2609-036` (`create_po`, `erpRaised=2026-09-09T08:58`) and
`HC-PO-2609-035` (`so_to_po`, 08:57) are ERP-raised documents from today.

**Root cause — NOT YET TRACED. This is the open question.** The repair scripts
(`topup-ac-lines-from-truth.mjs` and siblings) write **direct SQL** over
`DATABASE_URL` and never call `enqueueAcOp`, so on the face of it they cannot
enqueue anything. Two candidates remain, and neither is yet observed:

1. a path that uses `scripts/lib/pgrest-shim.mjs` and calls a real service
   function out of `src/`, getting the enqueue for free
   (`rebuild-ac-document.mjs`, `requeue-autocount-skipped.mjs`,
   `recompose-autocount-transfer.mjs`, `sync-ac-delta.mjs` all do this);
2. a database trigger that exists in production and in no migration file here —
   the failure mode CLAUDE.md already records ("the unique index does not
   exist" was wrong about four of them).

`grep` over `backend/src/db/migrations-pg/*.sql` finds no trigger writing to the
outbox, but **that is evidence about the repo, not about production**, which is
why `check-ac-outbox-provenance.mjs` asks `pg_trigger` directly rather than
assuming. The dispatched run of that report is what closes this section; until
then the cause is **UNKNOWN** and is deliberately not written as though it were
known.

**Fix.** Three parts.

1. **A repair can no longer queue a write-back.** Every client
   `scripts/lib/pgrest-shim.mjs` builds is now marked a repair client
   (`src/scm/lib/ac-repair-suppression.ts`), and every enqueue gate in
   `src/scm/lib/autocount-outbox.ts` refuses one. The mark is on the TRANSPORT,
   not in each caller's options, because an option is something ~40 repair
   scripts have to remember and forgetting is silent. It is a `Symbol`, so a
   request body — which can only produce string keys — can never set it.
   Suppressed is the DEFAULT; five tools whose purpose is to push opt back in by
   name, pinned by `tests/acWritebackPushAllowlist.test.mjs` so a sixth cannot
   join by copying a neighbour.

   **Proved RED first.** With the module present and the guard not yet wired in:
   `Tests 5 failed | 6 passed (11)` — the 5 being exactly the suppression cases,
   the 6 being "a request client still queues" and "the mark cannot arrive from
   a request". After wiring: `Tests 11 passed (11)`. `tests/pgrestShim.test.mjs`
   20 passed; backend typecheck clean.

2. **The queued repair rows** — `scripts/cancel-ac-outbox-repair-rows.mjs`.
   Cancel means `status = 'skipped'` with the reason in `last_error`, never a
   DELETE: migration 0277's own comment says the table is the audit trail. The
   apply path takes an EXPLICIT list of row ids and touches nothing else, and
   refuses the whole batch if any named row has stopped being `pending` or
   carries a `created_by`.

3. **What the sent rows did to the book** —
   `scripts/check-ac-writeback-vs-book.mjs` compares the sent payloads against
   `data/ac-reconcile-truth.json.gz` (exported 2026-09-09T00:18:49Z). It does
   not read the live book, and not only to avoid a lock timeout: the live book
   holds TODAY's value, so finding our value there cannot separate "we echoed
   what it already held" from "we overwrote it". Rows sent BEFORE the export are
   reported UNDECIDABLE rather than harmless.

**A CONTRADICTION, NOT BRIDGED.** Part 1 hardens the class, but it does **not**
explain today's rows, and saying otherwise would be the tidy answer rather than
the true one. Measured on this branch:

```
$ grep -c enqueue backend/scripts/recompute-so-allocation.mjs       backend/scripts/repair-so-delivered-from-imported-dos.mjs       backend/scripts/restamp-do-actual-cost.mjs       backend/scripts/backfill-zero-line-costs.ts
0  (all four)
```

Every repair script that now gets a suppressed client **never reached an
enqueue in the first place**, and neither does the SO allocator they drive. So
the suppression changes nothing about today's four scripts: it is a guard
against a class, not a repair of an observed path. The five tools that DO
enqueue are the deliberate push tools, and they keep working by design.

It follows that the path which queued ~36 migrated-SO edits at 08:48 is **still
UNKNOWN**. The remaining candidates are a production trigger absent from this
repo, or a route on the ERP's own API (`so-amendments.ts:952`,
`so-handover.ts:303`, `po-amendments.ts:494`, `so-payment-row.ts:211` all call
`enqueueEdit`), which would leave a `created_by`. `check-ac-outbox-provenance.mjs`
asks both questions — `pg_trigger` directly, and `created_by` per row — and its
production run is what closes this.

**Ref.** `fix/ac-writeback-suppress-repairs`, 2026-09-09.
