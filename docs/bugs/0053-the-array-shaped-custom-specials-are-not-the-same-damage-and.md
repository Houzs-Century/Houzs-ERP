## The array-shaped custom_specials are NOT the same damage, and NULLing them would have deleted correct data [med]

**Symptom** - #1944 NULLed the 478 `custom_specials` values the old sofa
backfill had double-encoded into jsonb STRING scalars, and left the ARRAY-shaped
remainder alone because `jsonb_typeof` cannot tell a correct
`Array<{description, surchargeSen}>` from a bare `string[]`. The obvious next
step was to finish the job and NULL the remainder too. That step would have been
a data loss.

**Root cause (traced, not guessed)** - the census
(`backend/scripts/census-custom-specials-arrays.mjs`, prod run **31428435434**,
read-only) classified every array-shaped row from its ELEMENTS:

```
SO  custom_specials shape census: array=511      511 bare string[], 0 object, 0 empty, 0 other
PO  custom_specials shape census: array=93        93 bare string[], 0 object, 0 empty, 0 other
migrated 604/604      already carrying variants.specials 604/604
694 strings, 16 distinct:  679 are a LIVE scm.special_addons code, 15 are raw slip text
rows where variants.specials COUNT differs from custom_specials length: 0
```

The histogram: `HB Fully Cover` 282, `Front Drawer` 150, `HB Straight` 138,
`Divan Curve` 45, `Divan Full Cover` 39, `No Side Panel` 9, `Left Drawer` 7,
`1 Piece Divan` 4, `Divan Top Fully Cover` 3, `Right Drawer` 2 - all real picker
codes - plus `BOTHWANT` 4, `FABRICHARRING` 3, `DAYBED` 2, `LEFTSIDE` 2, `LSIDE`
2, `request to normal leg and not fully cover` 2.

So these rows are NOT the sofa backfill's output. They are the BEDFRAME specials
pass (`fix-so-specials.mjs`), which wrote **correct picker codes** in the legacy
`string[]` shape and never double-encoded anything.

**The premise that does not carry.** #1944's repair stood on three legs, and the
load-bearing one was *"valid jsonb holding WRONG DATA is worse than empty,
because it looks repaired"*. Here the data is RIGHT: 679 of 694 strings are live
codes, and every row's `variants.specials` holds exactly as many entries as its
`custom_specials`, so the derived cache agrees with its source on all 604 rows.
The renderer handles both shapes deliberately - `SalesOrderDetailListing`'s
`formatSpecials`, mirrored by `check-specials-and-ocr.mjs:55-57`'s `elText`,
reads a plain string and a `{description|label}` object alike. NULLing these
would have removed a correct, currently-rendering line item from 604 historical
documents until somebody edited each one. That is a regression wearing the
costume of a repair.

The other two legs still hold and are why nothing is "upgraded" to the object
shape either: `custom_specials` is derived, and writing a real `surchargeSen`
would mean pricing outside the pricing engine on historical documents - the
repricing the owner ruled out on 2026-08-11.

**Fix** - no data was changed. The tool changed instead, so the next person
cannot make the mistake the numbers now rule out. `string[]` is split into
`codes[]` (every string a live code - legacy shape, correct content, **never** a
repair candidate) and `text[]` (at least one raw phrase). `APPLY=1` alone is now
inert: the only writable class is `text[]`, and it additionally requires
`APPLY_TEXT=1`, because all 15 of those rows carry the SAME raw text in
`variants.specials` - the field the picker actually reads - so nulling the
derived cache alone hides it from the report and leaves it in the operator's
view. That is an owner decision, and the switch is where the owner's answer gets
recorded. The report now prints `variants.specials` beside `custom_specials` so
the agreement is visible rather than inferred.

**Open, for the owner** - the 15 lines whose `variants.specials` carries raw
slip text instead of a code: SO HC-SO-004716, HC-SO-005940 (x2), HC-SO-007132
(x2), HC-SO-009600 (x2), HC-SO-012571 (x2); PO HC-PO-000162, HC-PO-000596 (x3),
HC-PO-009677 (x2). Two of them, `request to normal leg and not fully cover`, are
a phrase the map deliberately VETOES, so they were never meant to be a pick at
all.

**The class, for next time** - a repair that worked once is a hypothesis the
second time. #1944's reasoning was right about the rows it saw and wrong about
the rows it had not looked at, and the two populations are indistinguishable by
the column type that named them. Classify by CONTENT before extending a fix by
SHAPE - and when a script offers to delete, make the class it will delete the
narrow one, not the broad one.

**Ref** - 2026-08-11, census tool PR #1953, finding + refusal PR #1960
(fix/census-codes-are-not-damage). Prod evidence: read-only run 31428435434.
