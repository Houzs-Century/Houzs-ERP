## An unbounded .in() list broke MRP in the larger tenant and Delivery Planning in both [high]

<!-- area: Fleet, trips, TMS -->

**Symptom.** `GET /api/scm/mrp?category=SOFA` 500'd in Houzs Century (2,726
sales orders) and answered 200 in 2990's Home (100). `GET /api/scm/
delivery-planning` 500'd in BOTH with a bare "Something went wrong", taking
`/scm/dp-orders` and `/scm/trips` down with it. The unpaginated SO list — the
mobile convert wizard's only source — 500'd in Houzs Century.

**Root cause (traced).** `wrangler tail` on the production Worker recovered what
the generic handler had swallowed: `[onError] Error: delivered-sum read failed:`
— with an EMPTY message, the signature of a request refused before PostgREST
could produce a JSON body. `lib/do-unlinked-coverage.ts` built
`.in('so_item_id', …)` from every SO line with no chunking; the ids ride in the
request URL. `paginateAll` bounds the RESPONSE, not the request. Delivery
Planning failed in the small tenant too for a second reason: its SO read carried
no company predicate at all, so both tenants assembled the whole platform's
documents.

**Fix.** `chunkIn` sizes batches by URL BYTES rather than row count
(`chunkSizeForUrl`: 76 values for uuids, 200 for short codes), applied at 18
files; `[...new Set(...)]` on the epicentre because PostgREST de-dupes within one
`in.()` list but two batches would double-count a repeated id. The board's SO
read is company-scoped. `lib/read-failure.ts` makes this class of failure
diagnosable — it carries `code`/`details`/`hint`, the in-list size and the doc
count, and cannot resolve to an empty string, so the next occurrence answers
itself without a tail.

Ref: PR #2382, 2026-08-18.
