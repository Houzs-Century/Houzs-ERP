## Mobile SO special picker showed "None" for sofa and bedframe [high]

**Symptom.** Owner, days of complaints culminating 2026-09-10..11 on the
mobile Sales Order line editor: tap a sofa line → tap **Special order** → the
bottom sheet opens with *"No preset special orders for this model — use
Custom / other below."* Every HOUZS sofa was affected; bedframe the same
way. Only mobile — desktop's SoLineCard shows the specials fine because it
renders them inside its own configurator.

**Ruled out (already run, PROVEN).** Not a data issue:
`check-sofa-specials-coverage.mjs` (PR #3590, dispatch run
34500612563, 2026-09-10T16:12:50Z) reports **HOUZS sofa special_addons
pool: 19 codes; active sofa product_models: 79; models with < 19
specials: 0; models with 0 specials: 0** — every sofa model has every
one of the 19 SOFA specials in `allowed_options.specials`.

**Root cause (code-traced).** In `MobileNewSO.tsx:3416-3429` the
`SpecialOrderSheet` computes `specialOptions` correctly (filters
`pools.specialAddons` by `active + categories.includes("SOFA") + allowed`,
yielding the 19 codes for a sofa line) — then gates rendering on
`useSpecialOrderSurface(...).optionPicker`:

```javascript
const presets = useSpecialOrderSurface({...}).optionPicker ? specialOptions : [];
```

That hook lives in `vendor/scm/lib/special-order-surface.ts`. It returns
`optionPicker: false` for sofa and bedframe on purpose — because on
DESKTOP the sofa/bedframe configurator hosts the special checkboxes
inside itself, so a standalone panel would render them twice. The file's
own comment says so (L35-36): *"SOFA and BEDFRAME are absent on purpose:
they render SpecialOrders INSIDE their own configurator panel, so a
standalone block would show it twice."*

**Mobile has NO such configurator.** The mobile LineCard opens THIS same
`SpecialOrderSheet` for sofa/bedframe (guard at
`MobileNewSO.tsx:3168`: `line.cat === "sofa" || line.cat === "bedframe"
|| specialSurface.block`). So mobile is using the sheet AS the sofa/bedframe
picker, then gating its contents on a hook written for desktop's world
where the sheet is not the picker. Result: `presets = []`, the "None"
copy renders, and 19 real codes sit in `specialOptions` unrendered.

**Fix.** Mobile-only: in `SpecialOrderSheet` compute a
`showPresetsForMobile` that ORs `surface.optionPicker` with `catUpper ===
"SOFA"` / `"BEDFRAME"`. Pooled goods (accessory / others) keep the
original `surface.optionPicker` guard because ticking a special re-keys
the stock bucket, which those categories must not do — this is why
`special-order-surface.ts` gates them in the first place.

Not touching `special-order-surface.ts` or desktop `SoLineCard.tsx` —
their rule is correct for desktop's dual-surface world.

**Verification.** Same tree: `check-sofa-specials-coverage.mjs` prints
the 19 codes; the mobile sheet now renders them for a sofa line. Full
browser verification at mobile viewport will follow together with the
force-calendar overlay PR (#3592).

**Ref.** `fix/shrink-sku-dropdown`, 2026-09-11.
