## A sofa whose book line holds a piece of another model was refused and never reached AutoCount [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner's screenshot of the AutoCount Sync page on 2026-09-15
listed HC-SO-002861 and HC-PO-009827 under NOT ACCEPTED. Both edits were skipped
on 2026-09-14 (09:57 and 09:58Z) with *"sofa 8069: cannot spell [CNR] in the
AutoCount Desc2 grammar (stored Desc2 "MODENZA-01 HOUSTON CREAM / SEAT 28 / LEG
DEFAULT / SPECIAL: Bottom wrap nylon" decodes to [nothing])"*.

**Root cause (traced).** The amendment HC-SO-002861/A1, approved 2026-09-14,
changed one `8060-1NA` row to `8069-CNR` (the request note reads "ERP match wrong
code"), and the PO was re-derived from it. The book holds the sofa as ONE line,
DSL-8060 SOFA (184398 on the SO, 892697 on the PO), and all five ERP rows carry
that key: four 8060 pieces and the 8069 corner.

`scatteredByBookLine` (`backend/src/services/autocount-sofa-collapse.ts`)
grouped pieces by model AND key. The 8069 corner became a group of one, the
adjacency rule broke its run on the model change, and a lone corner has no solo
spelling, so it was refused.

Read on production 2026-09-15: this is the only build in company 1 whose pieces
mix models under one key. The difference may be what the customer ordered: other
orders carry specials such as "back rest change 8069". Changing the code without
the salesperson was therefore not an option.

**Fix.** Pieces sharing one key are gathered under the model that holds a strict
majority of them. Every other piece is named at the end of the text (`CNR 8069`),
so the book records the difference instead of hiding it.

The gate still round-trips pieces, size, colour and specials, and it also
requires every such name to be in the text. The decoder skips that segment: a
probe on 2026-09-15 read the same pieces, size, colour and specials with and
without it. Models with no majority are grouped apart and refused as before.

HC-SO-002861 now composes `1EL + C + 1NA + CT + 1B (28") / COL: MODENZA-01
HOUSTON CREAM / Nylon Fabric / CNR 8069` (87 characters) on key 184398 at the
line's own price.

Pinned in `backend/src/services/autocount-sofa-collapse.foreign-piece.test.ts`,
built from the production rows. It fails on the unfixed tree with the production
refusal, and passes after. Three controls pass on both:

- the same build with an 8060 corner carries no note;
- two models with no majority are still refused;
- a piece of another model under a different key is not gathered.

All five sofa fold suites pass (79 tests).

**Ref.** fix/ac-not-accepted-0915, 2026-09-15.
