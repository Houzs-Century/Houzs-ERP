## delete-test-so told the operator the deleted number would come back; the counter had already skipped it [high]

**Symptom.** The owner deleted the test order `2990-SO-2608-067` on 2026-08-30
and asked that the next POS order reuse `-067` rather than skip it. The delete
ran clean and its last line read:

```
Highest 2990-SO-2608-% now : 2990-SO-2608-066 — next mint reclaims the gap on its own.
```

That sentence is false. The live counter row for series `2990-SO-2608` held
`next_n = 68` at that moment, so the next save was going to take `-068` and
`-067` was already a permanent gap. The operator was told the opposite of what
the database was going to do, by the tool whose job was to report it.

**Root cause (traced).** `backend/scripts/delete-test-so.mjs` computed its
closing verdict from `MAX(doc_no)` over the surviving rows and asserted from
that alone that the sequence self-heals. That was accurate until migration
`0316_scm_doc_number_counters.sql`, which moved minting to the stored counter
`scm.doc_number_counters` claimed by `scm.next_doc_no_n(p_series, p_floor)`:

```sql
SET next_n = GREATEST(c.next_n, GREATEST(COALESCE(p_floor,0),0) + 1) + 1
RETURNING next_n - 1;
```

The surviving rows are now only a FLOOR — they can push the counter UP and can
never pull it down (`backend/src/scm/lib/doc-no.ts:215-231` calls the RPC;
`mfg-sales-orders.ts:1026-1038` is the SO caller). 0316 is the fix for the
2026-08-20 re-issue, where a wipe reset a series to 001 and the ERP re-minted
`HC-SO-2608-001/002` into an AutoCount book that already held them
(`docs/doc-number-reissue-coe.md`). The counter changed; the script's closing
sentence did not, and nothing gated it because no check reads a script's
console output.

Observed, not reasoned: `doc-no-integrity.yml` run 33316545434, section (G),
`2990-SO-2608 next_n= 68`, read minutes after the delete in run 33316472151
printed the "reclaims the gap" line. `docs/modules/sales-order.md` already
carried the correction — dated 2026-08-21, nine days earlier — so the fact was
known and had simply never reached the tool.

**Fix.** Two halves.

1. `delete-test-so.mjs` now READS `scm.doc_number_counters` and prints the doc
   number the next save will actually take, computed the same way the RPC does
   (`GREATEST(next_n, liveMax + 1)`). When that is not the number just deleted
   it prints a WARNING naming the gap as permanent and the command that
   reclaims it. It also handles the counter being absent or unseeded, where
   `max+1` genuinely still applies. The stale sentence and the stale header
   claim are gone.
2. New `backend/scripts/reclaim-doc-no.mjs` + `.github/workflows/reclaim-doc-no.yml`
   ("Reclaim a document number") — the only tool in the tree that moves a
   counter DOWN, because until now there was no answer to the owner's question
   at all. `MODE=plan` by default; `MODE=apply` needs `CONFIRM_SERIES` to equal
   the series. It REFUSES an `HC-` series outright (those are the numbers the
   AED_HOUZS book holds), a target not below `next_n`, a target any surviving
   row or any `scm.autocount_outbox` row already carries, and an unknown series
   type. `audit:release-discipline` reports "No new violations" — it carries all
   four rules including a fresh-connection verification that asserts the VALUE.

**What this does NOT fix, said plainly.** The class is "a tool prints a claim
nobody re-checks", and only this instance is closed. `check-working-agreement`
rule 4 already warns when a remedy claim is added to a `check-*.mjs` verdict;
it does not read `console.log` in `backend/scripts/*.mjs`, and it cannot tell a
sentence that was true in July from one that is true today. The durable fix is
for a verdict about the counter to be COMPUTED from the counter, which is what
half 1 does — extending that discipline to the other scripts that narrate
document numbering is not done here.

**Ref.** `fix/doc-no-counter-reclaim`, 2026-08-30. Evidence: delete run
33316472151, integrity run 33316545434 section (G).
