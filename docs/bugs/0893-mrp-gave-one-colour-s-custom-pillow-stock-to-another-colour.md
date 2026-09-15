## MRP gave one colour's custom pillow stock to another colour's order, because an accessory keyed on its code alone [high]

**Symptom.** The owner, 2026-09-14, on the MRP screen for
`AMN-SQUARE PILLOW (16"x16") (CUSTOM)`: 44 sales orders grouped under one row,
every one reading `stock`, while the orders want different colours. 「这个 scrap
custom 之前应该是有选颜色的，为什么没有帮我放颜色进来？…它莫名其妙把我的所有布料都乱分配…
包括 long pillow 也是这样子」.

**Root cause (traced to the line).** `computeVariantKey`
(`backend/src/scm/shared/variant-key.ts`) builds a line's stock bucket from its
group's attributes:

```ts
sofa:      ['fabricCode', 'seatHeight', 'legHeight'],
bedframe:  ['fabricCode', 'gap', 'divanHeight', 'legHeight', 'totalHeight'],
accessory: [],
```

A custom pillow is an `accessory`, so its key is empty: every colour is ONE
bucket, and MRP's FIFO walk hands PC151-01 stock to a PC151-02 order.

The colour was not lost — it was put where the key cannot see it. The
2026-09-10 design sent a custom pillow's colour to the typed *Custom / other*
special-order text (`variants.extraAddonNote`), which no branch of
`computeVariantKey` reads, by the rule "describe freely, re-key never". That rule
is right for pooled accessories and wrong for a made-to-order pillow whose colour
IS its identity. Measured on production (run 34784207049): **0 of 333**
scrap-pillow sales lines carry a colour in any field stock can read.

**Ruled out.** Counting the typed text as spec was measured before building it
(run 34832293775): the same box holds remarks on mattresses and free gifts —
`15years guarentee 1 to 1`, `dispose 2x s.single`, `taken` — which would have
split pooled stock and made a King mattress with a remark unable to use the 54 on
hand.

**Fix (owner's design, 2026-09-14).** A new category, **Sofa Accessory**:
enum `FABRIC_ACCESSORY`, group `fabric_accessory`. It keys stock by `fabricCode`
only, requires a fabric on the sales order (colour only — no seat or leg), offers
the same fabric picker as a sofa on desktop, mobile and the PO editors, binds per
order in MRP like a sofa, and takes the sofa lead days.

Two traps closed while building it, both measured:

- **The name.** 41 readers test a group with `includes('sofa')` — pricing,
  sofa-mix, MRP, readiness, the sofa batch guard, delivery rates. A pillow named
  `sofa_accessory` would have been a SOFA main product to every one, so the code is
  `FABRIC_ACCESSORY` and the label shown to people is "Sofa Accessory".
- **Two enum types.** Production holds BOTH `public.mfg_product_category` and
  `scm.mfg_product_category` (probe-category-constraints, run 34834008369). The
  DINING precedent (0258) extended only the public one; this migration extends
  both, or the category would appear in the UI and be refused on save.

The existing SQUARE PILLOW / LONG PILLOW products and their open orders are moved
in a separate step once the owner re-categorises them; this entry covers the
category and its behaviour.

**Ref.** feat/sofa-accessories-category, 2026-09-14.
`tasks/PLAN-sofa-accessories-category.md`, `backend/tests/fabricAccessoryCategory.test.ts`.
