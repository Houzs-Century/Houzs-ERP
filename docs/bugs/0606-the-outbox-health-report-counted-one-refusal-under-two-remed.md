## The outbox health report counted one refusal under two remedies [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The daily write-back health report says one document is held back
and then prints it twice, under two different remedies that contradict each
other. Read straight off the scheduled production run
**33593927462 (2026-09-02 05:15Z)**, whose queue held `sent 17 / skipped 2`:

```
skipped 2: line identity missing - backfill linked_ac_dtlkey, then save again
  - SO HC-SO-013394 (edit): ...
  - SO HC-SO-013394 (edit): ...
skipped 2: a PART of the parent was transferred and the ERP cannot name which
           lines - backfill linked_ac_dtlkey on the SOURCE document, then raise
           this document again
  - SO HC-SO-013394 (edit): ...
  - SO HC-SO-013394 (edit): ...
```

Two rows, one document, four report lines. Anyone adding the buckets up counts
four held-back items in a queue that holds two rows — and the second remedy is
not merely redundant, it is wrong for this row: an **edit** has no source
document, so "backfill the SOURCE document" names an action nobody can take.
That is the same wrong-subsystem cost `#2094` was written about.

**Root cause (traced).** `check-autocount-outbox-health.mjs` re-implemented the
classification instead of calling it. Its skip section looped over
`AC_SKIP_KINDS` and, per kind, did

```
const hits = outstanding.filter((r) => r.last_error.includes(needle));
```

with nothing excluding a row an earlier kind had already claimed — the `seen`
set it built was used only to compute the leftover "unrecognised" list. So a
stored sentence containing two needles was reported once per needle.

`KeylessLineError` writes *"N of M line(s) carry no AutoCount DtlKey"*. That
contains the `keyless-line` needle **and**, later in the same sentence, the
`dtlkey-subset` needle (`carry no AutoCount DtlKey`). Both matched.

The shared classifier was never wrong. `classifyAcSkip` returns the **first**
match, and `AC_SKIP_KINDS` is an explicit PRIORITY order — its own comment says
the transport needle sits before the masters needle on purpose. The ERP's page
over the same table calls `classifyAcSkip` per row
(`scm/routes/autocount-outbox.ts:232`) and has always shown one class per row.
Only the plain-node report drifted, which is exactly the hazard its own header
warned about: *"two readers with two copies of the classification is how a
screen and a workflow log start disagreeing about the same row."*

**Fix.** The grouping moved out of the script into
`backend/scripts/lib/ac-skip-grouping.mjs` — `groupAcSkipsByKind` classifies each
row ONCE through `classifyAcSkip` and returns the buckets in `AC_SKIP_KINDS`
order, with the unrecognised rows separate. The script consumes that. A second,
smaller hole closed with it: the old leftover set was keyed on `doc_no + op`, so
a second unrecognised row on the same document was dropped from the report
entirely.

**Tests.** Six in `backend/tests/acSkipGrouping.test.mjs`, plus one in
`src/scm/lib/autocountOutboxStatus.canonical.test.ts` pinning that the
two-needle sentence resolves to `keyless-line`.

**Proved RED on the unfixed tree.** The old per-needle logic was put back into
the module and the suite run: 3 of 6 failed —
`expected [ 'keyless-line', 'dtlkey-subset' ] to deeply equal [ 'keyless-line' ]`,
`expected 6 to be 4`, and the ordering assertion. Restored: 6 passed.

**What this did NOT cause.** No document was mis-handled and nothing was sent or
withheld because of it — this is a REPORT, and the queue's own behaviour never
consulted this loop. The cost was entirely in reading: a held-back count that
double-counts, next to a remedy that does not apply.

**Ref.** chore/ac-held-back-identity, 2026-09-02.
