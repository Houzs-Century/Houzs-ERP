## The build verification grouped by MODEL, so two sofas of one model read as a broken build and refused a correct write [medium]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** Apply run `34210459226` wrote every row it planned —
`APPLIED: 224 row(s) stamped of 224 planned`, `0 WRONG SHAPE`, and the money,
quantity, readiness, stock and migrated-movement shape identical on a fresh
connection — and then **exited 1**, naming 36 documents:

```
BROKEN BY THIS RUN HC-SO-002348 5527: 2 row(s), 2 distinct key(s), 0 keyless
BROKEN BY THIS RUN HC-SO-010147 8050: 3 row(s), 3 distinct key(s), 0 keyless
```

Every one of them reads `0 keyless`. `HC-SO-002348` holds two rows and two keys
because the customer bought **two 5527 sofas** and the book states two lines.
That is the intended outcome of the lane, reported as its damage.

**Root cause (traced).** The verification asked a different question from the one
`composeEdit` asks. `composeEdit` requires every compartment of ONE BUILD to
agree on the key; the check grouped by
`regexp_replace(item_code, '-[^-]*$', '')` — the MODEL — and flagged any group
holding more than one distinct key. That was equivalent while a model on a
document was always one build. It stopped being equivalent in the same PR: the
build-text split in `foldErpUnits` exists precisely so that two sofas of one
model become two builds with two keys, so the verifier's own premise was
invalidated by the change it was written to verify.

**Fix.** The check re-reads every sofa row of every migrated sales order on a
fresh connection and folds them with `foldErpUnits` — the same function the plan
used, so the verifier and the planner cannot disagree about what a build is — and
flags a build whose rows carry more than one distinct value, counting NULL as a
value so a half-keyed build (the `docs/bugs/0704` shape) still fails. It is fatal
only for a build the run stamped; a build it did not touch is reported as the
remainder, not as damage.

It also now runs in **PLAN mode**. The invariant is a property of the whole sofa
population, not of one run's writes, and the first corrected run
(`34210839524`) proved that: as a re-run it stamped `0 of 0`, so it verified
nothing about the 224 rows the first apply had written. The only way to check
yesterday's stamping would have been to stamp again, which is not a check.

Standing measurement, run `34211018125` (read-only): across all **523** migrated
sales orders holding a sofa, **578 builds, 2 of them not agreeing on one key**,
and **0** containing a row this lane stamped. The 2 —`HC-SO-013384` and
`HC-SO-012025` — are pre-existing half-keyed builds this lane refused and now
makes visible.

**What would NOT have caught it:** typecheck, lint, the unit tests and the shape
check were all green, because none of them was wrong. Only running the apply
against production surfaced it, and it surfaced in the SAFE direction — a
verifier that cannot tell the intended outcome from the damage refused rather
than passed, which is why this cost a re-run instead of a false `PROVEN`.

**Ref.** fix/sofa-keys-unread, 2026-09-08.
