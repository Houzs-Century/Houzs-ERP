## One "Price" box wrote the cost into the selling column, so a costing figure became a customer surcharge [high]

**Symptom.** The owner, 2026-09-13, when told a variant repair had to be checked
against pricing first: 「处理 variant 关卖价什么事情呢 不要影响到我们的卖价啊 只是
处理我们的 variant 啊」, then 「简单来说 我放的都是 costing 啊 为什么会 show 在 SO
和影响 SO 呢？完全都不需要有这个功能啊」.

He was right, and the code agreed with him before anyone asked.

**The design, on record since 2026-05-28** — `shared/mfg-pricing.ts:223-234`:

> *"variant `priceSen` is COST, NOT selling — so the customer-facing line total
> must read the Sales-Director-authored `sellingPriceSen` instead. Falls back to
> 0 when the option carries no selling surcharge (**the case today: surcharges
> contribute 0 to selling until a director sets a value**)."*

and `SoLineCard.tsx:1416`: *"`priceSen` is COST and must NOT surface in the SO
create/edit flow."*

So: the maintenance figure is a COST, and the customer surcharge is supposed to
be 0 unless a Sales Director deliberately authors one.

**Root cause (traced to the line).** Both maintenance screens showed ONE input,
labelled `Price (RM, can be −)`, and wrote it to BOTH columns:

```tsx
// frontend/src/pages/scm-v2/Products.tsx:4676
onChange={(e) => { const sen = …; patchRow(i, { sellingPriceSen: sen, costPriceSen: sen }); }}

// frontend/src/vendor/scm/components/SpecialAddonsTab.tsx
const withSyncedPrice = (priceSen) => ({ sellingPriceSen: priceSen, costPriceSen: priceSen });
```

Its comment explains the intent — *"the single surcharge that flows to SO
**costing** … keeping the two columns in sync means the displayed price and the
costing price never diverge"* — and the intent is the error. They are not two
spellings of one number: `lookupCost` reads the cost column, `lookupSelling`
reads the selling one and **adds it to what the customer pays**. Syncing them
made *"a director set a value"* accidentally true for every option anybody
priced.

**Measured on production, company 1, 2026-09-13** (audit run 34742004803):
**11 of 35** options carry a selling surcharge — RM500, RM250, RM160 ×2, RM130,
RM80, RM50 ×4, −RM40 — and in **every one of the eleven the selling figure
equals the cost figure exactly**. That is the signature of a copied column, not
of eleven separate pricing decisions.

**Blast radius: ZERO documents, measured not assumed** (run 34745750576). Of
3,948 sofa/bedframe sales lines, **3,944 are on a MIGRATED order** where the
surcharge arm is structurally inert —

```ts
// lib/mfg-pricing-recompute.ts:535-545
const isMigratedTrust = trustOperatorSelling === 'including-zero';
const chargeableSurchargesSen = isMigratedTrust ? 0 : sellingSurchargesSen;
```

— 4 are native, and **0 native lines carry a priced option**. So not one
document's price depends on these figures today, and the whole exposure is
forward-looking: the next order typed in the ERP that picks `HB Fully Cover`
would have charged the customer RM50 nobody decided on.

**It was also visible to the salesperson, on both surfaces.** Desktop
`SoLineCard.tsx:1223` renders a `+ Variants RM…` row whenever `extraSen > 0`,
and mobile `MobileNewSO.tsx:3490` renders `+RM …` whenever
`sellingPriceSen !== 0`. Both are keyed on the same column, so both showed a
number the owner never intended anyone to see.

**Fix, in two halves.**

1. **The screens write the COST only**, and the field is labelled `Cost`. The
   list columns read `costPriceSen` too, so the figure the owner types is the
   figure he sees. `selling_price_sen` stays in the schema and the API — a Sales
   Director can still author a real surcharge deliberately, and company 2 carries
   its own values to the 2990s POS, which sets its own price.
2. **`zero-special-addon-selling-price.mjs`** puts the eleven back to 0 for one
   company, leaves every cost byte-identical, and verifies both on a fresh
   connection. Because both SO surfaces gate on non-zero, that one data change
   makes desktop and mobile render clean with no further code change.

**The lesson worth keeping.** Two columns that usually hold the same number are
not one column. The comment that introduced this said keeping them in sync meant
they "never diverge" — but divergence was the feature: one is what we pay, the
other is what we charge, and the gap between them is the margin. A UI that
collapses two meanings into one box will eventually assert the wrong one, and
nothing downstream can tell that the value was never decided.

**Ref.** fix/special-addon-price-is-cost-only, 2026-09-13. Related:
`docs/bugs/0851` (the legacy-spelling round that made this question urgent).
