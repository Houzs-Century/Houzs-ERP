## `mode=all` cannot backfill the AutoCount mirror — it kills the Worker [high]

**Symptom.** `SO-005263` exists in AutoCount and is absent from the mirror, so a
salesperson cannot raise a Service Case against it. The remedy shipped hours
earlier — `POST /autocount/so-pull?mode=all` — **does not work**.

**Root cause (measured, not reasoned).** Dispatched against production
2026-08-19: **39 seconds, then HTTP 503 `Worker exceeded resource limits`.**
`mode=all` calls `client.getAll()`, and the AutoCount book holds roughly 13,000
sales orders; one Cloudflare Worker request cannot fetch and upsert that many.

The same call with `mode=filtered` returned **200** with `fetched: 0` — correct,
the checkpoint is current — which proves the route, the auth and the AutoCount
connection are all fine. Only the full refresh is impossible.

**What I got wrong, and it is the reason this entry exists.** The PR that shipped
`mode=all` described it as "the clean way to collect a backlog". That sentence
was written from reading `pull.ts:29` and **never executed**. CLAUDE.md's first
rule: a cause you have not observed is a hypothesis, and this was a remedy nobody
had observed working.

**Fix.** `?since=YYYY-MM-DD` on the same route. It asks `getSince(<that date>)`
instead of `getSince(checkpoint)`, so a backlog is collected in WINDOWS small
enough to finish. The checkpoint is neither read nor advanced on that path —
deliberately, because a backfill reaches BACKWARDS and writing its window forward
would skip everything in between. `runPull`'s new parameter is `string | null`,
not optional: it decides which window AutoCount is asked for.

`mode=all` is left in place and left documented as what it is — usable only
against a small book.

**Ref.** `fix/autocount-backfill-chunked`, 2026-08-19.
