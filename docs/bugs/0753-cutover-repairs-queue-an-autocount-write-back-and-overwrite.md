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

**IT IS THREE BURSTS, NOT ONE, AND NO ACTIONS RUN PRODUCED THEM.** Read out of
run `34331486258` ("Why is there no outbox row"), which prints every row's
`created_at`. All three are `edit`/`SO`, sweeping ASCENDING doc_no at a fixed
sub-second cadence:

| burst | window (UTC) | rows | cadence |
| --- | --- | --- | --- |
| C | 08:09:51.97 -> 08:12:08.14 | ~185 | ~0.67 s |
| A | 08:42:30.67 -> 08:43:19.69 | 132 | ~0.33 s |
| B | 08:48:11.73 -> 08:48:25.09 | 46 | ~0.29 s |

Burst B is the "36 rows at 08:48" above. Corroborated by the totals: run
`34315268339` (05:32) `queue: 133 row(s) — pending 0 / sent 110`, `edit SENT 73
(of 79)`; run `34331766799` (08:55) `queue: 616 row(s)`, `edit SENT 316 (of
533)`. **+454 edit rows between 05:32 and 08:55.**

**No GitHub Actions run accounts for any of them**, and this is measured, not
assumed:

- Burst A falls in a hole in the dispatch timeline — nothing ran between
  08:24:10 and 08:45:37. Deploy `34330181129`'s only production-DB step
  (`pg-migrate.mjs`) started 08:44:07, after A ended at 08:43:19.
- Both top-up runs bracket burst B without touching it: `34331065557` was
  `MODE: plan` (`PLAN ONLY — nothing written`) and ended 08:48:11;
  `34331161147` was `MODE: apply` but `LANES: do`, `ONLY_DOCS: DO-011465`,
  `MAX_WRITES: 1`, and started 08:48:32 — after B ended at 08:48:25.
- Burst C runs continuously THROUGH the gaps between the four "Re-file the
  mislabelled sofa purchase lines" runs — rows land at 08:11:09, :10, :11 …
  :27 while no run was executing. One process, not four runs.
- Every enqueue-capable workflow last ran before the window (`sync-ac-delta`
  02:42, `requeue-autocount-skipped` 01:59, `rebuild-ac-document` 09-03).

**So the producer is UNKNOWN and it is OUTSIDE GitHub Actions.** One round trip
per document, strict ascending doc_no, 0.29-0.67 s apart is a Node client
looping — not SQL, and not the `*/5` cron (no burst starts on a 5-minute
boundary). The two remaining candidates are a script run from someone's own
machine against production, or the Worker serving a bulk loop over its own API.
`scm.autocount_outbox.created_by` discriminates them and no run log prints it,
which is what `check-ac-outbox-provenance.mjs` exists to read.

**A CORRECTION TO MY OWN CHECK, recorded because it was wrong in the direction
that flatters the fix.** An earlier revision of this entry said all four newly
suppressed scripts "contain zero enqueue calls", from `grep -c enqueue` over
those files. That grep was too narrow: it sees a direct call and not an
IMPORTED one. Two genuine incidental paths do exist and the guard does close
them:

- `restamp-do-actual-cost.mjs` — `pgrestShim(pg, "scm")` plus
  `await import("../src/scm/routes/delivery-orders-mfg.ts")`, and that module
  holds `enqueueConvert` / `enqueueCancel` / `enqueueEdit`. Last run 2026-08-05.
- `backfill-zero-line-costs.ts` — `pgrestShim(sql)` plus `recomputeTotals` from
  `mfg-sales-orders.ts`, which wraps `enqueueEdit` in `queueAcSoEdit`. Whether
  the call sites sit inside `recomputeTotals`' own body is **UNKNOWN**. Never
  run.

Neither ran today, so neither explains the 454 rows. But the fix is not the
no-op the earlier paragraph made it out to be.

**Ref.** `fix/ac-writeback-suppress-repairs`, 2026-09-09.
