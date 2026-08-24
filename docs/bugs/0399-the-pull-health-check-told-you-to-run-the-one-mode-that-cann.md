## The pull-health check told you to run the one mode that cannot work [medium]

**Symptom.** `backend/scripts/check-autocount-pull-health.mjs` ends in a VERDICT
written for a person who has just learned the AutoCount mirror is dead. When it
found "NOT MOVING", it printed: *"Run the pull in 'all' mode: pull.ts:29 says
that path uses /getAll and does NOT touch the checkpoint, so it is the clean way
to collect a backlog."* That instruction 503s.

**Root cause.** The sentence was written from READING `services/pull.ts:29`.
Both halves of its reasoning are true — `getAll()` is called, the checkpoint is
not touched — and the operation was never once executed. Dispatched against
production 2026-08-19: **39 seconds, then HTTP 503 `Worker exceeded resource
limits`.** ~13,000 orders cannot be fetched and upserted inside one Cloudflare
Worker request. The remedy that works is `?since=YYYY-MM-DD` windows.

**Why it survived the correction.** The same claim lived in TWO places. The
retraction was written into `docs/modules/system-health.md` the same day and
missed this file, so the check went on printing the withdrawn advice to anyone
who ran it — for a reader whose whole reason for running it is that they do not
know what to do next. One claim, two homes, one of them forgotten.

**Fix.** The verdict now prints the windowed `?since=` call, and the comment at
the arrival-rate query no longer says the backlog is *"only `all` mode can
collect"*.

**And the class, not just the instance.** `scripts/lib/working-agreement.mjs`
gained rule 4: a PR that tells a reader an operation will fix/recover/collect
something must carry an `Observed:` line — a status, a count, a duration, an
error, a run URL — or mark the claim `UNTESTED`. It also WARNS (never fails) when
such a sentence is added to a module guide or a `check-*.mjs`, which is exactly
the surface that stayed wrong here. Nothing else could have caught this: the code
was correct, so types, lint, tests and review were all right to pass. The only
wrong artifact was the claim, and every gate in this repo read code.

Measured before shipping: 3 hits across 19,784 lines of existing module-guide
prose, and only ADDED lines are scanned.

**Ref.** `chore/remedy-claim-gate`, 2026-08-19.
