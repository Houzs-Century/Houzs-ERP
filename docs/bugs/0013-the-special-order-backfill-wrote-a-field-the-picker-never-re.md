## The special-order backfill wrote a field the picker never reads, and recompute erases [high]

**Symptom** — the sofa special orders were "backfilled" and the Special Orders
accordion on every migrated SO/PO line still showed `(0 selected)`.

**Root cause (traced, not guessed)** — the backfill wrote `custom_specials`.
The picker binds to `variants.specials`: `SpecialOrders.tsx:91` reads
`specialsList(variants.specials ?? variants.special)` and `toggleCode` patches
`specials` back (callers `SoLineCard.tsx:944`, `PoLineCard.tsx:493` and `:541`).
`custom_specials` is the opposite direction — a DERIVED OUTPUT of the pricing
recompute: `mfg-pricing-recompute.ts:283` normalises `variants.specials` and
`:604` emits `custom_specials` from it. Nothing anywhere reads it back into the
picker; in `frontend/src` it appears only as report columns. It is also
VOLATILE: `mfg-sales-orders.ts:8234` sets
`updates.custom_specials = recomputedPatch.custom_specials ?? null` on every
line recompute, so the first UI edit of a migrated line would have erased the
backfill even where it had landed.

Three defects, not one. The field was wrong (derived output, not the picker's
input); the CONTENT was wrong (`backfill-sofa-special-orders.mjs` wrote the
verbatim slip phrases parseSofa returns — "BOTTOM USE UMBRELLA FABRIC" — beside
the codes, and a phrase is not a pickable code); and the SHAPE was wrong —
`mfg-pricing-recompute.ts:117` declares
`custom_specials: Array<{ description: string; surchargeSen: number }> | null`,
objects, while the script wrote a bare `string[]`. Production as of 2026-08-10
carried any `custom_specials` at all on only 9 of 1005 migrated sofa SO lines
and 6 of 217 PO lines, and not one of those was a picker code.

**Fix** — `backend/scripts/backfill-specials-into-variants.mjs` +
`.github/workflows/backfill-specials-into-variants.yml`, re-deriving each line's
specials from its own `description2` and merging picker CODES into
`variants.specials` via `jsonb_set` on that one key. The phrase -> code map is a
data file (`backend/scripts/data/special-order-phrase-map.json`) carrying the
owner ruling behind each family; codes resolve against a LIVE
`scm.special_addons` read and a phrase with no owner code is REPORTED, never
invented. Covers SO + PO, sofa + bedframe. `custom_specials` is left alone —
recompute regenerates it from variants.

**The class, for next time** — before backfilling a user-visible choice, find
the line in the COMPONENT that reads it. A derived column and the field it is
derived FROM look identical in the database and behave in opposite directions:
writing the derived one is invisible, and is deleted by the next recompute.

**The money check that has to come with it** — a picked code's
`selling_price_sen` is folded into the authoritative unit price
(`mfg-pricing.ts:396/400/405` -> `unitPriceSen` at `:408-415`, charged at
`mfg-pricing-recompute.ts:435`). Stamping a PRICED code onto a migrated line
silently reprices that historical document on its next edit, so the backfill
script refuses to APPLY when any code it would stamp carries a non-zero price.

**Ref** — 2026-08-10, PR fix/specials-into-variants.
