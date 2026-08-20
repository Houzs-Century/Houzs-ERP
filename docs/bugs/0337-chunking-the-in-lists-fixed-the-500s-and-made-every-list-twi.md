## Chunking the .in() lists fixed the 500s and made every list twice as slow [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Measured on production 2026-08-18, after the chunking fix deployed
and before this one: Sales Orders 2450ms -> 5674-6276ms, Purchase Orders 2767 ->
5759-6230, GRN 2566 -> 4693-5554, Purchase Invoices fast -> 4425-4956. Three
runs each, so not noise. `pageSize=5` and `pageSize=50` stayed equally slow, so
it was still a fixed cost — the fixed cost had simply doubled.

**Root cause (traced, and it was mine).** `chunkIn`'s default batch went from a
literal `size = 200` to `chunkSizeForUrl()`, which computes 76 for a uuid. The
sizing is right — the failure it prevents is a gateway refusing an over-long
URI, which no row count predicts. But `chunkIn` walks its batches in a `for`
loop, one `await` at a time, and roughly 27 call sites already used the default.
So the same work became 2.6x as many SERIAL round trips, everywhere, at once.

**What the mistake actually was.** The production evidence was "the URL was
refused", and the fix was written against that sentence: make the URL shorter.
The question not asked was why the code materialises tens of thousands of ids in
the application layer at all — the standard answer to "filter by a large id set"
is to push the join into the database (a view, an RPC, a WHERE EXISTS), which
removes the URI limit AND the round trips. Chunking treats the symptom. It was
also shipped without measuring: the four 500s were re-tested and confirmed
fixed, latency was not re-tested at all, and the regression surfaced only
because the owner asked for a QA pass.

**Fix.** The batches are independent, so they now run through `mapBounded` at 6
in flight. Subrequest count is unchanged — only the wall clock is. `mapBounded`
returns results in INPUT order, so the merged output is byte-identical to the
sequential form, and the first failing batch in input order still wins with the
earlier batches kept. `backend/tests/chunkInOverlaps.test.ts` pins the answer,
the ordering, the error semantics and the overlap itself; setting the limit back
to 1 fails it with "expected 1 to be greater than 1".

**Still open.** The deeper fix is not to build the id list. And three list
endpoints run the whole-tenant MRP engine (~105 round trips) on every page load
to render one column, which is now the dominant remaining cost.

Ref: 2026-08-18.
