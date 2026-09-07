## sync-ac-delta verified lanes it did not run, so a LANES subset always exits 1 [medium]

**Symptom.** Go-live, 2026-09-07. `sync-ac-delta.yml` dispatched against prod
with `apply=yes lanes=recv,do,dedi` (run 34113822612). Every write it was asked
for landed and self-verified:

```
received_qty written: 241 of 241 intended
delivery documents created: 89 of 89 intended
SO->PO dedications written (lane dedi): 0 of 0 intended
VERIFY: 0 inventory movements against the 89 delivery document(s) created, as designed.
VERIFY FAILED on 15 sample(s)
##[error]Process completed with exit code 1.
```

The job went red on a run in which nothing was wrong. Worse than the red: the
next operator's honest reading of a failed apply against production is "back it
out", and backing this one out would have discarded 241 correct `received_qty`
values and 89 correct delivery documents.

**Root cause (traced, not guessed).** `backend/scripts/sync-ac-delta.mjs`
computes a plan for EVERY lane on every run and writes only the lanes named in
`LANES` — each apply block is guarded (`if (LANES.has("desc"))`, and so on). The
verification block underneath was not. Its sample loops read
`descUpdates`, `payUpdates` and `linkPlan` unconditionally, so on
`LANES=recv,do,dedi` they re-read rows the run had deliberately left alone,
found the value the plan intended absent — because nobody wrote it — and counted
each as a MISMATCH. The 15 failures were exactly 5 + 5 + 5, one full sample from
each unrun lane; `recv`, `do` and `dedi` produced no mismatch line at all.

It stayed invisible because the default `LANES` has always contained every lane
the verification block reads. `desc,pay,links` was the default before #3062 and
`desc,pay,links,recv,do,dedi` after it, so until an operator named a SUBSET on
the dispatch form, the guard's absence cost nothing.

**Fix.** Guard each sample loop by its own lane, the same way the write blocks
already are, and count the samples the summary line claims through the same
test. A lane that did not run is now verified zero times rather than verified
against a value it was never asked to write.

**What this does NOT change.** The movement assertion over the delivery
documents this run created stays unguarded on purpose — it is scoped to
`doMade`, which is empty unless lane `do` ran, and asserting zero inventory
movements is the one check that must never be skippable.

**Ref.** Found while applying the go-live conversion lanes, 2026-09-07. The
production data from run 34113822612 is correct and was left in place; a re-plan
immediately afterwards (run 34114554129) read back `recv 0 line(s)`,
`do 0 document(s)`, `received_qty AGREES with AutoCount TransferedQty 1281`
(was 869) and `ERP received LESS than the book says 0 line(s)` (was 241).
