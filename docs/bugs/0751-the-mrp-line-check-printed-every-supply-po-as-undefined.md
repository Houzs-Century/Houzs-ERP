## The MRP line check printed every supply PO as undefined [low]
<!-- area: Repo tooling: tests, ratchets, generators -->
<!-- status: fixed -->

**Symptom.** The first real run of `check-mrp-so-line.mjs`
(run 34328164770, `HC-SO-013043`) listed each bucket's open PO supply as:

```
  on-hand 8   open PO 1   demand lines 45
    PO undefined eta 2026-09-23 left 1
```

The quantity and the ETA were right; the PO number was `undefined` on every
row. The allocation lines below it printed their PO number correctly
(`-> covered by PO HC-PO-010104`), so only the supply LISTING was affected.

**Root cause (traced).** One field name, two spellings, in
`backend/scripts/check-mrp-so-line.mjs`. The queue entry is built camelCase from
the snake_case row — `{ poNumber: r.po_number, eta, qtyLeft: left }` (:309) —
and the listing line read `p.po_number` (:319), which no longer exists on that
object. The allocation walk below used `front.poNumber` and was right all along,
which is why the defect showed on one line and not the other. `undefined` in a
template literal is not an error in JS, so nothing failed — the run exited 0 and
the answer it was asked for (which lines enter MRP demand, and their coverage)
was still correct.

**Fix.** `p.po_number` -> `p.poNumber`. No test: this file is a read-only
production diagnostic with no harness, and its output is read by a human — the
proof is the next run's output, cited in the PR. Guarding a one-line template
read behind a fixture would be more machinery than the thing it guards.

**Lesson.** A camelCase view over a snake_case row is a place to be wary of
inside ONE file. The engine this replicates has the same shape and gets it right
by never mixing the two in a single scope; the script built a camelCase object
and then read it as if it were still the row.

**Ref.** `fix/mrp-line-check-po-number`, 2026-09-09. First reported by its own
first production run, one commit after `docs/bugs/0750` added it.
