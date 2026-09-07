## The bedframe variant sweep never said what it would erase [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** On the 2026-09-07 go-live the remaining variant backlog was pointed
at `refresh-so-variants.mjs`, the tool that owns the bedframe axes. Its dry-run
against production said:

```
imported bedframe lines: 2572
lines to refresh: 2565; with colour: 1233 (newly gained 51)
```

Every number there is something the sweep would ADD. Nothing in the output is
something it would take away, and the operator deciding whether to run it had no
way to tell the difference between "this closes the backlog" and "this reverts a
month of staff edits". The last apply was 2026-08-10 — four weeks of operator
corrections stood between that run and this one.

**Root cause (traced, not guessed).** Two lines, in two files:

| where | what it does |
|---|---|
| `scripts/lib/variant-merge.mjs:111-122` | `buildBedframeVariantPatch` returns `null` for every owned axis the parse did not yield — `size` only comes from an explicit `NNNxNNN CM` pattern (`parse-bedframe.mjs:117`), so it is null on most lines |
| `scripts/refresh-so-variants.mjs:90-91` | `isPendingColour(bf.color)` sets `fc = null`, which nulls `fabricId`, `colourId`, `fabricCode`, `colourLabel` and `fabricLabel` together |

The write is `variants = COALESCE(variants,'{}') || patch`. `jsonb || jsonb`
overwrites exactly the keys on the right — **including the ones whose value is
`null`**. So an axis the ERP holds and the AutoCount Desc2 does not state is
DELETED, and a line whose book text still reads TBC/KIV loses its whole colour
block. The same night's reconcile counts **1,171 not-proceeded and 1 proceeded**
bedframe lines in exactly that TBC/KIV state.

**This is not a defect in the write.** Re-deriving a line from AutoCount is what
a sweep is for, and `||` rather than a whole-column replace is the fix from the
earlier entry ("The variant refresh scripts REPLACE the whole variants jsonb").
The defect is that the size of what it destroys was never a number, so the
decision to run it could only ever be an argument.

**Fix.** The dry-run now counts, per owned key, every line where the ERP holds a
value and the patch would write `null`, and prints the first ten of each:

```
WOULD ERASE: N value(s) the ERP holds and the AutoCount Desc2 does not state
   size           N
      SO-0xxxxx TRION (A)-(K): "K" -> null
```

The counter is computed from the same `updates` array the apply consumes — one
plan, two readers — so it cannot describe a different write from the one that
would run. Write behaviour is unchanged.

**What this did NOT do, deliberately.** It did not make the sweep fill-only. Which
axes a re-derivation is allowed to clear is the owner's call, not a script's, and
the sofa backfill already occupies the fill-only end of that choice
(`buildSofaVariantPatch`, `variant-merge.mjs:137`). This entry buys the number
that the choice needs.

**Ref.** chore/measure-variant-erasure, 2026-09-07.
