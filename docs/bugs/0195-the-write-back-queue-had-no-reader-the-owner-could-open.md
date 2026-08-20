## The write-back queue had no reader the owner could open [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Owner, 2026-08-15: *"你确保有完整的记录，就是我可以看得到 ... 如果它是
在排队、skip、planning 还是 fail 等等，fail 的话是什么原因？everything 都要呈现出
来，要不然我就不知道."* He could not tell whether a document he had saved had
reached AutoCount.

**Root cause, traced.** `scm.autocount_outbox` records every operation the ERP
ever asked AutoCount to perform, with its status and its reason — and nothing in
the ERP read it. `grep -rn autocount_outbox backend/src` returns the enqueue, the
drain, the re-queue and their tests, and no route: there was no HTTP surface over
the table at all. Its only two readers were
`backend/scripts/check-autocount-outbox-health.mjs` and
`backend/scripts/check-cancel-parity.mjs`, both reachable only by dispatching a
GitHub Action and reading the log — which the owner cannot do and, per the repo's
own standing rule, should not have to.

That matters most for the two states that mean a real divergence. A `failed` row
is a document that is in the ERP and NOT in the account book. A `skipped` row is
one the ERP declined to send on purpose, with a named remedy. Both were invisible
in the product.

**Fix.** `GET /api/scm/autocount-outbox`
(`backend/src/scm/routes/autocount-outbox.ts`) plus the page at `/autocount-sync`
on both surfaces (`frontend/src/pages/AutoCountSync.tsx`,
`frontend/src/mobile/MobileAutoCountSync.tsx`, sharing
`frontend/src/lib/autocountOutbox.ts`). Counts by state first, then the list,
with every row's reason printed in full. Company-scoped on all seven statements
(#2201's lesson), gated on the new `scm.autocount.read` or the existing
`settings.manage`, and read-only — re-sending stays in the re-queue workflow
behind its `includeFailed` opt-in (#2189).

**The classification was NOT re-derived**, which was the real hazard: a second
copy of the skip taxonomy is how the health check once told an operator to
backfill DtlKeys for an item-map problem (#2094). It now lives once, in
`backend/src/scm/lib/autocount-outbox-status.ts`, with a plain-node mirror for
the script (which cannot import TypeScript) refereed by
`backend/src/scm/lib/autocountOutboxStatus.canonical.test.ts`.

**Ref.** 2026-08-15. Lesson: **a queue nobody can read is a queue nobody reads.**
The mechanism was durable, retried, dead-lettered and recorded its own reasons
for eight months of work, and still failed the one test that matters — the person
responsible for the account book could not see it.
