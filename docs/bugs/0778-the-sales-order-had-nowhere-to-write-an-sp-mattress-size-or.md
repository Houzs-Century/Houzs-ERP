## The Sales Order had nowhere to write an SP mattress size or a custom pillow colour [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** The owner, 2026-09-10: 「我有一些单一的SKU 好像mattress SP和这个custom
需要选颜色 SP需要写尺寸 这种我可以在哪里填写呢？」 A single-SKU line — a `(SP)`
special-order mattress that needs a SIZE, a custom pillow that needs a COLOUR —
had no field for it anywhere on the Sales Order. The information ended up in the
line remark or in somebody's head, and the supplier's purchase order never
carried it.

**Root cause (traced).** The free-text field already existed. `SpecialOrders`
renders a "Custom / other" description independently of the catalogue, and
`buildVariantSummary` prints it as `SPECIAL: <text>` into `description2`, which
is what a purchase order shows the supplier. What was missing was a way to REACH
it.

`SoLineCard.tsx` decided whether to render the panel with one condition that
answered a different question — *is there an add-on to tick?*

```
Boolean(draft.itemCode) && category === 'mattress'
  && (specialOptions.length > 0 || specials.length > 0 || posRemarkSpecial != null)
```

`specialOptions` is the active `special_addons` rows whose `categories` include
this line's category. The catalogue defines none for mattress (the code's own
comment says "none today"), so a plain SP mattress failed all three arms and got
no panel — and with no panel, no free text. Accessories and dining/`others`
lines were never in the condition at all. Mobile matched: `MobileNewSO.tsx`
showed its "Special order" row for `sofa` and `bedframe` only, and gave mattress
an explanatory note instead.

**Fix.** The decision moves into one shared module with its own tests,
`frontend/src/vendor/scm/lib/special-order-surface.ts`, read by both surfaces —
the desktop card, the mobile row, and the mobile sheet. It answers TWO questions
separately, which is the part the old condition conflated: does this line get the
panel, and may the operator tick a catalogue add-on inside it.

mattress / accessory / others now get the panel on category alone. Accessory and
others get the FREE TEXT ONLY: `computeVariantKey` (`scm/shared/variant-key.ts`)
builds a line's stock bucket from the group's attributes plus
`normSpecials(a.specials)`, so a ticked add-on appends `special=` and splits the
bucket — which for goods that pool by item code would stop a line matching its
stock and the purchase orders raised for it. `extraAddonNote` is read by no
branch of that function, so the free text cannot move a line anywhere. A pooled
line that ALREADY carries picks keeps its picker, so those picks render with
their real labels instead of SpecialOrders' "retired — untick to remove" branch.
SERVICE stays out: a fee line is not goods and orders nothing.

Eight tests on the new module. Four more in
`backend/src/scm/shared/variantSummarySuperseded.test.ts` pin the half that
reaches the supplier — the `SPECIAL:` segment is appended AFTER the per-group
attribute branch, not inside it, so a category contributing no attributes still
prints its note. Those four are CHARACTERISATION tests: they passed on the
unfixed tree, because that behaviour was already correct and is what makes the
UI change worth making. They exist so a later refactor cannot quietly strip the
note off every purchase order.

**Ref.** feat/so-custom-note-all-categories, 2026-09-10.
