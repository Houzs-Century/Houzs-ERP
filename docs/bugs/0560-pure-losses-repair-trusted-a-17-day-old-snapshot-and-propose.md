## Pure-losses repair trusted a 17-day-old snapshot and proposed resetting five correct received quantities to zero [high]

**Symptom.** During the 2026-08-28 re-import round, `repair-pure-losses`'s
dry-run (run 33177106426) proposed `received_qty 3 -> 0` (and four more lines)
on HC-PO-009736 — an order this round had just imported with received=3.

**Root cause (traced).** The script copies "AutoCount's own value" from
`data/ac-line-truth.json.gz`, whose **mtime** was 2026-08-28 (a git checkout)
but whose **exportedAt** was 2026-08-11 — a round-1 snapshot. On 8-11 those
lines were genuinely unreceived (book queried live: `PODTL.TransferedQty` now
3/2/1/1/1, matching the ERP exactly); the goods arrived in the 17 days
between. The header even asserted the values "do not move between runs", which
is false across days — received quantities rise as goods arrive. The file's
generator is not in the tree, so nothing could refresh it either. Caught by the
working-agreement rule that a contradiction is a finding: "we imported
TransferedQty" and "the tool says AutoCount's TransferedQty is 0" cannot both
be current.

**Fix.** The script now refuses to run when the snapshot's `exportedAt` is
older than 2 days, naming the age and the reason — proved RED against the real
stale file before merging (`exit=2`, "exported 2026-08-11 … 17.2 days ago").
The RE-RUN header now states the freshness precondition instead of denying it.
This round the repair is SKIPPED outright: the round-2 importers write
qty/received/delivery-date from the live book at insert, so there is nothing
for it to repair.

**Ref.** fix/pure-losses-stale-guard, 2026-08-28.
