## The feed latency check pooled backfilled rows with real saves and reported 35 minutes as the latency [medium]

**Symptom.** The first real dispatch of **Venture Portal feed latency
(read-only)** answered, against production on 2026-09-13:

```
switch            : ON for company 1
queue             : pending 2672, sent 275, skipped 4
LATENCY over the last 20 deliveries — save to portal 2xx:
  fastest         : 1816.9s
  median          : 2094.6s
  slowest         : 2101.8s
```

Read as written, that says a saved sales order takes **35 minutes** to reach the
Venture Portal — i.e. that the whole point of the work (「我要秒级 update 的」) had
failed. It had not. The number was real and the label on it was wrong.

**Root cause (traced).** `scm.venture_portal_outbox.created_at` is when the OUTBOX
ROW was written, and the migration writes it from two completely different places:

- `20260912T1800_scm_venture_portal_outbox.sql:320` — the capture trigger, with
  `op = TG_OP` (`INSERT` / `UPDATE` / `DELETE`), running in the SAME TRANSACTION as
  the salesperson's Save. For these rows `created_at` IS the save.
- `…:262` — the backfill, `scm.vp_requeue_undelivered`, with `op = 'RECONCILE'`,
  queueing a historical order that was never delivered. `created_at` is when the
  BACKFILL ran; the order itself may have been saved months earlier.

`check-venture-portal-latency.mjs` selected `WHERE status = 'sent'` with no `op`
predicate and pooled the two. The owner had just turned the feed on and queued the
backlog, so all 20 rows in the sample were `RECONCILE` rows draining out of a
queue 2,672 deep — and `sent_at - created_at` for those measures **how long the
backlog was**, which is not a latency at all.

Caught by disbelieving the number rather than by any check: 35 minutes was too
close to "the backlog is long" and too far from anything the design could produce,
so the `op` column was read against the migration before the figure was reported
to the owner as a finding.

**Why it matters more than a wrong figure.** This script exists specifically so
the number in `docs/modules/venture-portal-feed.md` §2 comes from a measurement
instead of an estimate. A measurement that answers a different question is worse
than the estimate it replaced, because it arrives wearing the authority of a
production read. CLAUDE.md names this exact trap — *"the check that answers a
different question"* — and lists `UPDATE 1` and `res.count` as its previous
instances here. This is the same shape: the query succeeded, every row it returned
was real, and the population was wrong.

**Fix.** The two populations are reported SEPARATELY and never pooled:

- `SAVE -> PORTAL (op is a trigger: this is the real latency)` — `op <> 'RECONCILE'`.
  This is the line §2 asks for, and it is labelled as such in the output.
- `BACKFILL (op = RECONCILE: queue wait, NOT a latency)` — printed beside it with a
  sentence saying it must never be quoted as the feed's latency.

Each prints its own fastest / median / slowest and its own rows with the `op`
visible, so a reader can see which population a number came from. When there are
no delivered SAVE rows the script says `NONE YET` and adds "do not read this as
'fast'" — a verdict over an empty set must not read as a pass.

**Lesson.** A timestamp column is not a fact until you know which code path writes
it. `created_at` on an outbox looks like "when the thing happened" and is actually
"when the row was made", and those coincide only for the trigger. Before
subtracting two timestamps, read what writes each one.

**Ref.** fix/vp-latency-measures-the-wrong-rows, 2026-09-13. The check shipped in
#3779; this corrects it before its first number reached the module guide.
