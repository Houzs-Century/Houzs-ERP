## The po_qty_picked drift count reported the query LIMIT, not the count [medium]

**Symptom.** The first production run of `check-ac-convert-symmetry.mjs`
(workflow run 34103398841, 2026-09-07) printed:

```
SO line po_qty_picked vs its PO children : 500 of 14492 live SO lines DISAGREE
```

500 is a suspiciously round number for a measurement, and it is exactly the
`LIMIT` on the query above it. The true count was unknown and could have been
any figure at or above 500 — the check reported a number that carried no
information about the thing it was measuring.

**Root cause (traced).** `check-ac-convert-symmetry.mjs` selected the offending
rows with `... ORDER BY o.doc_no LIMIT 500` and then reported `picked.length`,
the length of the LIMITed result set, as the population count. A second query
supplied the denominator (14,492), so the two halves of the sentence were
measured differently: the denominator counted every row, the numerator counted
at most 500 of them. This is the same class as reporting one page of search
results as the total number of matches.

It is also the trap CLAUDE.md names as *"the check that answers a different
question"* — `picked.length` is a true statement about the array in memory, and
false as an answer to "how many SO lines disagree".

**Fix.** COUNT and EXAMPLES are now two queries. An aggregate with
`count(*) FILTER (WHERE ...)` over the full join computes the population, the
direction split (reads LOW vs reads HIGH) and the migrated/native split; a
separate `LIMIT 20` fetches only the rows to print. The printed count now comes
from the aggregate and cannot be capped by a display limit.

Proved RED on the unfixed tree by the run that produced it: run 34103398841
printed `500 of 14492` against a live database whose real answer was not 500.
The direction split added in the same change is what makes the finding
actionable — the SO->PO ceiling is `qty - po_qty_picked`, so a counter reading
LOW makes the ceiling too generous and an over-convert could get through, while
one reading HIGH only blocks a legitimate purchase.

**Ref.** feat/ac-convert-symmetry-2026-09-07, 2026-09-07.
