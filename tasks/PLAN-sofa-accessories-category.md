# PLAN — the SOFA ACCESSORIES category (2026-09-14)

## The ask, in the owner's words

> 帮我把这个 square pillow 和 long pillow 做到像 bedframe 那样 binding 的选。然后这两个
> 可以选 fabrics … 我们需要开一个 category 是 sofa accessories。Sofa accessories 还是
> 需要选颜色的，它只需要选颜色，然后颜色是 from 我们的 fabric 那边去做。… 只要 under
> 这个 category 的，都需要选 fabric，而 fabric 是 API from 我们的 fabric 那边，就好像
> 沙发这样子。后续我会跟你说什么 category 需要换、什么 SKU 需要换去这一边。这样我们
> sofa 那边的 MRP 通常就可以根据这个来下订这个 order。

## Why (the defect this replaces)

MRP handed every `AMN-SQUARE PILLOW (16"x16") (CUSTOM)` the same stock whatever colour
the customer wanted. Traced, not guessed:

- `ATTRS_BY_GROUP.accessory = []` in `scm/shared/variant-key.ts` — an accessory's stock
  key carries no attribute, so all custom pillows are ONE bucket.
- The colour lives only in `variants.extraAddonNote` (the typed *Custom / other* text),
  which no branch of `computeVariantKey` reads — by the 2026-09-10 design "describe
  freely, re-key never", correct for pooled accessories and wrong for made-to-order
  pillows.
- Production, run 34784207049: 0 of 333 scrap-pillow sales lines carry a colour in any
  field stock can read; the colour is in text on ~150.

A typed-text-as-spec approach was measured first (run 34832293775) and rejected: mattress
and free-gift lines carry remarks in the same box (`15years guarentee 1 to 1`,
`dispose 2x s.single`, `taken`), which would have split pooled stock. The owner's
category design is the normal-ERP answer: colour becomes a real variant attribute.

## Design

| decision | value | why |
|---|---|---|
| enum value | `FABRIC_ACCESSORY` in `public.mfg_product_category`, shown as **Sofa Accessories** | one enum, same path as DINING/BEDLINES/DIFFUSER/CARPET (#1628) |
| line `item_group` | `fabric_accessory` | lower-case group, as every other category |
| **why not `SOFA_ACCESSORY`** | 41 readers test a group with `includes('sofa')` — pricing (`mfg-pricing-recompute.ts:201`), sofa-mix (`main-mix.ts:121`), MRP (`mrp.ts:1111`), readiness (`so-readiness.ts:69`), the sofa batch guard, delivery rate cards and zones. A pillow named `sofa_*` would be a SOFA main product to every one. `accessory` / `fabric` are tested by equality only (0 substring readers, `git grep` 2026-09-14) | the label is for people; the code is for machines |
| stock key attributes | `['fabricCode']` | colour only — no seat, leg, gap |
| required on SO line | fabric (colour) | 「只需要选颜色」 |
| fabric source | the fabric master, same picker as sofa | 「fabric 是 API from 我们的 fabric 那边」 |
| supplier binding | chosen like bedframe | 「像 bedframe 那样 binding 的选」 |
| MRP | hard-bound, per order, grouped with the sofa | a custom pillow is made per order; 「sofa 那边的 MRP … 下订这个 order」 |
| main-product rules | NOT a main product | a pillow must never trip the sofa-mix block or count as the order's main item |
| lead time | same base lead days as sofa | it is ordered on the sofa's purchase order |

## Phases — each one merged, deployed and verified before the next

1. **The category exists and keys stock by colour.** Enum migration; `ATTRS_BY_GROUP`
   and `REQUIRED_VARIANT_AXES_BY_CATEGORY` (backend + frontend mirrors); every
   hard-coded category list that must offer it (product maintenance, lead times, PWP,
   special add-ons, scan, assistant); supplier-category lead-time CHECK; tests.
2. **The sales order asks for the fabric.** `SoLineCard` (desktop) and `MobileNewSO`
   (mobile) render the fabric picker for `fabric_accessory`; supplier binding picked like
   bedframe; save blocked without a colour.
3. **MRP orders it per order.** `HARD_BOUND_GROUPS`; the sofa convert batch picks it up;
   verify on a real document.
4. **Move the two SKUs and the old orders.** `SQUARE PILLOW` and `LONG PILLOW` to the new
   category; every open line's `item_group` follows; colour back-filled into
   `fabricCode` from the line's own text ONLY where it resolves to a live fabric colour;
   stock moved per lot traced to the line's own receipt (`inventory_lots.source_doc_id`
   / `movement_id`), never by bucket; unresolved colours listed for the owner.

## Hard-coded category lists found (2026-09-14, `git grep`)

Backend: `lib/lead-time.ts:65`, `routes/mrp-lead-times.ts:28`, `routes/mfg-products.ts:233`,
`routes/product-models.ts:146`, `routes/pwp-rules.ts:24`, `routes/scan-so.ts:644`,
`routes/special-addons.ts:30`, `shared/so-branding-label.ts:106/110`,
`services/assistant-tools.ts:94`, `lib/so-stock-allocation.ts:78` (HARD_BOUND, phase 3),
`lib/so-readiness.ts:61` + `so-display-branding.ts:46` + `delivery-planning.ts:588` +
`mfg-sales-orders.ts:1571` (MAIN categories — deliberately NOT extended).

Frontend: `pages/scm-v2/Mrp.tsx:91`, `pages/scm-v2/ProductModels.tsx:49`,
`pages/scm-v2/SupplierDetail.tsx:208`, `pages/scm-v2/products/VariantsTab.tsx:87`,
`vendor/scm/lib/mrp-queries.ts:191`, `vendor/shared/so-branding-label.ts`,
`vendor/scm/lib/special-order-surface.ts:43/46`.

DB: `20260911T0900_scm_mrp_supplier_category_lead_times.sql:33` CHECK constraint.

## Phase 4 — the data run (2026-09-14)

Owner: 「这几个也是swap去sofa accessory 然后看一下之前旧的order 都帮我backfill颜色」 —
models AR01, AR02, BC04, BC04-MF, BC05, BC05-MF, SB02 plus SQUARE PILLOW, LONG PILLOW
(company 1). Tool: `backend/scripts/recategorise-fabric-accessory.mjs`, workflow
*Move products to Sofa Accessory + back-fill colour*; colours are read by the one
matcher (`backend/scripts/lib/fabric-colour-match.mjs`) through
`backend/scripts/lib/line-colour-verdict.mjs`, which refuses two-colour lines and
assumed series.

Plan run 34844943846 (production, rolled back): 7 models + 9 SKUs move; line
groups on SO 248 / PO 85 / GRN 48 / DO 14 / PI 29 / SI 1; 294 lines get a colour
(own text or inherited from the line they came from); 19 lines name a colour the
fabric master does not hold or name two colours, and are left blank and listed;
12 received lots relabelled by their own GRN line's colour; the AutoCount opening
lots (211 SQUARE PILLOW, 11 LONG PILLOW on hand) stay colourless.

After the apply: run *Recompute SO allocation* with write=1.

The owner can now swap a model or a model-less SKU between Accessory and Sofa
Accessory himself (PR #3861); that moves the product only, and old lines need
this run.

## Open

- The on-hand custom pillow stock (239 `SQUARE PILLOW`, 14 `LONG PILLOW`, all keyed with
  no colour) has no recorded colour. Phase 4 leaves it colourless — it cannot cover a
  coloured order — unless the owner stock-takes it by colour.
