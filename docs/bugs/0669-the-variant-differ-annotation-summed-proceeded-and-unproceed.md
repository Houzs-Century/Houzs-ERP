## The variant DIFFER annotation summed proceeded and unproceeded orders into one number [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The reconcile's per-axis annotation on run 34127889821 read:

```
SO VARIANT sofa compartments — 32 DIFFER, 0 ERP blank on a proceeded order
```

and "32" was carried into the go-live brief as the sofa-compartment backlog.
The table printed four lines above it says something different: of those 32,
**one** sits on a PROCEEDED order and **31** do not.

**Root cause (traced).** `check-ac-erp-reconcile.mjs` counted offenders without
looking at the flag the same loop had already computed:

```
`${t} VARIANT ${a.label} — ${list.filter((x) => x.differ).length} DIFFER, ` +
  `${list.filter((x) => !x.differ).length} ERP blank on a proceeded order`
```

The ERP-blank half is correctly restricted to proceeded orders — offenders only
collects `ERP_BLANK` when `proceeded` — but the DIFFER half counts both halves
of a split the table beneath it exists to make. The annotation is the line that
gets quoted into briefs, so the lumped number is the one that travelled.

The owner's rule 「还没proceed还没确认的就可以直接放空的」 has been broken twice
before by a lumped number (compartments read 141 when the work was 30; colour
594 when the work was 54), and both times the lump came from a line of this
shape.

**Fix.** The offender row now carries `proceeded`, and the annotation reads
`N DIFFER on a PROCEEDED order (+M on orders not yet proceeded)`. The M half is
never dropped — it is real disagreement, just not backlog — it simply cannot be
added to the first number any more.

**What this changed on the measured data**, same production state, before and
after: SO compartments 32 -> **1** (+31), SO specials 62 -> **22** (+40), SO seat
size 5 -> **2** (+3), PO specials 13 -> **13** (+0), PO compartments 5 -> **5**
(+0).

**Ref.** fix/variants-specials-close, 2026-09-07.
