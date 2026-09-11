## A superseded fabric row sent its own obituary to the account book [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-SO-012513` and `HC-SO-012629` could not reach AutoCount. The
collapse composed 113 and 117 characters against a 100-character column and
refused rather than truncating — correctly, since a truncated specification is a
wrong instruction. What the text actually held:

```
2EL + 1ER / COL: BO315-3 [superseded by BO315-03 on 2026-08-11] / BOTTOM USE UMBRELLA FABRIC / Nylon Fabric
```

**39 of those characters are bookkeeping**, not a specification.

**Root cause.** The fabric library renumbered itself on 2026-08-11 and left each
old row in place with `[superseded by X on 2026-08-11]` **written into the row's
own LABEL** (`scripts/lib/colour-identity.mjs` records the same thing, from the
other direction). A line still pointing at the dead row therefore renders that
sentence inside its colour, and `buildVariantSummary` passed it through to the
screen, the PDF and AutoCount's Desc2 alike.

Nobody wrote it by hand and no repair of ours put it there — it is the library's
own label, so every line pointing at a superseded colour carries it.

**Fix.** `buildVariantSummary` renders the SUCCESSOR the note names, and a note
naming no successor is stripped, leaving the code. The owner's ruling,
2026-09-09: 「遇到「已被取代」的颜色就用新色号」.

**Why this is safe against the account book, measured rather than assumed.**
`autocount-line-keys.ts` matches this string against the book's own Desc2 to tell
one line from another, so changing the rendering could in principle break line
identity. It cannot here: across the committed cutover snapshots —
**60,939 SO lines, 18,148 PO lines, 47,329 DO lines, 126,416 in total** — **ZERO**
carry the word `superseded`. The note is ours alone, so removing it can only make
our text agree with the book MORE often.

**Verified.**

* `variantSummarySuperseded.test.ts` — **5 tests**: the successor is rendered,
  not the dead code and not the note; a note with no successor is stripped
  leaving the code; the note is read off the colour NAME as well as the code; an
  ordinary colour renders character-for-character what it rendered before; and
  the arithmetic that takes `HC-SO-012513`'s build from 113 back under 100.
* `scm/shared` suite — 561 passed, 36 files. `services` + `autocount-line-keys`
  — 391 passed.
* `check-shared-mirrors.mjs` — the frontend copy is IDENTICAL, so the screen and
  the account book cannot disagree about a colour.
* Both typechecks clean (`tsc --noEmit -p .`, `tsc -b --force`).
* The naming gate caught the comment before CI did: `scm/shared` forbids the old
  word for what an order is built to, and the first draft used it.

**UNTESTED against production** — the two sofa documents have not been re-sent
under this build.

**Ref.** fix/a-superseded-colour-note-does-not-go-to-the-book, 2026-09-09.
