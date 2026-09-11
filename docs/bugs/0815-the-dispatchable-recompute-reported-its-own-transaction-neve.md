## The dispatchable recompute reported its own transaction, never the committed result [high]

<!-- area: Sales orders + pricing -->

**Symptom.** On 2026-09-11 an `APPLY=1` dispatch of *Recompute SO stock
allocation* concluded green and printed `canonical result: ok=true
linesFlipped=710 ordersAdvanced=72 ordersRegressed=0` followed by a 710-row
per-line list of `PENDING(0) -> READY(1)` changes. Re-reading those same rows
from a separate connection found **8** of them changed; 702 were untouched. The
run was believed, quoted to the owner as work completed, and the correction had
to be made afterwards.

**Root cause (read in the source).** `backend/scripts/recompute-so-allocation.mjs`
runs:

```
BEGIN
  before = snapshotLines()
  result = recomputeSoStockAllocation(sb, DOC)
  after  = snapshotLines()
  COMMIT            (when APPLY=1)
```

**`after` is taken INSIDE the transaction, before the COMMIT**, and nothing
re-reads afterwards. So every figure the run prints — the per-line list, `flips`,
the header flips — describes what the transaction INTENDED. A commit that does
not fully land is structurally invisible to this report: the script cannot
notice, and a reader has no way to tell a landed run from an unlanded one,
because they print identically.

The script predates `audit:release-discipline`, whose rule 3 is exactly this —
*"a verification that re-reads on a FRESH connection and asserts the SHAPE"* —
and the gate charges only NEW scripts, so it was never held to it.

**WHY only 8 of 710 persisted is still UNKNOWN and is NOT claimed here.** The
COMMIT reported success; the single-flight lock is held for 15 minutes against a
3-minute run and released under `.eq('locked_by', lockToken)`, so lock-stealing
is ruled out. What this entry fixes is the reason nobody could SEE it, which is
a different and separately worth-fixing thing. The 702 lines were recovered
through the Worker-cron path (`enqueue-so-allocation-recompute`), which is the
production path the repo already documents as the reliable one.

**Fix.** After the COMMIT, on `APPLY` runs that claim at least one change, open a
**separate** connection, re-read exactly the rows the report claims it changed
and compare status + `stock_qty_ready`. Every row that does not read back is
printed as an `::error::` and the run exits 4 with the report explicitly
disowned — *"THE REPORT ABOVE IS NOT WHAT THE DATABASE HOLDS"* — and points at
the enqueue workflow, which does land. A separate connection is the whole point:
the reporting connection is the one that cannot tell you this.

**UNTESTED against a real apply, and said so rather than implied.** The new block
runs only on `APPLY=1` with a non-zero change set, and the only credential
available outside CI is the read-only DSN — a dry run against it cannot reach
the lock, let alone a commit. What WAS observed: with the change in place the
script still runs and still refuses correctly —
`npx tsx scripts/recompute-so-allocation.mjs` with `DOC=HC-SO-011114` against the
read-only DSN printed `canonical result: ok=false … permission denied for table
stock_allocation_recompute_lock`, took the REFUSED path, and exited 3.
`node --check` clean; `audit:release-discipline` reports no new violations. The
verification path itself will first be exercised by the next production APPLY,
which is exactly when it matters.

**Ref.** `fix/recompute-verifies-its-own-writes`, 2026-09-11. Found while
retracting a wrong root cause (PR #3656, closed) — the retraction is the
reference for how the 710 figure came to be quoted as fact.
