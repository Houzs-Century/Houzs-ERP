## A book correction refused a sofa because the build has one row per compartment [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `repair-so-variant-from-book.mjs`'s first production run — PLAN,
read-only, run `34202158366`, 2026-09-08 16:00 Malaysia — refused four of its six
reviewed corrections:

```
  !! SO-013258 DtlKey 904643 (9058-2A(LHF), colour): 2 ERP lines carry that key; a correction must name ONE row — skipped
  !! SO-009708 DtlKey 660946 (9050-2A(LHF), seat):   2 ERP lines carry that key; a correction must name ONE row — skipped
  !! SO-001526 DtlKey 102957 (5526-2A(RHF), seat):   no ERP line carries that AutoCount key — skipped
  !! SO-013227 DtlKey 901845 (8030-Console, seat):   no ERP line carries that AutoCount key — skipped
PLAN: 2 line(s) would be corrected to the book; 4 skipped.
```

Two of those four are the guard being wrong. Two are real, and stay refused.

**Root cause (traced).** The script identified the row to correct by
`linked_ac_dtlkey` and treated more than one hit as an ambiguity. It is not one:
**one AutoCount sofa line becomes one ERP line per compartment**, and a scalar
axis — colour, seat size — is written IDENTICALLY to every piece of a build.
That is exactly why `variant-reconcile.mjs` reads those axes off the LEAD line
and only the compartment axis over all of them. So "several rows behind one book
line" is the normal shape of every decomposed sofa in this migration, and the
guard refused the ordinary case.

`SO-013258` (`HOK-5536 SOFA`, model 5536 → 9058) is an L-shape; `SO-009708`
(`AMN-SF9050 SOFA`) is a 3-seater the cutover decomposed into `2A(LHF)+1A(RHF)`.
Both are two-piece builds, and both are on PROCEEDED orders — so the refusal was
leaving a wrong colour and a wrong seat size on confirmed work.

**Fix.** The correction goes to **every piece of the build, or to none**:

- the stale-list refusal is asserted on EVERY row, not just the lead;
- a build whose pieces DISAGREE with each other is refused outright and named —
  that is a state a human has to look at, never one to flatten by writing over;
- the fresh-connection verification re-reads every piece, so the shape assertion
  covers the whole build rather than its first row.

**The other two refusals stand, and they are findings.** `SO-001526` and
`SO-013227` have no ERP line carrying their AutoCount key at all — they are among
the migrated documents that carry no line keys, where the reconcile identifies
the row by its own value-then-order fallback. Building a second, private matcher
inside a repair script is this repo's most expensive recurring bug (the header of
`lib/variant-reconcile.mjs` lists what a duplicated Desc2 rule has already cost),
so the script REPORTS them and writes nothing. Both are NOT PROCEEDED, so the
owner's rule 「还没proceed还没确认的就可以直接放空的」 makes them the lowest-priority
residue there is.

**The class, for next time.** A uniqueness guard on a foreign key is only correct
when the relationship really is one-to-one. Here the cutover deliberately made it
one-to-many — a sofa is stored as its compartments — and the guard was written
from the shape of the correction list rather than from the shape of the data.
Same family as `docs/bugs/0700`, where a guard counted a population wider than
the action it guarded: both fire on a state that was never a problem.

**What the plan proved while it was refusing things**, and the reason it ran
read-only first: of the two corrections it WOULD write, `HC-SO-010120` has no
purchase order and no delivery behind it (a records fix that reaches the floor
before the build), and `HC-SO-013310` has **1 purchase-order line — the factory
has already been told 28"** while the book says 30". That is the list the owner
needs, and it exists only because the apply is a separate dispatch.

**Ref.** fix/variant-book-decomposed, 2026-09-08.
