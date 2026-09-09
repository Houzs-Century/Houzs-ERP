## The DO price repair re-proposed two zero-quantity lines for ever and went red on them [low]

**Symptom.** Go-live, 2026-09-07. `repair-migrated-do-prices.yml` run with
`mode=apply` against prod
(run 34116824015) wrote its whole plan and then failed:

```
APPLIED. lines=65 documents=56
VERIFY FAILED (fresh connection, shape check): 2 repaired line(s) are STILL zero
##[error]Process completed with exit code 1.
```

Re-planning afterwards (run 34117119790) showed 63 of the 65 gone and **2 still
listed as repairable** — the same 2, for ever.

**Root cause (traced).** In `backend/scripts/repair-migrated-do-prices.mjs` the
plan and the verification disagree about what "repaired" means.

- `fixable` selects on the SALES ORDER's price: `Number(r.so_unit_price_sen) > 0`.
- The write computes `lineTotal = Math.max(0, Math.round(qty * unit))`.
- The shape check reads back `count(*) FILTER (WHERE line_total_sen <= 0)`.

On a delivery line with `qty = 0`, a positive unit price still yields a line
total of 0, so the row satisfies `fixable`, is written correctly, and then trips
`still_zero`. It also still matches the plan's own `di.line_total_sen = 0`
predicate, so the next plan proposes it again. Nothing converges.

The plan output named them before the apply did: of the 56 documents listed,
exactly two printed `-> local_total_sen 0` — `HC-DO-001953` and `HC-DO-002817` —
and those were the two the verification failed on.

**Fix.** Give a zero-quantity line its own bucket. A line that delivers nothing
has a correct line total of zero whatever the order charges per unit, so it is
reported (`ZERO-QTY <doc> line <id> qty=<n>`) and never written — the same shape
the script already uses for `UNLINKED` and `SO-IS-ZERO`. The apply converges and
the verification's `still_zero` arm keeps its meaning.

**What this is NOT.** Not a money defect. The two lines hold the right number
already; only the repair's own accounting of them was wrong.

**Ref.** 2026-09-07 go-live applies. 63 of 65 lines / 54 of 56 documents were
genuinely repaired by run 34116824015 and are correct.
