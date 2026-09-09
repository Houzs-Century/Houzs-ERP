## A description the account book cannot store was invisible on every screen [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Three documents sat outside AutoCount — `HC-SO-012312`,
`HC-SO-007678`, `HC-PO-2609-017` — and nothing on any screen said why. The
refusal existed only as a line in a workflow log:

> a line's Further Description is over AutoCount's nvarchar(100) — shorten the
> special order or the colour text on that line, then save again

Measured 2026-09-09: the worst of them is **104 characters against a limit of
100**. Four characters kept a purchase order out of the accounts, and the person
who typed it had no way to know.

**Root cause — the refusal was right, and it reached nobody.**
`Desc2TooLongError` has been correct since it was written: `SODTL.Desc2` /
`PODTL.Desc2` are `nvarchar(100)`, SQL Server refuses the whole Save, and
truncating is not an option because Desc2 IS the specification the factory
builds from. What was missing is the other half — **the screen never showed the
length**, so the only place the limit existed was the queue, hours later, in a
log nobody reads. This is the class `docs/bugs/0728` left open in writing:

> THE CLASS IS BIGGER THAN THIS FIELD, and it is open. AutoCount's columns are
> fixed-width, and this repo now holds exactly one of those widths.

The address was the first. This is the second, found because it stopped three
documents rather than because anybody went looking.

**Not a field anybody types, which is why there is no `maxLength`.** Desc2 is
BUILT: `buildVariantSummary` folds the line's colour, divan, gap, leg, seat and
special orders into one string, so the length belongs to the whole line and no
single input owns it. Measured the same day — a plain bedframe renders 46
characters, and two long special-order notes take it to 104:

```
PC151-12 / DIVAN 8 + LEG DEFAULT / GAP 2 / SPECIAL: ADD 2 INCH FOAM ON TOP + CHANGE HEADBOARD TO 48 INCH   104  refused
PC151-12 / DIVAN 8 + LEG DEFAULT / GAP 2 / SPECIAL: ADD 2" FOAM ON TOP + CHANGE HB TO 48 INCH               93  fits
```

The second is the owner's own shortening of the first, 2026-09-09. **The
special-order wording is what decides it**, not the rendering — which matters,
because `buildVariantSummary`'s output is also what `autocount-line-keys.ts`
matches against the book's stored Desc2 to tell one line from another. Changing
the renderer to save characters would break line identity; changing the words
does not.

**Fix — show it where the line is read, and never block.**

* `VariantDescription` renders `NNN/100 — too long for AutoCount` beside the
  specification when it overruns. **The warning lives there for the same reason
  the `Description 2` label does**: twelve screens already render that component,
  and the thirteenth gains it without remembering to.
* **A warning, not a wall.** The owner's standing rule is to loosen restrictions
  rather than wall the workflow, and the ERP has to stay usable on a line the
  accounts cannot yet take. Nothing is truncated and nothing is blocked; the
  person is told, and shortens it.
* **The number is one number.** `AC_DESC2_MAX` joins `ADDRESS_LINE_MAX` in
  `frontend/src/lib/acColumnWidths.ts` (renamed from `addressLimit.ts`, which had
  stopped describing what it holds), and
  `frontend/scripts/check-ac-column-widths.mjs` now compares BOTH against their
  backend originals — the address against `autocount-address-fit.ts`, Desc2
  against `autocount-sofa-collapse.ts`.

**Verified.**

* `VariantDescriptionTooLong.test.tsx` — **4 tests in a real DOM**: an
  over-long line shows the count and the limit; the owner's shortened spelling
  of the same specification (93) shows nothing; a plain line shows nothing; and
  the specification itself is still rendered — a warning that hid it would be
  worse than the refusal it warns about.
* `npm --prefix frontend run typecheck -- --force` clean; lint at ceiling;
  `check-docs-drift --strict` 0 CERTAIN.
* **The new gate arm was proven RED**: with the screen constant set to 101 it
  reported `the Description 2 limit on screen is 101 and the account book's
  column is 100` and exited 1.

**Still open, and it is the owner's to do.** The three documents above each need
their special-order text shortened by a few characters, in his own convention
(`2"` for `2 INCH`, `HB` for `HEADBOARD`). **Not done here on purpose**: the
actual text on those lines has never been read by this session, and Desc2 is a
factory build instruction — guessing at one sends a wrong instruction, which is
the failure `Desc2TooLongError` exists to prevent.

**Ref.** feat/the-screen-shows-a-description-the-book-cannot-store, 2026-09-09.
