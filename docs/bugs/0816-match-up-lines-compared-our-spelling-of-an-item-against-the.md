## Match up lines compared OUR spelling of an item against the book's [high]

**Symptom.** The relink sweep stamped ZERO keys on every held-back document,
through three `apply` runs on 2026-09-11 and a real fix to its matcher
(`docs/bugs/0812`). Pressing **Match up lines** by hand did nothing either. The
cause could not be established until the sweep was made to report
(`docs/bugs/0815`), and then it said the same thing thirteen times:

```
GR HC-GRN-2609-015: 2 keyless, 0 matched
   refused: 'AKEMI ARMOUR MATT (SK)' — the account book has no unclaimed line with that item code
```

**Root cause.** The book does not call it that. `composeEdit` resolves every ERP
code through the cutover map before sending it (`resolveAcItemCode`, the RESOLVE
step of the write-back's own pipeline), so the account book holds
`AK-ARMOUR MATT (SK)` where this ERP holds `AKEMI ARMOUR MATT (SK)`.
`planLineRelink` matched on the RAW ERP code, so it compared our spelling
against theirs. Every line of every document whose supplier spells things
differently could only ever refuse.

**It was a known gap, written down at both call sites and never closed.**
`ErpLineForRelink.acItemCode` is documented as *"what the write-back SENDS for
this row — the book's spelling, not ours"*, and both callers passed
`r.item_code` under a comment that ends: *"Resolving properly is the follow-up,
not a silent widening."* This is that follow-up.

**Why it hid for so long.** The refusal text names the code it looked for and
not the code the row holds, so `'AKEMI ARMOUR MATT (SK)' — no unclaimed line
with that item code` reads as a statement about the BOOK being short of a line.
It is a statement about the two sides using different words. And until the sweep
could report at all, even that sentence was invisible.

**Fix.** Both callers — the "Match up lines" route and the sweep — resolve each
ERP code through `bindingsFor` + `resolveAcItemCode` before handing it to
`planLineRelink`, which is exactly what the write-back does before sending. The
planner is unchanged.

**Still fail-closed.** An unresolvable code falls back to the raw one and
refuses, as before. Resolution can turn a guaranteed miss into a possible match;
it cannot turn a wrong match into a confident one. The planner's own proofs —
one unclaimed candidate, or Desc2 separating a repeat — are untouched.

**A test assumption that was wrong, kept as a note.** The first draft asserted
that an empty binding map means an unresolvable code. It does not: the resolver
has TWO sources, the live `supplier_material_bindings` and the cutover CSV
index, and the CSV alone resolved `AKEMI ARMOUR MATT (SK)`. The code was right
and the test was wrong; the test now uses a code neither source knows.

**Tests.** Two in `autocountRelinkSweep.test.ts`, RED against the unfixed tree:
a code the book spells differently now matches and would stamp; a code neither
source knows still refuses. The pre-existing 9028 delivery-order fixture — three
compartments the book keeps as three lines — still matches all three, which is
the regression that mattered. `scm/lib` + `scm/routes`: **2641 passed**.

**Ref.** 2026-09-11. The three that had to land first: `0812` (the matcher's
sofa fold), `0813` (the drain's silence), `0815` (the sweep's silence).
