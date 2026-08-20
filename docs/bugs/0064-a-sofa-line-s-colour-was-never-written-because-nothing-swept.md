## A sofa line's colour was never written, because nothing swept sofa and the parser could not read an unlabelled code [high]

**Symptom** - the owner, 2026-08-11: *"可是我明明之前已经整理了很多次，为什么还是没有
记录成功呢？"* The fabric library had been tidied repeatedly and sofa lines still
read with no colour: `COLOUR` complete 175/219 on purchase-order sofa and
218/274 on proceeded sales-order sofa, against bedframe's 405/406.

**Root cause (two independent causes, both measured on production, not guessed)**

1. **No sweep has ever written a sofa variant.** `refresh-po-variants.mjs:61` and
   `refresh-so-variants.mjs:69` are hard-filtered to `item_group = 'bedframe'`.
   Their own dry-run output says so - *"imported PO bedframe lines: 406"*. Every
   tidy-up of `scm.fabric_colours` was therefore invisible to sofa: the library
   was corrected, and nothing ever went back to read it onto a line.
2. **`parseSofa` read a colour only when it was LABELLED.** `Col: X` was matched;
   an unlabelled code was not. `parseSofa("BO315-21 (PEARL)/28\"/2L")` returns
   `color: null` with `why: ['token "BO315-21"']` - the parser SAW the code and
   discarded it as an unrecognised structure token. So a sweep that had run would
   still have read nothing.

**The evidence that the library was never the blocker:** of the 86 blank colour
axes, **85 hold no value at all** and exactly 1 says TBC. Not one is a code the
library failed to resolve.

**Fix** - `parseSofa` gains an opt-in `opts.knownColour` predicate. When no
labelled colour is found and the caller supplies the predicate, an unlabelled
segment is read - but only when `scm.fabric_colours` CONFIRMS it. A code the
library confirms is a copy of what AutoCount wrote; a code it cannot confirm is a
guess. Without the predicate the function behaves exactly as before, so no
existing caller changes. `backfill-sofa-variants-from-desc2.mjs` is the sweep
sofa never had: fill-only (an operator's correction outranks a re-parse),
exact-match by default, `variants || patch` through `db.json()`.

**What this did NOT fix.** Only **14** lines can be filled on exact matches.
**80** more are blocked because their colour resolves only through the fuzzy
matcher, and a match is not a copy, so they are held for the owner rather than
written. The blocking set is benign - 17 distinct mappings, every one a
formatting difference on the same fabric:

```
"BO315-21 (PEARL)"          ->  BO315  / BO315-21          (the bracket is the colour name)
"B0315-1 pearl"             ->  BO315  / BO315-1-PEARL     (zero for the letter O)
"GD2502#04-OAK"             ->  GD2502 / GD2502-04
"MODENZA 01-HOUSTON CREAM"  ->  MODENZA / MODENZA-01
```

A FIRST version of this script reported 338 held colours and a frightening
`Harring 02# Beige -> HIRRING GD8371` beside `HARRING GD8371 02# BEIGE ->
GD8371` - one physical fabric resolving to two library rows. That reading was
an artefact of the script, which pushed to the hold list before asking whether
the line had a blank axis at all: those rows were already filled and nothing
would have touched them. The duplicate-series problem is real and still open
with the owner, but it does NOT block this backfill.

**A second defect the hold list did expose:** the labelled-colour rule captures
to end of line, so it carries instructions as colour values -
`"B0315-5 FOSIL request to normal leg and not fully cover"`, `"BO315-2 (24inch)"`.
Not fixed here.

**Lesson** - a check that says a field is empty does not say WHY. "The library is
missing the code" and "nothing ever wrote the code" produce the identical
symptom, and only one of them is fixed by tidying the library. Ask which before
repeating the repair.

**Ref** - fix/sofa-variant-backfill, 2026-08-11.
