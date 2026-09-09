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

**Fix.** Pending — see the branch. Nothing has been cancelled: cancelling a
queued row is irreversible (it only returns if the document is saved again), so
the list comes first.

**Ref.** `fix/ac-writeback-suppress-repairs`, 2026-09-09.
