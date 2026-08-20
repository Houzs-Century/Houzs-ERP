## A GRN line delete could move stock and lose its allocation recompute [high]

**Symptom.** None visible — that is the whole problem. Delete a line from a
posted GRN, and if the Worker died between the reversing stock OUT and the
allocation recompute, SO lines stayed READY while the stock backing them had
just been pulled out. Nothing logged, nothing retried, nothing to see until an
unrelated mutation happened to sweep.

**Root cause (traced, not guessed).** The recompute was a best-effort call AFTER
the write: `recomputeSoStockAllocation(sb)` inside a try/catch, with the source
write already committed through PostgREST. Only a queue row inside the source
write's own transaction can survive that window, and this route had no
transaction to join — `grns.ts` used `runScmPgCommand` in zero places.

Counted on the tree the day this was written: 4 durable call sites against 42
`recomputeSoStockAllocation` call sites.

**Fix.** The route runs inside `runScmPgCommand`, and the recompute is requested
with `scheduleStockAllocationAfterCommand`, whose queue row commits in the same
transaction as the stock movement. It is also no longer swallowed: a failure to
enqueue now fails the delete, because a stock move with no recompute is the
exact state being removed.

**Proof, because this is a transaction property and no unit test can see it.**
`backend/tests-pg/grnLineDeleteAtomicity.pg.test.ts` against real Postgres —
commit leaves the line gone AND the request queued; a throw after the enqueue
leaves NEITHER; a throw before it leaves the line intact; the queue stays a
singleton across two deletes.

**Scope, stated so nobody reads more into it.** ONE of six GRN routes. The other
five are unchanged and still best-effort, `postGrnHandler` last on purpose. The
ledger `stockAllocationDurabilityScope.test.ts` moved 4/33 -> 5/32 in this PR,
which is how progress here is recorded — it FAILS if a count drifts silently.

**Ref.** `feat/grn-line-delete-in-transaction`, 2026-08-20.
