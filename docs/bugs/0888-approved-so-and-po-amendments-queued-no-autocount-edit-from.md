## Approved SO and PO amendments queued no AutoCount edit from 2026-09-10 - the transaction client could not run an in-list filter [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** HC-PO-2609-064/A1 (approved 2026-09-14 01:19 UTC, PO -> revision 2)
and HC-SO-013497/A1 + /A2 (01:09, 01:13) were applied in the ERP, but AutoCount
still carried the old sofa pieces (5536-L(LHF), 5536-1NA x2, 5536-1A(RHF)).
`scm.autocount_outbox` held NO row for any of the three — not even `skipped` or
`failed` — while `scm.autocount_writeback` was ON (`"1"`). The only outbox row for
the PO was its original create (2026-09-11). Trace runs 34815098686 / 34814256189.

**How wide (measured, not estimated).** `backend/scripts/check-amendment-ac-writeback.mjs`,
dispatched on production as run 34819514473 (company 1, since go-live
2026-09-07, outbox row within ±2 min of the approval, any op/status):

| | approved before 2026-09-10T10:07:50Z | with an edit row | approved after | with an edit row |
| --- | --- | --- | --- | --- |
| SO amendments | 12 | 12 | 32 | **0** |
| PO amendments | 9 | 9 | 15 | **0** |

Last amendment that queued: HC-PO-2609-049/A3, 2026-09-10 09:36. First that did
not: HC-SO-007869/A2, 2026-09-11 00:53. All 47 misses were on documents that DO
carry a `linked_ac_docno`, so the keyless-document return was not the cause. And
it was not "these documents never queue": company-wide SO `edit` rows kept landing
every day (56-84/day, 09-11..09-14), and HC-SO-008302 took 17 ordinary-save edits
after its missed amendment — only the amendment path was silent.

**Root cause (traced).** Both approve routes run inside `runScmPgCommand` and pass
ITS client to `enqueueEdit`: `routes/so-amendments.ts` `approveSoCommandHandler`
(`await enqueueEdit(sb, …)`) and `routes/po-amendments.ts`
`approvePoAmendmentHandler`. That client is `pgTransactionSupabase`
(`lib/pg-supabase-transaction.ts`), a PostgREST-shaped builder over one postgres.js
transaction, and its `filter()` knew `eq/neq/gt/gte/lt/lte` and THREW
`Unsupported PostgREST filter operator: in` for anything else.

#3545 (7f06b3502, merged 2026-09-10 09:54, Deploy run 34463750229 finished
10:07:50Z — docs/bugs/0780) moved `readMfgProductBindings`
(`lib/supplier-bindings.ts`) from `.in('item_code', batch)` to
`.filter('item_code', 'in', pgrestInList(batch))`, so a quote in an item code
stops truncating the list. `bindingsFor` reads through it on EVERY SO and PO
compose (`composeSoState`, `composePoState`), whatever the codes are. From that
deploy, every amendment's compose threw inside the transaction client. It is the
only commit touching that path between the last amendment that queued and the
first that did not (`git log --since=2026-09-10T09:00Z --until=2026-09-11T00:53Z`
over the outbox, bindings, shim, read and both route files).

The throw was then made INVISIBLE by `noteReadFailure` (`lib/autocount-outbox.ts`):
`if (!refused && !(e instanceof AcReadError)) return [];` — a plain `Error` wrote no
`skipped` row and no log line, and `enqueueEdit` returned `false`, which both
routes ignore by design. So nothing anywhere recorded that an amendment had failed
to reach AutoCount.

Why no test caught it: every `enqueueEdit` test builds its client with
`fake-postgrest.ts`, whose `filter()` DOES implement `in`. Ordinary saves use the
real PostgREST client (`c.get('supabase')`), which also does. Only the transaction
shim did not, and nothing drove `enqueueEdit` through it.

**Fix.**
1. `pgTransactionSupabase.filter(col, 'in', list)` parses the escaped list with
   `parsePgrestInList` (the same grammar PostgREST reads) and compiles it as `IN`,
   so every shared reader built on `pgrestInList` / `pgrestIn` works inside a
   command transaction.
2. `noteReadFailure` no longer returns early for an unnamed error: it is written as
   `skipped` with `compose failed, nothing sent: (<ErrorName>) <message>` and
   logged. A write-back that stops working now leaves a row.

Pinned in `backend/src/scm/lib/pgTransactionInFilter.test.ts`, which drives the
REAL shim over a minimal in-memory SQL executor: the in-list compiles, an empty
list matches nothing, SO and PO `enqueueEdit` through the transaction client write
a `pending` edit, and an unexpected compose error writes a `skipped` row. All red
on the unfixed tree (commit 06979db2d: 4 of 4 failed — `Unsupported PostgREST
filter operator: in` and `expected [] to have a length of 1`).

**Already-affected documents.** `backend/scripts/requeue-amendment-ac-edits.mjs`
(workflow *Requeue amendment AutoCount edits*, plan by default) queues one keyed
edit per document with an amendment approved since the cutoff and no later
`pending`/`sent` edit. Its plan composes each document through the real
`enqueueEdit` inside a transaction that is rolled back.

**Not covered here (UNVERIFIED, from reading the routes only).** Neither approve
route passes `newLineIds`, so an amendment that ADDS a line may be refused as
keyless (`KeylessLineError`) once it does queue. If that is real it predates
2026-09-10, and the requeue plan prints it as a composer refusal per document.

**Ref.** fix/amendment-autocount-writeback, 2026-09-14.
