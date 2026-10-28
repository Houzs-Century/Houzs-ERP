# Products redesign buildout (2026-09-17)

Build the approved Product-Maintenance mockups into the live app. One agent owns
`Products.tsx` + `mfg-products.ts` (product / anchor / history reads). Supplier-side
files (`SupplierDetail.tsx`, `SofaComboTab`, `suppliers.ts`) belong to another agent —
route any `suppliers.ts` need through main.

Each wave = its own CI-green PR. Status kept current here per PR.

## Wave A — SKU drawer redesign (`ProductSuppliersDrawer`)
- [x] A1 Backend cost-anchor read — extend `GET /mfg-products/:id/suppliers` with
      `anchor {state, reason, anchorSupplierId, anchorSupplierName, costSen, costedCount, totalCount}`.
      Resolver `resolveProductCostAnchor` in the audited derive module; cost figure
      finance-gated. **PR #4077 — MERGED.**
- [x] A2 Backend History reads — company-scoped GET endpoints over
      `scm.mfg_product_cost_history` (`/cost-history`, Cost tab) and
      `scm.supplier_binding_price_history` (`/supplier-price-history`, Supplier-price tab,
      up/down direction via `comparableCostSen`). Selling reuses the existing price-changes read.
      **PR: feat/sku-drawer-history-reads — opening.**
- [x] A3 Frontend — Product Maintenance Cost section (`CostAnchorCard`, ok/conflict/empty/service).
      **PR: feat/sku-drawer-cost-card — opening (with A5).**
- [x] A5 Frontend — editable Category for model SKUs too (reuse `CategorySwapSelect kind="model"`
      + the existing move-the-whole-model confirmation). Standalone SKUs were already editable.
      **PR: feat/sku-drawer-cost-card.**
- [x] A4 Frontend — History block (`SkuHistoryTabs`: Cost / Selling / Supplier price, ↑/↓ arrows).
      **PR: feat/sku-drawer-history-tabs — opening.**
- [x] A6 B2 — "Add supplier binding" action from the drawer (`AddSupplierBinding`, reuses
      `useCreateBinding` -> POST /suppliers/:id/bindings; editing existing bindings stays supplier-side).
      **PR: feat/sku-drawer-add-binding — opening.**

## Wave B — SKU Master list
- [x] B1 Cost/anchor column marker (teal derived / amber differ / red Gap chip), detail via the
      drawer on double-click. Backend `?anchorState=1` (#4086, merged); frontend `costMarker` on
      the Price 2 / base-price column. **PR: feat/sku-master-cost-marker — opening.**

## Wave C — sibling tabs to their mockups (align visuals, don't rebuild logic — R109)
- [x] C1 Modular tab — model Category is now editable on the model editor via
      `CategorySwapSelect kind="model"` (reuses the A5 move-whole-model-and-SKUs
      confirmation). The ON/OFF allowed-option chips, All/None toggle and authority
      copy already matched. **PR: feat/products-modular-redesign.**
- [x] C2 Variants tab — already built to the mockup (design-handoff item 5,
      `products/VariantsTab.tsx`): category/model picker, Size/Tier/Colour axis filters,
      SKU / Variant / Base / Override / Effective / Enabled table with the switch. No change needed.
- [x] C3 Categories tab — already the catalogue-category editor the mockup shows:
      hero-image card grid, kebab (edit / move / delete), New-category drawer and the
      409 delete-gate. Backend already carries hero-image upload + `hero_image_key`/focal/alt
      (`backend/src/scm/routes/categories.ts`). Nothing net-new; no change needed.

## Maintenance (A2 redesign) — separate from Wave A/B backend
- [x] Products > Maintenance pools calmed to the approved mockup: rows are label + cost
      only (dead per-row History icon removed; effective-dated History stays click-to-reveal),
      a priced pool shows an "RM" rail tag, and the Specials pool shows a "This is cost, not
      selling" note. **PR: feat/products-maintenance-redesign (#4099).**
- [ ] OWNER DECISION — the mockup's "auto-derive a pool cost from the most-expensive supplier"
      (a supplier anchor revealed on a cost click) is NOT built. Maintenance pools have no
      supplier binding today; the cost-anchor read is SKU-level only. This is net-new backend
      + storage, flagged rather than invented.

## Judgement calls / notes
- A1: `SERVICE` category returns `state:'service'` for DISPLAY only — it does not change
  what auto-derive writes for a service SKU that happens to carry a binding.
- A1: a zero-dearness winner (all prices blank/zero) shows as `empty / no_supplier_with_cost`,
  matching auto-derive's refusal to write an anchored RM 0.
- Mockups: match the app's real design tokens (`vendor/design-system/tokens.css`,
  `--c-success/-warn/-error`, `--font-mono`), NOT the mockup's raw CSS.
