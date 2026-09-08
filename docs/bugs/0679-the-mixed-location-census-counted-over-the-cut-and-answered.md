## The mixed-location census counted over the cut and answered zero for the whole book [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** `backfill-migrated-do-warehouse.mjs`, run against production
2026-09-08 (run 34152547466), printed:

```
book: 11134 document header(s), 84 document(s) with line locations
documents whose lines span TWO locations: 0
```

Zero — while the measurement that earned the owner's ruling had found **2 of
11,134** (`DO-000140` PG+HQ, `DO-000153` KL+SUNWAY). The ruling asked for exactly
those to be **NAMED in the output so they are visible rather than quietly
flattened**, and the run named none.

**Root cause (traced).** The script built its `lineLocs` map from
`data/ac-partial-dos.json.gz` only — the cutover **cut**, 84 documents. The
mixed-location census then ran over those 84 and correctly found none, because
neither mixed document is in the cut. The whole-book line snapshot,
`data/ac-fidelity-do-lines.json.gz` (47,329 lines across 11,134 documents), was
never loaded.

The tell was printed on the same line and read past: **`11134 document
header(s), 84 document(s) with line locations`.** A census over 84 documents was
answering a question asked about 11,134.

**This is the "checker that cannot match reports a clean run" shape** that
CLAUDE.md warns about, in its quieter form: nothing was broken, the count was
computed correctly — over the wrong corpus — and a wrong corpus produces a
number indistinguishable from a clean result.

**Fix.** `lineLocs` is now built from **both** line snapshots — the whole book
first, then the cut — so the census covers 11,153 documents and the two mixed
ones are named:

```
documents with line locations: 11153
MIXED documents named: 2
    DO-000140 -> PG + HQ
    DO-000153 -> KL + SUNWAY
```

Resolution is unaffected: the book **header** still wins wherever it exists, so
no document changes the warehouse it resolves to. Both mixed documents resolve
from their header (PG and KL respectively) exactly as before — the change is that
the run now SAYS the lines were not unanimous, instead of flattening them in
silence.

**Recorded while here, because it is the same question:** of 171 migrated
delivery orders, **89** resolve to no location at all, and every one is a
`DO-0114xx`/`DO-0115xx` raised **after** both snapshots were taken — absent from
`ac-fidelity-do-headers` and `ac-fidelity-do-lines` alike (verified: the fidelity
corpus is 11,134 documents and contains none of them). They are NAMED in the run
output, never defaulted. A snapshot refresh is what fills them, not a code
change.

**Ref.** PR (2026-09-08). The ruling and the backfill are
`docs/bugs/0675-*`.
