## The pairing roll-up printed undefined for the build-text stamps it had just made [low]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** Plan run `34210216732`:

```
SO — 2883 sales order(s), 15073 line(s): 224 row(s) the document FORCES
  (108 the only candidate, undefined matched one-to-one on the BUILD TEXT
   both sides state, 0 where the book's own lines are identical ...)
```

**Root cause (traced).** `planLineKeys` gained a third `forced` kind but its
`totals` object never gained the field: the `forcedBuildText: 0` initialiser was
written by a `perl -0pi` substitution whose pattern did not match, and the
accumulator line landed without it. `undefined + n` is `NaN`, and the property
was never read anywhere that would throw, so the only symptom was a report that
could not count its own work.

**Why it matters more than a cosmetic label.** The three `forced` kinds are meant
to sum to `stampedRows`, and that sum is the property that makes the number
checkable by a reader — 108 + 116 + 0 = 224. With one term `undefined` the
arithmetic silently stopped being available, on the very line an operator reads
before arming an apply that writes line identity into a live account book.

**Fix.** The field is initialised and accumulated beside the other two, and
`tests/acForcedLinePairing.test.mjs` pins `forcedUnique + forcedInterchangeable +
forcedBuildText === stampedRows` on a document that exercises the build-text
path. Re-measured on production, plan run `34210364936`: *"224 row(s) the
document FORCES (108 the only candidate, 116 matched one-to-one on the BUILD
TEXT, 0 ... interchangeable)"*.

**Ref.** fix/sofa-keys-unread, 2026-09-08.
