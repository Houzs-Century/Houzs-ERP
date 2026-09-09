## A helper reaching for the outer connection inside a transaction hung the apply, with `max: 1` in the pool [high]

**Symptom.** The first production apply of the downstream compartment write
STOPPED. Not an error, not a rollback — a job that sat there.
[Run 34320397321](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34320397321),
`DOC=HC-GR-000287 APPLY=1`: `npm ci` succeeded, the step
`node scripts/apply-sofa-compartment-corrections.mjs` went `in_progress` and
printed **nothing at all** — not the `mode=APPLY` banner's successors, not a
plan line, not a failure. The run's own `updated_at` stopped five seconds after
it started. The next dispatch queued behind it in the concurrency group. Both
were cancelled by hand.

The two applies before it, on the two PARENT documents, had both succeeded and
verified — `34320270490` (`HC-SO-000814`) and `34320336262` (`HC-PO-000254`).
Those take the pre-existing code path, which has no transaction-nested read.

**Root cause, traced.** `newSql()` in that script builds the pool with
`max: 1` — one connection, deliberately. `sql.begin` holds it for the whole
callback. The new downstream writer called two helpers from INSIDE that
callback:

```js
await sql.begin(async (tx) => {
  const label = await labelColumnName(spec.table);   // uses the module-level `sql`
  ...
  const hits = await spec.parentOf(templateParentId, a.to);  // ditto
```

Both reach for the module-level `sql`, which asks the pool for a connection —
the one the open transaction is holding. The request waits for a connection that
cannot be released until the request finishes. Nothing times out, nothing
errors: `postgres.js` simply queues it.

**Why it looked like nothing was wrong.** A deadlocked pool is silent. There is
no exception to catch, no statement timeout to trip, and the log's last line is
whatever was printed before the transaction opened — so the failure is
indistinguishable from a slow query against a large table, which is exactly what
an operator would expect an apply to be.

**Nothing was written.** The transaction never committed; cancelling the job
dropped the connection and the server rolled it back. Verified by the state the
next run read: `HC-GR-000287` still held its single `5526-L(LHF)` row.

**Fix.** Every read the write needs is resolved BEFORE the transaction opens —
the label column, the product names, and every parent link — and the block
touches `tx` only. The reads are the same reads; only their position moved.

**Proved RED first.** `tests/sofaDownstreamParityGuards.test.mjs` brace-matches
the `sql.begin` block of `applyDownstreamDoc` and asserts no bare `sql` inside
it, plus that the hoisted reads really are above it. Putting one product-name
read back inside fails it (1 of 12); restored, 12 pass. A source-reading test
because what is being pinned is a POSITION in a call graph, which no unit test
can see — the same argument `sofaCorrectionsCarryToInvoices.test.mjs` makes.

**The general rule, for anything in this repository using `postgres.js`:** these
scripts open pools of one on purpose. **Inside `sql.begin`, only `tx` exists.**
A helper that closes over the outer handle is a deadlock waiting for a caller to
put it in a transaction, and it will present as a hang rather than as a bug.

**Ref.** `fix/sofa-downstream-tx-deadlock`, 2026-09-09.
