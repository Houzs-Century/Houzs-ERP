## Three ruled sofa purchase orders read as unverifiable because their added compartments carry no line key [low]

**The data is CORRECT. The report cannot see it.** `HC-PO-009024`,
`HC-PO-010041` and `HC-PO-010083` sit in the tally's CANNOT-COMPARE column
reading *"the owner ruled X and the ERP does NOT hold it"* — and the ERP does
hold it.

**Measured**, `probe-po-sofa-line-keys` run 34354521717 / 34358356749:

```
HC-PO-010041   9058-L(LHF)    group=sofa  key=914330
               9058-1A(RHF)   group=sofa  key=(NONE)
               9058-1NA       group=sofa  key=(NONE)
```

All three pieces of the owner's build are present and tagged `sofa`. Two of them
carry no AutoCount line key. The reconcile groups a build BY DtlKey, so it sees
the one keyed row and reports *"we hold L(LHF)"*. `HC-PO-009024` is 3 of 5
keyless, `HC-PO-010083` is 4 of 6.

**Why the rows are keyless.** `apply-sofa-compartment-corrections.mjs` INSERTs
the compartments a build does not yet hold. Its INSERTs name
`linked_ac_dtlkey` today, so a build written NOW carries the key — these three
were written before that, and `docs/bugs/…` already records that *"every sofa
compartment that script has ever ADDED landed keyless"*.

**Why the existing repair will not stamp them, and the refusal is CORRECT.**
`repair-sofa-added-compartment-line-key.mjs`, DRY-RUN 34357813645, prints its own
reason:

```
3 live company-1 sofa row(s) on imported documents, in 1 build(s); 2 carry NO AutoCount line key
REFUSED, each for a reason the book or the build gives:
  the book's text for that key is not this row's   2   (gate 4 - a key from another build)
```

Gate 4 compares the ERP row's `description2` against the BOOK's text for that
key. They differ:

| | text |
|---|---|
| ERP | `32 inch / back rest (5540) / fully cover after push back / Nilon bottom / Col :CH141-09 sky` |
| book | `32 inch  back rest  (5540) fully cover after push back(extend 6")  Nilon bottom  Col :CH141-9 sky` |

`(extend 6")` is in the book and not in ours, and the colour reads `CH141-9`
against our `CH141-09`. Gate 4 exists to stop a key from ANOTHER build being
stamped onto a row, and it cannot tell "the same line, worded differently" from
"a different line". **Refusing is the right answer for a guard that cannot tell
those apart.**

**So this is the `GR-005334` shape** (`docs/bugs/0762`): the content is right, the
report is noisy, and making the report quiet means weakening a guard written for
a real incident. The owner accepted that trade on `GR-005334` the same day.

**What would actually close it, for whoever picks this up.** Not a fuzzy text
match — that is the guard's failure mode wearing a fix. Either:

1. correct the ERP `description2` on these rows to the book's own text, after
   which gate 4 passes on its own terms and the existing repair stamps them; or
2. give gate 4 a narrower exemption it can PROVE: the key came from a sibling
   inside the same build group, and the book holds exactly ONE line of that model
   on that document — so there is no other build for the key to have come from.

Option 1 changes data to satisfy a checker and needs the owner's word; option 2
changes the checker and needs a test. Neither was done here.

**Ref.** 2026-09-09. Related: `docs/bugs/0762`.
